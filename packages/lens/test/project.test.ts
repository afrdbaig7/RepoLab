import { describe, expect, it } from "vitest";
import { compareFiles } from "../src/compare.js";
import { createProject } from "../src/project.js";
import { loadTrustedLibraries } from "../src/libraries.js";
import type { InputFile } from "../src/extract.js";
import type { Manifest } from "../src/contracts.js";

const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
const file = (path: string, content: string): InputFile => ({ path, content, revision: "a".repeat(40) });
describe("snapshot project context and resolved calls", () => {
  it("resolves aliases through captured modules and identifies changed direct targets", () => {
    const functions = file("helpers.ts", "export function first() { return 1; } export function second() { return 2; }");
    const before = [functions, file("api.ts", "import { first as helper } from './helpers'; export function save() { return helper(); }")];
    const after = [functions, file("api.ts", "import { second as helper } from './helpers'; export function save() { return helper(); }")];
    const report = compareFiles(before, after, manifest);
    expect(report.findings.map(item => item.ruleId)).toEqual(["CALL001"]);
    expect(report.findings[0]?.reason).toContain("helpers.ts#first");
    expect(report.findings[0]?.reason).toContain("helpers.ts#second");
  });
  it("does not report a local import alias rename as a different target", () => {
    const helper = file("helper.ts", "export function load() { return 1; }");
    const before = file("api.ts", "import { load as a } from './helper'; export function read() { return a(); }");
    const after = file("api.ts", "import { load as b } from './helper'; export function read() { return b(); }");
    expect(compareFiles([helper, before], [helper, after], manifest).findings).toEqual([]);
  });
  it("uses captured tsconfig baseUrl/paths and local extends without reading disk", () => {
    const config = file("tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"] } } }));
    const base = file("tsconfig.base.json", JSON.stringify({ compilerOptions: { module: "commonjs", moduleResolution: "node", target: "es2022" } }));
    const helpers = file("src/helpers.ts", "export function one() {} export function two() {}");
    const before = [config, base, helpers, file("api.ts", "import { one as use } from '@lib/helpers'; export function run() { use(); }")];
    const after = [config, base, helpers, file("api.ts", "import { two as use } from '@lib/helpers'; export function run() { use(); }")];
    expect(compareFiles(before, after, manifest).findings.map(item => item.ruleId)).toEqual(["CALL001"]);
  });
  it("reports outside-root extends and missing call context rather than forcing a target", () => {
    const files = [file("tsconfig.json", JSON.stringify({ extends: "../../outside.json" })), file("api.ts", "import { missing } from 'not-installed'; export function run() { missing(); }")];
    const report = compareFiles(files, files, manifest);
    expect(report.findings).toEqual([]);
    expect(report.run.completeness).toBe("partial");
    expect(report.run.diagnostics.some(item => item.code === "config-error")).toBe(true);
    expect(report.run.diagnostics.some(item => item.code === "unresolved-calls")).toBe(true);
    expect(createProject(files).program.getSourceFiles().every(source => source.fileName.startsWith("/__lens_snapshot__/"))).toBe(true);
  });
  it("reads standard declarations only from explicitly supplied trusted compiler strings", async () => {
    const libraries = await loadTrustedLibraries();
    expect(libraries.some(entry => entry.path === "lib.es2022.full.d.ts")).toBe(true);
    const files = [file("api.ts", "export function trim(value: string): string { return value.trim(); }")];
    const report = compareFiles(files, files, manifest, {}, libraries);
    expect(report.findings).toEqual([]);
    expect(report.run.diagnostics.filter(item => item.code === "unresolved-calls")).toEqual([]);
  });
  it("links a configured-path import to the actual changed symbol", () => {
    const config = file("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@api": ["api.ts"] } } }));
    const test = file("api.test.ts", "import { it } from 'vitest'; import { save as persist } from '@api'; it('x', () => { persist('x'); });");
    const before = [config, test, file("api.ts", "export function save(id: string) { return id; }")];
    const after = [config, test, file("api.ts", "export function save(id?: string) { return id; }")];
    const result = compareFiles(before, after, manifest);
    expect(result.findings[0]?.ruleId).toBe("API001");
    expect(result.findings[0]?.relatedTests[0]?.name).toBe("x");
  });
});
