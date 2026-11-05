import { describe, expect, it } from "vitest";
import { canonicalJson, compileExecutionPlan, decodeProtocolFrames, encodeProtocolFrame, validateManifestValue } from "../src/index.js";

const valid = {
  schemaVersion: 1,
  name: "shop-lab",
  application: { service: "api", recipe: "node-typescript", entrypoint: "dist/server.js", healthPath: "/health", sourceRoot: "src" },
  dependencies: { cache: { recipe: "redis", routeThroughProxy: true } },
  features: [{ id: "search", title: "Search", description: "Search products", entrypoints: [{ method: "GET", path: "/products" }], scenarios: ["search-basic"] }],
  scenarios: [{ id: "search-basic", feature: "search", reset: "fresh-environment", request: { method: "GET", path: "/products" }, assertions: [{ id: "status", kind: "http-status", equals: 200 }] }],
  experiments: [{ id: "cache-down", scenario: "search-basic", fault: { target: "cache", kind: "unavailable", direction: "both" }, expectedAssertions: ["status"] }],
};

describe("manifest contract", () => {
  it("accepts the starter shape and rejects undeclared fault targets", () => {
    expect(validateManifestValue(valid).ok).toBe(true);
    const bad = structuredClone(valid) as typeof valid;
    bad.experiments[0].fault.target = "missing";
    expect(validateManifestValue(bad)).toMatchObject({ ok: false, errors: [{ message: "fault target must be a declared dependency" }] });
  });

  it("round trips a bounded protocol frame and rejects oversized frames", () => {
    const frame = encodeProtocolFrame({ type: "event", event: "accepted", requestId: "r1", sequence: "1", payload: {} });
    expect(decodeProtocolFrames(frame)).toMatchObject({ messages: [{ type: "event", event: "accepted" }], remainder: new Uint8Array() });
    expect(() => encodeProtocolFrame({ type: "event", event: "accepted", requestId: "r1", sequence: "1", payload: { text: "x".repeat(2_000_000) } })).toThrow(/exceeds/);
  });

  it("uses a stable plan fingerprint and rejects duplicate IDs or unproxied faults", () => {
    expect(compileExecutionPlan(validateManifestValue(valid).manifest!, "C:/repo").fingerprint).toHaveLength(64);
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    const bad = structuredClone(valid) as typeof valid;
    bad.features.push(structuredClone(bad.features[0]));
    bad.experiments[0].fault.target = "cache";
    bad.dependencies.cache.routeThroughProxy = false;
    const result = validateManifestValue(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.message)).toEqual(expect.arrayContaining(["duplicate id search", "fault target must route through its declared proxy"]));
  });
});
