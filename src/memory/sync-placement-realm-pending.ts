/** Metadata-only detection of pending realm admission; never grants authority or opens a realm. */
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

export const REALM_INTENT_PREFIX = "placement-realm-intent-";
export interface PendingRealmInventory { hashes: readonly string[]; unknown: boolean }
/** A pending filename identifies the realm even when its content is torn. Unknown evidence cannot authorize an extension. */
export function pendingRealmInventory(home: string): PendingRealmInventory {
  const hashes = new Set<string>(); let unknown = false, count = 0;
  try {
    const directory = opendirSync(home);
    try {
      for (;;) {
        const entry = directory.readSync(); if (!entry) break;
        if (++count > 20_000) return { hashes: [], unknown: true };
        if (!entry.name.startsWith(REALM_INTENT_PREFIX)) continue;
        const match = /^placement-realm-intent-([a-f0-9]{64})\.json(?:\.pending-[a-f0-9]{64})?$/.exec(entry.name);
        if (!match || match[0] !== entry.name) { unknown = true; continue; }
        hashes.add(match[1]!);
        if (hashes.size > 64) return { hashes: [], unknown: true };
        const stat = lstatSync(join(home, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || ![1, 2].includes(stat.nlink)) unknown = true;
      }
    } finally { directory.closeSync(); }
  } catch { return { hashes: [], unknown: true }; }
  return { hashes: [...hashes].sort(), unknown };
}
