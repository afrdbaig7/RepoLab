import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
describe("trusted Action launcher (local simulation only)", () => {
  it("uses exact event commits and refuses a tool/config from the target checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-action-"));
    try {
      const fixture = JSON.parse(await readFile(resolve("../../output/evaluation.json"), "utf8"));
      const event = join(root, "event.json");
      await writeFile(event, JSON.stringify({ repository: { full_name: "fixture/test" }, pull_request: { head: { sha: fixture.commits.head }, base: { sha: fixture.commits.base }, number: 1 } }));
      const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "fixture/test", GITHUB_WORKSPACE: fixture.repository, RUNNER_TEMP: root, LENS_TOOL_PACKAGE: resolve("."), GITHUB_STEP_SUMMARY: join(root, "summary.md"), GITHUB_OUTPUT: join(root, "outputs.txt") };
      await run(process.execPath, [resolve("../lens-action/run.mjs")], { env, timeout: 10000 });
      const report = JSON.parse(await readFile(join(root, "lens-review/report.json"), "utf8"));
      expect(report.run.comparison.resolvedHead).toBe(fixture.commits.head);
      expect(report.findings.length).toBeGreaterThan(0);
      expect(await readFile(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("Lens review");
      for (const change of [{ LENS_TOOL_PACKAGE: fixture.repository }, { LENS_TRUSTED_CONFIG: join(fixture.repository, "api.ts") }, { GITHUB_EVENT_NAME: "pull_request_target" }]) {
        await expect(run(process.execPath, [resolve("../lens-action/run.mjs")], { env: { ...env, ...change }, timeout: 10000 })).rejects.toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
