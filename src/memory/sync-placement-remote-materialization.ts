/** Select only a safe pre-admission subset from an already audited remote history. */
import { canonicalJSON, hashJSON } from "./generation.ts";
import { createHash } from "node:crypto";
import { PLACEMENT_SOURCE_MAX_BYTES, PLACEMENT_SOURCE_MAX_ROWS } from "./sync-placement-bound.ts";
import type { Entry } from "./store.ts";
import type { ShardHistory } from "./shard-sync-history.ts";
import { encodeShardPacks } from "./shard-sync-format.ts";

export interface RemoteMaterializationSelection { rows: Entry[]; omitted: number }
export interface RemoteStagedPack { name: string; bytes: Buffer }
const unavailable = (): never => { throw new Error("Remote placement realm cannot be materialized from complete verified proof within the source bounds."); };

/** Never stage a prune row or its target before the existing sync path activates the witness. */
export function selectRemoteMaterialization(history: ShardHistory): RemoteMaterializationSelection {
  if (history.rows.size > PLACEMENT_SOURCE_MAX_ROWS) return unavailable();
  const masks = new Map<string, string>(), witnessed = new Set<string>();
  for (const manifest of history.manifests.values()) {
    if (!manifest.eligible || !history.rows.has(manifest.row.id)) return unavailable();
    witnessed.add(manifest.row.id);
    for (const target of manifest.row.targets) {
      const prior = masks.get(target.id);
      if (prior !== undefined && prior !== target.rowHash) return unavailable();
      masks.set(target.id, target.rowHash);
    }
  }
  const rows: Entry[] = []; let omitted = 0, bytes = 0;
  for (const row of history.rows.values()) {
    bytes += Buffer.byteLength(canonicalJSON(row) + "\n");
    if (bytes > PLACEMENT_SOURCE_MAX_BYTES) return unavailable();
    if (row.op === "prune") { if (!witnessed.has(row.id)) return unavailable(); omitted++; continue; }
    const mask = masks.get(row.id);
    if (mask !== undefined) { if (hashJSON(row) !== mask) return unavailable(); omitted++; continue; }
    rows.push(row);
  }
  return { rows, omitted };
}

/** Use the same canonical immutable pack encoding as sync, but keep it detached until publication. */
export function remoteStagedPacks(selection: RemoteMaterializationSelection): RemoteStagedPack[] {
  if (!Number.isSafeInteger(selection.omitted) || selection.omitted < 0 || selection.rows.length > PLACEMENT_SOURCE_MAX_ROWS) return unavailable();
  const packs = new Map<string, Buffer>(); let total = 0;
  for (const bytes of encodeShardPacks(selection.rows).values()) {
    total += bytes.length; if (total > PLACEMENT_SOURCE_MAX_BYTES) return unavailable();
    const name = `sync-${createHash("sha256").update(bytes).digest("hex")}.jsonl`, previous = packs.get(name);
    if (previous && !previous.equals(bytes)) return unavailable();
    packs.set(name, Buffer.from(bytes));
  }
  return [...packs].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ name, bytes }));
}
