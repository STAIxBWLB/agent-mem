/**
 * Content-hash fence over the file set a brief's binding guard reads (#396, #359 AC3).
 *
 * The guard runs twice around every host screen, so it must answer "did any input of the binding change?" far more
 * often than it can afford to re-derive the binding. This module answers it from the bytes themselves: every path the
 * full read opens is hashed and compared, so two identical snapshots mean the values derived from those bytes (selector
 * revision, the sharded selection projection, aliases, lifecycle state, the placement validation) are identical too.
 *
 * Threat model, stated rather than implied: SHA-256 collision resistance, and the concurrent filesystem behaviour the
 * readers already allow (a rename or link publication between two syscalls). A hash is not an atomic snapshot of the
 * whole set: each path is opened, fstat-ed, read and re-checked against its path, and a mismatch sends the caller back
 * to the full read for that call. Nothing here claims more than that every comparable input was compared.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { PUBLIC_PRUNE_INTENT } from "./public-prune-view.ts";
import { PLACEMENT_ACTIVATION_INTENT } from "./sync-placement-activation-path.ts";

/** A caller's own bound: above this many paths the fence is abandoned for the full read instead of scaled. */
export const FENCE_MAX_PATHS = 512;
/** Placeholder for a path the fence cannot describe safely; it never equals an adopted entry, so the caller re-reads. */
export const FENCE_UNSAFE = "!";

export interface HomeBindingSnapshot { readonly paths: readonly string[]; readonly entries: readonly string[] }
/** A reader reports each path it consults, so the fence's list is the reader's own and not a parallel condition. */
export type ReadRecorder = (path: string) => void;

const IDENTITY = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}:${stat.nlink}`;
// A directory is a container, not an input: the files inside are compared one by one, so its own entry carries the
// replacement and ownership signals only. Its link count moves whenever any child directory appears, which would hand
// well-behaved concurrent work back to the full read for no gain.
const DIRECTORY_IDENTITY = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
const SAME = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

/**
 * One path's comparable state: absent, a directory's identity, or a regular file's identity plus the SHA-256 of its
 * bytes. A symlink, a foreign owner, a group-writable mode, a hardlinked file, an oversized input or any error answers
 * `FENCE_UNSAFE`, which forces the caller's full read rather than a guess.
 */
function entry(path: string, owner: number): string {
  let stat: BigIntStats | undefined;
  try { stat = lstatSync(path, { bigint: true, throwIfNoEntry: false }); } catch { return FENCE_UNSAFE; }
  if (stat === undefined) return "-";
  if (stat.isDirectory()) return stat.isSymbolicLink() ? FENCE_UNSAFE : `d:${DIRECTORY_IDENTITY(stat)}`;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(owner) || (stat.mode & 0o077n) !== 0n) return FENCE_UNSAFE;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !SAME(stat, opened)) return FENCE_UNSAFE;
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) return FENCE_UNSAFE;
    const bytes = Buffer.allocUnsafe(size + 1);
    let at = 0;
    while (at < size) { const read = readSync(descriptor, bytes, at, size - at, at); if (read === 0) break; at += read; }
    // A short read, or a change while reading, is not a hash of this file: the caller must re-derive the binding.
    if (at !== size || !SAME(opened, fstatSync(descriptor, { bigint: true })) || !SAME(opened, lstatSync(path, { bigint: true }))) return FENCE_UNSAFE;
    return `f:${IDENTITY(opened)}:${createHash("sha256").update(bytes.subarray(0, at)).digest("hex")}`;
  } catch { return FENCE_UNSAFE; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** The comparable state of every path, in the list's order. */
export function snapshotHomeBinding(paths: readonly string[]): HomeBindingSnapshot {
  const owner = process.getuid?.() ?? -1;
  return { paths: [...paths], entries: paths.map(path => entry(path, owner)) };
}

export function sameHomeBinding(left: HomeBindingSnapshot, right: HomeBindingSnapshot): boolean {
  return left.paths.length === right.paths.length
    && left.paths.every((path, index) => path === right.paths[index] && left.entries[index] === right.entries[index]);
}

/** Every entry describes a readable file or an owned directory, never a placeholder. */
export const fenceIsComplete = (snapshot: HomeBindingSnapshot): boolean => snapshot.entries.every(value => value !== FENCE_UNSAFE);

export interface FenceSelector { readonly pruneInputSetHash?: string; readonly placementHead?: string }

/**
 * The paths the guard's full read consults: the fixed metadata of the home, the placement binding's own chain, and the
 * paths the readers reported while the last full comparison ran. A selector without a prune set or a placement head
 * contributes no path of its own; the files that would introduce one are in the fixed part, so their appearance is
 * still compared.
 */
export function homeBindingPaths(home: string, selector: FenceSelector | undefined, reported: readonly string[] = []): string[] {
  const paths = [home, join(home, "profile.json"), join(home, "shards.json"), join(home, "aliases.jsonl"),
    join(home, "lifecycle.jsonl"), join(home, "profile.lock"), join(home, PUBLIC_PRUNE_INTENT), join(home, "public-prune-input-sets")];
  if (selector?.pruneInputSetHash) paths.push(join(home, "public-prune-input-sets", `${selector.pruneInputSetHash}.json`));
  paths.push(join(home, PLACEMENT_ACTIVATION_INTENT), join(home, "sync-placement"), join(home, "sync-placement", "epochs"), join(home, "sync-placement", "active.json"));
  if (selector?.placementHead) {
    const dir = join(home, "sync-placement", "epochs", selector.placementHead);
    paths.push(dir, join(dir, "epoch.json"), join(dir, "activation.json"));
  }
  for (const path of reported) if (!paths.includes(path)) paths.push(path);
  return paths;
}
