#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { configSchema, rules, version } from "./contracts.js";
import { display, render } from "./render.js";
import { capture, verifyPackagedWorker, workerPath } from "./snapshot.js";
import { runAnalysis } from "./analysis.js";
import { readBoundedText } from "./io.js";
import { resolveTrustedGit } from "./trusted-git.js";

const program = new Command().name("lens").description("Evidence-backed static TypeScript revision review").version(version).exitOverride();
program.configureOutput({ outputError: (message, write) => write(`${display(message.trimEnd())}\n`) });
const choose = <T extends string>(options: readonly T[]) => (value: string): T => {
  if (!options.includes(value as T)) throw new InvalidArgumentError(`Choose ${options.join(", ")}`);
  return value as T;
};
program.command("rules").description("List implemented rules and their limits").action(() => {
  for (const [id, title] of Object.entries(rules)) console.log(`${id} ${title}`);
  console.log("Guard names: text-only heuristic. CALL001 requires resolved local targets. EVIDENCE001 checks metadata, never authenticates artifact origin.");
});
program.command("doctor").description("Check Node, Git and the trusted worker without changing the system").action(async () => {
  const check = async (binary: string, args: string[]): Promise<string> => {
    try { return (await promisify(execFile)(binary, args, { timeout: 5000, maxBuffer: 65536, windowsHide: true })).stdout.trim(); }
    catch { return "unavailable (build/install a compatible trusted worker; see package README)"; }
  };
  let integrity = true;
  try { await verifyPackagedWorker(); } catch { integrity = false; }
  const worker = integrity ? await check(workerPath(), ["--version"]) : "packaged worker integrity failed";
  let git = "unavailable: install Git in a trusted directory outside source checkouts";
  try { git = await check(await resolveTrustedGit(process.cwd()), ["--version"]); } catch { /* diagnostic below */ }
  const compiler = (await import("typescript")).default.version;
  const ready = /^v24\./.test(process.version) && compiler === "5.8.3" && worker === "lens-snapshot 0.1.0 protocol=1" && git.startsWith("git version ");
  console.log(JSON.stringify({ node: process.version, supportedNode: "24.x", compiler, platform: `${process.platform}-${process.arch}`, git, worker: display(worker), ready }, null, 2));
  if (!ready) process.exitCode = 2;
});
program.command("review").description("Compare immutable Git commits; never fetch or execute target code")
  .requiredOption("--base <ref>", "requested base commit/ref")
  .option("--head <ref>", "requested head commit/ref", "HEAD")
  .option("--repo <path>", "repository directory", ".")
  .option("--policy <policy>", "pr uses merge-base; exact uses base tip", choose(["pr", "exact"] as const), "pr")
  .option("--format <format>", "report format", choose(["terminal", "json", "html", "markdown"] as const), "terminal")
  .option("--output <path>", "atomic output file (parent must exist)")
  .option("--config <path>", "explicit trusted local JSON config, never loaded from the PR")
  .option("--test-artifact <path>", "bounded supplied test-provenance JSON (never trusted solely by its claims)")
  .option("--quiet", "suppress terminal report when no output is requested")
  .option("--verbose", "print stage time and counts to stderr")
  .option("--fail-on-findings", "opt-in policy exit 4")
  .action(async (options: { base: string; head: string; repo: string; policy: "pr" | "exact"; format: "terminal" | "json" | "html" | "markdown"; output?: string; config?: string; testArtifact?: string; quiet?: boolean; verbose?: boolean; failOnFindings?: boolean }) => {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const started = performance.now();
    try {
      let config: unknown = {};
      if (options.config) {
        config = JSON.parse(await readBoundedText(options.config, 65536));
      }
      const validated = configSchema.parse(config);
      const snapshot = await capture(options.repo, options.base, options.head, options.policy, controller.signal);
      let artifact: string | undefined;
      if (options.testArtifact) {
        artifact = await readBoundedText(options.testArtifact, 65536);
      }
      const report = await runAnalysis({ before: snapshot.before, after: snapshot.after, manifest: snapshot.manifest, config: validated, ...(artifact === undefined ? {} : { artifact }) }, controller.signal);
      controller.signal.throwIfAborted();
      const content = render(report, options.format);
      if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("Rendered report exceeds 64 MiB; reduce comparison scope");
      if (options.output) {
        const destination = resolve(options.output);
        const temporary = `${destination}.lens-${randomUUID()}`;
        try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, destination); }
        finally { await rm(temporary, { force: true }); }
      } else if (!options.quiet) process.stdout.write(content);
      if (options.verbose) console.error(`Lens: ${Math.round(performance.now() - started)}ms; ${report.run.files} files; ${report.run.bytes} bytes; ${report.run.completeness}`);
      process.exitCode = options.failOnFindings && report.findings.length ? 4 : report.run.completeness === "partial" ? 3 : 0;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  });
try { await program.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode === 0 ? 0 : 2;
  else { console.error(`Lens: ${display(error instanceof Error ? error.message : String(error))}`); process.exitCode = 2; }
}
