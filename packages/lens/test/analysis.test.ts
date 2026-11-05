import { describe, expect, it } from "vitest";
import { runAnalysis } from "../dist/analysis.js";
import type { AnalysisInput } from "../src/analysis.js";

const input: AnalysisInput = { before: [], after: [], config: {}, manifest: { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 } };
describe("killable bounded semantic analysis", () => {
  it("returns a validated result from the actual compiled worker", async () => {
    expect((await runAnalysis(input)).findings).toEqual([]);
  });
  it("enforces a deadline and cancellation while waiting for termination", async () => {
    await expect(runAnalysis(input, undefined, 1)).rejects.toThrow(/deadline/);
    const controller = new AbortController();
    const result = runAnalysis(input, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(result).rejects.toThrow(/canceled/);
  });
  it("rejects excessive input before creating a worker", async () => {
    await expect(runAnalysis({ ...input, before: Array.from({ length: 4001 }, () => ({ path: "x.ts", revision: "a", content: "" })) })).rejects.toThrow(/limits/);
  });
});
