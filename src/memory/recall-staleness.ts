import { lstatSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDenied } from "./platform.ts";
import { fold, type StandalonePolicy } from "./policy.ts";
import { nodePath } from "./project.ts";
import type { View } from "./store.ts";

export interface RecallStalenessOptions {
  cwd: string; rootConfirmed?: boolean; deny?: readonly string[]; policy?: () => StandalonePolicy;
  /** Host-only lexical glob/private-path checks run before any filesystem probe. */
  allowedPath?: (path: string) => boolean;
  maxProbes?: number;
  probe?: (path: string) => Pick<Stats, "isSymbolicLink" | "isDirectory" | "mtimeMs">;
}
type PathState = { state: "present"; mtime: number } | { state: "missing" | "unknown" };
/** Call-scoped metadata hint only. Unknown/denied paths never become a marker or a filesystem query. */
export function createRecallStalenessProbe(options: RecallStalenessOptions): (view: Pick<View, "about" | "at">) => boolean | undefined {
  const root = resolve(options.cwd), cache = new Map<string, PathState>(), requested = options.maxProbes ?? 32;
  let remaining = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 32) : 0;
  const allowed = (path: string): boolean => {
    try { return !isDenied(path, [...options.deny ?? []]) && !isDenied(fold(path), [...options.deny ?? []].map(fold)) && options.allowedPath?.(path) !== false && (!options.policy || options.policy().screenStandalone({ path })); }
    catch { return false; }
  };
  const inspect = (path: string): PathState => {
    if (!path || path.length > 4096 || isAbsolute(path) || /[\p{Cc}\p{Cf}\\]/u.test(path) || path.split("/").includes("..") || !allowed(path)) return { state: "unknown" };
    const target = resolve(root, path), rel = relative(root, target); let current = root;
    if (!rel || rel.startsWith("../") || isAbsolute(rel)) return { state: "unknown" };
    const chainAllowed = () => { let at = root; for (const part of rel.split("/")) { at = join(at, part); if (!allowed(relative(root, at))) return false; } return true; };
    if (!chainAllowed()) return { state: "unknown" };
    if (cache.has(path)) return cache.get(path)!;
    for (const component of rel.split("/")) {
      current = join(current, component); const name = relative(root, current);
      if (remaining < 1 || !allowed(name)) return { state: "unknown" };
      remaining--;
      try {
        const stat = (options.probe ?? lstatSync)(current);
        if (stat.isSymbolicLink() || current !== target && !stat.isDirectory()) return { state: "unknown" };
        if (current === target) { const value: PathState = Number.isFinite(stat.mtimeMs) ? { state: "present", mtime: stat.mtimeMs } : { state: "unknown" }; if (!chainAllowed()) return { state: "unknown" }; cache.set(path, value); return value; }
      } catch (error) { const value: PathState = { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown" }; if (!chainAllowed()) return { state: "unknown" }; cache.set(path, value); return value; }
    }
    return { state: "unknown" };
  };
  // ponytail: same-user ancestor swaps are outside the current metadata-only fence. Descriptor-relative traversal
  // is required before treating concurrent hostile filesystem mutation as supported. No source/symbol index is stored.
  return view => {
    const at = Date.parse(view.at); if (!Number.isFinite(at)) return undefined;
    let known = false;
    for (const node of view.about) {
      const path = nodePath(node); if (path === undefined) continue;
      const state = inspect(path);
      if (state.state === "missing" && options.rootConfirmed === true || state.state === "present" && state.mtime > at) return true;
      known ||= state.state === "present";
    }
    return known ? false : undefined;
  };
}
