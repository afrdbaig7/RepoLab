import type { Assertion } from "@repolab/contracts";

export type AssertionOutcome = "passed" | "failed" | "inconclusive";

export interface AssertionResult {
  assertionId: string;
  outcome: AssertionOutcome;
  message: string;
  observed?: unknown;
}

export interface HttpObservation {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  durationMs: number;
  evidenceComplete: boolean;
  operations?: Array<{ service: string; operation: string }>;
}

export interface JsonPathResult { found: boolean; value?: unknown; }

function parsePath(path: string): Array<string | number> {
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,6}\])+$/.test(path)) throw new Error("unsupported JSON path");
  const tokens: Array<string | number> = [];
  const tokenPattern = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d{1,6})\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(path)) !== null) tokens.push(match[1] ?? Number(match[2]));
  return tokens;
}

export function readJsonPath(value: unknown, path: string): JsonPathResult {
  let current: unknown = value;
  for (const token of parsePath(path)) {
    if (typeof token === "string" && current !== null && typeof current === "object" && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, token)) current = (current as Record<string, unknown>)[token];
    else if (typeof token === "number" && Array.isArray(current) && token < current.length) current = current[token];
    else return { found: false };
  }
  return { found: true, value: current };
}

function headerValue(headers: HttpObservation["headers"], name: string): string | string[] | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function equalValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

export function evaluateAssertions(assertions: readonly Assertion[], observation: HttpObservation): AssertionResult[] {
  return assertions.map((assertion): AssertionResult => {
    switch (assertion.kind) {
      case "http-status":
        return assertionResult(assertion.id, observation.status === assertion.equals, `expected HTTP ${assertion.equals}, observed HTTP ${observation.status}`, observation.status);
      case "header-exists": {
        const value = headerValue(observation.headers, assertion.name);
        return assertionResult(assertion.id, value !== undefined, `expected header ${assertion.name} to exist`, value);
      }
      case "header-equals": {
        const value = headerValue(observation.headers, assertion.name);
        const observed = Array.isArray(value) ? value.join(", ") : value;
        return assertionResult(assertion.id, observed === assertion.equals, `expected header ${assertion.name} to equal ${assertion.equals}`, observed);
      }
      case "duration-ms":
        return assertionResult(assertion.id, observation.durationMs <= assertion.max, `expected duration <= ${assertion.max}ms, observed ${observation.durationMs}ms`, observation.durationMs);
      case "json-path": {
        if (observation.body === undefined) return { assertionId: assertion.id, outcome: "inconclusive", message: "response body was not collected" };
        let parsed: unknown;
        try { parsed = JSON.parse(observation.body); } catch { return { assertionId: assertion.id, outcome: "inconclusive", message: "response body was not valid JSON" }; }
        let result: JsonPathResult;
        try { result = readJsonPath(parsed, assertion.path); } catch (error) { return { assertionId: assertion.id, outcome: "inconclusive", message: error instanceof Error ? error.message : "unsupported JSON path" }; }
        const passed = assertion.exists !== undefined ? result.found === assertion.exists : result.found && equalValue(result.value, assertion.equals);
        return assertionResult(assertion.id, passed, result.found ? `observed ${JSON.stringify(result.value)}` : `JSON path ${assertion.path} was not found`, result.value);
      }
      case "operation-occurrence": {
        if (!observation.evidenceComplete) return { assertionId: assertion.id, outcome: "inconclusive", message: "operation assertion requires complete runtime evidence" };
        const found = observation.operations?.some((operation) => operation.service === assertion.service && operation.operation === assertion.operation) ?? false;
        return assertionResult(assertion.id, found, `expected operation ${assertion.service}:${assertion.operation} to occur`, found);
      }
    }
  });
}

function assertionResult(assertionId: string, passed: boolean, message: string, observed: unknown): AssertionResult {
  return { assertionId, outcome: passed ? "passed" : "failed", message, observed };
}

export function summarizeAssertions(results: readonly AssertionResult[]): { passed: boolean; incomplete: boolean; failed: number; inconclusive: number } {
  return { passed: results.every((result) => result.outcome === "passed"), incomplete: results.some((result) => result.outcome === "inconclusive"), failed: results.filter((result) => result.outcome === "failed").length, inconclusive: results.filter((result) => result.outcome === "inconclusive").length };
}
