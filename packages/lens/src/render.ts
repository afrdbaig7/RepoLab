import type { Evidence, Report } from "./contracts.js";
import { sourceUrlPattern } from "./links.js";

export function display(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

const htmlText = (value: string): string => escapeHtml(display(value));
const location = (evidence: Evidence): string =>
  `${evidence.method === "typescript-ast" ? "" : `[${evidence.method}] `}${evidence.revision.slice(0, 12)}:${evidence.path}:${evidence.startLine}:${evidence.startColumn}`;
const markdownText = (value: string): string =>
  display(value).replace(/[\\`*_{}[\]()#+.!|<>~]/g, "\\$&");

function terminal(report: Report, title: string): string {
  const lines = [title,
    `Completeness: ${report.run.completeness}; ${report.findings.length} finding(s); ${report.run.diagnostics.length} diagnostic(s)`];
  for (const finding of report.findings) {
    lines.push(`\n${finding.ruleId} [${finding.priority}; ${finding.strength}] ${display(finding.reason)}`,
      `  before ${display(location(finding.before))}`,
      `  after  ${display(location(finding.after))}`);
    if (finding.before.url && sourceUrlPattern.test(finding.before.url)) lines.push(`  before URL ${finding.before.url}`);
    if (finding.after.url && sourceUrlPattern.test(finding.after.url)) lines.push(`  after URL  ${finding.after.url}`);
    for (const test of finding.relatedTests) {
      lines.push(`  related test: ${display(test.name)} (${test.method}; ${test.changes.length} changed observations)`);
    }
  }
  for (const diagnostic of report.run.diagnostics.slice(0, 30)) {
    lines.push(`${display(diagnostic.code)}: ${display(diagnostic.path ?? "")} ${display(diagnostic.message)}`);
  }
  lines.push("\nNo findings does not mean safe. Inspect limitations in the JSON/HTML report.", "");
  return lines.join("\n");
}

function markdown(report: Report, title: string): string {
  const sections = [`## ${title}`,
    `Completeness: ${report.run.completeness}. Findings: ${report.findings.length}.`];
  for (const finding of report.findings) {
    sections.push(`### ${finding.ruleId}: ${markdownText(finding.reason)}`,
      `Priority: ${finding.priority}; evidence: ${finding.strength}.`,
      `Before: ${markdownText(location(finding.before))}`,
      `After: ${markdownText(location(finding.after))}`);
    if (finding.before.url && sourceUrlPattern.test(finding.before.url)) sections.push(`[Source before](${finding.before.url})`);
    if (finding.after.url && sourceUrlPattern.test(finding.after.url)) sections.push(`[Source after](${finding.after.url})`);
    for (const test of finding.relatedTests) {
      sections.push(`Related test: ${markdownText(test.name)}; method: ${test.method}; changed observations: ${test.changes.length}.`);
    }
  }
  sections.push("No findings does not mean safe.",
    ...report.limitations.map(limitation => `- ${markdownText(limitation)}`), "");
  return sections.join("\n\n");
}

function excerpt(label: string, evidence: Evidence): string {
  // Keep source line breaks, but display other controls/bidi characters as data.
  const source = evidence.excerpt.replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, display);
  const labelText = htmlText(location(evidence));
  const reference = evidence.url && sourceUrlPattern.test(evidence.url)
    ? `<a href="${escapeHtml(evidence.url)}" rel="noreferrer">${labelText}</a>` : labelText;
  return `<div><h3>${label}</h3><p>${reference}</p>
    <pre><code>${escapeHtml(source)}</code></pre></div>`;
}

function html(report: Report, title: string): string {
  const articles = report.findings.map(finding => {
    const tests = finding.relatedTests.map(test => `<details>
      <summary>Related test: ${htmlText(test.name)}
        (${test.method}; ${test.changes.length} changed observations)</summary>
      <div class="pair">${excerpt("Test before", test.before)}${excerpt("Test after", test.after)}</div>
    </details>`).join("");
    return `<article>
      <h2>${finding.ruleId}: ${htmlText(finding.reason)}</h2>
      <p>Review priority: ${finding.priority}. Evidence strength: ${finding.strength}.</p>
      <div class="pair">${excerpt("Before", finding.before)}${excerpt("After", finding.after)}</div>
      ${tests}
      <p>${htmlText(finding.next)}</p>
      <ul>${finding.limitations.map(value => `<li>${htmlText(value)}</li>`).join("")}</ul>
    </article>`;
  }).join("");
  const diagnostics = report.run.diagnostics.map(diagnostic =>
    `<li>${htmlText(`${diagnostic.code}: ${diagnostic.path ?? ""} ${diagnostic.message}`)}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Lens review</title>
<style>
  body { font:16px/1.55 system-ui,sans-serif; background:#f1f5f9; color:#172033;
    max-width:1100px; margin:auto; padding:24px; }
  article,section,header { background:white; border:1px solid #cbd5e1;
    padding:20px; margin-bottom:18px; border-radius:8px; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#f8fafc;
    padding:14px; font:13px/1.6 monospace; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .pair>div { min-width:0; }
  summary { cursor:pointer; font-weight:600; }
  summary:focus-visible { outline:3px solid #2563eb; }
  h1 { font-size:25px; } h2 { font-size:19px; }
  p,li { overflow-wrap:anywhere; }
  @media(max-width:700px) { .pair { grid-template-columns:1fr; } body { padding:12px; } }
</style></head><body>
<header><h1>${htmlText(title)}</h1>
  <p>Completeness: ${report.run.completeness}. ${report.findings.length} finding(s).
    No findings does not mean safe.</p></header>
${articles}
<section><h2>Completeness diagnostics</h2><ul>${diagnostics}</ul>
  <h2>Limitations</h2><ul>${report.limitations.map(value => `<li>${htmlText(value)}</li>`).join("")}</ul>
</section></body></html>\n`;
}

export function render(report: Report, format: "json" | "terminal" | "html" | "markdown"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const comparison = report.run.comparison;
  const title = `Lens review: ${comparison.comparisonBase.slice(0, 12)} -> ${comparison.resolvedHead.slice(0, 12)} (${comparison.policy})`;
  if (format === "terminal") return terminal(report, title);
  if (format === "markdown") return markdown(report, title);
  return html(report, title);
}
