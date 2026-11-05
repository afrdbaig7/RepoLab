import { describe, expect, it } from "vitest";
import { compareFiles } from "../src/compare.js";
import { extract } from "../src/extract.js";
import type { InputFile } from "../src/extract.js";
import type { Manifest } from "../src/contracts.js";

export const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "base", requestedHead: "head", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
function file(content: string, path = "api.ts", revision = "a".repeat(40)): InputFile { return { content, path, revision }; }
function compare(before: string, after: string) { return compareFiles([file(before)], [file(after, "api.ts", "b".repeat(40))], manifest); }

describe("signature fixture vertical slice", () => {
  it("detects a required parameter becoming optional with exact UTF-16 coordinates", () => {
    const report = compare("// Unicode: 🧭\r\nexport function load(id: string): string { return id; }", "// Unicode: 🧭\r\nexport function load(id?: string): string { return id ?? ''; }");
    expect(report.findings.map(item => item.ruleId)).toEqual(["API001"]);
    expect(report.findings[0]?.before).toMatchObject({ path: "api.ts", startLine: 2, startColumn: 1, revision: "a".repeat(40) });
    expect(report.findings[0]?.after.excerpt).toContain("id?: string");
  });
  it("does not report body-only edits or unchanged code", () => {
    expect(compare("export function load(id: string): string { return id; }", "export function load(id: string): string { return id.trim(); }").findings).toEqual([]);
    expect(compare("export function a() {}", "export function a() {}").findings).toEqual([]);
  });
  it("records unsupported and malformed input rather than fabricating comparisons", () => {
    for (const source of ["export const load = () => 1;", "export function load<T>(id: T): T { return id; }", "export function load( {"]) {
      const report = compare(source, source);
      expect(report.findings).toEqual([]);
      expect(report.run.completeness).toBe("partial");
      expect(report.run.diagnostics.length).toBeGreaterThan(0);
    }
  });
  it("supports explicit returns and required interface fields", () => {
    const report = compare("export function a(): string { return ''; } export interface User { id: string; }", "export function a(): number { return 1; } export interface User { id?: string; }");
    expect(report.findings.map(item => item.ruleId).sort()).toEqual(["API002", "TYPE001"]);
  });
  it("pairs a missing guard and changed assertion using an aliased import", () => {
    const before = [file("export function save() { own(); return 1; }"), file("import { it, expect } from 'vitest'; import { save as persist } from './api'; it('rejects', () => { expect(persist()).toThrow(); });", "api.test.ts")];
    const after = [file("export function save() { return 1; }"), file("import { it, expect } from 'vitest'; import { save as persist } from './api'; it.skip('rejects', () => { persist(); });", "api.test.ts")];
    const report = compareFiles(before, after, manifest, { guards: ["own"] });
    expect(report.findings.map(item => item.ruleId).sort()).toEqual(["GUARD001", "TEST001", "TEST002"]);
    const guard = report.findings.find(item => item.ruleId === "GUARD001")!;
    expect(guard.strength).toBe("heuristic");
    expect(guard.before.excerpt).toBe("own()");
    expect(guard.symbol).toBe("api.ts#save");
    expect(guard.relatedTests[0]).toMatchObject({ name: "rejects", method: "static-import-reference" });
    expect(guard.relatedTests[0]?.changes).toHaveLength(2);
  });
  it("does not treat nested helper guard calls as function protection", () => {
    const facts = extract(file("export function save() { const helper = () => own(); }"), ["own"]);
    expect([...facts.functions[0]!.guards]).toEqual([]);
  });
  it("does not match duplicate tests or execute arbitrary expect names", () => {
    const source = "function expect(x: number) { return x; } test('x', () => { expect(1); });";
    expect(extract(file(source), []).tests).toEqual([]);
    const duplicate = "import { it, expect } from 'vitest'; it('x', () => { expect(1).toBe(1); }); it('x', () => { expect(2).toBe(2); });";
    expect(compare(duplicate, duplicate).run.diagnostics.some(item => item.code === "ambiguous-test")).toBe(true);
  });
  it("preserves guards/assertions moved within their matched scope", () => {
    const before = "export function save() { own(); const x = 1; return x; }";
    const after = "export function save() { const x = 1; own(); return x; }";
    expect(compareFiles([file(before)], [file(after)], manifest, { guards: ["own"] }).findings).toEqual([]);
    expect(compareFiles([file("export function x() { auth.own(); }")], [file("export function x() { auth . own(); }")], manifest, { guards: ["auth.own"] }).findings).toEqual([]);
    const test = "import { it, expect } from 'vitest'; it('a', () => { expect(1).toBe(1); });";
    expect(compare(test, test.replace("expect(1)", "const moved = 1; expect(1)")).findings).toEqual([]);
  });
  it("does not establish test relationships through shadowed import names", () => {
    const before = [file("export function save() { own(); }"), file("import { it } from 'vitest'; import { save } from './api'; it('x', () => { const save = () => 1; save(); });", "api.test.ts")];
    const after = [{ ...before[0]!, content: "export function save() {}" }, before[1]!];
    const report = compareFiles(before, after, manifest, { guards: ["own"] });
    expect(report.findings.find(item => item.ruleId === "GUARD001")?.relatedTests).toEqual([]);
  });
  it("labels assertion edits/additions and explicitly excludes unsupported matchers", () => {
    const baseline = "import { it, expect } from 'vitest'; it('x', () => { expect(1).toBe(1); });";
    expect(compare(baseline, baseline.replace("toBe(1)", "toBe(2)")).findings[0]?.reason).toContain("edited");
    expect(compare(baseline, baseline.replace("expect(1).toBe(1);", "expect(1).toBe(1); expect(2).toEqual(2);")).findings[0]?.reason).toContain("added");
    expect(compare(baseline, baseline.replace("toBe(1)", "customMatcher(1)")).run.diagnostics.some(item => item.code === "unsupported-assertion")).toBe(true);
  });
  it("detects todo while unchanged optional fields/defaults remain negative", () => {
    const baseline = "import { it, expect } from 'vitest'; it('x', () => { expect(1).toBe(1); });";
    expect(compare(baseline, "import { it } from 'vitest'; it.todo('x');").findings.map(item => item.ruleId).sort()).toEqual(["TEST001", "TEST002"]);
    const unchanged = "export interface X { id?: string; } export function a(x = 1) { return x; }";
    expect(compare(unchanged, unchanged).findings).toEqual([]);
  });
  it("marks each/conditional/dynamic-suite forms unsupported instead of silently empty", () => {
    for (const source of ["it.each([1])('x', () => {});", "it.skipIf(true)('x', () => {});", "it(name, () => {});", "describe.skip('suite', () => { it('x', () => {}); });"]) {
      const input = "import { it, describe } from 'vitest'; " + source;
      const report = compare(input, input);
      expect(report.run.completeness).toBe("partial");
      expect(report.run.diagnostics.some(item => item.code === "unsupported-test")).toBe(true);
      expect(report.findings).toEqual([]);
    }
  });
});
