import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepository } from "@repolab/analyzer";
import { RepoLabStorage } from "../src/index.js";

describe("SQLite graph storage", () => {
  it("persists graph facts and only serves a snapshot-relative source path", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-storage-root-"));
    await writeFile(join(root, "server.ts"), "app.get('/health', () => 'ok');\n");
    const result = await analyzeRepository(root);
    const dataDir = await mkdtemp(join(tmpdir(), "repolab-storage-data-"));
    const storage = await RepoLabStorage.open(dataDir);
    const saved = await storage.saveAnalysis(root, result.snapshot, result.graph);
    expect(storage.getGraph(saved.snapshot.id)?.nodes.some((node) => node.kind === "route")).toBe(true);
    expect((await storage.getSource(saved.snapshot.id, "server.ts"))?.content).toContain("/health");
    expect(await storage.getSource(saved.snapshot.id, "../repolab.db")).toBeUndefined();
    storage.close();
  });

  it("persists run intent and enforces the explicit lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-storage-run-root-"));
    await writeFile(join(root, "server.ts"), "app.get('/health', () => 'ok');\n");
    const result = await analyzeRepository(root);
    const storage = await RepoLabStorage.open(join(root, ".data"));
    const saved = await storage.saveAnalysis(root, result.snapshot, result.graph);
    const run = storage.createRun({ repositoryId: saved.repository.id, snapshotId: saved.snapshot.id, scenarioId: "health", planFingerprint: "a".repeat(64) });
    expect(run.state).toBe("queued");
    expect(storage.getRunEvents(run.id)).toHaveLength(1);
    expect(storage.transitionRun(run.id, "preparing").state).toBe("preparing");
    expect(() => storage.transitionRun(run.id, "completed")).toThrow(/invalid run transition/);
    const cancelled = storage.transitionRun(run.id, "cancelled", "user_cancelled");
    expect(cancelled.outcome).toBe("user_cancelled");
    expect(storage.getRunEvents(run.id).at(-1)?.sequence).toBe("3");
    storage.close();
  });
});
