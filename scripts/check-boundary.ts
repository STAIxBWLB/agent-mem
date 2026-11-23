import { isBuiltin } from "node:module";
import { readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { SKILL_NAMES } from "../src/skills-install.ts";
import { realPath } from "../src/memory/platform.ts";
import { dependencyReach } from "./boundary-graph.ts";

const root = realPath(resolve(import.meta.dir, "../src"));
const failures: string[] = [];
const manifest = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ "@staix/cli-output": "0.1.3" }) || Object.keys(manifest.optionalDependencies ?? {}).length || Object.keys(manifest.peerDependencies ?? {}).length)
  failures.push("package.json: keep only @staix/cli-output at exact version 0.1.3; remove other runtime, optional or peer dependencies");
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
    if (isBuiltin(name) || name === "bun:sqlite" || name === "@staix/cli-output") return;
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
const skillsRoot = resolve(root, "../skills");
function skillWalk(dir: string): void {
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { failures.push(`${dir}: skill directory must be real`); return; }
    for (const entry of readdirSync(dir)) {
      const file = resolve(dir, entry), st = lstatSync(file);
      if (st.isSymbolicLink()) failures.push(`${file}: skill symlink is forbidden`);
      else if (st.isDirectory()) skillWalk(file);
      else if (!st.isFile()) failures.push(`${file}: skill file must be regular`);
    }
  } catch { failures.push(`${dir}: skill directory unavailable`); }
}
skillWalk(skillsRoot);
for (const name of ["_shared/amem-adapter.md", ...SKILL_NAMES.map(name => `${name}/SKILL.md`)]) {
  try { const st = lstatSync(resolve(skillsRoot, name)); if (!st.isFile() || st.isSymbolicLink()) throw Error(); }
  catch { failures.push(`${name}: required skill file missing or unsafe`); }
}
for (const name of SKILL_NAMES) {
  try { lstatSync(resolve(skillsRoot, name, "references/amem-adapter.md")); failures.push(`${name}: injected adapter must not be in source`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`${name}: cannot inspect injected adapter`); }
}
const reach = dependencyReach(root);
failures.push(...reach.failures);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`boundary: OK (${files} source files, ${reach.roots} write-path roots, none reach a runtime dependency)`);
