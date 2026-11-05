import ts from "typescript";
import { posix } from "node:path";
import type { Diagnostic } from "./contracts.js";
import type { InputFile } from "./extract.js";

const root = "/__lens_snapshot__";
export interface Project {
  program: ts.Program;
  sources: Map<string, ts.SourceFile>;
  diagnostics: Diagnostic[];
  pathOf(source: ts.SourceFile): string | undefined;
}
export interface LibraryFile { path: string; content: string; }

// Every compiler read is a map lookup. The caller supplies any trusted libraries.
// No target configuration or source is imported/executed as JavaScript.
export function createProject(files: InputFile[], libraries: LibraryFile[] = []): Project {
  if (ts.version !== "5.8.3") throw new Error(`Unsupported compiler ${ts.version}; this adapter requires TypeScript 5.8.3`);
  const contents = new Map(files.map(file => [`${root}/${file.path}`, file.content]));
  const libraryRoot = "/__lens_typescript_lib__";
  for (const file of libraries) contents.set(`${libraryRoot}/${file.path}`, file.content);
  const diagnostics: Diagnostic[] = [];
  const normalize = (path: string): string => posix.normalize(path.replaceAll("\\", "/"));
  const read = (path: string): string | undefined => contents.get(normalize(path));
  const inside = (path: string): boolean => normalize(path).startsWith(`${root}/`);
  const configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: directory => [...contents.keys()].filter(path => inside(path) && path.startsWith(`${normalize(directory)}/`) && /\.[cm]?tsx?$/.test(path)),
    fileExists: path => inside(path) && read(path) !== undefined,
    readFile: path => inside(path) ? read(path) : undefined,
  };
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
  };
  const configPath = `${root}/tsconfig.json`;
  if (contents.has(configPath)) {
    const loaded = ts.readConfigFile(configPath, configHost.readFile);
    if (loaded.error) diagnostics.push({ code: "config-error", stage: "project", message: ts.flattenDiagnosticMessageText(loaded.error.messageText, " "), path: "tsconfig.json" });
    else {
      // readFile/fileExists refuse any extends outside the captured root.
      const parsed = ts.parseJsonConfigFileContent(loaded.config, configHost, root, undefined, configPath);
      options = { ...options, ...parsed.options };
      for (const error of parsed.errors) diagnostics.push({ code: "config-error", stage: "project", message: ts.flattenDiagnosticMessageText(error.messageText, " "), path: "tsconfig.json" });
      if (parsed.projectReferences?.length) diagnostics.push({ code: "project-references", stage: "project", message: "Project references are not built or merged; captured source is analyzed as one project.", path: "tsconfig.json" });
      if (Array.isArray(options.plugins) && options.plugins.length) diagnostics.push({ code: "config-plugins", stage: "project", message: "Compiler plugins are never loaded.", path: "tsconfig.json" });
    }
  }
  // Source enumeration is the snapshot contract, not tsconfig include/exclude.
  options = { ...options, noEmit: true, noLib: libraries.length === 0,
    skipLibCheck: true, incremental: false, composite: false, plugins: [] };
  const cache = new Map<string, ts.SourceFile>();
  const directories = new Set<string>();
  for (const path of contents.keys()) {
    let directory = posix.dirname(path);
    while (directory !== "/") { directories.add(directory); directory = posix.dirname(directory); }
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      const path = normalize(name);
      const content = read(path);
      if (content === undefined) return undefined;
      if (!cache.has(path)) cache.set(path, ts.createSourceFile(path, content, languageVersion, true));
      return cache.get(path);
    },
    getDefaultLibFileName: () => `${libraryRoot}/${ts.getDefaultLibFileName(options)}`,
    writeFile: () => { throw new Error("Snapshot analysis cannot emit code"); },
    getCurrentDirectory: () => root,
    getDirectories: directory => [...directories].filter(path => posix.dirname(path) === normalize(directory)),
    directoryExists: directory => directories.has(normalize(directory)),
    fileExists: path => contents.has(normalize(path)), readFile: read,
    getCanonicalFileName: normalize, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n", realpath: normalize,
  };
  const roots = files.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => `${root}/${file.path}`);
  const program = ts.createProgram(roots, options, host);
  const sources = new Map<string, ts.SourceFile>();
  for (const source of program.getSourceFiles()) if (inside(source.fileName)) {
    const path = source.fileName.slice(root.length + 1);
    sources.set(path, source);
    for (const statement of source.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        if (!ts.resolveModuleName(specifier, source.fileName, options, host).resolvedModule) diagnostics.push({ code: "missing-module", stage: "project", path, message: `Module ${specifier} is absent from captured/trusted context; no target dependencies are installed.` });
      }
    }
  }
  for (const diagnostic of program.getOptionsDiagnostics()) diagnostics.push({ code: "compiler-options", stage: "project", message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
  return { program, sources, diagnostics, pathOf: source => inside(source.fileName) ? source.fileName.slice(root.length + 1) : undefined };
}
