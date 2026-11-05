import { types } from "node:util";
/** Private bounded placement evidence. Caller supplies the live home mutation fence and fresh authority proof. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { validatePlacementPlan, type SyncPlacementActivationPlan } from "./sync-placement-plan.ts";
import { validatePlacementProfile, validatePlacementShards } from "./sync-placement-format.ts";
import { PLACEMENT_ACTIVE_FENCE_SCHEMA, PLACEMENT_JOURNAL_MAX_RECORDS, PLACEMENT_JOURNAL_MAX_OBJECTS, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_ROOT_MAX_BYTES,
  SyncPlacementJournalError, createPlacementRecord, placementEpochHash, validatePlacementActiveFence, validatePlacementEpoch, validatePlacementEvent, validatePlacementRecord,
  type PlacementActiveFence, type PlacementEpoch, type PlacementEvent, type PlacementRecord, type SyncPlacementJournalErrorCode } from "./sync-placement-journal-format.ts";
import { PlacementProjection } from "./sync-placement-projection.ts";

export type PlacementStoragePhase = "epoch-written" | "epoch-fsync" | "activation-written" | "activation-fsync" | "fence-written" | "fence-fsync"
  | "intent-written" | "intent-fsync" | "chunk-written" | "chunk-fsync" | "intent-cleared";
export interface PlacementStorageOptions { mutation: MutationHandle; assertCurrent(): void; phase?(phase: PlacementStoragePhase): void }
export interface PlacementJournalRead {
  epoch: PlacementEpoch; activation: SyncPlacementActivationPlan; records: PlacementRecord[]; headHash: string; sequence: number; objects: number; pending: boolean;
}
interface Paths { home: string; root: string; epochs: string; dir: string; hash: string }
interface Chunk { name: string; size: number; hash: string }
interface Intent { schema: "agent-mem.sync-placement-append-intent/v1"; epochHash: string; record: PlacementRecord; chunk: string; prefixBytes: number; prefixHash: string; lineHash: string }
interface Snapshot extends PlacementJournalRead { chunks: Chunk[]; projection: PlacementProjection; intent?: Intent; intentPending: boolean; fencePending: boolean }
const inflight = new WeakSet<MutationHandle>(), hex = (value: unknown, width = 64): value is string => typeof value === "string" && value.length === width && new RegExp(`^[a-f0-9]{${width}}$`).test(value);
const fail = (code: SyncPlacementJournalErrorCode = "corrupt"): never => { throw new SyncPlacementJournalError(code); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const line = (value: unknown) => Buffer.from(canonicalJSON(value) + "\n");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const knownError = (error: unknown): error is SyncPlacementJournalError => !!error && typeof error === "object" && !types.isProxy(error) && error instanceof SyncPlacementJournalError;
function protectedIO<T>(work: () => T): T { try { return work(); } catch (error) { if (knownError(error)) throw error; return fail(); } }
function owned(stat: BigIntStats, directory = false): void {
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o077n) !== 0n || stat.isSymbolicLink()
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail();
}
function state(file: string, directory = false): BigIntStats | undefined {
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (stat) owned(stat, directory); return stat;
}
function paths(home: string, epochHash: string): Paths {
  if (!hex(epochHash)) return fail("invalid");
  const canonical = realPath(home); owned(lstatSync(home, { bigint: true }), true);
  return { home: canonical, root: join(canonical, "sync-placement"), epochs: join(canonical, "sync-placement", "epochs"), dir: join(canonical, "sync-placement", "epochs", epochHash), hash: epochHash };
}
function names(dir: string, maximum: number): string[] {
  const reader = opendirSync(dir), result: string[] = [];
  try { for (;;) { const entry = reader.readSync(); if (!entry) break; if (result.length >= maximum) fail("bound"); result.push(entry.name); } }
  finally { reader.closeSync(); }
  return result.sort();
}
function inventory(p: Paths): { files: Map<string, BigIntStats>; token: string } {
  const parents: unknown[] = [];
  for (const dir of [p.home, p.root, p.epochs, p.dir]) { const stat = state(dir, true); parents.push([dir, stat ? [String(stat.dev), String(stat.ino)] : null]); }
  if (state(p.root, true)) for (const name of names(p.root, 2)) {
    if (name === "epochs") state(p.epochs, true); else if (name === "active.json") { const stat = state(join(p.root, name))!; if (stat.size > BigInt(PLACEMENT_JOURNAL_ROOT_MAX_BYTES)) fail("bound"); }
    else fail();
  }
  const files = new Map<string, BigIntStats>();
  if (state(p.dir, true)) for (const name of names(p.dir, PLACEMENT_JOURNAL_MAX_OBJECTS - 1)) {
    const chunk = /^records-\d{5}\.jsonl$/.test(name);
    if (!chunk && !["epoch.json", "activation.json", "append-intent.json"].includes(name)) fail();
    const stat = state(join(p.dir, name))!;
    if (stat.size > BigInt(chunk ? PLACEMENT_JOURNAL_CHUNK_MAX_BYTES : PLACEMENT_JOURNAL_ROOT_MAX_BYTES)) fail("bound");
    files.set(name, stat);
  }
  // One global active.json slot is always reserved, whether that fence exists yet or not.
  if (files.size + 1 > PLACEMENT_JOURNAL_MAX_OBJECTS) fail("bound");
  const fence = state(join(p.root, "active.json"));
  return { files, token: canonicalJSON({ parents, files: [...files].map(([name, stat]) => [name, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]),
    fence: fence ? [String(fence.dev), String(fence.ino), String(fence.size), String(fence.mtimeNs), String(fence.ctimeNs)] : null }) };
}
function readOwned(file: string, maximum: number): Buffer | undefined {
  const before = state(file); if (!before) return undefined;
  if (before.size > BigInt(maximum)) fail("bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (!same(before, opened)) fail("changed");
    const bytes = Buffer.alloc(Number(opened.size) + 1); let count = 0;
    while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const named = state(file); if (count !== Number(opened.size) || !named || !same(opened, fstatSync(fd, { bigint: true })) || !same(opened, named)) fail("changed");
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
function decode<T>(bytes: Buffer | undefined, validate: (value: unknown) => T): T {
  if (!bytes || !bytes.length || bytes.at(-1) !== 10) return fail("pending");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), value = validate(JSON.parse(text));
  if (canonicalJSON(value) + "\n" !== text) return fail(); return value;
}
function activation(epoch: PlacementEpoch, epochHash: string, value: unknown): SyncPlacementActivationPlan {
  const plan = validatePlacementPlan(value);
  if (plan.generation !== epoch.generation || plan.contextHash !== epoch.contextHash || plan.targetProfile.placementHead !== epochHash) return fail("conflict");
  return plan;
}
function intent(value: unknown, epochHash: string): Intent {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "chunk,epochHash,lineHash,prefixBytes,prefixHash,record,schema") return fail();
  const input = value as Intent, record = validatePlacementRecord(input.record);
  if (input.schema !== "agent-mem.sync-placement-append-intent/v1" || input.epochHash !== epochHash || record.epochHash !== epochHash
    || !/^records-\d{5}\.jsonl$/.test(input.chunk) || !Number.isSafeInteger(input.prefixBytes) || input.prefixBytes < 0 || !hex(input.prefixHash) || !hex(input.lineHash)
    || input.lineHash !== digest(line(record)) || input.prefixBytes + line(record).length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) return fail();
  return { schema: input.schema, epochHash, record, chunk: input.chunk, prefixBytes: input.prefixBytes, prefixHash: input.prefixHash, lineHash: input.lineHash };
}
function snapshot(p: Paths): Snapshot {
  const before = inventory(p);
  const epoch = decode(readOwned(join(p.dir, "epoch.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES), validatePlacementEpoch);
  if (placementEpochHash(epoch) !== p.hash) return fail("conflict");
  const plan = decode(readOwned(join(p.dir, "activation.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES), value => activation(epoch, p.hash, value));
  const pendingBytes = readOwned(join(p.dir, "append-intent.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES);
  const intentPending = pendingBytes !== undefined && (!pendingBytes.length || pendingBytes.at(-1) !== 10);
  const pending = pendingBytes && !intentPending ? decode(pendingBytes, value => intent(value, p.hash)) : undefined;
  const projection = new PlacementProjection(epoch), records: PlacementRecord[] = [], chunks: Chunk[] = [];
  const apply = (bytes: Buffer) => {
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start); if (end < 0 || end === start) fail();
      if (records.length >= PLACEMENT_JOURNAL_MAX_RECORDS) fail("bound");
      const row = decode(bytes.subarray(start, end + 1), validatePlacementRecord); projection.apply(row); records.push(row); start = end + 1;
    }
  };
  const chunkNames = [...before.files.keys()].filter(name => /^records-\d{5}\.jsonl$/.test(name));
  for (const [index, name] of chunkNames.entries()) {
    if (name !== `records-${String(index).padStart(5, "0")}.jsonl`) fail();
    const bytes = readOwned(join(p.dir, name), PLACEMENT_JOURNAL_CHUNK_MAX_BYTES)!;
    chunks.push({ name, size: bytes.length, hash: digest(bytes) });
    if (pending?.chunk === name) {
      if (index !== chunkNames.length - 1 || bytes.length < pending.prefixBytes || digest(bytes.subarray(0, pending.prefixBytes)) !== pending.prefixHash) fail();
      apply(bytes.subarray(0, pending.prefixBytes));
      if (projection.headHash !== pending.record.previousHash || projection.sequence + 1 !== pending.record.sequence) fail();
      const suffix = bytes.subarray(pending.prefixBytes), expected = line(pending.record);
      if (suffix.length > expected.length || !expected.subarray(0, suffix.length).equals(suffix)) fail();
      if (suffix.length === expected.length) apply(suffix);
    } else { if (!bytes.length) fail(); apply(bytes); }
  }
  if (pending) {
    const found = chunkNames.includes(pending.chunk);
    if (!found && (pending.chunk !== `records-${String(chunkNames.length).padStart(5, "0")}.jsonl` || pending.prefixBytes !== 0 || pending.prefixHash !== digest(Buffer.alloc(0)))) fail();
    if (!found && (projection.headHash !== pending.record.previousHash || projection.sequence + 1 !== pending.record.sequence)) fail();
    if (pending.record.sequence > PLACEMENT_JOURNAL_MAX_RECORDS) fail("bound");
  }
  let fencePending = false, activeFence: PlacementActiveFence | undefined;
  const fenceBytes = readOwned(join(p.root, "active.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES);
  if (fenceBytes !== undefined) {
    if (!fenceBytes.length || fenceBytes.at(-1) !== 10) fencePending = true;
    else activeFence = decode(fenceBytes, validatePlacementActiveFence);
  }
  // A durable append always follows the immutable fence's fsync. Missing/wrong fence evidence cannot be repaired
  // by inventing publication history. Only a completely empty, intent-free epoch can have a recoverable fence prefix.
  if ((records.length > 0 || pendingBytes !== undefined) && (!activeFence || fencePending || activeFence.epochHash !== p.hash
    || activeFence.homeHash !== epoch.homeHash || activeFence.generation !== epoch.generation)) fail();
  if (inventory(p).token !== before.token) fail("changed");
  return { epoch, activation: plan, records, projection, headHash: projection.headHash, sequence: projection.sequence, objects: before.files.size + 1, pending: !!pending || intentPending || fencePending, chunks, intentPending, fencePending, ...(pending ? { intent: pending } : {}) };
}
export function readPlacementJournal(home: string, epochHash: string): PlacementJournalRead {
  return protectedIO(() => { const { chunks: _chunks, projection: _projection, intent: _intent, intentPending: _intentPending, fencePending: _fencePending, ...result } = snapshot(paths(home, epochHash)); return result; });
}
function current(p: Paths, opts: PlacementStorageOptions, required: readonly string[] = []): void {
  try { assertMutationHandle(opts.mutation, p.home); } catch { return fail("busy"); }
  try { opts.assertCurrent(); } catch (error) { if (knownError(error)) throw error; return fail("changed"); }
  try { assertMutationHandle(opts.mutation, p.home); } catch { return fail("busy"); }
  const found = inventory(p), names = new Set([...found.files.keys(), ...required]);
  if (names.size + 1 > PLACEMENT_JOURNAL_MAX_OBJECTS) fail("bound");
}
function writer<T>(home: string, epochHash: string, opts: PlacementStorageOptions, work: (p: Paths) => T): T {
  return protectedIO(() => {
    const p = paths(home, epochHash); current(p, opts);
    if (inflight.has(opts.mutation)) return fail("busy"); inflight.add(opts.mutation);
    try { return work(p); } finally { inflight.delete(opts.mutation); }
  });
}
function syncDirectory(p: Paths, opts: PlacementStorageOptions, dir: string, required: readonly string[]): void {
  current(p, opts, required); const before = state(dir, true)!;
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const opened = fstatSync(fd, { bigint: true }); owned(opened, true); if (!same(before, opened)) fail("changed"); current(p, opts, required); if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, state(dir, true)!)) fail("changed"); fsyncSync(fd); if (!same(opened, state(dir, true)!)) fail("changed"); }
  finally { closeSync(fd); }
}
function directories(p: Paths, opts: PlacementStorageOptions, required: readonly string[]): void {
  for (const dir of [p.root, p.epochs, p.dir]) if (!state(dir, true)) {
    current(p, opts, required); mkdirSync(dir, { mode: 0o700 }); owned(lstatSync(dir, { bigint: true }), true);
    syncDirectory(p, opts, dir === p.root ? p.home : dir === p.epochs ? p.root : p.epochs, required);
  }
}
/** Exact prefix completion is the sole recovery write; no file is ever truncated or replaced. */
function complete(p: Paths, opts: PlacementStorageOptions, file: string, expected: Buffer, maximum: number, required: readonly string[], written: PlacementStoragePhase, synced: PlacementStoragePhase): boolean {
  if (expected.length > maximum) return fail("bound");
  current(p, opts, required); const prior = readOwned(file, maximum);
  if (prior && (prior.length > expected.length || !expected.subarray(0, prior.length).equals(prior))) return fail("conflict");
  const created = prior === undefined; current(p, opts, required);
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (created ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    let stat = fstatSync(fd, { bigint: true }); owned(stat);
    if (!same(stat, state(file)!)) fail("changed");
    let offset = prior?.length ?? 0;
    if (Number(stat.size) !== offset || !readOwned(file, maximum)?.equals(prior ?? Buffer.alloc(0))) fail("changed");
    while (offset < expected.length) {
      current(p, opts, required); owned(fstatSync(fd, { bigint: true })); if (!same(stat, state(file)!)) fail("changed");
      const size = writeSync(fd, expected, offset, expected.length - offset, offset); if (size < 1) fail(); offset += size; stat = fstatSync(fd, { bigint: true });
    }
    if (created || (prior?.length ?? 0) !== expected.length) opts.phase?.(written);
    current(p, opts, required);
    if (!same(stat, state(file)!) || !readOwned(file, maximum)?.equals(expected)) fail("changed");
    current(p, opts, required); owned(fstatSync(fd, { bigint: true }));
    if (!same(stat, state(file)!) || !same(stat, fstatSync(fd, { bigint: true }))) fail("changed");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(p, opts, file.startsWith(p.dir + "/") ? p.dir : p.root, required); opts.phase?.(synced);
  current(p, opts, required); if (!readOwned(file, maximum)?.equals(expected)) fail("changed");
  return prior?.equals(expected) === true;
}
export function preparePlacementEpoch(home: string, value: PlacementEpoch, activationPlan: unknown, opts: PlacementStorageOptions): void {
  const epoch = validatePlacementEpoch(value), epochHash = placementEpochHash(epoch);
  writer(home, epochHash, opts, p => {
    const plan = activation(epoch, epochHash, activationPlan), required = ["epoch.json", "activation.json"];
    current(p, opts, required); directories(p, opts, required);
    complete(p, opts, join(p.dir, "epoch.json"), line(epoch), PLACEMENT_JOURNAL_ROOT_MAX_BYTES, required, "epoch-written", "epoch-fsync");
    complete(p, opts, join(p.dir, "activation.json"), line(plan), PLACEMENT_JOURNAL_ROOT_MAX_BYTES, required, "activation-written", "activation-fsync");
    current(p, opts); const read = snapshot(p); if (canonicalJSON(read.epoch) !== canonicalJSON(epoch) || canonicalJSON(read.activation) !== canonicalJSON(plan) || read.records.length || read.pending) fail("conflict");
  });
}
function ensureFence(p: Paths, epoch: PlacementEpoch, opts: PlacementStorageOptions, required: readonly string[]): void {
  const profile = decode(readOwned(join(p.home, "profile.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES), validatePlacementProfile);
  decode(readOwned(join(p.home, "shards.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES), value => validatePlacementShards(value, profile));
  if (profile.generation !== epoch.generation || profile.placementHead !== p.hash) fail("changed");
  const fence: PlacementActiveFence = validatePlacementActiveFence({ schema: PLACEMENT_ACTIVE_FENCE_SCHEMA, epochHash: p.hash, homeHash: epoch.homeHash, generation: epoch.generation });
  complete(p, opts, join(p.root, "active.json"), line(fence), PLACEMENT_JOURNAL_ROOT_MAX_BYTES, required, "fence-written", "fence-fsync");
}
export function ensurePlacementFence(home: string, epochHash: string, opts: PlacementStorageOptions): void {
  writer(home, epochHash, opts, p => { const read = snapshot(p); ensureFence(p, read.epoch, opts, []); current(p, opts); });
}
function sameEvent(record: PlacementRecord, value: PlacementEvent): boolean {
  const { schema: _schema, epochHash: _epoch, sequence: _seq, previousHash: _previous, seal: _seal, ...event } = record;
  return canonicalJSON(validatePlacementEvent(event)) === canonicalJSON(value);
}
export function appendPlacementEvent(home: string, epochHash: string, value: PlacementEvent, expectedHead: string, opts: PlacementStorageOptions): { record: PlacementRecord; already: boolean } {
  const event = validatePlacementEvent(value); if (!hex(expectedHead)) return fail("invalid");
  return writer(home, epochHash, opts, p => {
    const read = snapshot(p);
    if (read.intent) {
      const pending = read.intent;
      if (pending.record.previousHash !== expectedHead || !sameEvent(pending.record, event)) return fail("pending");
      if (read.projection.headHash !== pending.record.seal) read.projection.apply(pending.record);
      const required = ["append-intent.json", pending.chunk]; current(p, opts, required); ensureFence(p, read.epoch, opts, required);
      const chunk = readOwned(join(p.dir, pending.chunk), PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) ?? Buffer.alloc(0);
      const expected = Buffer.concat([chunk.subarray(0, pending.prefixBytes), line(pending.record)]);
      const already = complete(p, opts, join(p.dir, pending.chunk), expected, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, required, "chunk-written", "chunk-fsync");
      current(p, opts, required); const ownedIntent = readOwned(join(p.dir, "append-intent.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES);
      if (!ownedIntent?.equals(line(pending))) fail("changed");
      unlinkSync(join(p.dir, "append-intent.json")); syncDirectory(p, opts, p.dir, []); opts.phase?.("intent-cleared");
      current(p, opts); const done = snapshot(p); if (done.pending || done.headHash !== pending.record.seal) fail("changed");
      return { record: pending.record, already };
    }
    const existing = read.projection.request(event.requestId);
    if (existing) {
      if (!sameEvent(existing, event) || existing.previousHash !== expectedHead || read.headHash !== existing.seal) return fail("conflict");
      current(p, opts); const latest = snapshot(p); if (latest.pending || latest.headHash !== existing.seal) fail("changed"); return { record: existing, already: true };
    }
    if (read.intent || read.headHash !== expectedHead) return fail(read.intent ? "pending" : "conflict");
    const record = createPlacementRecord(epochHash, read.sequence + 1, expectedHead, event), bytes = line(record);
    read.projection.apply(record); // Conflict/source/outcome validation must precede even the immutable fence write.
    if (bytes.length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) fail("bound");
    const prior = read.chunks.at(-1), reuse = prior !== undefined && prior.size + bytes.length <= PLACEMENT_JOURNAL_CHUNK_MAX_BYTES;
    const chunk = reuse ? prior.name : `records-${String(read.chunks.length).padStart(5, "0")}.jsonl`;
    const transaction: Intent = { schema: "agent-mem.sync-placement-append-intent/v1", epochHash, record, chunk, prefixBytes: reuse ? prior.size : 0,
      prefixHash: reuse ? prior.hash : digest(Buffer.alloc(0)), lineHash: digest(bytes) };
    const required = ["append-intent.json", chunk], transactionBytes = line(transaction);
    if (transactionBytes.length > PLACEMENT_JOURNAL_ROOT_MAX_BYTES) fail("bound");
    // Torn intent has no acknowledged effect. Only the freshly proved request may complete an exact owned prefix;
    // snapshot already required every existing chunk to be complete and in-chain when the intent was unparseable.
    const savedIntent = readOwned(join(p.dir, "append-intent.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES);
    if (savedIntent && (savedIntent.length > transactionBytes.length || !transactionBytes.subarray(0, savedIntent.length).equals(savedIntent))) fail("conflict");
    current(p, opts, required); // Reserve both future objects before even the immutable active fence is written.
    ensureFence(p, read.epoch, opts, required);
    complete(p, opts, join(p.dir, "append-intent.json"), line(transaction), PLACEMENT_JOURNAL_ROOT_MAX_BYTES, required, "intent-written", "intent-fsync");
    const prefix = reuse ? readOwned(join(p.dir, chunk), PLACEMENT_JOURNAL_CHUNK_MAX_BYTES)! : Buffer.alloc(0);
    if (prefix.length !== transaction.prefixBytes || digest(prefix) !== transaction.prefixHash) fail("changed");
    complete(p, opts, join(p.dir, chunk), Buffer.concat([prefix, bytes]), PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, required, "chunk-written", "chunk-fsync");
    current(p, opts, required); if (!readOwned(join(p.dir, "append-intent.json"), PLACEMENT_JOURNAL_ROOT_MAX_BYTES)?.equals(line(transaction))) fail("changed");
    unlinkSync(join(p.dir, "append-intent.json")); syncDirectory(p, opts, p.dir, []); opts.phase?.("intent-cleared");
    current(p, opts); const done = snapshot(p); if (done.pending || done.headHash !== record.seal) fail("changed");
    return { record, already: false };
  });
}
