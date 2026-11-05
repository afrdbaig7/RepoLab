import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const cli = resolve("dist/cli.js");
describe("CLI exit and output contract", () => {
  it("uses exit 2 for invalid options while help remains successful", async () => {
    await expect(run(process.execPath, [cli, "review", "--base", "HEAD", "--format", "bad"])).rejects.toMatchObject({ code: 2 });
    expect((await run(process.execPath, [cli, "--help"])).stdout).toContain("review");
  });
  it("writes a valid report before opt-in policy failure and writes partial reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-cli-report-"));
    try {
      const evaluation = JSON.parse(await readFile(resolve("../../output/evaluation.json"), "utf8"));
      const env = { ...process.env, LENS_WORKER: resolve("../../target/debug/lens-snapshot" + (process.platform === "win32" ? ".exe" : "")) };
      const reportPath = join(root, "report.json");
      const args = [cli, "review", "--repo", evaluation.repository, "--base", evaluation.commits.base, "--head", evaluation.commits.head, "--policy", "exact", "--format", "json", "--output", reportPath];
      await expect(run(process.execPath, [...args, "--fail-on-findings"], { env, timeout: 10000 })).rejects.toMatchObject({ code: 4 });
      const baseline = JSON.parse(await readFile(reportPath, "utf8"));
      expect(baseline.findings.length).toBeGreaterThan(0);
      const artifact = join(root, "artifact.json");
      await writeFile(artifact, JSON.stringify({ schemaVersion: 1, kind: "test-provenance", comparisonBase: baseline.run.comparison.comparisonBase, head: "0".repeat(40), configDigest: baseline.run.configDigest, files: {} }));
      await expect(run(process.execPath, [...args, "--test-artifact", artifact], { env, timeout: 10000 })).rejects.toMatchObject({ code: 3 });
      expect(JSON.parse(await readFile(reportPath, "utf8")).findings.some((finding: { ruleId: string }) => finding.ruleId === "EVIDENCE001")).toBe(true);
      const partialRepo = join(root, "partial-repo");
      await run("git", ["clone", "--no-local", "--quiet", evaluation.repository, partialRepo]);
      const git = async (...values: string[]) => (await run("git", ["-C", partialRepo, ...values])).stdout.trim();
      await git("config", "user.name", "Lens CLI fixture");
      await git("config", "user.email", "fixture@example.invalid");
      await git("config", "commit.gpgsign", "false");
      await writeFile(join(partialRepo, "README.md"), "Excluded context is visible\n");
      await git("add", "README.md"); await git("commit", "-m", "excluded context");
      const partialHead = await git("rev-parse", "HEAD");
      await expect(run(process.execPath, [cli, "review", "--repo", partialRepo, "--base", evaluation.commits.base, "--head", partialHead, "--policy", "exact", "--format", "json", "--output", reportPath], { env, timeout: 10000 })).rejects.toMatchObject({ code: 3 });
      expect(JSON.parse(await readFile(reportPath, "utf8")).run.completeness).toBe("partial");
      expect((await run(process.execPath, [cli, "rules"], { env })).stdout).toContain("EVIDENCE001 checks metadata");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
});
