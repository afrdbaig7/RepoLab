import { describe, expect, it } from "vitest";
import { exportHtmlReport } from "../src/index.js";

describe("offline reports", () => {
  it("escapes repository text and emits a stable checksum without remote assets", () => {
    const result = exportHtmlReport({ title: "<lab>", repository: "C:\\private\\repo", snapshotId: "snapshot", generatedAt: "2026-11-03T00:00:00Z", scenario: { id: "check", request: { method: "GET", path: "/health" }, assertions: [{ id: "x", outcome: "passed", message: "<script>alert(1)</script>", observed: "ok" }] }, graph: { nodes: [], edges: [] }, evidence: { complete: false }, sourceMetadata: {}, limitations: ["runtime evidence was partial"] });
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).not.toContain("<script>alert(1)</script>");
    expect(result.html).not.toContain("https://");
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
