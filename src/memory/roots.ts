import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { effectiveAliases } from "./aliases.ts";
import { indexFileName } from "./index-file.ts";
import { realPath } from "./platform.ts";
import { memoryProjectKey } from "./project.ts";

/**
 * #581: which project key each working directory resolved to last, on this machine. `roots.jsonl` in the memory home
 * holds only `sha256(realPath(dir))`, never path text, and is never synced or exported. Append-only; the latest line
 * per root wins. The only writer is the native SessionStart path (first sight, and a re-bind after an alias settled a
 * transition); `amem project keep-separate --confirm` appends a `keep`. Status, doctor and MCP only read it.
 */
export const ROOTS_SCHEMA = "agent-mem.roots/v1";
export const ROOTS_FILE = "roots.jsonl";
const READ_BOUND = 256 * 1024;

export interface RootLine { schema: typeof ROOTS_SCHEMA; op: "bind" | "keep"; root: string; key: string; prev?: string; at: string; machine?: string }
export interface ProjectTransition { state: "project_transition"; previousKey: string; key: string; previousCuratedNotes: number | null; aliasCommand: string; keepCommand: string }

/** The key every #581 reader and writer compares: the hook's own resolution, isolated from an inherited GIT_* environment. Raw, before alias resolution. */
export function transitionKey(cwd: string): string {
  return memoryProjectKey(cwd, { repositoryIsolation: true });
}

export const rootsLogPath = (home: string): string => join(home, ROOTS_FILE);

/**
 * The working root a directory belongs to: the nearest ancestor holding `.git` (a directory or a worktree's file),
 * found by `lstat` alone so the hook spawns no git process; without one, the directory itself.
 * ponytail: a submodule or nested repository is its own root, the same boundary `git rev-parse --show-toplevel` draws;
 * a repository more than 32 levels up is not found and the directory stands for itself.
 */
export function workingRoot(dir: string): string {
  const start = realPath(dir);
  for (let current = start, depth = 0; depth < 32; current = dirname(current), depth++) {
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) return current;
    if (dirname(current) === current) break;
  }
  return start;
}

/** sha256 hex of the working root's real path; the path text itself is never stored. */
export function rootHash(dir: string): string {
  return createHash("sha256").update(workingRoot(dir)).digest("hex");
}

/** Latest line per root, from at most the last 256 KB. Missing, unreadable or malformed input yields fewer lines, never a throw. */
export function readRootBindings(home: string, maxBytes = READ_BOUND): Map<string, RootLine> {
  const latest = new Map<string, RootLine>();
  let text = "";
  try {
    const fd = openSync(rootsLogPath(home), "r");
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - maxBytes), buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the cut first line
    } finally { closeSync(fd); }
  } catch { return latest; }
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      const line = JSON.parse(raw) as RootLine;
      if (line?.schema !== ROOTS_SCHEMA || (line.op !== "bind" && line.op !== "keep") || typeof line.root !== "string" || !/^[0-9a-f]{64}$/.test(line.root) || typeof line.key !== "string" || !line.key) continue;
      latest.set(line.root, line);
    } catch { /* a malformed line is skipped */ }
  }
  return latest;
}

const shellWord = (word: string) => /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
export const aliasCommandFor = (previousKey: string, key: string) => `amem alias add ${shellWord(previousKey)} ${shellWord(key)}`;
export const KEEP_COMMAND = "amem project keep-separate";

/** Two keys one alias hop apart (either direction, or both onto one canonical key) are already joined. */
function joined(aliases: Map<string, string>, a: string, b: string): boolean {
  return (aliases.get(a) ?? a) === (aliases.get(b) ?? b);
}

/** The transition for this root, if its recorded key differs from `key` and nothing joins or keeps them apart. Never throws. */
export function projectTransition(home: string, dir: string, key: string, countCurated?: (key: string) => number | null): ProjectTransition | undefined {
  try {
    const line = readRootBindings(home).get(rootHash(dir));
    if (!line || line.key === key) return undefined;
    if (joined(effectiveAliases(home), line.key, key)) return undefined;
    let previousCuratedNotes: number | null = null;
    try { previousCuratedNotes = countCurated ? countCurated(line.key) : null; } catch { previousCuratedNotes = null; }
    return { state: "project_transition", previousKey: line.key, key, previousCuratedNotes, aliasCommand: aliasCommandFor(line.key, key), keepCommand: KEEP_COMMAND };
  } catch { return undefined; }
}

export function transitionNotice(t: ProjectTransition): string {
  const count = t.previousCuratedNotes === null ? "" : ` (${t.previousCuratedNotes} curated notes)`;
  return `amem: project key changed for this directory: was ${t.previousKey}${count}, now ${t.key}. Join: ${t.aliasCommand}  Keep apart: ${t.keepCommand}`;
}

/** Curated notes a key holds, from its derived index read-only (busy 0); null when the index is absent, locked or unreadable. A bounded local read. */
export function curatedCount(home: string, key: string, shardDir: (home: string, key: string) => string): number | null {
  // A curated shard's own index first, then a shared-v1 home's single index (which holds every project's rows).
  for (const file of [indexFileName(false), indexFileName(true)].flatMap(name => [join(shardDir(home, key), name), join(home, name)])) {
    let db: Database | undefined;
    try {
      if (!lstatSync(file, { throwIfNoEntry: false })) continue;
      db = new Database(file, { readonly: true });
      db.run("PRAGMA busy_timeout = 0");
      return (db.query("SELECT COUNT(*) AS n FROM entries WHERE scope = 'project' AND project = ?").get(key) as { n: number }).n;
    } catch { return null; } finally { db?.close(); }
  }
  return null;
}

function machineOf(home: string): string | undefined {
  try { const id = JSON.parse(readFileSync(join(home, "machine.json"), "utf8")).id; return typeof id === "string" ? id : undefined; } catch { return undefined; }
}

function append(home: string, line: RootLine): void {
  appendFileSync(rootsLogPath(home), JSON.stringify(line) + "\n", { mode: 0o600 });
}

/**
 * The SessionStart writer. Appends a `bind` on first sight of a root, and a re-bind when the recorded key is already
 * alias-joined to the resolved one (so a later change names the middle key). A differing, unjoined key is left alone
 * so the notice persists until a person settles it. Fail-open: a write or read error yields no line and no throw.
 */
export function observeRoot(home: string, dir: string, key: string, now: () => number = Date.now): "appended" | "unchanged" | "transition" | "failed" {
  try {
    const root = rootHash(dir), line = readRootBindings(home).get(root);
    if (line?.key === key) return "unchanged";
    if (line && !joined(effectiveAliases(home), line.key, key)) return "transition";
    const machine = machineOf(home);
    append(home, { schema: ROOTS_SCHEMA, op: "bind", root, key, at: new Date(now()).toISOString(), ...(machine ? { machine } : {}) });
    return "appended";
  } catch { return "failed"; }
}

/** `amem project keep-separate --confirm`: record the resolved key for this root on purpose, ending the transition without joining. */
export function recordKeepSeparate(home: string, dir: string, transition: ProjectTransition, now: () => number = Date.now): RootLine {
  const machine = machineOf(home);
  const line: RootLine = { schema: ROOTS_SCHEMA, op: "keep", root: rootHash(dir), key: transition.key, prev: transition.previousKey, at: new Date(now()).toISOString(), ...(machine ? { machine } : {}) };
  append(home, line);
  return line;
}
