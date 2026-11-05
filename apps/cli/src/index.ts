#!/usr/bin/env node
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { analyzeRepository, augmentGraphWithManifest } from "@repolab/analyzer";
import { compileExecutionPlan, validateManifestFile } from "@repolab/contracts";
import { createControlServer } from "@repolab/control";
import { runnerBinaryAvailable, packagedRunnerPath } from "@repolab/runner-client";
import { RepoLabStorage } from "@repolab/storage";

const version = "0.1.0";
const starterManifest = `schemaVersion: 1
name: starter-lab
application:
  service: api
  recipe: node-typescript
  entrypoint: dist/server.js
  healthPath: /health
  sourceRoot: src
dependencies:
  cache:
    recipe: redis
    routeThroughProxy: true
features:
  - id: health
    title: Health check
    description: The application exposes a health endpoint.
    entrypoints:
      - method: GET
        path: /health
    scenarios:
      - health-check
scenarios:
  - id: health-check
    feature: health
    reset: fresh-environment
    request:
      method: GET
      path: /health
    assertions:
      - id: health-status
        kind: http-status
        equals: 200
experiments: []
`;

function usage(): never { console.error("Usage: repolab <doctor|init|validate|analyze|open|plan|run|runs|cancel|compare|export|clean>"); process.exit(2); }
function output(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true; } catch { return false; } }

async function init(root: string): Promise<void> {
  const directory = join(root, ".repolab"); await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "lab.yaml");
  if (!(await exists(manifestPath))) await writeFile(manifestPath, starterManifest, "utf8");
  console.log(`Created ${manifestPath}`);
}

async function validate(root: string): Promise<void> {
  const result = await validateManifestFile(join(root, ".repolab", "lab.yaml"));
  if (!result.ok) { output(result); process.exitCode = 1; return; }
  output({ ok: true, name: result.manifest.name, schemaVersion: result.manifest.schemaVersion });
}

async function analyze(root: string): Promise<void> {
  const result = await analyzeRepository(root);
  const validation = await validateManifestFile(join(root, ".repolab", "lab.yaml"));
  const graph = validation.ok ? augmentGraphWithManifest(result.graph, validation.manifest, result.snapshot.id) : result.graph;
  const storage = await RepoLabStorage.open(join(root, ".repolab", "data"));
  const saved = await storage.saveAnalysis(root, result.snapshot, graph);
  output({ repository: saved.repository, snapshot: saved.snapshot, nodes: graph.nodes.length, edges: graph.edges.length, manifest: validation.ok ? { valid: true, augmented: true } : { valid: false, errors: validation.errors } });
  storage.close();
}

async function plan(root: string): Promise<void> {
  const validation = await validateManifestFile(join(root, ".repolab", "lab.yaml"));
  if (!validation.ok) { output(validation); process.exitCode = 1; return; }
  output(compileExecutionPlan(validation.manifest, resolve(root)));
}

async function doctor(): Promise<void> {
  const checks: Record<string, unknown> = { node: process.version, platform: `${process.platform}/${process.arch}`, runner: { path: packagedRunnerPath(), available: await runnerBinaryAvailable() } };
  try {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    checks.docker = { available: code === 0 && stdout.trim().length > 0, server: stdout.trim(), diagnostic: code === 0 ? undefined : stderr.trim() || `docker exited with ${code}` };
  } catch (error) { checks.docker = { available: false, message: error instanceof Error ? error.message : "Docker Engine could not be started" }; }
  checks.status = (checks.runner as { available: boolean }).available ? "ready-for-runner" : "static-explorer-ready";
  output(checks);
  if (!(checks.runner as { available: boolean }).available) process.exitCode = 1;
}

async function open(root: string): Promise<void> {
  const { app, storage } = await createControlServer({ root, dataDir: join(root, ".repolab", "data") });
  const repository = storage.ensureRepository(root);
  if (!storage.getLatestSnapshot(repository.id)) { const result = await analyzeRepository(root); await storage.saveAnalysis(root, result.snapshot, result.graph); }
  const port = Number(process.env.REPOLAB_PORT ?? "4177");
  await app.listen({ host: "127.0.0.1", port });
  console.log(`RepoLab is ready at http://127.0.0.1:${port}`);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  await app.close();
}

async function unavailable(command: string): Promise<never> { console.error(`${command}: execution is not available until the packaged Go supervisor is installed; no runtime result was created`); process.exit(2); }

const [, , command, ...args] = process.argv;
const root = resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".");
try {
  switch (command) {
    case "doctor": await doctor(); break;
    case "init": await init(root); break;
    case "validate": await validate(root); break;
    case "analyze": if (!args[0]) usage(); await analyze(root); break;
    case "open": await open(root); break;
    case "plan": await plan(root); break;
    case "run": case "runs": case "cancel": case "compare": case "export": case "clean": await unavailable(command); break;
    default: usage();
  }
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
