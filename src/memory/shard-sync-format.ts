import { createHash } from "node:crypto";
import { legacyEntries } from "./bridge.ts";
import { canonicalJSON, validGeneration } from "./generation.ts";
import { validatePruneRow, type PruneRow } from "./prune.ts";
import { shardKeyHash } from "./shard.ts";
import type { Entry } from "./store.ts";

export type ShardSyncRealm = { scope: "project"; key: string } | { scope: "user" };
export type ShardSyncRow = Entry | PruneRow;
export const SHARD_SYNC_SCHEMA = "agent-mem.shard-sync/v1";
export const SHARD_PACK_MAX_BYTES = 1024 * 1024;
const PACK = /^rows\/([a-f0-9]{64})\/([a-f0-9]{64})\.jsonl$/;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export class ShardSyncFormatError extends Error {
  constructor(label: string, reason: string) { super(`${label}: ${reason}`); this.name = "ShardSyncFormatError"; }
}
function checkRealm(realm: ShardSyncRealm): void {
  if (!realm || (realm.scope !== "user" && (realm.scope !== "project" || typeof realm.key !== "string" || !realm.key))) {
    throw new ShardSyncFormatError("shard", "invalid realm");
  }
}
export function shardSyncLabel(realm: ShardSyncRealm): string {
  checkRealm(realm);
  return realm.scope === "user" ? "user shard" : `project shard ${shardKeyHash(realm.key)}`;
}
export function shardSyncRef(realm: ShardSyncRealm): string {
  checkRealm(realm);
  return realm.scope === "user" ? "refs/heads/amem/u" : `refs/heads/amem/p/${shardKeyHash(realm.key)}`;
}
export function shardSyncDescriptor(realm: ShardSyncRealm): string {
  checkRealm(realm);
  return canonicalJSON(realm.scope === "user" ? { schema: SHARD_SYNC_SCHEMA, scope: "user" } : { schema: SHARD_SYNC_SCHEMA, scope: "project", key: realm.key }) + "\n";
}

/** Only row shape/public placement here. The sync engine must prove target/basis realm ownership across the full source set. */
function publicRow(value: unknown, label: string): ShardSyncRow {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("row");
    if ((value as { schema?: unknown }).schema === "agent-mem.prune/v1") return validatePruneRow(value, undefined, "synced");
    const raw = Buffer.from(canonicalJSON(value) + "\n");
    const [row] = legacyEntries([{ source: "legacy-main", path: "log/format.jsonl", bytes: raw, offset: raw.length, hash: hash(raw), local: false, tailBytes: 0 }], { strict: true });
    if (!row || row.op === "settle" || row.op === "note" && row.tier !== "long") throw new Error("placement");
    return row;
  } catch { throw new ShardSyncFormatError(label, "invalid public row"); }
}
function collision(seen: Map<string, string>, row: ShardSyncRow, line: string, label: string): void {
  const previous = seen.get(row.id);
  if (previous !== undefined && previous !== line) throw new ShardSyncFormatError(label, "row id collision");
  seen.set(row.id, line);
}

/** Content-addressed immutable packs retain original attribution, ids and even repeated identical input rows. */
export function encodeShardPacks(rows: readonly ShardSyncRow[]): Map<string, Buffer> {
  const groups = new Map<string, { id: string; line: string }[]>(), seen = new Map<string, string>();
  const label = "shard pack";
  for (const input of rows) {
    let line: string;
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string") throw new ShardSyncFormatError(label, "invalid public row");
    try { line = canonicalJSON(input); } catch { throw new ShardSyncFormatError(label, "invalid public row"); }
    // Check before validation too: a conflicting claimed id is never silently preferred over the other payload.
    collision(seen, input, line, label);
    const row = publicRow(input, label);
    if (Buffer.byteLength(line) + 1 > SHARD_PACK_MAX_BYTES) throw new ShardSyncFormatError(label, "row exceeds pack bound");
    const held = groups.get(row.machine) ?? [];
    held.push({ id: row.id, line: line + "\n" }); groups.set(row.machine, held);
  }
  const packs = new Map<string, Buffer>();
  for (const machine of [...groups.keys()].sort()) {
    const group = groups.get(machine)!; group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let parts: string[] = [], bytes = 0;
    const publish = () => {
      if (!parts.length) return;
      const body = Buffer.from(parts.join(""));
      const path = `rows/${hash(machine)}/${hash(body)}.jsonl`;
      if (packs.has(path)) throw new ShardSyncFormatError(label, "duplicate immutable pack");
      packs.set(path, body); parts = []; bytes = 0;
    };
    for (const row of group) {
      const size = Buffer.byteLength(row.line);
      if (bytes + size > SHARD_PACK_MAX_BYTES) publish();
      parts.push(row.line); bytes += size;
    }
    publish();
  }
  return packs;
}

export function decodeShardPack(path: string, bytes: Uint8Array, realm: ShardSyncRealm, generation: string): ShardSyncRow[] {
  const label = shardSyncLabel(realm), match = PACK.exec(path);
  if (!match || !bytes.byteLength || bytes.byteLength > SHARD_PACK_MAX_BYTES || hash(bytes) !== match[2] || !validGeneration(generation)) {
    throw new ShardSyncFormatError(label, "invalid pack identity or bound");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ShardSyncFormatError(label, "invalid pack encoding"); }
  if (!text.endsWith("\n")) throw new ShardSyncFormatError(label, "incomplete pack tail");
  const rows: ShardSyncRow[] = [], seen = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    let value: unknown;
    try { if (!line.trim()) throw new Error("empty"); value = JSON.parse(line); }
    catch { throw new ShardSyncFormatError(label, "malformed pack row"); }
    const row = publicRow(value, label);
    if (hash(row.machine) !== match[1]) throw new ShardSyncFormatError(label, "pack author mismatch");
    // Generation is preserved in the original prune payload. Acceptance here is structural,
    // never permission to apply it: the engine proves each original generation and holds foreign rows.
    if (row.op === "note" || row.op === "goal") {
      if (realm.scope === "project" ? row.scope !== "project" || row.project !== realm.key : row.scope !== "shared") {
        throw new ShardSyncFormatError(label, "row scope mismatch");
      }
    }
    collision(seen, row, canonicalJSON(row), label); rows.push(row);
  }
  return rows;
}
