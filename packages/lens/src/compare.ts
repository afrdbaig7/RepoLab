import { posix } from "node:path";
import { configSchema, digest, reportSchema, version, type Config, type Evidence, type Finding, type Manifest, type Report } from "./contracts.js";
import { extract, type Facts, type InputFile, type TestFact } from "./extract.js";
import { createProject, type LibraryFile } from "./project.js";

export const limitations = [
  "Static observations direct human review; zero findings does not mean safe.",
  "Types and return annotations are compared textually, not for semantic equivalence.",
  "Guard names use a text-only heuristic; equivalent enforcement elsewhere is unknown.",
  "Only exported named non-generic function declarations and simple exported interfaces are supported.",
  "Tests require named imports from vitest or @jest/globals, literal titles, and supported block callbacks.",
  "Test relationships use imported identifier references, not execution or assertion adequacy.",
  "CALL001 compares supported resolved local direct-call target sets, not behavior or a complete call graph. Test artifacts are not accepted yet.",
];

function targetPath(testPath: string, specifier: string, paths: Set<string>): string | undefined {
  const stem = posix.normalize(posix.join(posix.dirname(testPath), specifier));
  return [stem, stem.replace(/\.js$/, ".ts"), `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(path => paths.has(path));
}

export function compareFiles(beforeFiles: InputFile[], afterFiles: InputFile[], manifest: Manifest, inputConfig: unknown = {}, libraries: LibraryFile[] = []): Report {
  const config: Config = configSchema.parse(inputConfig);
  const beforeProject = createProject(beforeFiles, libraries);
  const afterProject = createProject(afterFiles, libraries);
  const before = beforeFiles.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => extract(file, config.guards, beforeProject, config.repositoryUrl));
  const after = afterFiles.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => extract(file, config.guards, afterProject, config.repositoryUrl));
  const diagnostics = [...manifest.diagnostics, ...beforeProject.diagnostics, ...afterProject.diagnostics, ...before.flatMap(file => file.diagnostics), ...after.flatMap(file => file.diagnostics)];
  const report: Report = {
    schemaVersion: 1,
    run: { toolVersion: version, compilerVersion: "5.8.3", configDigest: digest(JSON.stringify(config)), comparison: manifest.comparison, completeness: "partial", diagnostics, unresolvedCalls: [...before, ...after].flatMap(file => file.functions).reduce((sum, fn) => sum + fn.unresolvedCalls, 0), files: beforeFiles.length + afterFiles.length, bytes: manifest.totalBytes },
    symbols: [], changes: [], findings: [], limitations,
  };
  const pairs: Array<{ before: Facts; after: Facts; method: "exact-path-and-name" | "identical-blob-rename" }> = [];
  for (const old of before) {
    const exact = after.find(file => file.path === old.path);
    if (exact) { pairs.push({ before: old, after: exact, method: "exact-path-and-name" }); continue; }
    // A unique identical content digest is a verified narrow rename; edited renames stay unmatched.
    const hash = digest(beforeFiles.find(file => file.path === old.path)!.content);
    const candidates = afterFiles.filter(file => !beforeFiles.some(previous => previous.path === file.path) && digest(file.content) === hash);
    if (candidates.length === 1 && beforeFiles.filter(file => digest(file.content) === hash).length === 1) {
      pairs.push({ before: old, after: after.find(file => file.path === candidates[0]!.path)!, method: "identical-blob-rename" });
    } else diagnostics.push({ code: "unmatched-file", stage: "matching", path: old.path, message: "Deleted, moved or edited-renamed file: cross-file symbol matching is unknown." });
  }
  for (const file of after) if (!pairs.some(pair => pair.after === file)) diagnostics.push({ code: "unmatched-file", stage: "matching", path: file.path, message: "Added or unmatched file: no before/after symbol comparison available." });
  const testPairs: Array<{ before: TestFact; after: TestFact }> = [];
  for (const pair of pairs) for (const test of pair.before.tests) {
    const oldMatches = pair.before.tests.filter(candidate => candidate.name === test.name);
    const matches = pair.after.tests.filter(candidate => candidate.name === test.name);
    if (oldMatches.length === 1 && matches.length === 1) testPairs.push({ before: test, after: matches[0]! });
    else diagnostics.push({ code: "unmatched-test", stage: "matching", path: pair.before.path, message: `Test ${test.name} was removed, renamed or ambiguous; assertion comparison skipped.` });
  }
  const emit = (ruleId: Finding["ruleId"], symbol: string, before: Evidence, after: Evidence, reason: string, strength: Finding["strength"] = "structural"): void => {
    const identity = digest(JSON.stringify([ruleId, symbol, before.path, before.startLine, after.path, after.startLine, before.fileDigest, after.fileDigest])).slice(0, 24);
    report.changes.push({ id: `change:${identity}`, kind: ruleId, symbol, before, after, ambiguity: strength === "heuristic" ? "Text identity does not establish resolved call identity." : null });
    report.findings.push({ id: `finding:${identity}`, symbol, ruleId, priority: ruleId === "GUARD001" ? "high" : "medium", strength, reason, before, after, relatedTests: [], limitations: ruleId === "GUARD001" ? [limitations[2]!] : ["A rewrite may preserve behavior; inspect the surrounding implementation."], next: "Inspect both revisions and related tests before deciding whether this change is intended." });
  };
  for (const pair of pairs) {
    for (const old of pair.before.functions) {
      const matches = pair.after.functions.filter(candidate => candidate.name === old.name);
      if (matches.length !== 1) { diagnostics.push({ code: "unmatched-function", stage: "matching", path: pair.before.path, message: `Function ${old.name} has no supported unique match.` }); continue; }
      const current = matches[0]!;
      const id = `${pair.before.path}#${old.name}`;
      report.symbols.push({ id, name: old.name, kind: "function", source: current.source, matching: pair.method });
      if (JSON.stringify(old.parameters) !== JSON.stringify(current.parameters)) emit("API001", id, old.source, current.source, "Exported parameter structure changed (textual annotations, names, optional/default/rest structure).");
      if (old.returns !== null && current.returns !== null && old.returns !== current.returns) emit("API002", id, old.source, current.source, "Explicit return annotation changed; comparison method: textual annotation.");
      if ((old.returns === null) !== (current.returns === null)) diagnostics.push({ code: "return-context", stage: "comparison", path: pair.before.path, message: `Function ${old.name}: adding/removing a return annotation is outside API002.` });
      for (const guard of old.guards) if (!current.guards.has(guard)) emit("GUARD001", id, old.guardEvidence.get(guard)!, current.source, `Configured guard call ${guard} is absent from the matched function (text-only heuristic).`, "heuristic");
      if (!old.unresolvedCalls && !current.unresolvedCalls) {
        const normalizeTarget = (target: string): string => {
          const separator = target.lastIndexOf("#");
          const path = target.slice(0, separator);
          return `${pairs.find(candidate => candidate.before.path === path)?.after.path ?? path}${target.slice(separator)}`;
        };
        const oldTargets = [...old.resolvedCalls].map(normalizeTarget).sort();
        const newTargets = [...current.resolvedCalls].sort();
        if (JSON.stringify(oldTargets) !== JSON.stringify(newTargets)) emit("CALL001", id, old.source, current.source, `Resolved local direct-call target set changed: ${JSON.stringify(oldTargets)} -> ${JSON.stringify(newTargets)}. Method: snapshot TypeChecker declaration resolution; this does not prove behavioral change.`);
      }
    }
    for (const old of pair.before.interfaces) {
      const current = pair.after.interfaces.find(candidate => candidate.name === old.name);
      if (!current) continue;
      const id = `${pair.before.path}#${old.name}`;
      report.symbols.push({ id, name: old.name, kind: "interface", source: current.source, matching: pair.method });
      for (const [name, field] of old.fields) {
        const next = current.fields.get(name);
        if (!field.optional && next?.optional) emit("TYPE001", `${id}.${name}`, field.source, next.source, `Required field ${name} became optional.`);
      }
    }
  }
  for (const pair of testPairs) {
    const id = `${pair.before.source.path}#test:${pair.before.name}`;
    report.symbols.push({ id, name: pair.before.name, kind: "test", source: pair.after.source, matching: "exact-path-and-name" });
    if (pair.before.state === "active" && pair.after.state !== "active") emit("TEST002", id, pair.before.source, pair.after.source, `Test became ${pair.after.state}.`);
    // Preserve positional ambiguity explicitly: compare the ordered assertion sequence, not semantics.
    const oldText = pair.before.assertions.map(item => item.excerpt);
    const newText = pair.after.assertions.map(item => item.excerpt);
    if (JSON.stringify(oldText) !== JSON.stringify(newText)) {
      const kind = oldText.length > newText.length ? "removed" : oldText.length < newText.length ? "added" : "edited";
      emit("TEST001", id, pair.before.assertions[0] ?? pair.before.source, pair.after.assertions[0] ?? pair.after.source, `Supported assertion sequence ${kind}; ordered textual comparison does not prove changed behavior.`);
    }
  }
  const paths = new Set(before.map(file => file.path));
  for (const finding of report.findings.filter(item => ["GUARD001", "API001", "API002", "CALL001"].includes(item.ruleId))) {
    const name = finding.symbol;
    for (const pair of testPairs) {
      const referenced = pair.before.resolvedReferences.has(name) || [...pair.before.references].some(reference => {
        const separator = reference.lastIndexOf("#");
        const target = targetPath(pair.before.source.path, reference.slice(0, separator), paths);
        return `${target}#${reference.slice(separator + 1)}` === name;
      });
      if (referenced) finding.relatedTests.push({ name: pair.before.name, method: "static-import-reference", before: pair.before.source, after: pair.after.source, changes: report.findings.filter(item => item.ruleId.startsWith("TEST") && item.before.path === pair.before.source.path && item.before.startLine >= pair.before.source.startLine && item.before.endLine <= pair.before.source.endLine).map(item => item.id) });
    }
  }
  for (const key of ["symbols", "changes", "findings"] as const) report[key].sort((left, right) => left.id.localeCompare(right.id, "en"));
  diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  report.run.completeness = diagnostics.length ? "partial" : "complete-within-supported-syntax";
  return reportSchema.parse(report);
}
