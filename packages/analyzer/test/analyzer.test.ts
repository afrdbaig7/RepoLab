import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepository, analyzeSnapshot, createSourceSnapshot, augmentGraphWithManifest } from "../src/index.js";

describe("bounded source analyzer", () => {
  it("analyzes captured content even after the working tree changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-isolation-"));
    const file = join(root, "example.ts");
    await writeFile(file, "export function beforeSnapshot() {}\n");
    const snapshot = await createSourceSnapshot(root);
    await writeFile(file, "export function afterSnapshot() {}\n");
    const symbols = analyzeSnapshot(snapshot).nodes.filter(node => node.kind === "symbol");
    expect(symbols.map(node => node.label)).toEqual(["example.ts#beforeSnapshot"]);
    expect(symbols[0]?.sourceRef?.fileHash).toBe(snapshot.files[0]?.hash);
  });
  it("extracts a real Express route and import without executing source", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-analysis-"));
    await writeFile(join(root, "routes.ts"), "import { handler } from './handler';\napp.get('/health', handler);\n");
    await writeFile(join(root, "handler.ts"), "export function handler() { return 'ok'; }\n");
    const result = await analyzeRepository(root);
    expect(result.graph.nodes.some((node) => node.kind === "route" && node.label === "GET /health")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "imports" && edge.to === "module:handler.ts")).toBe(true);
    expect(result.graph.nodes.find((node) => node.kind === "route")?.provenance.kind).toBe("parsed");
  });

  it("enforces a file bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-analysis-limit-"));
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await expect(analyzeRepository(root, { maxFiles: 0 })).rejects.toThrow(/exceeds 0 files/);
  });

  it("keeps declared lab facts separate from parsed source facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-analysis-manifest-"));
    await writeFile(join(root, "server.ts"), "app.get('/health', () => 'ok');\n");
    const result = await analyzeRepository(root);
    const graph = augmentGraphWithManifest(result.graph, {
      schemaVersion: 1,
      name: "lab",
      application: { service: "api", recipe: "node-typescript", entrypoint: "dist/server.js", healthPath: "/health", sourceRoot: "src" },
      dependencies: { cache: { recipe: "redis", routeThroughProxy: true } },
      features: [{ id: "health", title: "Health", description: "Health", entrypoints: [{ method: "GET", path: "/health" }], scenarios: ["health-check"] }],
      scenarios: [{ id: "health-check", feature: "health", reset: "fresh-environment", request: { method: "GET", path: "/health" }, assertions: [{ id: "status", kind: "http-status", equals: 200 }] }],
      experiments: [],
    }, result.snapshot.id);
    expect(graph.nodes.some((node) => node.kind === "feature" && node.provenance.kind === "declared")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "route" && node.provenance.kind === "parsed")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "route" && node.provenance.kind === "declared")).toBe(true);
  });
});
