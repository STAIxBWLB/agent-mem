import { isBuiltin } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { realPath } from "../src/memory/platform.ts";

const root = realPath(resolve(import.meta.dir, "../src"));
const failures: string[] = [];
let files = 0;
const inside = (path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };

function check(path: string): void {
  files++;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  function fail(node: ts.Node, message: string): void {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    failures.push(`${relative(root, path)}:${line}: ${message}`);
  }
  function dependency(node: ts.Node, specifier: ts.Node | undefined): void {
    if (!specifier || !ts.isStringLiteralLike(specifier)) { fail(node, "dependency must be a string literal"); return; }
    const name = specifier.text;
    if (isBuiltin(name) || name === "bun:sqlite") return;
    if (!name.startsWith("./") && !name.startsWith("../")) { fail(node, `non-built-in dependency ${name}`); return; }
    try {
      const target = realPath(resolve(dirname(path), name));
      if (!inside(target) || !statSync(target).isFile()) fail(node, `dependency leaves src or is not a file: ${name}`);
    } catch { fail(node, `unresolved dependency ${name}`); }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) dependency(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      dependency(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      dependency(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      dependency(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) { failures.push(`${relative(root, path)}: source symlinks are not allowed`); continue; }
    if (entry.isDirectory()) walk(path);
    else if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extname(path))) check(path);
  }
}
walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`boundary: OK (${files} source files)`);
