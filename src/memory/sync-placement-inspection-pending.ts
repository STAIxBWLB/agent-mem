/** Passive pending-prune namespace capture. It grants no recovery, writer or publication authority. */
import { lstatSync, opendirSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { SYNC_SCREEN_MAX_BYTES, SYNC_SCREEN_MAX_ROWS } from "./sync-screen.ts";
import { SyncPlacementJournalError, type SyncPlacementJournalErrorCode } from "./sync-placement-journal-format.ts";

function fail(code: SyncPlacementJournalErrorCode = "corrupt"): never { throw new SyncPlacementJournalError(code); }
function owned(stat: BigIntStats, directory: boolean): void {
  if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail();
}
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
function parentIdentity(target: string): string {
  const stat = lstatSync(target, { bigint: true }); owned(stat, true);
  // Derived indexes may change the target directory; its identity/ownership, rather than unrelated contents, is binding.
  return canonicalJSON([stat.dev, stat.ino, stat.uid, stat.mode].map(String));
}
function snapshot(target: string): string {
  const dir = join(target, "prune-plans"), before = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
  if (!before) return "absent";
  owned(before, true);
  const rows: string[][] = []; let count = 0, metadataBytes = Buffer.byteLength(canonicalJSON({ directory: stamp(before), entries: [] }));
  const iterator = opendirSync(dir);
  try {
    for (;;) {
      const entry = iterator.readSync(); if (!entry) break;
      if (++count > SYNC_SCREEN_MAX_ROWS) fail("bound");
      // Refuse incomplete/malformed claim names too. No content is read, decoded, completed or removed.
      if (entry.name.startsWith("pending-local-") || entry.name.startsWith("pending-log-")) fail("pending");
      const stat = lstatSync(join(dir, entry.name), { bigint: true }); owned(stat, stat.isDirectory());
      const row = [entry.name, stat.isDirectory() ? "directory" : "file", ...stamp(stat)];
      metadataBytes += Buffer.byteLength(canonicalJSON(row)) + (rows.length ? 1 : 0); if (metadataBytes > SYNC_SCREEN_MAX_BYTES) fail("bound");
      rows.push(row);
    }
  } finally { iterator.closeSync(); }
  const after = lstatSync(dir, { bigint: true }); owned(after, true);
  if (canonicalJSON(stamp(before)) !== canonicalJSON(stamp(after))) fail("changed");
  rows.sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
  return hashJSON({ directory: stamp(before), entries: rows });
}
function safeError(error: unknown, final: boolean): never {
  if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SyncPlacementJournalError) {
    const code = Object.getOwnPropertyDescriptor(error, "code");
    if (code && "value" in code && ["bound", "pending", "changed", "corrupt"].includes(code.value))
      return fail(final && code.value !== "bound" ? "changed" : code.value);
  }
  return fail(final ? "changed" : "corrupt");
}
/** Captures the selected target's namespace and returns a no-effect final recheck.
 * ponytail: at most20000 direct metadata entries/8MiB of canonical name/stat metadata may be captured. Saved plan
 * bodies are never read; a reviewed streaming namespace proof is required before this inventory ceiling can grow. */
export function captureInspectionPendingPrunes(targetDir: string): () => void {
  try {
    const original = parentIdentity(targetDir), target = realPath(targetDir);
    if (parentIdentity(target) !== original) fail("changed");
    const before = snapshot(target);
    if (parentIdentity(target) !== original) fail("changed");
    return () => {
      try { if (parentIdentity(target) !== original || snapshot(target) !== before || parentIdentity(target) !== original) fail("changed"); }
      catch (error) { safeError(error, true); }
    };
  } catch (error) { return safeError(error, false); }
}
