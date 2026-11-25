/**
 * #612: a derived, machine-local cache that lets a placement publication with nothing to do skip policy evaluation.
 * It holds one key digest and the four not-needed decision counts, never a path, row id or text. It is never read
 * for publication, capture or import: a hit only returns `not-needed` with the stored counts, and any read failure,
 * unknown schema, size overrun, bad count or key mismatch takes the full path. Deleting it is always safe.
 * ponytail: one file per publication slot (sha256 of the epoch and its selected realms) under `<home>/sync-noop-cache/`; upgrade path is a per-publication key set
 * if stale slots ever accumulate past a handful per home (prune slots not seen in the last run).
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";

export const PLACEMENT_NOOP_CACHE_SCHEMA = "agent-mem.placement-noop-cache/v1";
export const PLACEMENT_NOOP_CACHE_MAX_BYTES = 512;
export const PLACEMENT_NOOP_CACHE_DIR = "sync-noop-cache";

export interface PlacementNoopCounts { permitted: number; local: number; declined: number; held: number }
export interface PlacementNoopKeyInput {
  version: string; writersHash: string; policyHash: string; sourceHash: string; aliasesHash: string; contextHash: string; markerHash: string;
  remoteHash: string; journal: { sequence: number; headHash: string };
  targets: readonly { remote: string | null; local: string | null; pruned: readonly string[]; fetched: readonly string[] }[];
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const HEX64 = /^[a-f0-9]{64}$/;
const SLOT = HEX64;

/** The reuse key: every input a no-op decision depends on. Any change produces a different digest. */
export function placementNoopKey(input: PlacementNoopKeyInput): string {
  return sha(canonicalJSON({ ...input, targets: input.targets.map(t => ({ ...t, pruned: [...t.pruned].sort(), fetched: [...t.fetched].sort() })) }));
}

function file(home: string, slot: string): string | undefined {
  return SLOT.test(slot) ? join(home, PLACEMENT_NOOP_CACHE_DIR, `${slot}.json`) : undefined;
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Stored counts when the file holds exactly `key`; undefined on any other state. Never throws. */
export function readPlacementNoopCache(home: string, slot: string, key: string): PlacementNoopCounts | undefined {
  try {
    const path = file(home, slot); if (!path) return undefined;
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size > PLACEMENT_NOOP_CACHE_MAX_BYTES) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) return undefined;
    if (value.schema !== PLACEMENT_NOOP_CACHE_SCHEMA || typeof value.key !== "string" || !HEX64.test(value.key) || value.key !== key) return undefined;
    const c = value.counts as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length !== 4) return undefined;
    if (!count(c.permitted) || !count(c.local) || !count(c.declined) || !count(c.held)) return undefined;
    return { permitted: c.permitted, local: c.local, declined: c.declined, held: c.held };
  } catch { return undefined; }
}

/** Atomic private write (0700 directory, 0600 file, tmp then rename). Best effort: a failure only loses the cache. */
export function writePlacementNoopCache(home: string, slot: string, key: string, counts: PlacementNoopCounts): void {
  const path = file(home, slot); if (!path || !HEX64.test(key)) return;
  if (![counts.permitted, counts.local, counts.declined, counts.held].every(count)) return;
  const bytes = Buffer.from(canonicalJSON({ schema: PLACEMENT_NOOP_CACHE_SCHEMA, key, counts: { permitted: counts.permitted, local: counts.local, declined: counts.declined, held: counts.held } }) + "\n");
  if (bytes.length > PLACEMENT_NOOP_CACHE_MAX_BYTES) return;
  const dir = join(home, PLACEMENT_NOOP_CACHE_DIR), temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const fd = openSync(temp, "wx", 0o600);
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } catch { try { rmSync(temp, { force: true }); } catch { /* cache only */ } }
}

/** Invalidate: any outcome other than not-needed. Never throws. */
export function clearPlacementNoopCache(home: string, slot: string): void {
  try { const path = file(home, slot); if (path) rmSync(path, { force: true }); } catch { /* cache only */ }
}
