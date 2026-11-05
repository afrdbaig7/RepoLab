import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { digest, requestSchema, responseSchema, type Manifest } from "./contracts.js";
import type { InputFile } from "./extract.js";
import { readBoundedFile, readBoundedText } from "./io.js";
import { resolveTrustedGit } from "./trusted-git.js";

const maxOutput = 16 * 1024 * 1024;
const validator = new Ajv2020({ strict: false, allErrors: true }).compile(z.toJSONSchema(responseSchema));
export function workerPath(): string {
  return process.env.LENS_WORKER ?? fileURLToPath(new URL(`../bin/${process.platform}-${process.arch}/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
}

export async function verifyPackagedWorker(binary = workerPath()): Promise<void> {
  if (process.env.LENS_WORKER || binary !== workerPath()) return;
  const metadata = z.object({ version: z.literal("0.1.0"), protocolVersion: z.literal(1), target: z.literal(`${process.platform}-${process.arch}`), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readBoundedText(join(dirname(binary), "worker.json"), 65536)));
  const stat = await lstat(binary);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024 || digest(await readBoundedFile(binary, 32 * 1024 * 1024)) !== metadata.sha256) throw new Error("Packaged worker integrity/compatibility check failed");
}

async function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>(done => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 1000 }, () => done()));
    // Restricted Windows sessions may reject taskkill; still terminate our direct child.
    if (child.exitCode === null) child.kill("SIGKILL");
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export async function invokeWorker(request: unknown, binary = workerPath(), signal?: AbortSignal, timeout = 90000, binaryArgs: string[] = []): Promise<Manifest> {
  const validated = requestSchema.parse(request);
  const frame = Buffer.from(`${JSON.stringify(validated)}\n`);
  if (frame.length > 8192) throw new Error("Worker request exceeds 8192 bytes");
  signal?.throwIfAborted();
  await verifyPackagedWorker(binary);
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const child = spawn(binary, binaryArgs, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnosticBytes = 0;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      if (failure) return;
      failure = error;
      void killTree(child);
    };
    const cancel = (): void => fail(new Error("Analysis canceled; worker process tree terminated"));
    const timer = setTimeout(() => fail(new Error("Snapshot worker exceeded timeout")), timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutput) fail(new Error("Worker stdout exceeds 16 MiB"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 65536) fail(new Error("Worker stderr exceeds 64 KiB"));
    });
    child.stdin.on("error", error => fail(error));
    child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new Error(`Cannot launch trusted snapshot worker: ${error.message}`)); });
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) { reject(failure); return; }
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("Expected exactly one completed NDJSON worker response");
        const value: unknown = JSON.parse(text);
        if (!validator(value)) throw new Error("Worker response violates JSON Schema");
        const response = responseSchema.parse(value);
        if (response.id !== validated.id) throw new Error("Worker response request ID mismatch");
        if (response.type === "error") throw new Error(`${response.code} at ${response.stage}: ${response.message}`);
        if (code !== 0) throw new Error(`Worker exited ${code} after result`);
        const comparison = response.manifest.comparison;
        if (comparison.requestedBase !== validated.base || comparison.requestedHead !== validated.head || comparison.policy !== validated.policy || (validated.policy === "exact" && comparison.comparisonBase !== comparison.resolvedBase)) throw new Error("Worker comparison does not match requested policy/refs");
        accept(response.manifest);
      } catch (error) { reject(error); }
    });
    child.stdin.end(frame);
  });
}

export async function capture(repo: string, base: string, head: string, policy: "pr" | "exact", signal?: AbortSignal, binary?: string): Promise<{ manifest: Manifest; before: InputFile[]; after: InputFile[] }> {
  const directory = await mkdtemp(join(tmpdir(), "lens-snapshot-"));
  try {
    const repository = await realpath(resolve(repo));
    const manifest = await invokeWorker({ protocolVersion: 1, id: randomUUID(), operation: "snapshot", repo: repository, git: await resolveTrustedGit(repository), output: directory, base, head, policy }, binary, signal);
    const declaredBytes = [...manifest.before, ...manifest.after].reduce((sum, entry) => sum + entry.bytes, 0);
    if (declaredBytes > 33554432 || declaredBytes > manifest.totalBytes) throw new Error("Manifest aggregate byte accounting is inconsistent");
    const root = await realpath(directory);
    const read = async (entries: Manifest["before"], revision: string): Promise<InputFile[]> => {
      const result: InputFile[] = [];
      const paths = new Set<string>();
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (paths.has(entry.path)) throw new Error("Duplicate path in snapshot manifest");
        paths.add(entry.path);
        const path = join(directory, entry.storage);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== entry.bytes || metadata.size > 1048576 || await realpath(path) !== join(root, entry.storage)) throw new Error("Snapshot file escaped root or violates size/type contract");
        const bytes = await readBoundedFile(path, 1048576);
        if (bytes.length !== entry.bytes || digest(bytes) !== entry.digest) throw new Error("Snapshot content digest/size mismatch");
        result.push({ path: entry.path, revision, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) });
      }
      return result;
    };
    const before = await read(manifest.before, manifest.comparison.comparisonBase);
    const after = await read(manifest.after, manifest.comparison.resolvedHead);
    return { manifest, before, after };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
