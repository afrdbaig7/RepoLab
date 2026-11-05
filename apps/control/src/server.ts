import { access, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { analyzeRepository, augmentGraphWithManifest } from "@repolab/analyzer";
import { compileExecutionPlan, validateManifestFile } from "@repolab/contracts";
import { runnerBinaryAvailable } from "@repolab/runner-client";
import { RepoLabStorage } from "@repolab/storage";
import { indexHtml } from "./ui.js";

export interface ControlOptions { root?: string; dataDir?: string; port?: number; host?: string; }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "unexpected error"; }

export async function createControlServer(options: ControlOptions = {}): Promise<{ app: FastifyInstance; storage: RepoLabStorage }> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const root = resolve(options.root ?? process.cwd());
  const storage = await RepoLabStorage.open(options.dataDir ?? join(root, ".repolab", "data"));
  app.addHook("onClose", async () => storage.close());
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(indexHtml));
  app.get("/api/v1/health", async () => ({ status: "ok", version: "0.1.0", runnerAvailable: await runnerBinaryAvailable(), node: process.version }));
  app.get("/api/v1/repositories", async () => storage.listRepositories());
  app.post<{ Body: { root?: string } }>("/api/v1/repositories", async (request, reply) => {
    const candidate = request.body?.root;
    if (!candidate || typeof candidate !== "string") return reply.code(400).send({ code: "invalid_request", message: "root is required" });
    const repositoryRoot = resolve(candidate);
    try { await access(repositoryRoot, constants.R_OK); } catch { return reply.code(400).send({ code: "invalid_repository", message: "repository path is not readable" }); }
    return storage.ensureRepository(repositoryRoot);
  });
  app.get<{ Params: { id: string } }>("/api/v1/repositories/:id", async (request, reply) => { const value = storage.getRepository(request.params.id); return value ?? reply.code(404).send({ code: "not_found", message: "repository not found" }); });
  app.post<{ Params: { id: string } }>("/api/v1/repositories/:id/index", async (request, reply) => {
    const repository = storage.getRepository(request.params.id);
    if (!repository) return reply.code(404).send({ code: "not_found", message: "repository must be indexed through the CLI first" });
    try { const result = await analyzeRepository(repository.root); const validation = await validateManifestFile(join(repository.root, ".repolab", "lab.yaml")); const graph = validation.ok ? augmentGraphWithManifest(result.graph, validation.manifest, result.snapshot.id) : result.graph; return await storage.saveAnalysis(repository.root, result.snapshot, graph); } catch (error) { return reply.code(422).send({ code: "analysis_failed", message: errorMessage(error) }); }
  });
  app.get<{ Params: { id: string } }>("/api/v1/repositories/:id/snapshots", async (request, reply) => { const repository = storage.getRepository(request.params.id); if (!repository) return reply.code(404).send({ code: "not_found", message: "repository not found" }); return { snapshot: storage.getLatestSnapshot(repository.id) ?? null }; });
  app.get<{ Params: { id: string } }>("/api/v1/snapshots/:id/graph", async (request, reply) => { const graph = storage.getGraph(request.params.id); return graph ? { snapshotId: request.params.id, ...graph } : reply.code(404).send({ code: "not_found", message: "snapshot not found" }); });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/v1/snapshots/:id/source", async (request, reply) => { if (!request.query.path) return reply.code(400).send({ code: "invalid_request", message: "path is required" }); const source = await storage.getSource(request.params.id, request.query.path); return source ?? reply.code(404).send({ code: "not_found", message: "source file not found" }); });
  app.post<{ Params: { id: string } }>("/api/v1/repositories/:id/manifest/validate", async (request, reply) => { const repository = storage.getRepository(request.params.id); if (!repository) return reply.code(404).send({ code: "not_found", message: "repository not found" }); return validateManifestFile(join(repository.root, ".repolab", "lab.yaml")); });
  app.post<{ Params: { id: string } }>("/api/v1/repositories/:id/execution-plan", async (request, reply) => { const repository = storage.getRepository(request.params.id); if (!repository) return reply.code(404).send({ code: "not_found", message: "repository not found" }); const validation = await validateManifestFile(join(repository.root, ".repolab", "lab.yaml")); if (!validation.ok) return reply.code(422).send(validation); const plan = compileExecutionPlan(validation.manifest, repository.root); return { plan, trusted: storage.getTrustedPlan(repository.id)?.fingerprint === plan.fingerprint }; });
  app.post<{ Params: { id: string }; Body: { expectedFingerprint?: string } }>("/api/v1/repositories/:id/trust", async (request, reply) => {
    const repository = storage.getRepository(request.params.id);
    if (!repository) return reply.code(404).send({ code: "not_found", message: "repository not found" });
    const validation = await validateManifestFile(join(repository.root, ".repolab", "lab.yaml"));
    if (!validation.ok) return reply.code(422).send(validation);
    const plan = compileExecutionPlan(validation.manifest, repository.root);
    if (request.body?.expectedFingerprint !== plan.fingerprint) return reply.code(409).send({ code: "plan_fingerprint_mismatch", message: "trust requires the currently displayed execution-plan fingerprint", fingerprint: plan.fingerprint });
    return storage.trustPlan(repository.id, plan);
  });
  app.post<{ Body: { repositoryId?: string; scenarioId?: string; experimentId?: string; expectedFingerprint?: string } }>("/api/v1/runs", async (request, reply) => {
    const { repositoryId, scenarioId, experimentId, expectedFingerprint } = request.body ?? {};
    if (!repositoryId || !scenarioId || typeof expectedFingerprint !== "string") return reply.code(400).send({ code: "invalid_request", message: "repositoryId, scenarioId, and expectedFingerprint are required" });
    const repository = storage.getRepository(repositoryId);
    if (!repository) return reply.code(404).send({ code: "not_found", message: "repository not found" });
    const validation = await validateManifestFile(join(repository.root, ".repolab", "lab.yaml"));
    if (!validation.ok) return reply.code(422).send(validation);
    const scenario = validation.manifest.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) return reply.code(422).send({ code: "unknown_scenario", message: `unknown scenario ${scenarioId}` });
    if (experimentId && !validation.manifest.experiments.some((candidate) => candidate.id === experimentId && candidate.scenario === scenarioId)) return reply.code(422).send({ code: "invalid_experiment", message: "experiment must target the selected scenario" });
    const plan = compileExecutionPlan(validation.manifest, repository.root);
    if (expectedFingerprint !== plan.fingerprint) return reply.code(409).send({ code: "plan_fingerprint_mismatch", message: "run must use the current execution-plan fingerprint", fingerprint: plan.fingerprint });
    if (storage.getTrustedPlan(repository.id)?.fingerprint !== plan.fingerprint) return reply.code(403).send({ code: "plan_not_trusted", message: "trust the displayed execution plan before starting a run", fingerprint: plan.fingerprint });
    if (!(await runnerBinaryAvailable())) return reply.code(503).send({ code: "runner_unavailable", message: "the packaged Go supervisor is unavailable; no run was created" });
    const snapshot = storage.getLatestSnapshot(repository.id);
    if (!snapshot) return reply.code(409).send({ code: "snapshot_required", message: "index the repository before starting a run" });
    const active = storage.listRuns(repository.id).find((run) => !["completed", "failed", "cancelled", "interrupted"].includes(run.state));
    if (active) return reply.code(409).send({ code: "run_in_progress", message: "one active run per repository is supported", runId: active.id });
    return reply.code(201).send(storage.createRun({ repositoryId: repository.id, snapshotId: snapshot.id, scenarioId, ...(experimentId ? { experimentId } : {}), planFingerprint: plan.fingerprint }));
  });
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => { const run = storage.getRun(request.params.id); return run ?? reply.code(404).send({ code: "not_found", message: "run not found" }); });
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/api/v1/runs/:id/events", async (request, reply) => { if (!storage.getRun(request.params.id)) return reply.code(404).send({ code: "not_found", message: "run not found" }); const after = request.query.after ?? "0"; const limit = Number(request.query.limit ?? "500"); return { runId: request.params.id, events: storage.getRunEvents(request.params.id, after, Number.isFinite(limit) ? limit : 500) }; });
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/cancel", async (request, reply) => { const run = storage.getRun(request.params.id); if (!run) return reply.code(404).send({ code: "not_found", message: "run not found" }); if (["completed", "failed", "cancelled", "interrupted"].includes(run.state)) return reply.code(409).send({ code: "run_not_active", message: `run is already ${run.state}` }); try { return storage.transitionRun(run.id, "cancelled", "user_cancelled", { reason: "user_request" }); } catch (error) { return reply.code(409).send({ code: "invalid_transition", message: errorMessage(error) }); } });
  return { app, storage };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const port = Number(process.env.REPOLAB_PORT ?? "4177");
  const root = process.env.REPOLAB_ROOT ?? process.cwd();
  const { app } = await createControlServer({ root, port });
  await app.listen({ host: "127.0.0.1", port });
  console.log(`RepoLab control service listening at http://127.0.0.1:${port}`);
}
