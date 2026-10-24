import { extractNodes, type View } from "./store.ts";
import { nodePath } from "./project.ts";

export interface PlanGuardContext { cwd: string; project: string; repo: string; deny?: string[] }
/** Structural input accepts host task adapters without importing a host or a task board. */
export interface PlanGuardInput {
  paths?: readonly string[]; symbols?: readonly string[];
  refs?: { paths?: readonly string[] };
  plan?: { paths?: readonly string[]; symbols?: readonly string[] };
}
export function normalizeMemorySymbolInput(value: string): string {
  const at = value.lastIndexOf("@"), name = at < 0 ? value : value.slice(0, at);
  const normalized = name.startsWith("section ") || name.startsWith("source ") ? name : name.replace(/\s*\(.*$/, "").trim();
  return at < 0 ? normalized : `${normalized}@${value.slice(at + 1)}`;
}
/** Explicit inputs only. Per-input extraction retains more than v1's 64-node extraction cap. */
export function planGuardNodes(input: PlanGuardInput, context: PlanGuardContext): string[] {
  const nodes = new Set<string>();
  for (const path of [...input.paths ?? [], ...input.refs?.paths ?? [], ...input.plan?.paths ?? []]) {
    for (const node of extractNodes("", { ...context, paths: [path], checkExists: false })) nodes.add(node);
  }
  const only = nodes.size === 1 ? nodePath([...nodes][0]!) : undefined;
  for (const symbol of [...input.symbols ?? [], ...input.plan?.symbols ?? []]) {
    if (typeof symbol !== "string") continue;
    const at = symbol.lastIndexOf("@");
    const explicitPath = at < 0 ? undefined : extractNodes("", { ...context, paths: [symbol.slice(at + 1)], checkExists: false })[0];
    if (at >= 0 && !explicitPath) continue;
    const qualified = explicitPath ? `${symbol.slice(0, at)}@${nodePath(explicitPath)}` : symbol;
    for (const form of new Set([qualified, normalizeMemorySymbolInput(qualified)])) {
      for (const node of extractNodes("", { ...context, paths: only ? [only] : [], symbols: [form], checkExists: false })) nodes.add(node);
    }
  }
  return [...nodes].sort();
}
const samePath = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** Symbols require name and file identity; path scopes intersect only on whole components. */
export function planNodesIntersect(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.startsWith("symbol:") && right.startsWith("symbol:")) return normalizeMemorySymbolInput(left.slice(7)) === normalizeMemorySymbolInput(right.slice(7));
  const a = nodePath(left), b = nodePath(right);
  return !!a && !!b && samePath(a, b);
}
/** Callers screen complete live notes first; this pure matcher performs no I/O or writes. */
export function matchingPlanFails<T extends Pick<View, "kind" | "about" | "supersededBy">>(input: PlanGuardInput, notes: readonly T[], context: PlanGuardContext): T[] {
  const nodes = planGuardNodes(input, context);
  return nodes.length ? notes.filter(note => note.kind === "fail" && !note.supersededBy && note.about.some(about => nodes.some(node => planNodesIntersect(node, about)))) : [];
}
