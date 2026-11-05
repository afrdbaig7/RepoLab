import { describe, expect, it } from "vitest";
import { evaluateAssertions, readJsonPath, summarizeAssertions } from "../src/index.js";

describe("scenario assertions", () => {
  const observation = { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "r1" }, body: JSON.stringify({ items: [{ name: "Mechanical Keyboard" }] }), durationMs: 12, evidenceComplete: true, operations: [{ service: "cache", operation: "GET" }] };

  it("evaluates only the supported JSON-path subset", () => {
    expect(readJsonPath(JSON.parse(observation.body!), "$.items[0].name")).toEqual({ found: true, value: "Mechanical Keyboard" });
    expect(readJsonPath(JSON.parse(observation.body!), "$.items[1].name")).toEqual({ found: false });
    expect(() => readJsonPath({}, "$.items[*].name")).toThrow(/unsupported/);
  });

  it("distinguishes failed assertions from incomplete evidence", () => {
    const results = evaluateAssertions([
      { id: "status", kind: "http-status", equals: 200 },
      { id: "item", kind: "json-path", path: "$.items[0].name", equals: "Mechanical Keyboard" },
      { id: "operation", kind: "operation-occurrence", service: "cache", operation: "GET" },
    ], observation);
    expect(summarizeAssertions(results)).toMatchObject({ passed: true, incomplete: false, failed: 0, inconclusive: 0 });
    const incomplete = evaluateAssertions([{ id: "operation", kind: "operation-occurrence", service: "cache", operation: "GET" }], { ...observation, evidenceComplete: false });
    expect(incomplete[0]?.outcome).toBe("inconclusive");
  });
});
