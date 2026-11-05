import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../src/snapshot.js";
import { compareFiles } from "../src/compare.js";

const run = promisify(execFile);
const worker = resolve("../../target/debug/lens-snapshot" + (process.platform === "win32" ? ".exe" : ""));
const roots: string[] = [];
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "lens-git-"));
  roots.push(root);
  const git = async (...args: string[]) => (await run("git", ["-C", root, ...args], { timeout: 10000 })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Lens fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.autocrlf", "false");
  return { root, git, commit: async (message: string) => { await git("add", "."); await git("commit", "-m", message); return git("rev-parse", "HEAD"); } };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("real Rust immutable Git worker", () => {
  it("reads committed blobs, preserves dirty source, and reports actual revisions", async () => {
    const repo = await repository();
    const path = join(repo.root, "日本語 with space.ts");
    await writeFile(path, "\uFEFF// 🧭\r\nexport function load(id: string): string { return id; }\r\n");
    const base = await repo.commit("required");
    await writeFile(path, "// 🧭\r\nexport function load(id?: string): string { return id ?? ''; }\r\n");
    const head = await repo.commit("optional");
    await writeFile(path, "this dirty file must not be analyzed");
    const status = await repo.git("status", "--porcelain");
    const result = await capture(repo.root, base, head, "exact", undefined, worker);
    expect(result.manifest.comparison).toMatchObject({ resolvedBase: base, resolvedHead: head, comparisonBase: base, policy: "exact" });
    const report = compareFiles(result.before, result.after, result.manifest);
    expect(report.findings.map(item => item.ruleId)).toEqual(["API001"]);
    expect(report.findings[0]?.before).toMatchObject({ path: "日本語 with space.ts", startLine: 2 });
    expect(result.before[0]?.content.charCodeAt(0)).toBe(0xfeff);
    expect(report.findings[0]?.before.fileDigest).toBe(result.manifest.before[0]?.digest);
    expect(await repo.git("status", "--porcelain")).toBe(status);
    expect(await readFile(path, "utf8")).toBe("this dirty file must not be analyzed");
  });
  it("distinguishes PR merge-base from exact base on divergent history", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "api.ts"), "export function load(id: string) {}\n");
    const ancestor = await repo.commit("ancestor");
    await repo.git("checkout", "-b", "feature");
    await writeFile(join(repo.root, "api.ts"), "export function load(id?: string) {}\n");
    const head = await repo.commit("feature");
    await repo.git("checkout", "main");
    await writeFile(join(repo.root, "api.ts"), "export function load(id?: string) {}\n");
    const base = await repo.commit("base tip");
    const pr = await capture(repo.root, base, head, "pr", undefined, worker);
    const exact = await capture(repo.root, base, head, "exact", undefined, worker);
    expect(pr.manifest.comparison.comparisonBase).toBe(ancestor);
    expect(exact.manifest.comparison.comparisonBase).toBe(base);
    expect(compareFiles(pr.before, pr.after, pr.manifest).findings).toHaveLength(1);
    expect(compareFiles(exact.before, exact.after, exact.manifest).findings).toEqual([]);
  });
  it("handles addition/deletion/identical rename and visibly excludes unsupported files", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "old.ts"), "export function old() {}\n");
    await writeFile(join(repo.root, "delete.ts"), "export function gone() {}\n");
    await writeFile(join(repo.root, "README.md"), "not TypeScript");
    const base = await repo.commit("before");
    await repo.git("mv", "old.ts", "renamed.ts");
    await repo.git("rm", "delete.ts");
    await writeFile(join(repo.root, "new.ts"), "export function added() {}\n");
    const head = await repo.commit("after");
    const result = await capture(repo.root, base, head, "exact", undefined, worker);
    const report = compareFiles(result.before, result.after, result.manifest);
    expect(report.symbols.find(item => item.name === "old")?.matching).toBe("identical-blob-rename");
    expect(report.run.diagnostics.some(item => item.code === "unsupported-file")).toBe(true);
    expect(report.run.diagnostics.some(item => item.path === "delete.ts" && item.code === "unmatched-file")).toBe(true);
    expect(report.run.completeness).toBe("partial");
  });
  it("fails for missing history or option-looking refs rather than returning zero findings", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
    await repo.commit("base");
    for (const base of ["missing", "--all"]) await expect(capture(repo.root, base, "HEAD", "pr", undefined, worker)).rejects.toThrow(/snapshot_failed/);
  });
  it("captures project configuration and resolves path-aliased calls across revisions", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@helpers": ["helpers.ts"] } } }));
    await writeFile(join(repo.root, "helpers.ts"), "export function one() {} export function two() {}\n");
    await writeFile(join(repo.root, "api.ts"), "import { one as use } from '@helpers'; export function run() { use(); }\n");
    const base = await repo.commit("project before");
    await writeFile(join(repo.root, "api.ts"), "import { two as use } from '@helpers'; export function run() { use(); }\n");
    const head = await repo.commit("project after");
    const result = await capture(repo.root, base, head, "exact", undefined, worker);
    expect(result.before.some(entry => entry.path === "tsconfig.json")).toBe(true);
    expect(compareFiles(result.before, result.after, result.manifest).findings.map(item => item.ruleId)).toEqual(["CALL001"]);
  });
  it("does not silently fetch missing shallow history", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
    const base = await repo.commit("ancestor");
    await writeFile(join(repo.root, "api.ts"), "export function a(x?: string) {}\n");
    await repo.commit("tip");
    const shallow = join(repo.root, "shallow-clone");
    await run("git", ["clone", "--depth", "1", "--no-local", "--quiet", repo.root, shallow]);
    await expect(capture(shallow, base, "HEAD", "pr", undefined, worker)).rejects.toThrow(/snapshot_failed/);
  });
  it("classifies Git symlink/submodule, binary and LFS entries without materializing them", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
    const base = await repo.commit("base");
    const blob = execFileSync("git", ["-C", repo.root, "hash-object", "-w", "--stdin"], { input: "api.ts" }).toString().trim();
    execFileSync("git", ["-C", repo.root, "update-index", "-z", "--index-info"], { input: `120000 blob ${blob}\tlink.ts\0` + `160000 commit ${base}\tsubmodule\0` });
    await writeFile(join(repo.root, "binary.ts"), Buffer.from([0, 1, 2]));
    await writeFile(join(repo.root, "lfs.ts"), "version https://git-lfs.github.com/spec/v1\noid sha256:example\nsize 1\n");
    await repo.git("add", "binary.ts", "lfs.ts");
    const tree = await repo.git("write-tree");
    const head = await repo.git("commit-tree", tree, "-p", base, "-m", "unsupported modes");
    const result = await capture(repo.root, base, head, "exact", undefined, worker);
    expect(result.manifest.diagnostics.map(entry => entry.code).sort()).toEqual(["submodule", "symlink", "unsupported-content", "unsupported-content"]);
    expect(result.after.map(entry => entry.path)).toEqual(["api.ts"]);
  });
  it("rejects a non-UTF-8 historical Git path without silently replacing characters", async () => {
    const repo = await repository();
    await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
    const base = await repo.commit("base");
    const blob = execFileSync("git", ["-C", repo.root, "hash-object", "-w", "--stdin"], { input: "export function x() {}" }).toString().trim();
    const index = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff]), Buffer.from(".ts\0")]);
    execFileSync("git", ["-C", repo.root, "update-index", "-z", "--index-info"], { input: index });
    const tree = await repo.git("write-tree");
    const head = await repo.git("commit-tree", tree, "-p", base, "-m", "invalid path encoding");
    await expect(capture(repo.root, base, head, "exact", undefined, worker)).rejects.toThrow(/non-UTF-8 Git paths/);
  });
});
