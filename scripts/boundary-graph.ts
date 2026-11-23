import { isBuiltin } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * #592 option (a): writer pins cover only amem's own files, so no write-path module may reach a runtime dependency,
 * directly or through other src/ modules. Roots come from what a module does, so a new writer is covered without a list.
 */
const SOURCE = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
/** A root calls one of these filesystem mutations, hashes, or opens SQLite in its own source. */
export const WRITE_SIGNAL = /\b(?:writeFileSync|appendFileSync|openSync|writeSync|renameSync|ftruncateSync|truncateSync|mkdirSync|linkSync|symlinkSync|copyFileSync|rmSync|unlinkSync|rmdirSync|chmodSync|createWriteStream|createHash)\s*\(/;
/** Modules that decide what a writer may publish without writing themselves: the policy screen and writer identity. */
export const DECIDING = /^memory\/(?:policy|screen|sync-screen|sync-policy-inspection|sync-placement-writer[\w-]*)\.ts$/;

interface Edge { target: string; typeOnly: boolean }
function edges(path: string, text: string): Edge[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), out: Edge[] = [];
  const add = (specifier: ts.Node | undefined, typeOnly: boolean) => { if (specifier && ts.isStringLiteralLike(specifier)) out.push({ target: specifier.text, typeOnly }); };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)));
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly);
    else if (ts.isImportTypeNode(node)) { /* type position only */ }
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0], false);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Reads every source file under `srcRoot` (sorted, symlinks skipped: the per-file check refuses them). */
export function readSources(srcRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.includes(extname(path))) files.set(path, readFileSync(path, "utf8"));
    }
  };
  walk(srcRoot);
  return files;
}

const rel = (srcRoot: string, path: string) => relative(srcRoot, path).split("\\").join("/");
/** Where the write path lives (#592): the memory modules and the placement sync entry points. Person-facing entry points (cli, setup, ui) are reached only through these. */
export const WRITE_PATH_SCOPE = /^(?:memory\/[^/]+|sync-placement-[^/]+)\.ts$/;
export function writePathRoots(srcRoot: string, sources: ReadonlyMap<string, string>): string[] {
  return [...sources].filter(([path, text]) => { const name = rel(srcRoot, path); return WRITE_PATH_SCOPE.test(name) && (WRITE_SIGNAL.test(text) || DECIDING.test(name)); }).map(([path]) => path);
}

/** Each root that reaches a non-built-in package through runtime imports, with the shortest chain (breadth first). */
export function dependencyReach(srcRoot: string, sources: ReadonlyMap<string, string> = readSources(srcRoot)): { roots: number; failures: string[]; chains: string[][] } {
  const graph = new Map<string, Edge[]>();
  for (const [path, text] of sources) graph.set(path, edges(path, text));
  const resolveLocal = (from: string, target: string): string | undefined => {
    const path = resolve(dirname(from), target);
    try { return statSync(path).isFile() && sources.has(path) ? path : undefined; } catch { return undefined; }
  };
  const roots = writePathRoots(srcRoot, sources), failures: string[] = [], chains: string[][] = [];
  for (const root of roots) {
    const parent = new Map<string, string | null>([[root, null]]), queue = [root];
    let hit: { from: string; dependency: string } | undefined;
    while (queue.length && !hit) {
      const current = queue.shift()!;
      for (const edge of graph.get(current) ?? []) {
        if (edge.typeOnly) continue;
        if (edge.target.startsWith("./") || edge.target.startsWith("../")) {
          const next = resolveLocal(current, edge.target);
          if (next && !parent.has(next)) { parent.set(next, current); queue.push(next); }
        } else if (!isBuiltin(edge.target) && edge.target !== "bun:sqlite") { hit = { from: current, dependency: edge.target }; break; }
      }
    }
    if (!hit) continue;
    const chain = [hit.dependency];
    for (let at: string | null | undefined = hit.from; at; at = parent.get(at)) chain.unshift(rel(srcRoot, at));
    chains.push(chain);
    failures.push(`boundary: write-path root src/${chain[0]} reaches ${hit.dependency} through ${chain.join(" -> ")}; runtime dependencies stay off the write path (#592). Keep formatting that needs the package outside the writer's imports.`);
  }
  return { roots: roots.length, failures, chains };
}
