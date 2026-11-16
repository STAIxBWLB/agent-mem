/** Closed v2 publication append intent. The I/O layer owns fencing and durable prefix completion. */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_MAX_OBJECTS, PLACEMENT_JOURNAL_MAX_RECORDS,
  SyncPlacementJournalError, validatePlacementRecord, type PlacementRecord } from "./sync-placement-journal-format.ts";

// ponytail: 20 MiB holds the records under the existing 256-object/64 KiB journal ceiling plus metadata;
// replace this in-memory envelope with a bounded streaming manifest before increasing the journal ceiling.
export const PLACEMENT_BATCH_INTENT_MAX_BYTES = 20 * 1024 * 1024;
export interface PlacementBatchChunk { name: string; prefixBytes: number; prefixHash: string; first: number; count: number; suffixHash: string }
export interface PlacementBatchIntent {
  schema: "agent-mem.sync-placement-append-intent/v2"; epochHash: string; attemptHash: string;
  previousHash: string; records: PlacementRecord[]; chunks: PlacementBatchChunk[]; seal: string;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (record: PlacementRecord) => Buffer.from(canonicalJSON(record) + "\n");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) throw new SyncPlacementJournalError("corrupt");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",") || Object.values(descriptors).some(descriptor => !("value" in descriptor))) throw new SyncPlacementJournalError("corrupt");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
};
const fail = (): never => { throw new SyncPlacementJournalError("corrupt"); };
const array = (value: unknown, limit: number): unknown[] => {
  if (!Array.isArray(value) || types.isProxy(value) || value.length < 1 || value.length > limit) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return fail();
    return descriptor.value;
  });
};

/** Validate an entire batch and its canonical record chain before any storage effect. */
export function validatePlacementBatchIntent(value: unknown, epochHash: string): PlacementBatchIntent {
  const row = object(value, ["schema", "epochHash", "attemptHash", "previousHash", "records", "chunks", "seal"]);
  if (row.schema !== "agent-mem.sync-placement-append-intent/v2" || row.epochHash !== epochHash || !hex(epochHash)
    || !hex(row.attemptHash) || !hex(row.previousHash) || !hex(row.seal)) return fail();
  let recordBytes = 0;
  const records = array(row.records, PLACEMENT_JOURNAL_MAX_RECORDS).map(value => {
    const record = validatePlacementRecord(value);
    recordBytes += bytesOf(record).length;
    if (recordBytes > PLACEMENT_BATCH_INTENT_MAX_BYTES) return fail();
    return record;
  });
  let head = row.previousHash, sequence = records[0]!.sequence - 1;
  for (const record of records) {
    if (record.epochHash !== epochHash || record.previousHash !== head || record.sequence !== ++sequence) return fail();
    head = record.seal;
  }
  let first = 0, previousIndex = -1;
  const chunks = array(row.chunks, PLACEMENT_JOURNAL_MAX_OBJECTS).map(value => {
    const chunk = object(value, ["name", "prefixBytes", "prefixHash", "first", "count", "suffixHash"]);
    if (typeof chunk.name !== "string" || !/^records-\d{5}\.jsonl$/.test(chunk.name)
      || !Number.isSafeInteger(chunk.prefixBytes) || (chunk.prefixBytes as number) < 0 || !hex(chunk.prefixHash)
      || !Number.isSafeInteger(chunk.first) || chunk.first !== first || !Number.isSafeInteger(chunk.count)
      || (chunk.count as number) < 1 || !hex(chunk.suffixHash)) return fail();
    const index = Number(chunk.name.slice(8, 13)), count = chunk.count as number;
    if ((previousIndex >= 0 && index !== previousIndex + 1) || first + count > records.length
      || (first > 0 && (chunk.prefixBytes !== 0 || chunk.prefixHash !== digest(Buffer.alloc(0))))) return fail();
    const suffix = Buffer.concat(records.slice(first, first + count).map(bytesOf));
    if ((chunk.prefixBytes as number) + suffix.length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES || digest(suffix) !== chunk.suffixHash) return fail();
    const result: PlacementBatchChunk = { name: chunk.name, prefixBytes: chunk.prefixBytes as number, prefixHash: chunk.prefixHash, first, count, suffixHash: chunk.suffixHash };
    first += count; previousIndex = index; return result;
  });
  if (first !== records.length) return fail();
  const body = { schema: "agent-mem.sync-placement-append-intent/v2" as const, epochHash, attemptHash: row.attemptHash, previousHash: row.previousHash, records, chunks };
  if (hashJSON(body) !== row.seal || Buffer.byteLength(canonicalJSON({ ...body, seal: row.seal }) + "\n") > PLACEMENT_BATCH_INTENT_MAX_BYTES) return fail();
  return { ...body, seal: row.seal };
}

/** Lay out the frozen record sequence across existing or new journal chunks without reading or writing files. */
export function planPlacementBatchIntent(epochHash: string, attemptHash: string, records: readonly PlacementRecord[],
  existing: readonly { name: string; size: number; hash: string }[]): PlacementBatchIntent {
  if (!records.length || !hex(epochHash) || !hex(attemptHash)) return fail();
  const chunks: PlacementBatchChunk[] = [], empty = digest(Buffer.alloc(0));
  let used = existing.at(-1)?.size ?? 0, index = existing.length ? existing.length - 1 : 0;
  let prefixBytes = existing.at(-1)?.size ?? 0, prefixHash = existing.at(-1)?.hash ?? empty;
  let first = 0, count = 0, suffix: Buffer[] = [];
  const flush = () => {
    if (!count) return;
    chunks.push({ name: `records-${String(index).padStart(5, "0")}.jsonl`, prefixBytes, prefixHash, first, count, suffixHash: digest(Buffer.concat(suffix)) });
    first += count; count = 0; suffix = []; index++; used = 0; prefixBytes = 0; prefixHash = empty;
  };
  for (const record of records) {
    const data = bytesOf(validatePlacementRecord(record));
    if (data.length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) return fail();
    if (used + data.length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) {
      if (count) flush(); else { index++; used = 0; prefixBytes = 0; prefixHash = empty; }
    }
    used += data.length; count++; suffix.push(data);
  }
  flush();
  const body = { schema: "agent-mem.sync-placement-append-intent/v2" as const, epochHash, attemptHash,
    previousHash: records[0]!.previousHash, records: [...records], chunks };
  return validatePlacementBatchIntent({ ...body, seal: hashJSON(body) }, epochHash);
}
