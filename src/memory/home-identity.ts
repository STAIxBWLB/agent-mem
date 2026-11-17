/** Memory home identity bound into sync-placement epochs (#444). */
import type { BigIntStats } from "node:fs";
import { hashJSON } from "./generation.ts";

type HomeStat = Pick<BigIntStats, "dev" | "ino" | "uid">;
const hashFor = (home: string, dev: bigint, stat: HomeStat) => hashJSON([home, String(dev), String(stat.ino), String(stat.uid)]);
const resolved = new Map<string, string>();

/**
 * Hash of the home's path, device, inode and uid. Epochs persist this value, and a macOS reboot can renumber the volume's
 * `st.dev` while the directory stays the same. When `pinned` reproduces from the current path, inode and uid with another
 * device number, it is returned unchanged, so a retained epoch keeps binding; a replaced or copied home still differs by inode.
 * ponytail: only device numbers that differ in the low 16 bits are tried (65536 hashes, about 30 ms, memoized per process);
 * widen the window or bind a stored volume UUID if a platform renumbers higher bits.
 */
export function homeIdentityHash(home: string, stat: HomeStat, pinned?: string): string {
  const current = hashFor(home, stat.dev, stat);
  if (pinned === undefined || pinned === current) return current;
  const key = JSON.stringify([pinned, home, String(stat.dev), String(stat.ino), String(stat.uid)]);
  const known = resolved.get(key); if (known !== undefined) return known;
  let result = current;
  const base = stat.dev & ~0xffffn;
  for (let low = 0n; low <= 0xffffn; low++) if (hashFor(home, base | low, stat) === pinned) { result = pinned; break; }
  resolved.set(key, result); return result;
}
export const homeIdentityMatches = (expected: string, home: string, stat: HomeStat): boolean => homeIdentityHash(home, stat, expected) === expected;
