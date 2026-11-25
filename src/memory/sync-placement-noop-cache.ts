/**
 * #612: a derived, machine-local cache that lets a placement publication with nothing to do skip policy evaluation.
 * It holds one key digest and the four not-needed decision counts, never a path, row id or text. It is never read
 * for publication, capture or import: a hit only returns `not-needed` with the stored counts, and any read failure,
 * unknown schema, size overrun, bad count, foreign owner, loose mode, link or key mismatch takes the full path.
 * Deleting it is always safe. Every operation stays inside `<home>/sync-noop-cache/` and touches nothing else.
 * ponytail: one file per publication slot (sha256 of the epoch and its selected realms); the upgrade path is pruning
 * slots not seen in the last inventory run if stale slots ever accumulate past a handful per home.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";

export const PLACEMENT_NOOP_CACHE_SCHEMA = "agent-mem.placement-noop-cache/v1";
export const PLACEMENT_NOOP_CACHE_MAX_BYTES = 512;
export const PLACEMENT_NOOP_CACHE_DIR = "sync-noop-cache";

export interface PlacementNoopCounts { permitted: number; local: number; declined: number; held: number }
export interface PlacementNoopKeyInput {
  version: string; writersHash: string; screenIdentity: string | null; policyHash: string; sourceHash: string; aliasesHash: string; contextHash: string; markerHash: string;
  remoteHash: string; journal: { sequence: number; headHash: string };
  targets: readonly { remote: string | null; local: string | null; pruned: readonly string[]; fetched: readonly string[] }[];
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const HEX64 = /^[a-f0-9]{64}$/;

/** The reuse key: every input a no-op decision depends on. Any change produces a different digest. */
export function placementNoopKey(input: PlacementNoopKeyInput): string {
  return sha(canonicalJSON({ ...input, targets: input.targets.map(t => ({ ...t, pruned: [...t.pruned].sort(), fetched: [...t.fetched].sort() })) }));
}

const uid = () => process.getuid?.();
/** Owned by this user, no group/other bits, and the expected type. Symbolic links never qualify. */
function privateNode(stat: Stats | undefined, kind: "dir" | "file"): boolean {
  if (!stat || stat.isSymbolicLink() || (kind === "dir" ? !stat.isDirectory() : !stat.isFile())) return false;
  const owner = uid(); return (owner === undefined || stat.uid === owner) && (stat.mode & 0o077) === 0;
}
function cacheDir(home: string): string | undefined {
  const dir = join(home, PLACEMENT_NOOP_CACHE_DIR);
  try { return privateNode(lstatSync(dir, { throwIfNoEntry: false }), "dir") ? dir : undefined; } catch { return undefined; }
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0, NONBLOCK = constants.O_NONBLOCK ?? 0;

/** Stored counts when the file holds exactly `key`; undefined on any other state. Never throws, never writes. */
export function readPlacementNoopCache(home: string, slot: string, key: string): PlacementNoopCounts | undefined {
  if (!HEX64.test(slot)) return undefined;
  const dir = cacheDir(home); if (!dir) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, `${slot}.json`), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const stat = fstatSync(fd); if (!privateNode(stat, "file") || stat.size > PLACEMENT_NOOP_CACHE_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(PLACEMENT_NOOP_CACHE_MAX_BYTES + 1); let length = 0, read = 0;
    while ((read = readSync(fd, buffer, length, buffer.length - length, null)) > 0) { length += read; if (length > PLACEMENT_NOOP_CACHE_MAX_BYTES) return undefined; }
    if (!cacheDir(home)) return undefined; // the directory must still be the private one after the read
    const value = JSON.parse(buffer.subarray(0, length).toString("utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) return undefined;
    if (value.schema !== PLACEMENT_NOOP_CACHE_SCHEMA || typeof value.key !== "string" || !HEX64.test(value.key) || value.key !== key) return undefined;
    const c = value.counts as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length !== 4) return undefined;
    if (!count(c.permitted) || !count(c.local) || !count(c.declined) || !count(c.held)) return undefined;
    return { permitted: c.permitted, local: c.local, declined: c.declined, held: c.held };
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* cache only */ } }
}

/** Atomic private write (0700 directory, 0600 file, exclusive temporary then rename). Best effort: a failure only loses the cache. */
export function writePlacementNoopCache(home: string, slot: string, key: string, counts: PlacementNoopCounts): void {
  if (!HEX64.test(slot) || !HEX64.test(key) || ![counts.permitted, counts.local, counts.declined, counts.held].every(count)) return;
  const bytes = Buffer.from(canonicalJSON({ schema: PLACEMENT_NOOP_CACHE_SCHEMA, key, counts: { permitted: counts.permitted, local: counts.local, declined: counts.declined, held: counts.held } }) + "\n");
  if (bytes.length > PLACEMENT_NOOP_CACHE_MAX_BYTES) return;
  try { mkdirSync(join(home, PLACEMENT_NOOP_CACHE_DIR), { mode: 0o700 }); } catch { /* exists or unavailable: checked next */ }
  const dir = cacheDir(home); if (!dir) return;
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`); let created = false;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); created = true;
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    if (!cacheDir(home)) return;
    const target = join(dir, `${slot}.json`), prior = lstatSync(target, { throwIfNoEntry: false });
    if (prior && !prior.isFile()) return; // never replace a link or directory someone else put there
    renameSync(temp, target); created = false;
  } catch { /* cache only */ }
  finally { if (created) try { unlinkSync(temp); } catch { /* cache only */ } }
}

/** Invalidate one slot: any outcome other than not-needed. Removes only a regular file inside the private directory. Never throws. */
export function clearPlacementNoopCache(home: string, slot: string): void {
  if (!HEX64.test(slot)) return;
  const dir = cacheDir(home); if (!dir) return;
  try { const path = join(dir, `${slot}.json`), stat = lstatSync(path, { throwIfNoEntry: false }); if (stat?.isFile()) unlinkSync(path); } catch { /* cache only */ }
}
