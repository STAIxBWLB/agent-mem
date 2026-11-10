import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { pendingSummary } from "../memory/candidate-pending.ts";
import { realPath } from "../memory/platform.ts";
import { inboxPolicyVersion } from "./inbox.ts";

type Scope = "home" | "realm" | "projects" | "generations" | "machines" | "machine" | "work" | "logs" | "evidence";
type Source = Scope | "file";
// ponytail: at most 16,384 directory entries and 24 levels per probe, including ignored entries.
// Refuse larger inventories; upgrade to an authoritative append-revision manifest before increasing these bounds.
const MAX_ENTRIES = 16_384, MAX_DEPTH = 24;
const realms = new Set(["user", "legacy", "legacy-main"]);
const evidence = new Set(["bridge-snapshots", "public-prune-objects", "public-prune-inputs", "public-prune-input-sets", "sync-placement"]);
const databases = /^(?:capture|candidates)\.db(?:-wal|-journal)?$/;
const derived = /^(?:index(?:-[a-z0-9]+)*|search(?:-[a-f0-9]+)?|catalog|mutation-lock|reader-admission)\.db(?:-(?:wal|shm|journal))?$/;

function source(scope: Scope, name: string): Source | undefined {
  if (name === ".git" || name === "node_modules" || name === "reader-leases" || name === "leases" || name === "readers" || name === "shard-readers"
    || name.endsWith("-shm") || derived.test(name) || /^brief-(?:capture|curated)\.json$/.test(name)) return;
  if (scope === "logs") return name.endsWith(".jsonl") ? "file" : undefined;
  if (scope === "projects") return /^[a-f0-9]{16}$/.test(name) ? "realm" : undefined;
  if (scope === "generations") return /^[a-f0-9]{32}$/.test(name) ? "realm" : undefined;
  if (scope === "machines") return "machine";
  if (scope === "machine") return databases.test(name) || name === "config.json" ? "file" : undefined;
  if (scope === "work") return name === "log" ? "logs" : undefined;
  if (scope === "evidence") return "evidence";
  if (name === "log" || name === "local") return "logs";
  if (name === "projects") return "projects";
  if (name === "generations") return "generations";
  if (name === "machine") return "machines";
  if (name === "work") return "work";
  if (realms.has(name)) return "realm";
  if (evidence.has(name)) return "evidence";
  if (name === "profile.lock" || databases.test(name) || /\.(?:json|jsonl)$/.test(name)) return "file";
}

/** Metadata of authoritative console inputs only. No payloads, read-write stores, index refresh or reader lease. */
export function snapshotRevision(base: string, now = Date.now()): string {
  if (!Number.isFinite(now)) throw Error("snapshot revision clock is unavailable");
  try { base = realPath(base); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const frames: unknown[] = [];
  let entries = 0;
  const walk = (relative: string, expected: Source, depth: number) => {
    if (depth > MAX_DEPTH) throw Error("snapshot source inventory exceeds its depth bound");
    const file = join(base, relative), stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      if (relative) throw Error("snapshot source changed during inventory");
      frames.push(["", "missing"]); return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw Error("snapshot source is not a plain file or directory");
    if (stat.isFile()) {
      if (expected !== "file" && expected !== "evidence") throw Error("snapshot source directory is unavailable");
      if (file.endsWith("-wal") && stat.size === 0n) return; // A read-only SQLite open may recreate an empty WAL.
      frames.push([relative, "file", String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
      return;
    }
    if (expected === "file") throw Error("snapshot source file is unavailable");
    const children: { name: string; kind: Source }[] = [], iterator = opendirSync(file);
    try {
      for (;;) {
        const child = iterator.readSync(); if (!child) break;
        if (++entries > MAX_ENTRIES) throw Error("snapshot source inventory exceeds its entry bound");
        const kind = expected === "machines" && !child.isDirectory() && !child.isSymbolicLink() ? undefined : source(expected, child.name);
        if (kind) children.push({ name: child.name, kind });
      }
    } finally { iterator.closeSync(); }
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const start = frames.length;
    frames.push(undefined);
    const names: string[] = [];
    for (const child of children) {
      const before = frames.length;
      walk(relative ? `${relative}/${child.name}` : child.name, child.kind, depth + 1);
      if (frames.length > before) names.push(child.name);
    }
    // Readers may create an otherwise empty work/log tree alongside its disposable index.
    if (relative && !names.length) { frames.splice(start, 1); return; }
    // Directory times/size also change for excluded indexes and leases. Namespace plus identity tracks sources without that churn.
    frames[start] = [relative, "directory", String(stat.dev), String(stat.ino), String(stat.mode), names];
  };
  walk("", "home", 0);
  const policy = inboxPolicyVersion(base), pending = pendingSummary(base, undefined, now, true);
  if (pending === null) throw Error("snapshot pending candidates are unavailable");
  return createHash("sha256").update(JSON.stringify({ frames, policy, pending })).digest("hex");
}
