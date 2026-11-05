import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const inside = (root, candidate) => { const path = relative(root, candidate); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const required = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const readBounded = async (path, limit) => { if ((await lstat(path)).size > limit) throw new Error("Artifact/input exceeds size limit"); return readFile(path, "utf8"); };
try {
  if (required("GITHUB_EVENT_NAME") !== "pull_request") throw new Error("Only read-only pull_request analysis is supported");
  const event = JSON.parse(await readBounded(required("GITHUB_EVENT_PATH"), 1024 * 1024));
  if (event.repository?.full_name !== required("GITHUB_REPOSITORY")) throw new Error("Event repository does not match workflow repository");
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (![base, head].every(value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value))) throw new Error("Event must contain exact base/head commit SHAs");
  const workspace = await realpath(required("GITHUB_WORKSPACE"));
  const tool = await realpath(required("LENS_TOOL_PACKAGE"));
  if (inside(workspace, tool)) throw new Error("Analyzer must be installed outside the untrusted checkout");
  const temporary = await realpath(required("RUNNER_TEMP"));
  if (inside(workspace, temporary)) throw new Error("Report directory must be outside the target checkout");
  const output = join(temporary, "lens-review");
  await mkdir(output, { recursive: true });
  const config = process.env.LENS_TRUSTED_CONFIG ? await realpath(process.env.LENS_TRUSTED_CONFIG) : undefined;
  if (config && inside(workspace, config)) throw new Error("CI configuration must come from outside the untrusted checkout");
  const env = { ...process.env };
  delete env.LENS_WORKER;
  const args = [join(tool, "dist/cli.js"), "review", "--repo", workspace, "--base", base, "--head", head, "--policy", "pr", "--format", "json", "--output", join(output, "report.json")];
  if (config) args.push("--config", config);
  try { await run(process.execPath, args, { env, timeout: 100000, maxBuffer: 65536, windowsHide: true }); }
  catch (error) { if (error.code !== 3) throw new Error("Trusted Lens engine failed; no successful analysis is claimed"); }
  const { reportSchema } = await import(pathToFileURL(join(tool, "dist/contracts.js")).href);
  const { render } = await import(pathToFileURL(join(tool, "dist/render.js")).href);
  const report = reportSchema.parse(JSON.parse(await readBounded(join(output, "report.json"), 64 * 1024 * 1024)));
  if (report.run.comparison.resolvedBase !== base || report.run.comparison.resolvedHead !== head || report.run.comparison.policy !== "pr") throw new Error("Report revisions do not match event metadata");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(output, "report.html"), render(report, "html"));
  await appendFile(required("GITHUB_STEP_SUMMARY"), render(report, "markdown"));
  const safeOutput = resolve(output).replaceAll("\\", "/");
  if (/[\r\n]/.test(safeOutput)) throw new Error("Unsafe workflow output path");
  await appendFile(required("GITHUB_OUTPUT"), `report-directory=${safeOutput}\n`);
} catch (error) {
  console.error(`Lens Action: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, " ")}`);
  process.exitCode = 2;
}
