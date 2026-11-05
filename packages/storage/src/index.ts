import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceSnapshot } from "@repolab/analyzer";
import type { ExecutionPlan, Graph } from "@repolab/contracts";
import { sha256 } from "@repolab/contracts";

export interface RepositoryRecord { id: string; root: string; createdAt: string; updatedAt: string; }
export interface SnapshotRecord { id: string; repositoryId: string; createdAt: string; analyzerVersion: string; fileCount: number; totalBytes: number; }
export interface TrustedPlanRecord { repositoryId: string; fingerprint: string; manifestHash: string; planVersion: number; trustedAt: string; }
export type RunState = "queued" | "preparing" | "starting" | "ready" | "baseline_running" | "resetting" | "fault_applying" | "experiment_running" | "collecting" | "comparing" | "cleaning" | "completed" | "failed" | "cancelled" | "interrupted";
export interface RunRecord { id: string; repositoryId: string; snapshotId: string; scenarioId: string; experimentId?: string; planFingerprint: string; state: RunState; outcome?: string; createdAt: string; updatedAt: string; }
export interface RunEvent { runId: string; sequence: string; type: string; payload: Record<string, unknown>; createdAt: string; }
interface DbRunRow { id: string; repositoryId: string; snapshotId: string; scenarioId: string; experimentId: string | null; planFingerprint: string; state: string; outcome: string | null; createdAt: string; updatedAt: string; }

const allowedTransitions: Record<RunState, readonly RunState[]> = {
  queued: ["preparing", "failed", "cancelled", "interrupted"], preparing: ["starting", "failed", "cancelled", "interrupted"], starting: ["ready", "failed", "cancelled", "interrupted"], ready: ["baseline_running", "failed", "cancelled", "interrupted"], baseline_running: ["resetting", "collecting", "failed", "cancelled", "interrupted"], resetting: ["fault_applying", "experiment_running", "failed", "cancelled", "interrupted"], fault_applying: ["experiment_running", "failed", "cancelled", "interrupted"], experiment_running: ["collecting", "failed", "cancelled", "interrupted"], collecting: ["comparing", "cleaning", "failed", "cancelled", "interrupted"], comparing: ["cleaning", "failed", "interrupted"], cleaning: ["completed", "failed", "interrupted"], completed: [], failed: ["cleaning"], cancelled: ["cleaning"], interrupted: ["cleaning"],
};

export class RepoLabStorage {
  readonly dataDir: string;
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.db = new DatabaseSync(join(this.dataDir, "repolab.db"));
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  static async open(dataDir: string): Promise<RepoLabStorage> {
    await mkdir(dataDir, { recursive: true });
    return new RepoLabStorage(dataDir);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_facts (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        fact_id TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, fact_id)
      );
      CREATE TABLE IF NOT EXISTS graph_edges (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        edge_id TEXT NOT NULL,
        edge_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, edge_id)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_repository ON snapshots(repository_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS trusted_plans (
        repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        trusted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE RESTRICT,
        scenario_id TEXT NOT NULL,
        experiment_id TEXT,
        plan_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_repository ON runs(repository_id, created_at DESC);
    `);
    const current = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version?: number } | undefined;
    if (!current) this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
  }

  async saveAnalysis(root: string, snapshot: SourceSnapshot, graph: Graph): Promise<{ repository: RepositoryRecord; snapshot: SnapshotRecord }> {
    const repositoryRoot = resolve(root);
    const now = new Date().toISOString();
    const repositoryId = `repo:${sha256(repositoryRoot).slice(0, 32)}`;
    const snapshotDir = join(this.dataDir, "snapshots", snapshot.id);
    await mkdir(snapshotDir, { recursive: true });
    for (const file of snapshot.files) {
      const destination = join(snapshotDir, file.path);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${process.pid}`;
      await writeFile(temporary, file.content, "utf8");
      await rename(temporary, destination);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO repositories(id, root, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(root) DO UPDATE SET updated_at=excluded.updated_at`).run(repositoryId, repositoryRoot, now, now);
      this.db.prepare(`INSERT OR REPLACE INTO snapshots(id, repository_id, created_at, analyzer_version, file_count, total_bytes) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(snapshot.id, repositoryId, snapshot.createdAt, snapshot.analyzerVersion, snapshot.files.length, snapshot.totalBytes);
      this.db.prepare("DELETE FROM graph_facts WHERE snapshot_id = ?").run(snapshot.id);
      this.db.prepare("DELETE FROM graph_edges WHERE snapshot_id = ?").run(snapshot.id);
      const insertFact = this.db.prepare("INSERT INTO graph_facts(snapshot_id, fact_id, fact_json) VALUES (?, ?, ?)");
      for (const fact of graph.nodes) insertFact.run(snapshot.id, fact.id, JSON.stringify(fact));
      const insertEdge = this.db.prepare("INSERT INTO graph_edges(snapshot_id, edge_id, edge_json) VALUES (?, ?, ?)");
      for (const edge of graph.edges) insertEdge.run(snapshot.id, edge.id, JSON.stringify(edge));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { repository: { id: repositoryId, root: repositoryRoot, createdAt: now, updatedAt: now }, snapshot: { id: snapshot.id, repositoryId, createdAt: snapshot.createdAt, analyzerVersion: snapshot.analyzerVersion, fileCount: snapshot.files.length, totalBytes: snapshot.totalBytes } };
  }

  listRepositories(): RepositoryRecord[] {
    return this.db.prepare("SELECT id, root, created_at AS createdAt, updated_at AS updatedAt FROM repositories ORDER BY updated_at DESC").all() as unknown as RepositoryRecord[];
  }

  ensureRepository(root: string): RepositoryRecord {
    const repositoryRoot = resolve(root);
    const now = new Date().toISOString();
    const id = `repo:${sha256(repositoryRoot).slice(0, 32)}`;
    this.db.prepare(`INSERT INTO repositories(id, root, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(root) DO UPDATE SET updated_at=excluded.updated_at`).run(id, repositoryRoot, now, now);
    return this.getRepository(id) ?? { id, root: repositoryRoot, createdAt: now, updatedAt: now };
  }

  getRepository(id: string): RepositoryRecord | undefined {
    return this.db.prepare("SELECT id, root, created_at AS createdAt, updated_at AS updatedAt FROM repositories WHERE id = ?").get(id) as unknown as RepositoryRecord | undefined;
  }

  trustPlan(repositoryId: string, plan: ExecutionPlan): TrustedPlanRecord {
    const trustedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO trusted_plans(repository_id, fingerprint, manifest_hash, plan_version, trusted_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET fingerprint=excluded.fingerprint, manifest_hash=excluded.manifest_hash, plan_version=excluded.plan_version, trusted_at=excluded.trusted_at`)
      .run(repositoryId, plan.fingerprint, plan.manifestHash, plan.planVersion, trustedAt);
    return { repositoryId, fingerprint: plan.fingerprint, manifestHash: plan.manifestHash, planVersion: plan.planVersion, trustedAt };
  }

  getTrustedPlan(repositoryId: string): TrustedPlanRecord | undefined {
    return this.db.prepare("SELECT repository_id AS repositoryId, fingerprint, manifest_hash AS manifestHash, plan_version AS planVersion, trusted_at AS trustedAt FROM trusted_plans WHERE repository_id = ?").get(repositoryId) as unknown as TrustedPlanRecord | undefined;
  }

  createRun(input: { repositoryId: string; snapshotId: string; scenarioId: string; experimentId?: string; planFingerprint: string }): RunRecord {
    const id = `run:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const run: RunRecord = { id, repositoryId: input.repositoryId, snapshotId: input.snapshotId, scenarioId: input.scenarioId, ...(input.experimentId ? { experimentId: input.experimentId } : {}), planFingerprint: input.planFingerprint, state: "queued", createdAt, updatedAt: createdAt };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO runs(id, repository_id, snapshot_id, scenario_id, experiment_id, plan_fingerprint, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(run.id, run.repositoryId, run.snapshotId, run.scenarioId, run.experimentId ?? null, run.planFingerprint, run.state, createdAt, createdAt);
      this.db.prepare("INSERT INTO run_events(run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(id, "1", "accepted", JSON.stringify({ state: "queued" }), createdAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return run;
  }

  transitionRun(runId: string, state: RunState, outcome?: string, payload: Record<string, unknown> = {}): RunRecord {
    const current = this.getRun(runId);
    if (!current) throw new Error(`run not found: ${runId}`);
    if (!allowedTransitions[current.state].includes(state)) throw new Error(`invalid run transition ${current.state} -> ${state}`);
    const updatedAt = new Date().toISOString();
    const next: RunRecord = { ...current, state, updatedAt, ...(outcome === undefined ? {} : { outcome }) };
    const sequence = this.nextRunSequence(runId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE runs SET state = ?, outcome = ?, updated_at = ? WHERE id = ?").run(state, outcome ?? current.outcome ?? null, updatedAt, runId);
      this.db.prepare("INSERT INTO run_events(run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, sequence, "phase_changed", JSON.stringify({ ...payload, state, outcome }), updatedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return next;
  }

  appendRunEvent(runId: string, type: string, payload: Record<string, unknown>): RunEvent {
    if (!this.getRun(runId)) throw new Error(`run not found: ${runId}`);
    const createdAt = new Date().toISOString();
    const event = { runId, sequence: this.nextRunSequence(runId), type, payload, createdAt };
    this.db.prepare("INSERT INTO run_events(run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, event.sequence, type, JSON.stringify(payload), createdAt);
    return event;
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT id, repository_id AS repositoryId, snapshot_id AS snapshotId, scenario_id AS scenarioId, experiment_id AS experimentId, plan_fingerprint AS planFingerprint, state, outcome, created_at AS createdAt, updated_at AS updatedAt FROM runs WHERE id = ?").get(runId) as unknown as DbRunRow | undefined;
    if (!row) return undefined;
    return toRunRecord(row);
  }

  listRuns(repositoryId?: string): RunRecord[] {
    const rows = (repositoryId ? this.db.prepare("SELECT id, repository_id AS repositoryId, snapshot_id AS snapshotId, scenario_id AS scenarioId, experiment_id AS experimentId, plan_fingerprint AS planFingerprint, state, outcome, created_at AS createdAt, updated_at AS updatedAt FROM runs WHERE repository_id = ? ORDER BY created_at DESC").all(repositoryId) : this.db.prepare("SELECT id, repository_id AS repositoryId, snapshot_id AS snapshotId, scenario_id AS scenarioId, experiment_id AS experimentId, plan_fingerprint AS planFingerprint, state, outcome, created_at AS createdAt, updated_at AS updatedAt FROM runs ORDER BY created_at DESC").all()) as unknown as DbRunRow[];
    return rows.map(toRunRecord);
  }

  getRunEvents(runId: string, afterSequence = "0", limit = 500): RunEvent[] {
    const rows = this.db.prepare("SELECT run_id AS runId, sequence, type, payload_json AS payloadJson, created_at AS createdAt FROM run_events WHERE run_id = ? AND CAST(sequence AS INTEGER) > CAST(? AS INTEGER) ORDER BY CAST(sequence AS INTEGER) LIMIT ?").all(runId, afterSequence, Math.min(Math.max(limit, 1), 500)) as Array<{ runId: string; sequence: string; type: string; payloadJson: string; createdAt: string }>;
    return rows.map((row) => ({ runId: row.runId, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payloadJson) as Record<string, unknown>, createdAt: row.createdAt }));
  }

  private nextRunSequence(runId: string): string {
    const row = this.db.prepare("SELECT sequence FROM run_events WHERE run_id = ? ORDER BY CAST(sequence AS INTEGER) DESC LIMIT 1").get(runId) as { sequence?: string } | undefined;
    return String(Number(row?.sequence ?? "0") + 1);
  }

  getLatestSnapshot(repositoryId: string): SnapshotRecord | undefined {
    return this.db.prepare("SELECT id, repository_id AS repositoryId, created_at AS createdAt, analyzer_version AS analyzerVersion, file_count AS fileCount, total_bytes AS totalBytes FROM snapshots WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1").get(repositoryId) as unknown as SnapshotRecord | undefined;
  }

  getSnapshot(id: string): SnapshotRecord | undefined {
    return this.db.prepare("SELECT id, repository_id AS repositoryId, created_at AS createdAt, analyzer_version AS analyzerVersion, file_count AS fileCount, total_bytes AS totalBytes FROM snapshots WHERE id = ?").get(id) as unknown as SnapshotRecord | undefined;
  }

  getGraph(snapshotId: string): Graph | undefined {
    if (!this.getSnapshot(snapshotId)) return undefined;
    const nodes = this.db.prepare("SELECT fact_json AS value FROM graph_facts WHERE snapshot_id = ? ORDER BY fact_id").all(snapshotId).map((row) => JSON.parse((row as { value: string }).value));
    const edges = this.db.prepare("SELECT edge_json AS value FROM graph_edges WHERE snapshot_id = ? ORDER BY edge_id").all(snapshotId).map((row) => JSON.parse((row as { value: string }).value));
    return { nodes, edges } as Graph;
  }

  async getSource(snapshotId: string, path: string): Promise<{ path: string; content: string; hash: string } | undefined> {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot || path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) return undefined;
    const filePath = join(this.dataDir, "snapshots", snapshotId, path);
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    return content === undefined ? undefined : { path, content, hash: sha256(content) };
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}

function toRunRecord(row: DbRunRow): RunRecord {
  return { id: row.id, repositoryId: row.repositoryId, snapshotId: row.snapshotId, scenarioId: row.scenarioId, planFingerprint: row.planFingerprint, state: row.state as RunState, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.experimentId === null ? {} : { experimentId: row.experimentId }), ...(row.outcome === null ? {} : { outcome: row.outcome }) };
}
