import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseDocument, type Document } from "yaml";
import { z } from "zod";

export const evidenceKindSchema = z.enum(["parsed", "observed", "declared", "suggested"]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

const sourceRefSchema = z.object({
  path: z.string().min(1),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict();

export const factProvenanceSchema = z.object({
  kind: evidenceKindSchema,
  snapshotId: z.string().min(1),
  producer: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  sourceRef: sourceRefSchema.optional(),
  runId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  manifestPointer: z.string().min(1).optional(),
  resolution: z.enum(["resolved", "partial", "unresolved"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "parsed" && !value.sourceRef) ctx.addIssue({ code: "custom", message: "parsed evidence requires sourceRef", path: ["sourceRef"] });
  if (value.kind === "observed" && !value.runId) ctx.addIssue({ code: "custom", message: "observed evidence requires runId", path: ["runId"] });
  if (value.kind === "declared" && !value.manifestPointer) ctx.addIssue({ code: "custom", message: "declared evidence requires manifestPointer", path: ["manifestPointer"] });
});
export type FactProvenance = z.infer<typeof factProvenanceSchema>;

export const graphFactSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["repository", "module", "symbol", "route", "feature", "service", "scenario", "experiment", "run", "operation"]),
  label: z.string().min(1),
  sourceRef: sourceRefSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  provenance: factProvenanceSchema,
}).strict();
export type GraphFact = z.infer<typeof graphFactSchema>;

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["imports", "declares", "registers_route", "references", "may_call", "observed_child", "exercises", "asserts", "targets_dependency"]),
  provenance: factProvenanceSchema,
}).strict();
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphSchema = z.object({ nodes: z.array(graphFactSchema), edges: z.array(graphEdgeSchema) }).strict();
export type Graph = z.infer<typeof graphSchema>;

const id = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, "must start with a lowercase letter and contain lowercase letters, numbers, and hyphens");
const boundedString = (max: number) => z.string().min(1).max(max);
const pathSchema = z.string().min(1).max(240).refine((value) => !value.includes("\\") && !value.includes("\0") && !value.split("/").includes("..") && !value.startsWith("/"), "must be a repository-relative path");

const serviceSchema = z.object({
  recipe: z.enum(["node-typescript", "redis", "postgres", "http-stub"]),
  routeThroughProxy: z.boolean().default(false),
  fixture: id.optional(),
}).strict();

const entrypointSchema = z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]), path: boundedString(200) }).strict();

const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("http-status"), equals: z.number().int().min(100).max(599) }).strict(),
  z.object({ id, kind: z.literal("header-exists"), name: boundedString(128) }).strict(),
  z.object({ id, kind: z.literal("header-equals"), name: boundedString(128), equals: boundedString(2000) }).strict(),
  z.object({ id, kind: z.literal("json-path"), path: z.string().regex(/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,6}\])+$/, "must use the supported JSON-path subset"), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), exists: z.boolean().optional() }).strict().superRefine((value, ctx) => {
    if (value.equals === undefined && value.exists === undefined) ctx.addIssue({ code: "custom", message: "json-path requires equals or exists" });
    if (value.equals !== undefined && value.exists !== undefined) ctx.addIssue({ code: "custom", message: "json-path cannot set both equals and exists" });
  }),
  z.object({ id, kind: z.literal("duration-ms"), max: z.number().int().positive().max(300_000) }).strict(),
  z.object({ id, kind: z.literal("operation-occurrence"), service: id, operation: boundedString(240) }).strict(),
]);
export type Assertion = z.infer<typeof assertionSchema>;

const scenarioSchema = z.object({
  id,
  feature: id,
  reset: z.literal("fresh-environment"),
  request: z.object({ method: entrypointSchema.shape.method, path: boundedString(500), headers: z.record(z.string().max(128), z.string().max(2000)).optional(), body: z.unknown().optional() }).strict(),
  assertions: z.array(assertionSchema).min(1).max(50),
}).strict();

const faultSchema = z.object({ target: id, kind: z.enum(["unavailable", "latency", "timeout"]), latencyMs: z.number().int().min(1).max(120_000).optional(), direction: z.enum(["upstream", "downstream", "both"]).default("both") }).strict().superRefine((value, ctx) => {
  if (value.kind === "latency" && value.latencyMs === undefined) ctx.addIssue({ code: "custom", message: "latency faults require latencyMs", path: ["latencyMs"] });
  if (value.kind !== "latency" && value.latencyMs !== undefined) ctx.addIssue({ code: "custom", message: "latencyMs is only valid for latency faults", path: ["latencyMs"] });
});

const experimentSchema = z.object({ id, scenario: id, fault: faultSchema, expectedAssertions: z.array(id).max(50) }).strict();

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: boundedString(120),
  application: z.object({ service: id, recipe: z.literal("node-typescript"), entrypoint: pathSchema, healthPath: z.string().regex(/^\/[A-Za-z0-9_./-]*$/), sourceRoot: pathSchema }).strict(),
  dependencies: z.record(id, serviceSchema).refine((value) => Object.keys(value).length <= 32, "too many dependencies"),
  features: z.array(z.object({ id, title: boundedString(120), description: boundedString(1000), entrypoints: z.array(entrypointSchema).min(1).max(20), scenarios: z.array(id).min(1).max(20) }).strict()).max(100),
  scenarios: z.array(scenarioSchema).max(200),
  experiments: z.array(experimentSchema).max(200),
}).strict();
export type LabManifest = z.infer<typeof manifestSchema>;

export type ManifestValidation = { ok: true; manifest: LabManifest; normalized: string } | { ok: false; errors: Array<{ path: string; message: string }> };

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map((part) => `[${String(part)}]`).join("") : "$";
}

export function validateManifestValue(value: unknown): ManifestValidation {
  const result = manifestSchema.safeParse(value);
  if (!result.success) return { ok: false, errors: result.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })) };
  const manifest = result.data;
  const errors: Array<{ path: string; message: string }> = [];
  const features = new Set(manifest.features.map((feature) => feature.id));
  const scenarios = new Map(manifest.scenarios.map((scenario) => [scenario.id, scenario]));
  const dependencies = new Set(Object.keys(manifest.dependencies));
  const addDuplicateErrors = (items: Array<{ id: string }>, collection: string): void => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) errors.push({ path: `$.${collection}`, message: `duplicate id ${item.id}` });
      seen.add(item.id);
    }
  };
  addDuplicateErrors(manifest.features, "features");
  addDuplicateErrors(manifest.scenarios, "scenarios");
  addDuplicateErrors(manifest.experiments, "experiments");
  for (const scenario of manifest.scenarios) {
    if (!features.has(scenario.feature)) errors.push({ path: `$.scenarios[${scenario.id}].feature`, message: `unknown feature ${scenario.feature}` });
    const assertionIds = new Set<string>();
    for (const assertion of scenario.assertions) {
      if (assertionIds.has(assertion.id)) errors.push({ path: `$.scenarios[${scenario.id}].assertions`, message: `duplicate assertion id ${assertion.id}` });
      assertionIds.add(assertion.id);
      if (assertion.kind === "operation-occurrence" && !dependencies.has(assertion.service) && assertion.service !== manifest.application.service) errors.push({ path: `$.scenarios[${scenario.id}].assertions[${assertion.id}]`, message: `unknown service ${assertion.service}` });
    }
  }
  for (const feature of manifest.features) for (const scenarioId of feature.scenarios) if (!scenarios.has(scenarioId)) errors.push({ path: `$.features[${feature.id}].scenarios`, message: `unknown scenario ${scenarioId}` });
  for (const experiment of manifest.experiments) {
    const scenario = scenarios.get(experiment.scenario);
    if (!scenario) errors.push({ path: `$.experiments[${experiment.id}].scenario`, message: `unknown scenario ${experiment.scenario}` });
    if (!dependencies.has(experiment.fault.target)) errors.push({ path: `$.experiments[${experiment.id}].fault.target`, message: `fault target must be a declared dependency` });
    else if (!manifest.dependencies[experiment.fault.target]?.routeThroughProxy) errors.push({ path: `$.experiments[${experiment.id}].fault.target`, message: `fault target must route through its declared proxy` });
    for (const assertionId of experiment.expectedAssertions) if (!scenario?.assertions.some((assertion) => assertion.id === assertionId)) errors.push({ path: `$.experiments[${experiment.id}].expectedAssertions`, message: `unknown assertion ${assertionId}` });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest, normalized: JSON.stringify(manifest, Object.keys(manifest).sort()) };
}

export async function validateManifestFile(path: string): Promise<ManifestValidation> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { return { ok: false, errors: [{ path, message: error instanceof Error ? error.message : "unable to read manifest" }] }; }
  let document: Document;
  try { document = parseDocument(text, { prettyErrors: true }); } catch (error) { return { ok: false, errors: [{ path, message: error instanceof Error ? error.message : "invalid YAML" }] }; }
  if (document.errors.length) return { ok: false, errors: document.errors.map((error) => ({ path, message: error.message })) };
  return validateManifestValue(document.toJS({ maxAliasCount: 0 }));
}

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface ExecutionPlan {
  planVersion: 1;
  manifestHash: string;
  fingerprint: string;
  repositoryRoot: string;
  application: LabManifest["application"];
  dependencies: LabManifest["dependencies"];
  scenarioIds: string[];
  experimentIds: string[];
}

export function compileExecutionPlan(manifest: LabManifest, repositoryRoot: string): ExecutionPlan {
  const normalized = canonicalJson(manifest);
  const manifestHash = sha256(normalized);
  const plan = { planVersion: 1 as const, manifestHash, repositoryRoot, application: manifest.application, dependencies: manifest.dependencies, scenarioIds: manifest.scenarios.map((item) => item.id), experimentIds: manifest.experiments.map((item) => item.id) };
  return { ...plan, fingerprint: sha256(canonicalJson(plan)) };
}

export const protocolVersion = "1" as const;
export const maxProtocolFrameBytes = 1024 * 1024;

export const protocolMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("handshake"), protocolVersion: z.string(), runnerVersion: z.string(), supportedPlanVersions: z.array(z.number().int()), platform: z.string(), capabilities: z.array(z.string()) }).strict(),
  z.object({ type: z.literal("command"), command: z.enum(["capabilities", "prepare", "start", "apply_fault", "reset_faults", "collect", "cancel", "cleanup", "reconcile", "shutdown"]), requestId: z.string().min(1), runId: z.string().min(1).optional(), attemptId: z.string().min(1).optional(), planFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), payload: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ type: z.literal("event"), event: z.enum(["accepted", "phase_changed", "resource_created", "readiness", "fault_applied", "artifact_ready", "cleanup_result", "completed", "failed"]), requestId: z.string().min(1), runId: z.string().min(1).optional(), attemptId: z.string().min(1).optional(), sequence: z.string().regex(/^[0-9]+$/), payload: z.record(z.string(), z.unknown()).default({}), errorCode: z.string().optional() }).strict(),
]);
export type ProtocolMessage = z.infer<typeof protocolMessageSchema>;

export function encodeProtocolFrame(message: ProtocolMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  if (body.byteLength > maxProtocolFrameBytes) throw new Error(`protocol frame exceeds ${maxProtocolFrameBytes} bytes`);
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

export function decodeProtocolFrames(buffer: Uint8Array): { messages: ProtocolMessage[]; remainder: Uint8Array } {
  const messages: ProtocolMessage[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
    if (length > maxProtocolFrameBytes) throw new Error("protocol frame exceeds maximum size");
    if (buffer.byteLength - offset - 4 < length) break;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(offset + 4, offset + 4 + length));
    const parsed: unknown = JSON.parse(text);
    messages.push(protocolMessageSchema.parse(parsed));
    offset += 4 + length;
  }
  return { messages, remainder: buffer.slice(offset) };
}
