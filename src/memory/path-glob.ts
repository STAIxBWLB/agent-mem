/**
 * `pii.paths` matching, ported from agent-hub (`src/hub/path-policy.ts`: `policyPaths`, `patternScope`, `matchesPolicyLexically`; `src/hub/memory-policy.ts`:
 * `mentionsPrivatePath`) so the repo scope screens with the semantics the project's own config was written for: exact paths and subtrees, `*`, `?` and
 * whole-segment `**` globs, case and Unicode folded like a case-insensitive disk. amem imports no agent-hub code, so this is a port, and
 * `test/path-policy-parity.test.ts` pins it to values produced by the hub's real matcher (`scripts/gen-path-policy-parity.ts`).
 *
 * Lexical only. The hub's `matchesPolicy` also resolves real paths and symlink aliases against the filesystem; a note merely names a path, so nothing here
 * reads the disk. The port keeps the hub's `includeParents` stance (a directory that could hold a protected descendant counts), the over-protective side:
 * for a file that exists the hub is narrower, never broader.
 * ponytail: no symlink alias discovery. Upgrade: ask the host (agent-hub) for the verdict through the library API once amem has a host policy port for paths.
 */
import { posix } from "node:path";
import { nodePath, pathCandidates } from "./project.ts";

/** One spelling per name, as a case-insensitive disk sees it (agent-hub `foldSegment`). */
const foldSegment = (segment: string): string => segment.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase().toUpperCase().toLowerCase();

/** Bounded project-relative exact paths/subtrees or `*`, `?` and whole-segment `**` globs (agent-hub `policyPaths`). Throws on anything the hub would refuse. */
export function policyEntries(raw: unknown, field: string): string[] {
  const bad = raw === undefined ? false : !Array.isArray(raw) || raw.length > 64 || raw.some(p => typeof p !== "string" || !p || p.length > 200 || posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || /[\[\]{}!]/.test(p) || /[\x00-\x1f\x7f]/.test(p) || p.split(/[\\/]/).includes("..")
    || (/[?*]/.test(p) && (p.includes("\\") || (p.match(/[?*]/g)?.length ?? 0) > 16 || p.split("/").some(s => s.includes("**") && s !== "**"))));
  if (bad) throw new Error(`${field} takes up to 64 bounded project-relative paths or *, ? and whole-segment ** patterns of at most 200 characters (no absolute paths, .., brackets, braces or !)`);
  if (raw === undefined) return [];
  return [...new Set((raw as string[]).map(p => p.replace(/\/+/g, "/").replace(/\/$/, "") || "."))];
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
const beneath = (path: string, root: string) => within(path.toLowerCase(), root.toLowerCase()) || within(foldSegment(path), foldSegment(root));

/** Either spelling protects: the lowercase comparison keeps `?` matching one code point whose fold expands, the folded one catches NFD/NFC and compatibility aliases. */
const segmentMatches = (pattern: string, name: string): boolean => wildcard(pattern.toLowerCase(), name.toLowerCase()) || wildcard(foldSegment(pattern), foldSegment(name));
/** Linear-space wildcard DP, no regex backtracking on untrusted paths. */
function wildcard(pattern: string, name: string): boolean {
  const chars = [...name];
  let previous = new Array<boolean>(chars.length + 1).fill(false); previous[0] = true;
  for (const char of pattern) {
    const next = new Array<boolean>(chars.length + 1).fill(false);
    next[0] = char === "*" && previous[0]!;
    for (let i = 1; i <= chars.length; i++) next[i] = char === "*" ? previous[i]! || next[i - 1]! : previous[i - 1]! && (char === "?" || char === chars[i - 1]);
    previous = next;
  }
  return previous[chars.length]!;
}
function closure(pattern: string[], states: Set<number>): Set<number> {
  const out = new Set(states);
  for (const i of out) if (pattern[i] === "**") out.add(i + 1);
  return out;
}
function advance(pattern: string[], states: Set<number>, name: string): Set<number> {
  const next = new Set<number>();
  for (const i of closure(pattern, states)) {
    if (pattern[i] === "**") next.add(i);
    else if (pattern[i] !== undefined && segmentMatches(pattern[i]!, name)) next.add(i + 1);
  }
  return closure(pattern, next);
}
function patternScope(pattern: string[], path: string, includeParents: boolean): boolean {
  if (posix.isAbsolute(path) || path === ".." || path.startsWith("../")) return false;
  let states = closure(pattern, new Set([0]));
  if (states.has(pattern.length)) return true;
  for (const name of path.split("/").filter(p => p && p !== ".")) {
    states = advance(pattern, states, name);
    if (states.has(pattern.length)) return true; // a matched directory protects its entire subtree
    if (!states.size) return false;
  }
  return includeParents && states.size > 0; // this scope can contain a future protected descendant
}

const ROOT = "/project";
const segments = (entry: string) => entry.split("/").filter(p => p && p !== ".");

/** Whether `path` (project-relative as written in a note) falls under any entry: the hub's `matchesPolicy` without the filesystem. */
export function matchesEntries(path: string, entries: readonly string[], includeParents = true): boolean {
  if (!entries.length) return false;
  try {
    if (path.length > 4096) return true;
    const lexical = posix.resolve(ROOT, path), relative = posix.relative(ROOT, lexical);
    return entries.some(entry => {
      if (/[?*]/.test(entry)) return patternScope(segments(entry), relative, includeParents);
      const target = posix.resolve(ROOT, entry);
      return beneath(lexical, target) || includeParents && beneath(target, lexical) || patternScope([...segments(entry), "**"], relative, includeParents);
    });
  } catch { return true; }
}

/** Whether a note's text or its path links name a private path (agent-hub `mentionsPrivatePath`): written paths, and an entry's literal part written out. */
export function mentionsPrivatePath(text: string, about: readonly string[], entries: readonly string[]): boolean {
  if (!entries.length) return false;
  const nfc = (value: string) => value.normalize("NFC"), body = nfc(text), policy = entries.map(nfc);
  const paths = [...about.map(nodePath), ...pathCandidates(body)].filter((p): p is string => p !== undefined).map(nfc);
  if (paths.some(path => matchesEntries(path, policy, true))) return true;
  // The entry's literal part (up to its first glob character) written out: catches a path a word split breaks (a space).
  return policy.some(entry => { const literal = entry.replace(/^\.\//, "").split(/[*?[\]{}]/)[0]!.replace(/\/+$/, ""); return /[/\s]/.test(literal) && body.includes(literal); });
}
