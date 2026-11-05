import { createHash } from "node:crypto";
import { z } from "zod";
import { repositoryUrlPattern, sourceUrlPattern } from "./links.js";

export const version = "0.1.0";
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const rules = {
  API001: "Exported function parameter structure changed",
  API002: "Explicit return annotation changed (textual comparison)",
  TYPE001: "Exported interface field became optional",
  GUARD001: "Configured guard call absent from matched function",
  TEST001: "Assertion added, removed or edited in matched test",
  TEST002: "Matched test became skipped or todo",
  CALL001: "Supported resolved local direct-call target set changed",
  EVIDENCE001: "Supplied test-artifact metadata does not match this run",
} as const;
export const configSchema = z.object({ schemaVersion: z.literal(1).default(1), guards: z.array(z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/)).max(50).default([]), repositoryUrl: z.string().regex(repositoryUrlPattern).optional() }).strict();
export type Config = z.infer<typeof configSchema>;
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const path = z.string().min(1).max(1000).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === "." || part === "") && !/^[A-Za-z]:/.test(value), "unsafe repository path");
export const evidenceSchema = z.object({ revision: z.string().min(1), path, startLine: z.number().int().positive(), startColumn: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive(), excerpt: z.string().max(12000), method: z.enum(["typescript-ast", "supplied-artifact", "derived-run-context"]), fileDigest: z.string().regex(/^[a-f0-9]{64}$/), url: z.string().regex(sourceUrlPattern).optional() }).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const symbolSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["function", "interface", "test"]), source: evidenceSchema, matching: z.enum(["exact-path-and-name", "identical-blob-rename"]) }).strict();
export const changeSchema = z.object({ id: z.string(), kind: z.string(), symbol: z.string(), before: evidenceSchema, after: evidenceSchema, ambiguity: z.string().nullable() }).strict();
export const findingSchema = z.object({ id: z.string(), symbol: z.string(), ruleId: z.enum(["API001", "API002", "TYPE001", "GUARD001", "TEST001", "TEST002", "CALL001", "EVIDENCE001"]), priority: z.enum(["high", "medium", "low"]), strength: z.enum(["structural", "heuristic"]), reason: z.string(), before: evidenceSchema, after: evidenceSchema, relatedTests: z.array(z.object({ name: z.string(), method: z.literal("static-import-reference"), before: evidenceSchema, after: evidenceSchema, changes: z.array(z.string()) }).strict()), limitations: z.array(z.string()), next: z.string() }).strict();
export const comparisonSchema = z.object({ requestedBase: z.string().min(1).max(1000), requestedHead: z.string().min(1).max(1000), resolvedBase: sha, resolvedHead: sha, comparisonBase: sha, policy: z.enum(["pr", "exact"]) }).strict();
export const diagnosticSchema = z.object({ code: z.string(), stage: z.string(), message: z.string(), path: z.string().optional() }).strict();
export const reportSchema = z.object({ schemaVersion: z.literal(1), run: z.object({ toolVersion: z.literal(version), compilerVersion: z.literal("5.8.3"), configDigest: z.string(), comparison: comparisonSchema, completeness: z.enum(["complete-within-supported-syntax", "partial"]), diagnostics: z.array(diagnosticSchema), unresolvedCalls: z.number().int().nonnegative(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict(), symbols: z.array(symbolSchema), changes: z.array(changeSchema), findings: z.array(findingSchema), limitations: z.array(z.string()) }).strict();
export type Report = z.infer<typeof reportSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export const fileSchema = z.object({ path, digest: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(1048576), storage: z.string().regex(/^[a-f0-9]{64}\.txt$/) }).strict();
export const manifestSchema = z.object({ schemaVersion: z.literal(1), comparison: comparisonSchema, before: z.array(fileSchema).max(4000), after: z.array(fileSchema).max(4000), diagnostics: z.array(diagnosticSchema), totalBytes: z.number().int().min(0).max(33554432) }).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export const requestSchema = z.object({ protocolVersion: z.literal(1), id: z.string().regex(/^[a-f0-9-]{36}$/), operation: z.literal("snapshot"), repo: z.string().min(1).max(4000), git: z.string().min(1).max(4000), output: z.string().min(1).max(4000), base: z.string().min(1).max(1000), head: z.string().min(1).max(1000), policy: z.enum(["pr", "exact"]) }).strict();
export const responseSchema = z.discriminatedUnion("type", [
  z.object({ protocolVersion: z.literal(1), id: z.string(), type: z.literal("result"), manifest: manifestSchema, complete: z.literal(true) }).strict(),
  z.object({ protocolVersion: z.literal(1), id: z.string(), type: z.literal("error"), code: z.string(), stage: z.string(), message: z.string(), retryable: z.literal(false), complete: z.literal(true) }).strict(),
]);
