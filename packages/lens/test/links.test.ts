import { describe, expect, it } from "vitest";
import { sourceUrl, sourceUrlPattern } from "../src/links.js";
import { compareFiles } from "../src/compare.js";
import type { Manifest } from "../src/contracts.js";

describe("revision-specific source links", () => {
  it("encodes path segments and excludes end-exclusive line starts", () => {
    const url = sourceUrl("https://github.com/owner/repo/", "a".repeat(40), "src/日本語 (x)#.ts", 2, 5, 1)!;
    expect(url).toContain("src/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28x%29%23.ts#L2-L4");
    expect(sourceUrlPattern.test(url)).toBe(true);
    for (const origin of ["javascript:alert(1)", "https://evil.invalid/o/r", "https://github.com@evil.invalid/o/r"]) expect(sourceUrl(origin, "a".repeat(40), "a.ts", 1, 1, 4)).toBeUndefined();
  });
  it("uses comparison base for removed code and resolved head for added code", () => {
    const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "c".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "pr" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
    const before = [{ path: "a.ts", revision: manifest.comparison.comparisonBase, content: "export function a(x: string) {}" }];
    const after = [{ ...before[0]!, revision: manifest.comparison.resolvedHead, content: "export function a(x?: string) {}" }];
    const report = compareFiles(before, after, manifest, { repositoryUrl: "https://github.com/owner/repo" });
    expect(report.findings[0]?.before.url).toContain(`/blob/${"a".repeat(40)}/`);
    expect(report.findings[0]?.after.url).toContain(`/blob/${"b".repeat(40)}/`);
  });
});
