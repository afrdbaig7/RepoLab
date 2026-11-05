import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, posix } from "node:path";
import { annotations, overviews } from "./annotations.mjs";

const ignored = new Set(["node_modules", ".git", ".tools", "target", "output", "tmp", ".pnpm-store", "dist", "bin", ".agents", ".codex", ".aws"]);
const derived = new Set(["docs/learning/annotation-coverage.json", "docs/learning/file-map.md", "docs/learning/chapters/source-walkthrough.md"]);
const paths = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory === "." ? entry.name : posix.join(directory, entry.name);
    if (entry.isDirectory()) { if (!ignored.has(entry.name)) await walk(path); }
    else if (!derived.has(path) && !path.endsWith(".tgz") && !path.includes("/schemas/") && [".ts", ".tsx", ".js", ".mjs", ".go", ".rs", ".json", ".yaml", ".yml", ".toml", ".md", ".py", ".txt", ".lock", ""].includes(extname(path))) paths.push(path);
  }
}
await walk(".");
paths.sort();
const hash = text => createHash("sha256").update(text).digest("hex");
const entries = [];
const details = [];
for (const path of paths) {
  const content = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  const lines = content.trimEnd().split("\n");
  const generated = ["Cargo.lock", "pnpm-lock.yaml"].includes(path);
  const teaching = path.startsWith("docs/") || extname(path) === ".md";
  const configuration = [".json", ".yaml", ".yml", ".toml", ".lock", ".txt", ""].includes(extname(path));
  const groups = annotations[path];
  const overview = overviews[path];
  const test = path.includes("/test/");
  const lensConfig = configuration && (path.includes("lens") || path.startsWith(".github/") || path.startsWith("scripts/learning-docs") || ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "pnpm-lock.yaml", ".gitignore"].includes(path));
  const status = groups ? "statement-groups" : overview ? "file-overview" : generated ? "generated-origin" : teaching ? "learning-or-reference-source" : lensConfig ? "configuration-overview" : test && path.startsWith("packages/lens/") ? "test-overview" : "annotation-gap";
  const ranges = [];
  if (groups) {
    let previous = -1;
    for (const [marker, explanation] of groups) {
      const index = lines.findIndex((line, number) => number > previous && line.includes(marker));
      if (index < 0) throw new Error(`Stale annotation marker ${path}: ${marker}`);
      ranges.push({ startLine: index + 1, marker, explanation });
      previous = index;
    }
    for (let index = 0; index < ranges.length; index++) ranges[index].endLine = (ranges[index + 1]?.startLine ?? lines.length + 1) - 1;
  }
  const advanced = /(?:project|libraries|artifacts|analysis|trusted-git|links|io)\.(?:ts|test\.ts)$/.test(path);
  const entry = { path, digest: teaching ? null : hash(content), lines: lines.length, status, chapter: advanced ? "chapters/04-projects-and-provenance.md" : path.includes("snapshot") || path.endsWith(".rs") ? "chapters/02-worker.md" : path.includes("render") || path.includes("cli") || path.includes("action") || path.startsWith("scripts/") ? "chapters/03-reports-and-delivery.md" : "chapters/01-fixtures.md", ranges };
  entries.push(entry);
  if (groups || overview || test && path.startsWith("packages/lens/")) {
    details.push(`## ${path}\n\nSource digest: ${entry.digest}. ${lines.length} lines. Explanation level: ${status}.\n`);
    if (overview) details.push(`${overview}\n\n${groups ? "Statement groups below explain the local implementation." : "The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap."}\n`);
    if (path === "scripts/learning-docs/annotations.mjs") {
      details.push("The handwritten annotation data is rendered as the associated files' explanations throughout this volume, rather than duplicated as enormous string listings. Its marker-resolution algorithm is explained in coverage.mjs.\n");
      continue;
    }
    if (test && !groups && !overview) details.push("This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.\n");
    const sections = ranges.length ? ranges : [{ startLine: 1, endLine: lines.length, explanation: "Complete file excerpt for review alongside its responsibility above." }];
    for (const section of sections) {
      details.push(`### Lines ${section.startLine}-${section.endLine}\n\n${section.explanation}\n\n\`\`\`\n${lines.slice(section.startLine - 1, section.endLine).map((line, index) => `${String(section.startLine + index).padStart(4)}${line ? ` ${line}` : ""}`).join("\n")}\n\`\`\`\n`);
    }
  }
}
const sourceDigest = hash(entries.filter(entry => entry.digest).map(entry => `${entry.path}\0${entry.digest}`).join("\n"));
const coverage = { schemaVersion: 1, sourceDigest, revision: null, dirtyWorktree: "Live Git revision/dirty status is captured when PDFs are built; the versioned inventory uses the source digest to avoid commit/digest cycles.", note: "Statement groups cover the main new engine/worker. File/test overviews and inherited RepoLab files remain explicit annotation gaps; inventory coverage is not complete teaching coverage. PDF output is excluded from source digests.", counts: Object.fromEntries([...new Set(entries.map(entry => entry.status))].sort().map(status => [status, entries.filter(entry => entry.status === status).length])), entries };
const map = `# Handwritten file inventory\n\nSource snapshot digest: ${sourceDigest}. PDF builds capture live Git revision/dirty status separately.\n\nGenerated schema artifacts originate in contracts.ts through schema.ts; lockfiles originate in pnpm/Cargo resolution and must be regenerated with the pinned tools. Packaged worker binaries originate in cargo release + stage-package; PDFs originate in this learning build. Dependencies and generated bundles are not handwritten source.\n\n| File | Lines | Teaching coverage | Chapter |\n| --- | --- | --- | --- |\n${entries.map(entry => `| ${entry.path} | ${entry.lines} | ${entry.status} | ${entry.chapter} |`).join("\n")}\n`;
const book = `# Detailed source walkthrough - volume 1\n\nImplementation source digest: ${sourceDigest}. PDF builds capture live Git revision/dirty status separately.\n\nRead concepts in the overview first. Numbered source lines are extracted from the actual files, not retyped examples. Each grouped explanation states local runtime purpose and the consequence of losing a boundary. File/test overviews are deliberately marked as incomplete statement coverage. The PDF displays non-ASCII source characters with explicit Unicode escapes for print-font compatibility; the versioned Markdown and source retain the original UTF-8 text.\n\n${details.join("\n")}\n`;
const outputs = { "docs/learning/annotation-coverage.json": JSON.stringify(coverage, null, 2) + "\n", "docs/learning/file-map.md": map, "docs/learning/chapters/source-walkthrough.md": book.trimEnd() + "\n" };
await mkdir("docs/learning/chapters", { recursive: true });
for (const [path, content] of Object.entries(outputs)) {
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== content) throw new Error(`Stale learning output: ${path}; update explanations and regenerate`);
  } else await writeFile(path, content);
}
console.log(`Learning source snapshot ${sourceDigest.slice(0, 16)}; ${entries.length} files inventoried. Explicit gaps preserved.`);
