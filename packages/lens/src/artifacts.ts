import { z } from "zod";
import { digest, reportSchema, type Evidence, type Report } from "./contracts.js";
import type { InputFile } from "./extract.js";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const testArtifactSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("test-provenance"),
  comparisonBase: sha, head: sha, configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(z.string().min(1).max(1000), z.string().regex(/^[a-f0-9]{64}$/))
    .refine(value => Object.keys(value).length <= 4000, "too many file digests"),
}).strict();

export function expectedArtifact(report: Report, files: InputFile[]): z.infer<typeof testArtifactSchema> {
  return {
    schemaVersion: 1, kind: "test-provenance",
    comparisonBase: report.run.comparison.comparisonBase,
    head: report.run.comparison.resolvedHead, configDigest: report.run.configDigest,
    files: Object.fromEntries([...files].sort((a, b) => a.path.localeCompare(b.path, "en")).map(file => [file.path, digest(file.content)])),
  };
}

export function attachTestArtifact(report: Report, content: string, files: InputFile[]): Report {
  if (Buffer.byteLength(content) > 65536) throw new Error("Test provenance artifact exceeds 64 KiB");
  const supplied = testArtifactSchema.parse(JSON.parse(content));
  const expected = expectedArtifact(report, files);
  const mismatches: string[] = (["comparisonBase", "head", "configDigest"] as const)
    .filter(key => supplied[key] !== expected[key]);
  if (JSON.stringify(Object.entries(supplied.files).sort()) !== JSON.stringify(Object.entries(expected.files).sort())) mismatches.push("files");
  const result = structuredClone(report);
  result.run.completeness = "partial";
  result.run.diagnostics.push({ code: mismatches.length ? "artifact-mismatch" : "artifact-unverified", stage: "artifact", message: mismatches.length ? `Supplied test metadata mismatch: ${mismatches.join(", ")}; excluded from trusted associations.` : "Metadata is consistent, but producer/workflow origin is unauthenticated. Artifact is excluded from trusted associations." });
  if (mismatches.length) {
    const reference = (text: string, method: "supplied-artifact" | "derived-run-context"): Evidence => {
      const lines = text.split(/\r\n|\n/);
      return { revision: method, path: `${method}/test-provenance.json`, startLine: 1, startColumn: 1, endLine: lines.length, endColumn: lines.at(-1)!.length + 1, excerpt: text.slice(0, 12000), method, fileDigest: digest(text) };
    };
    const before = reference(content, "supplied-artifact");
    const after = reference(JSON.stringify(expected, null, 2), "derived-run-context");
    const identity = digest(`${before.fileDigest}\0${after.fileDigest}`).slice(0, 24);
    result.findings.push({ id: `finding:${identity}`, symbol: "artifact:test-provenance", ruleId: "EVIDENCE001", priority: "medium", strength: "structural", reason: `Supplied test-artifact metadata differs from this run: ${mismatches.join(", ")}.`, before, after, relatedTests: [], limitations: ["Matching metadata would not authenticate a producer/workflow or establish per-test attribution. No coverage/test-artifact association is trusted."], next: "Regenerate the artifact against the recorded commits/configuration and authenticate its origin separately before relying on it." });
    result.changes.push({ id: `change:${identity}`, symbol: "artifact:test-provenance", kind: "artifact-provenance-mismatch", before, after, ambiguity: "Metadata comparison does not authenticate artifact origin." });
  }
  result.findings.sort((a, b) => a.id.localeCompare(b.id, "en"));
  result.changes.sort((a, b) => a.id.localeCompare(b.id, "en"));
  result.run.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  return reportSchema.parse(result);
}
