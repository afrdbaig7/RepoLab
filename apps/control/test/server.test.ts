import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createControlServer } from "../src/server.js";

describe("control service", () => {
  it("serves health and the real graph/source flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-control-root-"));
    await writeFile(join(root, "server.ts"), "app.get('/health', () => 'ok');\n");
    await mkdir(join(root, ".repolab"));
    await writeFile(join(root, ".repolab", "lab.yaml"), `schemaVersion: 1
name: test-lab
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
    title: Health
    description: Health endpoint
    entrypoints:
      - method: GET
        path: /health
    scenarios: [health-check]
scenarios:
  - id: health-check
    feature: health
    reset: fresh-environment
    request:
      method: GET
      path: /health
    assertions:
      - id: status
        kind: http-status
        equals: 200
experiments: []
`);
    const { app, storage } = await createControlServer({ root, dataDir: join(root, ".data") });
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    const post = await app.inject({ method: "POST", url: "/api/v1/repositories", payload: { root } });
    expect(post.statusCode).toBe(200);
    const id = JSON.parse(post.body).id as string;
    expect(id).toContain("repo:");
    const index = await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(id)}/index` });
    expect(index.statusCode).toBe(200);
    const graph = await app.inject({ method: "GET", url: `/api/v1/snapshots/${JSON.parse(index.body).snapshot.id}/graph` });
    expect(graph.statusCode).toBe(200);
    expect(JSON.parse(graph.body).nodes.some((node: { kind: string }) => node.kind === "route")).toBe(true);
    const plan = await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(id)}/execution-plan` });
    expect(plan.statusCode).toBe(200);
    const planBody = JSON.parse(plan.body) as { plan: { fingerprint: string }; trusted: boolean };
    expect(planBody.trusted).toBe(false);
    const trust = await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(id)}/trust`, payload: { expectedFingerprint: planBody.plan.fingerprint } });
    expect(trust.statusCode).toBe(200);
    expect(JSON.parse((await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(id)}/execution-plan` })).body).trusted).toBe(true);
    await app.close();
    storage.close();
  });

  it("does not create a run when the supervisor binary is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "repolab-control-run-root-"));
    await writeFile(join(root, "server.ts"), "app.get('/health', () => 'ok');\n");
    await mkdir(join(root, ".repolab"));
    await writeFile(join(root, ".repolab", "lab.yaml"), `schemaVersion: 1
name: test-lab
application: { service: api, recipe: node-typescript, entrypoint: dist/server.js, healthPath: /health, sourceRoot: src }
dependencies: { cache: { recipe: redis, routeThroughProxy: true } }
features: [{ id: health, title: Health, description: Health, entrypoints: [{ method: GET, path: /health }], scenarios: [health-check] }]
scenarios: [{ id: health-check, feature: health, reset: fresh-environment, request: { method: GET, path: /health }, assertions: [{ id: status, kind: http-status, equals: 200 }] }]
experiments: []
`);
    const { app, storage } = await createControlServer({ root, dataDir: join(root, ".data") });
    const repository = JSON.parse((await app.inject({ method: "POST", url: "/api/v1/repositories", payload: { root } })).body) as { id: string };
    await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(repository.id)}/index` });
    const planResponse = await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(repository.id)}/execution-plan` });
    const plan = JSON.parse(planResponse.body) as { plan: { fingerprint: string } };
    await app.inject({ method: "POST", url: `/api/v1/repositories/${encodeURIComponent(repository.id)}/trust`, payload: { expectedFingerprint: plan.plan.fingerprint } });
    const run = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { repositoryId: repository.id, scenarioId: "health-check", expectedFingerprint: plan.plan.fingerprint } });
    expect(run.statusCode).toBe(503);
    expect(storage.listRuns()).toHaveLength(0);
    await app.close();
    storage.close();
  });
});
