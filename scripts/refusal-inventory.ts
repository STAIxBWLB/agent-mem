import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { completionDefinitions } from "../src/commands-table.ts";

export interface BaselineEntry { file: string; message: string }
export interface Refusal extends BaselineEntry { line: number; marked: boolean }
export interface Finding extends BaselineEntry { line?: number; reason: string }

const classes = new Set(["Error", "CommandUsageError", "AgentUsageError"]);
const marker = /refusal-by-design: (?:operator-knowledge|world-action|human-authority) [^*\s]/;
const definitions = new Map(completionDefinitions().map(row => [row.path.join(" "), row]));

function staticText(node: ts.Expression, checker?: ts.TypeChecker, depth = 0): string[] {
  const joinParts = (left: string[], right: string[]) => {
    if (left.length * right.length > 128) throw Error("refusal has too many static message alternatives; use separate throw statements");
    return left.flatMap(a => right.map(b => a + b));
  };
  const render = (part: ts.Expression) => staticText(part, checker, depth + 1);
  if (depth < 8) {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((head, span) => joinParts(head, render(span.expression).map(text => text + span.literal.text)), [node.head.text]);
    if (ts.isConditionalExpression(node)) return [...render(node.whenTrue), ...render(node.whenFalse)];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return render(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return joinParts(render(node.left), render(node.right));
    if (ts.isIdentifier(node) || ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      let symbol = checker?.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker?.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      if (ts.isIdentifier(node) && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) return render(declaration.initializer);
      if (ts.isCallExpression(node) && declaration && ts.isFunctionDeclaration(declaration) && declaration.body?.statements.length === 1) {
        const statement = declaration.body.statements[0]!;
        if (ts.isReturnStatement(statement) && statement.expression) return render(statement.expression);
      }
    }
  }
  // ponytail: unresolved calls and expressions carry a stable source fingerprint, never guessed runtime text.
  return [`<dynamic:${createHash("sha256").update(node.getText()).digest("hex").slice(0, 16)}>`];
}

export function collectRefusals(file: string, text: string, source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), checker?: ts.TypeChecker): Refusal[] {
  const result: Refusal[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isThrowStatement(node)) {
      const error = node.expression;
      if ((ts.isNewExpression(error) || ts.isCallExpression(error)) && ts.isIdentifier(error.expression) && classes.has(error.expression.text)) {
        const argument = error.arguments?.[0];
        const comments = text.slice(node.getFullStart(), node.getStart(source)) + (argument ? text.slice(argument.getFullStart(), argument.getStart(source)) : "");
        const messages = argument ? staticText(argument, checker) : [""];
        for (const message of new Set(messages)) result.push({ file, message: message.replace(/\s+/g, " ").trim(),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, marked: marker.test(comments) });
      }
    }
    // A source-only opt-out on a returned fixed literal (for the deliberately opaque MCP failure).
    if (ts.isStringLiteralLike(node) && marker.test(text.slice(node.getFullStart(), node.getStart(source))) && !ts.isNewExpression(node.parent) && !ts.isCallExpression(node.parent))
      result.push({ file, message: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, marked: true });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

interface CommandMentions { named: boolean; invalid: string[] }
function commandMentions(message: string): CommandMentions {
  const invalid: string[] = [];
  let named = false;
  for (const match of message.matchAll(/\bamem\s+(--[a-z][\w-]*|[a-z][\w-]*)(?![\w/-])/gi)) {
    const first = match[1]!, start = match.index!;
    const lead = message.slice(0, start);
    const explicit = start === 0 || /(?:\b(?:run|rerun|preview|use|invoke|try|execute|usage:|command:)\s+|[`'"]\s*)$/i.test(lead);
    const rest = message.slice(start + match[0].length);
    // Shell-quoted arguments can contain the same punctuation that ends a remedy in prose.
    const tail = rest.replace(/\s+(?:"[^"]*"|'[^']*')(?=\s|$)/g, " <quoted>").split(/\|\s*amem\b|&&|[;\n,`"()]|[.!?](?=\s|$)|\band (?:run|use|then)\b|\b(?:before|after|then|works)\b/i)[0] ?? "";
    if (!explicit && first === "version" && /\b(?:older|newer|current|installed)\s+$/i.test(lead)) continue;
    if (!definitions.has(first) && !first.startsWith("--")) {
      if (explicit) invalid.push(`unknown command amem ${first}`);
      continue;
    }
    const path = first.startsWith("--") ? [] : [first];
    const args = [first.startsWith("--") ? first : "", tail].join(" ").match(/<[^>]+>|'[^']*'|--[a-z][\w-]*(?:=[^\s|\]]+)?|-[a-z](?![\w-])|[a-z0-9][\w-]*/gi) ?? [];
    let row = definitions.get(path.join(" "))!;
    let i = 0;
    if (path[0] === "help" && args[0] && /^[a-z]/i.test(args[0]!)) {
      const helpTarget = args[i++]!;
      const target = definitions.get(helpTarget);
      if (!target) { invalid.push(`unknown command amem help ${helpTarget}`); continue; }
      path.push(helpTarget);
      row = target;
    }
    while (row.children.length && args[i] && /^[a-z]/i.test(args[i]!)) {
      const child = args[i++]!;
      if (!row.children.includes(child)) {
        invalid.push(`unknown command amem ${[...path, child].join(" ")}`);
        break;
      }
      path.push(child);
      row = definitions.get(path.filter(part => part !== "help").join(" "))!;
    }
    named ||= path.length > 0;
    for (const token of args.slice(i)) {
      if (!token.startsWith("-")) continue;
      const flag = token.split("=")[0]!;
      if (!Object.hasOwn(row.options, flag)) invalid.push(`unknown flag ${flag} for amem${path.length ? " " + path.join(" ") : ""}`);
    }
  }
  return { named, invalid };
}

const key = ({ file, message }: BaselineEntry) => JSON.stringify([file, message]);

export function checkRefusals(refusals: readonly Refusal[], baseline: readonly BaselineEntry[]): Finding[] {
  const remaining = new Set(baseline.map(key)), trusted = new Set(remaining);
  const findings: Finding[] = [];
  for (const refusal of refusals) {
    const { named, invalid } = commandMentions(refusal.message);
    for (const reason of invalid) findings.push({ ...refusal, reason });
    if (named || invalid.length || refusal.marked) continue;
    const id = key(refusal);
    remaining.delete(id);
    if (!trusted.has(id)) findings.push({ ...refusal, reason: "missing an amem command or refusal-by-design marker" });
  }
  const seen = new Set<string>();
  for (const entry of baseline) {
    const id = key(entry);
    if (remaining.has(id)) findings.push({ ...entry, reason: "unused baseline entry" });
    if (seen.has(id)) findings.push({ ...entry, reason: "duplicate baseline entry" });
    seen.add(id);
  }
  return findings;
}

export function baselineGrowth(baseline: readonly BaselineEntry[], base: readonly BaselineEntry[]): Finding[] {
  const old = new Set(base.map(key));
  return baseline.filter(entry => !old.has(key(entry))).map(entry => ({ ...entry, reason: "baseline grew; name a real command or mark the refusal" }));
}

const root = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = "scripts/refusal-inventory.baseline.json";
function readBaseline(text: string): BaselineEntry[] {
  const items: unknown = JSON.parse(text);
  if (!Array.isArray(items) || items.some(item => !item || typeof item.file !== "string" || typeof item.message !== "string")) throw Error("invalid refusal baseline");
  return items;
}

function main(argv: string[]): void {
  const files = ts.sys.readDirectory(join(root, "src"), [".ts"]).sort();
  const program = ts.createProgram(files, { noLib: true, allowImportingTsExtensions: true });
  const checker = program.getTypeChecker();
  const refusals = files.flatMap(file => collectRefusals(relative(root, file), readFileSync(file, "utf8"), program.getSourceFile(file), checker));
  const report = argv.includes("--report"), list = argv.includes("--list-unnamed"), index = argv.indexOf("--base");
  const baseline = report || list ? [] : readBaseline(readFileSync(join(root, baselinePath), "utf8"));
  const findings = checkRefusals(refusals, baseline);
  const unnamed = findings.filter(finding => finding.reason.startsWith("missing"));
  if (list) {
    const entries = [...new Map(unnamed.map(({ file, message }) => [key({ file, message }), { file, message }])).values()];
    console.log("[\n" + entries.map(entry => "  " + JSON.stringify(entry)).join(",\n") + "\n]");
    return;
  }
  if (index >= 0) {
    const sha = argv[index + 1];
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw Error("--base requires a full Git commit SHA");
    const filesAtBase = spawnSync("git", ["ls-tree", "--name-only", sha, "scripts/refusal-inventory.ts", baselinePath], { cwd: root, encoding: "utf8" });
    if (filesAtBase.status !== 0) throw Error("refusal baseline base commit is unavailable");
    const paths = filesAtBase.stdout.trim().split("\n");
    if (paths.includes(baselinePath)) {
      const before = spawnSync("git", ["show", `${sha}:${baselinePath}`], { cwd: root, encoding: "utf8" });
      if (before.status !== 0) throw Error("refusal baseline at the base commit is unreadable");
      findings.push(...baselineGrowth(baseline, readBaseline(before.stdout)));
    } else if (paths.includes("scripts/refusal-inventory.ts")) throw Error("the established refusal inventory requires a baseline at the base commit");
  }
  const shown = report ? findings.filter(finding => !finding.reason.startsWith("missing")) : findings;
  for (const finding of shown) console.error(`${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.reason}: ${finding.message}`);
  console.log(`refusals: ${refusals.length} message records, ${baseline.length} baseline entries, ${unnamed.length} unnamed findings, ${findings.length - unnamed.length} other findings`);
  if (!report && findings.length) process.exitCode = 1;
}

if (import.meta.main) main(process.argv.slice(2));
