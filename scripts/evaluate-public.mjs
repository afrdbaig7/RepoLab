import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { cpus, release, totalmem } from "node:os";
import { capture } from "../packages/lens/dist/snapshot.js";
import { runAnalysis } from "../packages/lens/dist/analysis.js";
import { render } from "../packages/lens/dist/render.js";
import { rules } from "../packages/lens/dist/contracts.js";

const specification = JSON.parse(await readFile("benchmarks/public-prs.json", "utf8"));
const repo = resolve(process.argv[2] ?? "tmp/evaluation/hono.git");
const worker = resolve(`target/debug/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`);
const run = promisify(execFile);
const results = [];
for (const entry of specification.cases) {
  const directory = resolve("output/public-evaluation", entry.id);
  await mkdir(directory, { recursive: true });
  const license = (await run("git", ["-C", repo, "show", `${entry.head}:LICENSE`], { timeout: 10000, maxBuffer: 65536 })).stdout;
  await writeFile(join(directory, "LICENSE"), license);
  const started = performance.now();
  const snapshot = await capture(repo, entry.base, entry.head, "exact", undefined, worker);
  const captured = performance.now();
  const report = await runAnalysis({ before: snapshot.before, after: snapshot.after, manifest: snapshot.manifest, config: {} });
  const analyzed = performance.now();
  const detected = report.findings.map(finding => finding.ruleId).sort();
  const matchesLabel = JSON.stringify(detected) === JSON.stringify([...entry.expectedRules].sort());
  await writeFile(join(directory, "report.json"), render(report, "json"));
  await writeFile(join(directory, "report.html"), render(report, "html"));
  const linkedEvidence = report.findings.flatMap(finding => [finding.before, finding.after]).filter(evidence => evidence.method === "typescript-ast");
  let correctEvidence = 0;
  for (const evidence of linkedEvidence) {
    const source = [...snapshot.before, ...snapshot.after].find(file => file.revision === evidence.revision && file.path === evidence.path);
    if (source && source.content.split(/\r\n|\n/)[evidence.startLine - 1]?.includes(evidence.excerpt.split(/\r\n|\n/)[0])) correctEvidence++;
  }
  results.push({ id: entry.id, url: entry.url, base: entry.base, head: entry.head, expected: entry.expectedRules, detected, matchesLabel, completeness: report.run.completeness, diagnostics: report.run.diagnostics.length, unresolvedCalls: report.run.unresolvedCalls, files: report.run.files, bytes: report.run.bytes, milliseconds: Math.round(analyzed - started), stagesMs: { snapshot: Math.round(captured - started), analysis: Math.round(analyzed - captured) }, evidenceAccuracy: { correct: correctEvidence, denominator: linkedEvidence.length, fraction: linkedEvidence.length ? correctEvidence / linkedEvidence.length : null } });
}
const perRule = Object.fromEntries(Object.keys(rules).map(rule => {
  let truePositive = 0, falsePositive = 0, falseNegative = 0;
  for (const entry of results) {
    const expected = entry.expected.filter(id => id === rule).length;
    const detected = entry.detected.filter(id => id === rule).length;
    truePositive += Math.min(expected, detected);
    falsePositive += Math.max(0, detected - expected);
    falseNegative += Math.max(0, expected - detected);
  }
  return [rule, { truePositive, falsePositive, falseNegative, precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null, recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null }];
}));
const output = { specification: "benchmarks/public-prs.json", cases: results, perRule, falsePositivesPerPR: Object.values(perRule).reduce((sum, value) => sum + value.falsePositive, 0) / results.length, machine: { platform: `${process.platform}-${process.arch}`, node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), osRelease: release() }, nodePeakRssBytes: process.resourceUsage().maxRSS * 1024, memoryLimitations: "Node including semantic threads only; not total Rust/Git peak memory. These source-boundary public cases have zero positive labels, so precision/recall denominators are zero/undefined.", limitations: specification.limitations };
await writeFile("output/public-evaluation/summary.json", JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
if (results.some(entry => !entry.matchesLabel)) process.exitCode = 1;
