import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, extname, posix as posixPath, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { graphEdgeSchema, graphFactSchema, graphSchema, sha256, type Graph, type GraphEdge, type GraphFact, type LabManifest } from "@repolab/contracts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".repolab", "vendor"]);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 250_000_000;

export interface SnapshotFile {
  path: string;
  hash: string;
  bytes: number;
  content: string;
}

export interface SourceSnapshot {
  id: string;
  root: string;
  createdAt: string;
  analyzerVersion: string;
  files: SnapshotFile[];
  totalBytes: number;
}

export interface IntakeOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

function isInside(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(rootWithSep);
}

async function collectFiles(root: string, current: string, files: SnapshotFile[], options: Required<IntakeOptions>, total: { bytes: number }): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= options.maxFiles) throw new Error(`repository exceeds ${options.maxFiles} files`);
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) await collectFiles(root, path, files, options, total);
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in source snapshot: ${relative(root, path)}`);
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const stat = await lstat(path);
    if (stat.size > options.maxFileBytes) throw new Error(`file exceeds ${options.maxFileBytes} bytes: ${relative(root, path)}`);
    total.bytes += stat.size;
    if (total.bytes > options.maxTotalBytes) throw new Error(`repository exceeds ${options.maxTotalBytes} source bytes`);
    const buffer = await readFile(path);
    const content = buffer.toString("utf8");
    if (Buffer.byteLength(content, "utf8") !== buffer.byteLength) throw new Error(`invalid UTF-8 source file: ${relative(root, path)}`);
    const relativePath = relative(root, path).split(sep).join("/");
    files.push({ path: relativePath, hash: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.byteLength, content });
  }
}

export async function createSourceSnapshot(inputRoot: string, inputOptions: IntakeOptions = {}): Promise<SourceSnapshot> {
  const root = await realpath(resolve(inputRoot));
  const stat = await lstat(root);
  if (!stat.isDirectory()) throw new Error(`repository path is not a directory: ${inputRoot}`);
  const options = { maxFiles: inputOptions.maxFiles ?? MAX_FILES, maxFileBytes: inputOptions.maxFileBytes ?? MAX_FILE_BYTES, maxTotalBytes: inputOptions.maxTotalBytes ?? MAX_TOTAL_BYTES };
  const files: SnapshotFile[] = [];
  const total = { bytes: 0 };
  await collectFiles(root, root, files, options, total);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const id = sha256(files.map((file) => `${file.path}\0${file.hash}\0${file.bytes}`).join("\n"));
  return { id, root, createdAt: new Date().toISOString(), analyzerVersion: "0.1.0", files, totalBytes: total.bytes };
}

function lineRef(source: ts.SourceFile, node: ts.Node, snapshot: SourceSnapshot, hashes: Map<string, string>) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  const path = source.fileName.split(sep).join("/");
  const relativePath = relative(snapshot.root, source.fileName).split(sep).join("/");
  return { path: relativePath, fileHash: hashes.get(relativePath) ?? sha256("missing"), startLine: start.line + 1, endLine: Math.max(start.line + 1, end.line + 1) };
}

function fact(snapshot: SourceSnapshot, kind: GraphFact["kind"], label: string, source: ts.SourceFile | undefined, node: ts.Node | undefined, hashes: Map<string, string>, metadata: Record<string, unknown> = {}): GraphFact {
  const sourceRef = source && node ? lineRef(source, node, snapshot, hashes) : undefined;
  return graphFactSchema.parse({ id: `${kind}:${label}`, kind, label, sourceRef, metadata, provenance: { kind: "parsed", snapshotId: snapshot.id, producer: { name: "repolab-analyzer", version: snapshot.analyzerVersion }, sourceRef, resolution: "resolved" } });
}

function edge(snapshot: SourceSnapshot, from: string, to: string, kind: GraphEdge["kind"], source: ts.SourceFile | undefined, node: ts.Node | undefined, hashes: Map<string, string>, resolution: "resolved" | "partial" | "unresolved" = "resolved"): GraphEdge {
  const sourceRef = source && node ? lineRef(source, node, snapshot, hashes) : undefined;
  return graphEdgeSchema.parse({ id: `${kind}:${from}->${to}`, from, to, kind, provenance: { kind: "parsed", snapshotId: snapshot.id, producer: { name: "repolab-analyzer", version: snapshot.analyzerVersion }, sourceRef, resolution } });
}

function moduleId(path: string): string { return `module:${path}`; }

function resolveImport(fromPath: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posixPath.normalize(posixPath.join(posixPath.dirname(fromPath), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.js`];
  return candidates.find((candidate) => files.has(candidate));
}

export function analyzeSnapshot(snapshot: SourceSnapshot): Graph {
  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const hashes = new Map(snapshot.files.map((file) => [file.path, file.hash]));
  const sources = snapshot.files.map((file) => ts.createSourceFile(resolve(snapshot.root, file.path), file.content, ts.ScriptTarget.ES2022, true));
  const nodes: GraphFact[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const addNode = (item: GraphFact) => { if (!nodeIds.has(item.id)) { nodeIds.add(item.id); nodes.push(item); } };
  const firstFile = snapshot.files[0];
  const snapshotSourceRef = firstFile ? { path: firstFile.path, fileHash: firstFile.hash, startLine: 1, endLine: 1 } : undefined;
  if (firstFile) addNode({ id: `snapshot:${snapshot.id}`, kind: "repository", label: snapshot.id, metadata: { fileCount: snapshot.files.length, totalBytes: snapshot.totalBytes }, provenance: { kind: "parsed", snapshotId: snapshot.id, producer: { name: "repolab-analyzer", version: snapshot.analyzerVersion }, sourceRef: snapshotSourceRef } });

  for (const source of sources) {
    const path = relative(snapshot.root, source.fileName).split(sep).join("/");
    const file = filesByPath.get(path);
    if (!file) continue;
    const module = moduleId(path);
    addNode(fact(snapshot, "module", path, source, source, hashes, { path }));
    edges.push(edge(snapshot, `snapshot:${snapshot.id}`, module, "declares", source, source, hashes));
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const imported = resolveImport(path, node.moduleSpecifier.text, new Set(filesByPath.keys()));
        const target = imported ? moduleId(imported) : `module:external:${node.moduleSpecifier.text}`;
        if (!imported) addNode(fact(snapshot, "module", `external:${node.moduleSpecifier.text}`, source, node, hashes, { external: true }));
        edges.push(edge(snapshot, module, target, "imports", source, node, hashes, imported ? "resolved" : "partial"));
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        const symbol = `symbol:${path}#${node.name.text}`;
        addNode(fact(snapshot, "symbol", `${path}#${node.name.text}`, source, node, hashes, { declaration: "function" }));
        edges.push(edge(snapshot, module, symbol, "declares", source, node, hashes));
      }
      if (ts.isClassDeclaration(node) && node.name) {
        const symbol = `symbol:${path}#${node.name.text}`;
        addNode(fact(snapshot, "symbol", `${path}#${node.name.text}`, source, node, hashes, { declaration: "class" }));
        edges.push(edge(snapshot, module, symbol, "declares", source, node, hashes));
      }
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
        const symbol = `symbol:${path}#${declaration.name.text}`;
        addNode(fact(snapshot, "symbol", `${path}#${declaration.name.text}`, source, declaration, hashes, { declaration: "variable" }));
        edges.push(edge(snapshot, module, symbol, "declares", source, declaration, hashes));
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toUpperCase();
        const receiver = node.expression.expression.getText(source);
        const first = node.arguments[0];
        if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method) && (receiver === "app" || receiver === "router" || receiver.endsWith("Router")) && first && ts.isStringLiteral(first)) {
          const routePath = first.text;
          const route = `route:${method} ${routePath}`;
          addNode(fact(snapshot, "route", `${method} ${routePath}`, source, node, hashes, { method, path: routePath, receiver }));
          edges.push(edge(snapshot, module, route, "registers_route", source, node, hashes));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return graphSchema.parse({ nodes, edges });
}

export function augmentGraphWithManifest(graph: Graph, manifest: LabManifest, snapshotId: string, producerVersion = "0.1.0"): Graph {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const declared = { kind: "declared" as const, snapshotId, producer: { name: "repolab-manifest", version: producerVersion } };
  const addNode = (node: GraphFact): void => { if (!nodeIds.has(node.id)) { nodeIds.add(node.id); nodes.push(node); } };
  const addEdge = (edge: GraphEdge): void => { if (!edgeIds.has(edge.id)) { edgeIds.add(edge.id); edges.push(edge); } };
  const addDeclaredNode = (kind: GraphFact["kind"], id: string, label: string, manifestPointer: string, metadata: Record<string, unknown>): void => addNode(graphFactSchema.parse({ id, kind, label, metadata, provenance: { ...declared, manifestPointer } }));
  const addDeclaredEdge = (from: string, to: string, kind: GraphEdge["kind"], manifestPointer: string): void => addEdge(graphEdgeSchema.parse({ id: `declared:${kind}:${from}->${to}`, from, to, kind, provenance: { ...declared, manifestPointer } }));

  const applicationServiceId = `service:${manifest.application.service}`;
  addDeclaredNode("service", applicationServiceId, manifest.application.service, "$.application.service", { recipe: manifest.application.recipe, application: true });
  for (const [dependencyId, dependency] of Object.entries(manifest.dependencies)) {
    const serviceId = `service:${dependencyId}`;
    addDeclaredNode("service", serviceId, dependencyId, `$.dependencies.${dependencyId}`, { recipe: dependency.recipe, routeThroughProxy: dependency.routeThroughProxy, fixture: dependency.fixture });
    addDeclaredEdge(applicationServiceId, serviceId, "targets_dependency", `$.dependencies.${dependencyId}`);
  }
  for (const feature of manifest.features) {
    const featureId = `feature:${feature.id}`;
    addDeclaredNode("feature", featureId, feature.title, `$.features[${feature.id}]`, { featureId: feature.id, description: feature.description });
    for (const entrypoint of feature.entrypoints) {
      const routeId = `declared-route:${entrypoint.method} ${entrypoint.path}`;
      addDeclaredNode("route", routeId, `${entrypoint.method} ${entrypoint.path}`, `$.features[${feature.id}].entrypoints`, { method: entrypoint.method, path: entrypoint.path, declared: true });
      addDeclaredEdge(featureId, routeId, "references", `$.features[${feature.id}].entrypoints`);
    }
    for (const scenarioId of feature.scenarios) addDeclaredEdge(featureId, `scenario:${scenarioId}`, "exercises", `$.features[${feature.id}].scenarios`);
  }
  for (const scenario of manifest.scenarios) {
    const scenarioId = `scenario:${scenario.id}`;
    addDeclaredNode("scenario", scenarioId, scenario.id, `$.scenarios[${scenario.id}]`, { feature: scenario.feature, request: scenario.request, assertionCount: scenario.assertions.length });
    addDeclaredEdge(scenarioId, `feature:${scenario.feature}`, "exercises", `$.scenarios[${scenario.id}].feature`);
    const routeId = `declared-route:${scenario.request.method} ${scenario.request.path}`;
    addDeclaredEdge(scenarioId, routeId, "references", `$.scenarios[${scenario.id}].request`);
  }
  for (const experiment of manifest.experiments) {
    const experimentId = `experiment:${experiment.id}`;
    addDeclaredNode("experiment", experimentId, experiment.id, `$.experiments[${experiment.id}]`, { scenario: experiment.scenario, fault: experiment.fault, expectedAssertions: experiment.expectedAssertions });
    addDeclaredEdge(experimentId, `scenario:${experiment.scenario}`, "exercises", `$.experiments[${experiment.id}].scenario`);
    addDeclaredEdge(experimentId, `service:${experiment.fault.target}`, "targets_dependency", `$.experiments[${experiment.id}].fault.target`);
  }
  return graphSchema.parse({ nodes, edges });
}

export async function analyzeRepository(root: string, options: IntakeOptions = {}): Promise<{ snapshot: SourceSnapshot; graph: Graph }> {
  const snapshot = await createSourceSnapshot(root, options);
  return { snapshot, graph: analyzeSnapshot(snapshot) };
}
