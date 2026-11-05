import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeProtocolFrames, encodeProtocolFrame, protocolMessageSchema, protocolVersion, type ProtocolMessage } from "@repolab/contracts";

const MAX_DIAGNOSTICS = 64 * 1024;

export function packagedRunnerPath(packageRoot = dirname(fileURLToPath(import.meta.url))): string {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  return join(packageRoot, "..", "..", "..", "runner", "bin", `${platform}-${architecture}`, process.platform === "win32" ? "repolab-runner.exe" : "repolab-runner");
}

export async function runnerBinaryAvailable(path = packagedRunnerPath()): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

export interface RunnerEvent { message: ProtocolMessage; }

export class RunnerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = new Uint8Array();
  private stderrBytes = 0;
  private readonly listeners = new Set<(event: RunnerEvent) => void>();

  async start(binary = packagedRunnerPath()): Promise<ProtocolMessage> {
    if (!(await runnerBinaryAvailable(binary))) throw new Error(`RepoLab runner binary is unavailable at ${binary}; build or install the supported runner package`);
    this.process = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.process.stdout.on("data", (chunk: Buffer) => {
      const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      combined.set(this.buffer); combined.set(chunk, this.buffer.byteLength); this.buffer = combined;
      const decoded = decodeProtocolFrames(this.buffer);
      this.buffer = decoded.remainder;
      for (const message of decoded.messages) for (const listener of this.listeners) listener({ message });
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > MAX_DIAGNOSTICS) this.process?.stderr.pause();
    });
    const handshake = await this.waitFor((message) => message.type === "handshake", 5_000);
    if (handshake.type !== "handshake" || handshake.protocolVersion !== protocolVersion || !handshake.supportedPlanVersions.includes(1)) {
      await this.stop();
      throw new Error("runner protocol version mismatch");
    }
    return handshake;
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  send(message: ProtocolMessage): void {
    if (!this.process?.stdin.writable) throw new Error("runner is not connected");
    this.process.stdin.write(encodeProtocolFrame(protocolMessageSchema.parse(message)));
  }

  async request(message: Extract<ProtocolMessage, { type: "command" }>, timeoutMs = 30_000): Promise<ProtocolMessage[]> {
    const events: ProtocolMessage[] = [];
    const accepted = new Promise<ProtocolMessage[]>((resolve, reject) => {
      const unsubscribe = this.onEvent(({ message: event }) => {
        if (event.type !== "event" || event.requestId !== message.requestId) return;
        events.push(event);
        if (event.event === "completed" || event.event === "failed") { unsubscribe(); resolve(events); }
      });
      const timer = setTimeout(() => { unsubscribe(); reject(new Error(`runner request timed out after ${timeoutMs}ms`)); }, timeoutMs);
      void timer.unref?.();
    });
    this.send(message);
    return accepted;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    const child = this.process;
    this.process = undefined;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  private waitFor(predicate: (message: ProtocolMessage) => boolean, timeoutMs: number): Promise<ProtocolMessage> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.onEvent(({ message }) => { if (predicate(message)) { unsubscribe(); clearTimeout(timer); resolve(message); } });
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("runner handshake timed out")); }, timeoutMs);
    });
  }
}
