import ts from "typescript";
import { digest, type Diagnostic, type Evidence } from "./contracts.js";
import type { Project } from "./project.js";
import { sourceUrl } from "./links.js";

export interface InputFile { path: string; content: string; revision: string; }
export interface Parameter { name: string; type: string | null; optional: boolean; rest: boolean; initializer: string | null; }
export interface FunctionFact { name: string; parameters: Parameter[]; returns: string | null; guards: Set<string>; guardEvidence: Map<string, Evidence>; resolvedCalls: Set<string>; unresolvedCalls: number; source: Evidence; }
export interface InterfaceFact { name: string; fields: Map<string, { optional: boolean; source: Evidence }>; source: Evidence; }
export interface TestFact { name: string; state: "active" | "skip" | "todo"; assertions: Evidence[]; references: Set<string>; resolvedReferences: Set<string>; source: Evidence; }
export interface Facts { path: string; functions: FunctionFact[]; interfaces: InterfaceFact[]; tests: TestFact[]; diagnostics: Diagnostic[]; }

export function extract(file: InputFile, guards: readonly string[], project?: Project, repositoryUrl?: string): Facts {
  const source = project?.sources.get(file.path) ?? ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: Facts = { path: file.path, functions: [], interfaces: [], tests: [], diagnostics: [] };
  const evidence = (node: ts.Node): Evidence => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.getEnd());
    const url = sourceUrl(repositoryUrl, file.revision, file.path, start.line + 1, end.line + 1, end.character + 1);
    return { revision: file.revision, path: file.path, startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, excerpt: node.getText(source).slice(0, 12000), method: "typescript-ast", fileDigest: digest(file.content), ...(url ? { url } : {}) };
  };
  const diagnose = (code: string, message: string): void => { facts.diagnostics.push({ code, message, path: file.path, stage: "extraction" }); };
  // Parse errors are observable through a Program without relying on private SourceFile fields.
  const host: ts.CompilerHost = {
    getSourceFile: name => name === file.path ? source : undefined,
    fileExists: name => name === file.path,
    readFile: name => name === file.path ? file.content : undefined,
    getDefaultLibFileName: () => "__no_lib__.d.ts",
    writeFile: () => { throw new Error("Analysis cannot emit target code"); },
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    directoryExists: () => false,
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = project?.program ?? ts.createProgram([file.path], { noLib: true, noResolve: true }, host);
  if (program.getSyntacticDiagnostics(source).length) {
    diagnose("parse-error", "File has TypeScript syntax errors; no facts extracted.");
    return facts;
  }
  const checker = program.getTypeChecker();
  const imported = new Map<string, { module: string; exported: string; symbol: ts.Symbol | undefined; resolved?: string }>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
        const symbol = checker.getSymbolAtLocation(specifier.name);
        const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const declaration = target?.declarations?.find(ts.isFunctionDeclaration);
        const path = declaration && project?.pathOf(declaration.getSourceFile());
        imported.set(specifier.name.text, { module: statement.moduleSpecifier.text, exported: specifier.propertyName?.text ?? specifier.name.text, symbol, ...(path && declaration?.name ? { resolved: `${path}#${declaration.name.text}` } : {}) });
      }
    }
  }
  const exports = (node: ts.Node): boolean => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  for (const node of functions) {
    if (!exports(node) || !node.name) continue;
    if (!node.body || node.asteriskToken || node.typeParameters?.length || functions.filter(candidate => candidate.name?.text === node.name?.text).length !== 1 || node.parameters.some(parameter => !ts.isIdentifier(parameter.name))) {
      diagnose("unsupported-function", `Function ${node.name.text}: overloads, generics, declarations or destructured parameters are unsupported.`);
      continue;
    }
    const calls = new Set<string>();
    const guardEvidence = new Map<string, Evidence>();
    const resolvedCalls = new Set<string>();
    let unresolvedCalls = 0;
    const callName = (expression: ts.Expression): string | undefined => {
      if (ts.isIdentifier(expression)) return expression.text;
      if (ts.isPropertyAccessExpression(expression)) {
        const receiver = callName(expression.expression);
        return receiver === undefined ? undefined : `${receiver}.${expression.name.text}`;
      }
      return undefined;
    };
    const visitBody = (child: ts.Node): void => {
      if (child !== node && ts.isFunctionLike(child)) return;
      if (ts.isCallExpression(child)) {
        const name = callName(child.expression);
        if (name !== undefined && guards.includes(name)) { calls.add(name); guardEvidence.set(name, evidence(child)); }
        if (project) {
          const declaration = checker.getResolvedSignature(child)?.declaration;
          const targetPath = declaration && project.pathOf(declaration.getSourceFile());
          if (declaration && !targetPath && declaration.getSourceFile().fileName.startsWith("/__lens_typescript_lib__/")) {
            // Trusted built-in library calls are outside the local target-set contract.
          } else if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name && declaration.body && ts.isSourceFile(declaration.parent) && targetPath && declaration.parent.statements.filter(candidate => ts.isFunctionDeclaration(candidate) && candidate.name?.text === declaration.name?.text).length === 1) {
            resolvedCalls.add(`${targetPath}#${declaration.name.text}`);
          } else unresolvedCalls++;
        }
      }
      ts.forEachChild(child, visitBody);
    };
    visitBody(node);
    if (unresolvedCalls) diagnose("unresolved-calls", `${node.name.text}: ${unresolvedCalls} call(s) lack a supported resolved target; CALL001 is excluded for this function.`);
    facts.functions.push({ name: node.name.text, parameters: node.parameters.map(parameter => ({ name: parameter.name.getText(source), type: parameter.type?.getText(source) ?? null, optional: !!parameter.questionToken || !!parameter.initializer, rest: !!parameter.dotDotDotToken, initializer: parameter.initializer?.getText(source) ?? null })), returns: node.type?.getText(source) ?? null, guards: calls, guardEvidence, resolvedCalls, unresolvedCalls, source: evidence(node) });
  }
  for (const node of source.statements) {
    if (ts.isInterfaceDeclaration(node) && exports(node)) {
      if (node.typeParameters?.length || node.heritageClauses?.length || source.statements.filter(candidate => ts.isInterfaceDeclaration(candidate) && candidate.name.text === node.name.text).length !== 1) {
        diagnose("unsupported-interface", `Interface ${node.name.text}: generic, inherited or merged declarations are unsupported.`);
        continue;
      }
      const fields = new Map<string, { optional: boolean; source: Evidence }>();
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) fields.set(member.name.text, { optional: !!member.questionToken, source: evidence(member) });
        else diagnose("unsupported-field", `Interface ${node.name.text} contains unsupported members.`);
      }
      facts.interfaces.push({ name: node.name.text, fields, source: evidence(node) });
    }
    if (exports(node) && (ts.isVariableStatement(node) || ts.isClassDeclaration(node) || ts.isExportDeclaration(node))) diagnose("unsupported-export", "Exported variables, classes, methods and re-exports are outside this syntax release.");
  }
  const isFramework = (name: string, family: readonly string[]): boolean => {
    const binding = imported.get(name);
    return !!binding && ["vitest", "@jest/globals"].includes(binding.module) && family.includes(binding.exported);
  };
  // Narrow contract: top-level imported test/it, or inside imported describe callbacks.
  const collectTests = (statements: ts.NodeArray<ts.Statement>, scope: string[]): void => {
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
      const call = statement.expression;
      let rootCall: ts.Expression = call.expression;
      while (ts.isPropertyAccessExpression(rootCall) || ts.isCallExpression(rootCall)) rootCall = rootCall.expression;
      const frameworkRoot = ts.isIdentifier(rootCall) && isFramework(rootCall.text, ["test", "it", "describe"]) && checker.getSymbolAtLocation(rootCall) === imported.get(rootCall.text)?.symbol;
      let callee = call.expression;
      let state: TestFact["state"] = "active";
      if (ts.isPropertyAccessExpression(callee) && ["skip", "todo"].includes(callee.name.text)) { state = callee.name.text as "skip" | "todo"; callee = callee.expression; }
      if (!ts.isIdentifier(callee)) { if (frameworkRoot) diagnose("unsupported-test", "Parameterized, conditional or wrapped test/suite calls are unsupported."); continue; }
      const title = call.arguments[0];
      const callback = call.arguments[1];
      if (!title || !ts.isStringLiteral(title)) { if (frameworkRoot) diagnose("unsupported-test", "Test and suite titles must be static string literals."); continue; }
      if (isFramework(callee.text, ["describe"]) && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
        if (state !== "active" || !frameworkRoot) { diagnose("unsupported-test", "Modified or shadowed describe calls are unsupported."); continue; }
        collectTests(callback.body.statements, [...scope, title.text]);
      }
      if (!isFramework(callee.text, ["test", "it"]) || checker.getSymbolAtLocation(callee) !== imported.get(callee.text)?.symbol) continue;
      if (state !== "todo" && (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body))) { diagnose("unsupported-test", "Test requires a literal title and block callback."); continue; }
      const assertions: Evidence[] = [];
      const references = new Set<string>();
      const resolvedReferences = new Set<string>();
      if (callback) walk(callback, child => {
        if (ts.isIdentifier(child) && imported.has(child.text)) {
          const binding = imported.get(child.text)!;
          if (checker.getSymbolAtLocation(child) === binding.symbol) {
            if (binding.module.startsWith(".")) references.add(`${binding.module}#${binding.exported}`);
            if (binding.resolved) resolvedReferences.add(binding.resolved);
          }
        }
        if (!ts.isCallExpression(child)) return;
        let expression: ts.Expression = child.expression;
        while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && isFramework(expression.expression.text, ["expect"]) && checker.getSymbolAtLocation(expression.expression) === imported.get(expression.expression.text)?.symbol) {
          if (ts.isPropertyAccessExpression(child.expression) && ["toBe", "toEqual", "toThrow"].includes(child.expression.name.text)) assertions.push(evidence(child));
          else diagnose("unsupported-assertion", "Only expect(...)[.not/.rejects/.resolves].toBe/toEqual/toThrow assertions are supported.");
        }
      });
      facts.tests.push({ name: [...scope, title.text].join(" / "), state, assertions, references, resolvedReferences, source: evidence(call) });
    }
  };
  collectTests(source.statements, []);
  for (const test of facts.tests) if (facts.tests.filter(candidate => candidate.name === test.name).length > 1) diagnose("ambiguous-test", `Duplicate test title ${test.name}; matching will be skipped.`);
  return facts;
}
