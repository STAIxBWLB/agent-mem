import { lstatSync, type BigIntStats } from "node:fs";

export function sameMetadataStamp(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export function freezeMetadata<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}

const snapshots = new WeakSet<object>();
export function isMetadataSnapshot(value: unknown): value is object {
  return !!value && typeof value === "object" && snapshots.has(value);
}

/** Each reader owns its cache and keeps its own parsing, permission and refusal rules. */
export function metadataReader(read: (path: string) => { stamp: BigIntStats; value: unknown } | undefined) {
  // ponytail: 32 file snapshots per reader across all homes; partition by home if alternating homes churn the cache.
  const entries = new Map<string, { stamp: BigIntStats; value: unknown }>();
  return (path: string): unknown | undefined => {
    let before: BigIntStats | undefined;
    try { before = lstatSync(path, { bigint: true, throwIfNoEntry: false }); }
    catch { entries.delete(path); return read(path)?.value; }
    const entry = entries.get(path);
    if (before?.isFile() && entry && sameMetadataStamp(before, entry.stamp)) {
      entries.delete(path);
      entries.set(path, entry);
      return entry.value;
    }
    entries.delete(path);
    const result = read(path);
    if (!result) return undefined;
    const { value, stamp } = result;
    if (!before?.isFile() || !sameMetadataStamp(before, stamp)) return value;
    try { freezeMetadata(value); } catch { return value; }
    if (value && typeof value === "object") snapshots.add(value);
    if (entries.size === 32) entries.delete(entries.keys().next().value!);
    entries.set(path, { stamp, value });
    return value;
  };
}
