import { sha256, type Graph } from "@repolab/contracts";

export interface ReportAssertion { id: string; outcome: "passed" | "failed" | "inconclusive"; message: string; observed?: unknown; }
export interface ReportData {
  title: string;
  repository: string;
  snapshotId: string;
  generatedAt: string;
  scenario: { id: string; request: { method: string; path: string }; assertions: ReportAssertion[] };
  experiment?: { id: string; fault: Record<string, unknown> };
  graph: Graph;
  evidence: { complete: boolean; droppedSpans?: number; artifactChecksum?: string };
  sourceMetadata: { commitSha?: string; dirty?: boolean; manifestHash?: string; planFingerprint?: string };
  limitations: string[];
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function outcomeClass(outcome: ReportAssertion["outcome"]): string { return outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : "inconclusive"; }

export function exportHtmlReport(data: ReportData): { html: string; checksum: string } {
  const payload = safeJson(data);
  const checksum = sha256(payload);
  const assertionRows = data.scenario.assertions.map((assertion) => `<tr><td>${escapeHtml(assertion.id)}</td><td><span class="${outcomeClass(assertion.outcome)}">${escapeHtml(assertion.outcome)}</span></td><td>${escapeHtml(assertion.message)}</td><td><code>${escapeHtml(assertion.observed === undefined ? "—" : JSON.stringify(assertion.observed))}</code></td></tr>`).join("");
  const nodeRows = data.graph.nodes.slice(0, 150).map((node) => `<tr><td>${escapeHtml(node.kind)}</td><td>${escapeHtml(node.label)}</td><td>${escapeHtml(node.provenance.kind)}</td><td>${escapeHtml(node.sourceRef?.path ?? "—")}</td></tr>`).join("");
  const limitations = data.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("");
  const title = escapeHtml(data.title);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · RepoLab report</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#17202a;background:#f5f7fb;line-height:1.45}body{max-width:1180px;margin:0 auto;padding:32px}header,.card{background:#fff;border:1px solid #dbe3ee;border-radius:14px;padding:22px;margin-bottom:18px;box-shadow:0 4px 18px #17202a0b}h1{margin:0 0 4px;letter-spacing:-.03em}h2{font-size:18px;margin-top:0}dl{display:grid;grid-template-columns:180px 1fr;gap:7px 18px}dt{font-weight:700;color:#475569}dd{margin:0;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e2e8f0;padding:9px 7px;vertical-align:top}th{color:#475569}.passed{color:#047857;font-weight:700}.failed{color:#b91c1c;font-weight:700}.inconclusive{color:#a16207;font-weight:700}code{overflow-wrap:anywhere}footer{color:#64748b;font-size:12px}.warning{background:#fffbeb;border-color:#fde68a}</style></head><body><header><h1>${title}</h1><div>Read-only RepoLab evidence report</div></header><section class="card"><h2>Overview</h2><dl><dt>Repository</dt><dd>${escapeHtml(data.repository)}</dd><dt>Snapshot</dt><dd><code>${escapeHtml(data.snapshotId)}</code></dd><dt>Generated</dt><dd>${escapeHtml(data.generatedAt)}</dd><dt>Scenario</dt><dd>${escapeHtml(data.scenario.id)} · ${escapeHtml(data.scenario.request.method)} ${escapeHtml(data.scenario.request.path)}</dd><dt>Evidence</dt><dd>${data.evidence.complete ? "complete" : "partial"}${data.evidence.droppedSpans === undefined ? "" : ` · dropped spans: ${escapeHtml(data.evidence.droppedSpans)}`}</dd><dt>Report checksum</dt><dd><code>${checksum}</code></dd></dl></section>${data.experiment ? `<section class="card"><h2>Experiment</h2><dl><dt>Experiment</dt><dd>${escapeHtml(data.experiment.id)}</dd><dt>Fault settings</dt><dd><code>${escapeHtml(JSON.stringify(data.experiment.fault))}</code></dd></dl></section>` : ""}<section class="card"><h2>Assertions</h2><table><thead><tr><th>ID</th><th>Outcome</th><th>Message</th><th>Observed</th></tr></thead><tbody>${assertionRows}</tbody></table></section><section class="card"><h2>Observed and declared graph facts</h2><p>${data.graph.nodes.length > 150 ? "Showing the first 150 facts; the full graph is not embedded." : "All recorded facts are shown."}</p><table><thead><tr><th>Kind</th><th>Label</th><th>Evidence</th><th>Source</th></tr></thead><tbody>${nodeRows}</tbody></table></section><section class="card"><h2>Source and reproducibility metadata</h2><dl><dt>Commit</dt><dd>${escapeHtml(data.sourceMetadata.commitSha ?? "not recorded")}</dd><dt>Dirty worktree</dt><dd>${escapeHtml(data.sourceMetadata.dirty === undefined ? "not recorded" : data.sourceMetadata.dirty)}</dd><dt>Manifest hash</dt><dd><code>${escapeHtml(data.sourceMetadata.manifestHash ?? "not recorded")}</code></dd><dt>Plan fingerprint</dt><dd><code>${escapeHtml(data.sourceMetadata.planFingerprint ?? "not recorded")}</code></dd></dl></section><section class="card warning"><h2>Limitations</h2><ul>${limitations || "<li>None recorded.</li>"}</ul></section><footer>This report is read-only. It contains no execution controls, external assets, or network requests. Checksums identify corruption; they are not signatures or tamper-proof attestations.</footer><script type="application/json" id="report-data">${payload}</script></body></html>`;
  return { html, checksum };
}
