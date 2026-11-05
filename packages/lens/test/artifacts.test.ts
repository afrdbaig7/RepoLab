import { describe, expect, it } from "vitest";
import { attachTestArtifact, expectedArtifact } from "../src/artifacts.js";
import { compareFiles } from "../src/compare.js";
import { render } from "../src/render.js";
import type { Manifest } from "../src/contracts.js";

const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
const files = [{ path: "api.ts", content: "export function a() {}", revision: "b".repeat(40) }];
const report = () => compareFiles(files, files, manifest);
describe("supplied test-artifact provenance", () => {
  it.each(["head", "comparisonBase", "configDigest", "files"])("excludes mismatched %s metadata with exact labeled artifact evidence", field => {
    const baseline = report();
    const artifact = expectedArtifact(baseline, files);
    if (field === "files") artifact.files = {};
    else artifact[field as "head"] = "0".repeat(field === "configDigest" ? 64 : 40);
    const content = JSON.stringify(artifact, null, 2);
    const result = attachTestArtifact(baseline, content, files);
    expect(result.findings.map(item => item.ruleId)).toEqual(["EVIDENCE001"]);
    expect(result.findings[0]?.before).toMatchObject({ method: "supplied-artifact", excerpt: content });
    expect(result.findings[0]?.after.method).toBe("derived-run-context");
    expect(result.run.completeness).toBe("partial");
    expect(render(result, "terminal")).toContain("[supplied-artifact]");
  });
  it("does not treat self-consistent claims as authenticated origin or per-test coverage", () => {
    const baseline = report();
    const result = attachTestArtifact(baseline, JSON.stringify(expectedArtifact(baseline, files)), files);
    expect(result.findings).toEqual([]);
    expect(result.run.diagnostics.some(item => item.code === "artifact-unverified")).toBe(true);
    expect(result.run.completeness).toBe("partial");
    expect(baseline.run.diagnostics).toEqual([]);
  });
  it("rejects malformed, oversized and wrong-version artifacts without an invented successful report", () => {
    for (const content of ["{", "x".repeat(65537), JSON.stringify({ ...expectedArtifact(report(), files), schemaVersion: 2 })]) expect(() => attachTestArtifact(report(), content, files)).toThrow();
  });
});
