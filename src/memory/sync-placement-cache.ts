/** Shared private cache metadata validation. These checks never initialize, repair or publish a repository. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";

function fail(): never { throw new SyncPlacementJournalError("corrupt"); }
export function placementCacheRootStamp(home: string): string {
  const stat = lstatSync(join(home, "shard-sync-placement"), { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n) fail();
  return canonicalJSON([String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode)]);
}
export function placementCacheConfigStamp(cache: string): string {
  const stat = lstatSync(join(cache, "config"), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1)
    || (stat.mode & 0o077n) !== 0n || stat.size > 65536n) fail();
  return canonicalJSON([String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
}
export function validatePlacementCacheConfig(output: string): ReadonlyMap<string, string> {
  const seen = new Map<string, string>();
  const booleans = new Set(["core.filemode", "core.bare", "core.ignorecase", "core.precomposeunicode", "core.protecthfs", "core.protectntfs", "core.logallrefupdates", "core.symlinks"]);
  for (const row of output.split("\0").filter(Boolean)) {
    const at = row.indexOf("\n"); if (at < 1) fail();
    const key = row.slice(0, at), value = row.slice(at + 1);
    if (seen.has(key)) fail(); seen.set(key, value);
    if (booleans.has(key)) { if (value !== "true" && value !== "false") fail(); }
    else if (key === "core.repositoryformatversion") { if (value !== "0" && value !== "1") fail(); }
    else if (key === "extensions.objectformat") { if (value !== "sha1") fail(); }
    else if (!["remote.origin.url", "remote.origin.fetch", "remote.origin.pushurl"].includes(key)) fail();
  }
  return seen;
}
