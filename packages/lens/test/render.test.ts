import { describe, expect, it } from "vitest";
import { compareFiles } from "../src/compare.js";
import { display, render } from "../src/render.js";
import type { Manifest } from "../src/contracts.js";

const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
describe("report rendering", () => {
  it("escapes source HTML, terminal controls, Markdown and workflow-like text", () => {
    const before = { path: "<script>\x1b[31m.ts", revision: "a".repeat(40), content: "export function x(a: string) { return '<script>alert(1)</script>'; }" };
    const report = compareFiles([before], [{ ...before, content: "export function x(a?: string) { return '<script>alert(1)</script>'; }" }], manifest);
    report.findings[0]!.reason = "::warning:: <img onerror=x> [link](javascript:bad)\x1b[31m";
    const html = render(report, "html");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
    expect(render(report, "terminal")).not.toContain("\x1b");
    expect(render(report, "markdown")).toContain("\\[link\\]\\(javascript:bad\\)");
    expect(display("\x1b\r\n")).toBe("\\u001b\\u000d\\u000a");
    expect(JSON.parse(render(report, "json"))).toEqual(report);
  });
  it("produces identical deterministic reports for repeated input", () => {
    const file = { path: "a.ts", revision: "a".repeat(40), content: "export function a() {}" };
    expect(compareFiles([file], [file], manifest)).toEqual(compareFiles([file], [file], manifest));
  });
});
