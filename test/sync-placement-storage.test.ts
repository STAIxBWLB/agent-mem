import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { acquireMutation, type MutationHandle } from "../src/memory/mutation.ts";
import { PLACEMENT_FORMAT, validatePlacementProfile, validatePlacementShards } from "../src/memory/sync-placement-format.ts";
import { planSyncPlacementActivation, type SyncPlacementActivationContext } from "../src/memory/sync-placement-plan.ts";
import { PLACEMENT_EPOCH_SCHEMA, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_MAX_RECORDS, SyncPlacementJournalError,
  createPlacementRecord, placementEpochHash, type PlacementEpoch, type PlacementEvent, type PlacementRecord } from "../src/memory/sync-placement-journal-format.ts";
import { rebuildPlacementProjection } from "../src/memory/sync-placement-projection.ts";
import { appendPlacementEvent, ensurePlacementFence, preparePlacementEpoch, readPlacementJournal, type PlacementStorageOptions, type PlacementStoragePhase } from "../src/memory/sync-placement-journal-storage.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => canonicalJSON(value) + "\n";
const key = { realm: { scope: "user" as const }, id: "d".repeat(32), rowHash: "e".repeat(64) };
const event = (n: number, kind: "hold" | "release" = "hold"): PlacementEvent => ({ requestId: hash("request" + n), key, sourcePlacement: "synced", effectHash: hash("effect" + n), ...(kind === "hold" ? { kind, reason: "person-local" as const } : { kind }) });
function fixture(prepared = true) {
  const home = mkdtempSync(join(tmpdir(), "amem-placement-storage-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const profile = { schema: "agent-mem.profile/v2", kind: "generation", generation: "a".repeat(32), foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "b".repeat(64) };
  const shards = { schema: "agent-mem.shards/v2", generation: profile.generation, phase: "active", selectorRevision: hashJSON(profile), sources: [], machine: { id: "c".repeat(16), label: "storage fixture" } };
  const context: SyncPlacementActivationContext = { profile, shards, homeHash: hash(home), sourceHash: hash("source"), aliasesHash: hash("aliases"), policyHash: hash("policy"), realms: [],
    writers: [{ writerId: hash("writer"), version: "1.0.0", pin: hash("pin"), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true };
  const epoch: PlacementEpoch = { schema: PLACEMENT_EPOCH_SCHEMA, publicationFormat: PLACEMENT_FORMAT, generation: profile.generation, homeHash: context.homeHash, contextHash: hashJSON(context), nonce: "f".repeat(32) };
  const epochHash = placementEpochHash(epoch), activation = planSyncPlacementActivation(context, epochHash), mutation = acquireMutation(home);
  if (!mutation) throw Error("fixture lock unavailable"); cleanup.push(mutation);
  const opts: PlacementStorageOptions = { mutation, assertCurrent() {} }, dir = join(home, "sync-placement", "epochs", epochHash);
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 }); writeFileSync(join(home, "shards.json"), json(shards), { mode: 0o600 });
  if (prepared) preparePlacementEpoch(home, epoch, activation, opts);
  const activate = () => {
    const next = validatePlacementProfile(activation.targetProfile), marker = validatePlacementShards({ ...shards, schema: "agent-mem.shards/v3", selectorRevision: hashJSON(next), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }, next);
    writeFileSync(join(home, "profile.json"), json(next), { mode: 0o600 }); writeFileSync(join(home, "shards.json"), json(marker), { mode: 0o600 });
  };
  return { home, epoch, epochHash, activation, opts, dir, activate, context };
}
function bytes(home: string): Record<string, string> {
  const root = join(home, "sync-placement"), result: Record<string, string> = {};
  const visit = (dir: string, prefix: string) => { for (const name of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, name.name), relative = prefix + name.name;
    if (name.isDirectory()) visit(file, relative + "/"); else if (!name.isSymbolicLink()) result[relative] = hash(readFileSync(file)); else result[relative] = "symlink";
  } };
  if (existsSync(root)) visit(root, ""); return result;
}
function code(work: () => unknown): string {
  try { work(); } catch (error) { expect(error).toBeInstanceOf(SyncPlacementJournalError); return (error as SyncPlacementJournalError).code; }
  throw Error("expected storage refusal");
}

test("private epoch/read/rebuild, exact last-request acknowledgement and stale-release conflict", () => {
  const f = fixture(); expect(readPlacementJournal(f.home, f.epochHash)).toMatchObject({ pending: false, sequence: 0, headHash: f.epochHash, objects: 3 });
  expect(existsSync(join(f.home, "sync-placement", "active.json"))).toBe(false); f.activate();
  const first = appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts), before = bytes(f.home);
  expect(first.already).toBe(false); expect(appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts)).toMatchObject({ already: true, record: first.record });
  expect(bytes(f.home)).toEqual(before);
  const released = appendPlacementEvent(f.home, f.epochHash, event(2, "release"), first.record.seal, f.opts);
  const held = appendPlacementEvent(f.home, f.epochHash, event(3), released.record.seal, f.opts), stable = bytes(f.home);
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, event(2, "release"), first.record.seal, f.opts))).toBe("conflict");
  expect(bytes(f.home)).toEqual(stable);
  const read = readPlacementJournal(f.home, f.epochHash), projection = rebuildPlacementProjection(read.epoch, read.records);
  expect(read).toMatchObject({ pending: false, sequence: 3, headHash: held.record.seal }); expect(projection.get(key)?.held).toBe(true);
});

const phases: PlacementStoragePhase[] = ["epoch-written", "epoch-fsync", "activation-written", "activation-fsync", "fence-written", "fence-fsync", "intent-written", "intent-fsync", "chunk-written", "chunk-fsync", "intent-cleared"];
for (const phase of phases) test("retained fault resumes exact request without another record: " + phase, () => {
  const preparing = phase.startsWith("epoch-") || phase.startsWith("activation-"), f = fixture(!preparing); let fired = false;
  const opts = { ...f.opts, phase(at: PlacementStoragePhase) { if (!fired && at === phase) { fired = true; throw Error("synthetic crash"); } } };
  if (preparing) { expect(() => preparePlacementEpoch(f.home, f.epoch, f.activation, opts)).toThrow(); preparePlacementEpoch(f.home, f.epoch, f.activation, f.opts); }
  else { f.activate(); expect(() => appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, opts)).toThrow(); appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts); }
  expect(fired).toBe(true); const read = readPlacementJournal(f.home, f.epochHash);
  expect(read.pending).toBe(false); expect(read.records.length).toBe(preparing ? 0 : 1);
});

for (const torn of ["intent", "chunk", "fence"] as const) test("owned exact torn prefix resumes and reader never claims complete: " + torn, () => {
  const f = fixture(); f.activate(); let seen = false;
  const at = torn === "fence" ? "fence-written" : torn === "intent" ? "intent-written" : "chunk-written";
  expect(() => appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, { ...f.opts, phase(phase) { if (phase === at && !seen) { seen = true; throw Error("synthetic crash"); } } })).toThrow();
  const file = torn === "fence" ? join(f.home, "sync-placement", "active.json") : join(f.dir, torn === "intent" ? "append-intent.json" : "records-00000.jsonl");
  const saved = readFileSync(file); writeFileSync(file, saved.subarray(0, Math.floor(saved.length / 2)), { mode: 0o600 });
  expect(readPlacementJournal(f.home, f.epochHash).pending).toBe(true);
  appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts);
  expect(readPlacementJournal(f.home, f.epochHash)).toMatchObject({ pending: false, sequence: 1 });
});

test("semantic row-hash/outcome conflict is refused before fence or journal effects", () => {
  const f = fixture(); f.activate(); const first = appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts), before = bytes(f.home);
  const changed = { ...event(2), key: { ...key, rowHash: "a".repeat(64) } };
  const phases: PlacementStoragePhase[] = [];
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, changed, first.record.seal, { ...f.opts, phase: at => phases.push(at) }))).toBe("conflict");
  expect(phases).toEqual([]); expect(bytes(f.home)).toEqual(before);
});

test("forged/released mutation, mismatched activation and unsafe owned files refuse without effects", () => {
  const f = fixture(false), before = bytes(f.home);
  expect(code(() => preparePlacementEpoch(f.home, f.epoch, f.activation, { ...f.opts, mutation: (() => {}) as MutationHandle }))).toBe("busy");
  const wrong = planSyncPlacementActivation({ ...f.context, sourceHash: hash("changed") }, f.epochHash);
  expect(code(() => preparePlacementEpoch(f.home, f.epoch, wrong, f.opts))).toBe("conflict"); expect(bytes(f.home)).toEqual(before);
  f.opts.mutation(); expect(code(() => preparePlacementEpoch(f.home, f.epoch, f.activation, f.opts))).toBe("busy");
  const safe = fixture(); safe.activate(); writeFileSync(join(safe.dir, "unknown"), "private", { mode: 0o600 });
  expect(code(() => appendPlacementEvent(safe.home, safe.epochHash, event(1), safe.epochHash, safe.opts))).toBe("corrupt");
  const linked = fixture(); linkSync(join(linked.dir, "epoch.json"), join(linked.home, "linked-header"));
  expect(code(() => readPlacementJournal(linked.home, linked.epochHash))).toBe("corrupt");
  const symbolic = fixture(); symlinkSync(join(symbolic.dir, "epoch.json"), join(symbolic.home, "sync-placement", "active.json"));
  expect(code(() => readPlacementJournal(symbolic.home, symbolic.epochHash))).toBe("corrupt");
  const publicMode = fixture(); chmodSync(join(publicMode.dir, "epoch.json"), 0o644);
  expect(code(() => readPlacementJournal(publicMode.home, publicMode.epochHash))).toBe("corrupt");
  expect(code(() => readPlacementJournal(safe.home, safe.epochHash + "\n"))).toBe("invalid");
});

test("proxy-thrown fresh proof becomes a fixed safe error without invoking proxy traps", () => {
  const f = fixture(false), before = bytes(f.home); let traps = 0;
  const unsafe = new Proxy({}, { getPrototypeOf() { traps++; throw Error("private prototype"); }, get() { traps++; throw Error("private message"); } });
  expect(code(() => preparePlacementEpoch(f.home, f.epoch, f.activation, { ...f.opts, assertCurrent() { throw unsafe; } }))).toBe("changed");
  expect(traps).toBe(0); expect(bytes(f.home)).toEqual(before);
});

test("a nonempty journal requires the matching immutable home/generation/epoch fence", () => {
  const f = fixture(); f.activate(); appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts);
  const file = join(f.home, "sync-placement", "active.json"), original = readFileSync(file), fence = JSON.parse(original.toString());
  for (const changed of [{ epochHash: "1".repeat(64) }, { homeHash: "2".repeat(64) }, { generation: "3".repeat(32) }]) {
    writeFileSync(file, json({ ...fence, ...changed }), { mode: 0o600 });
    expect(code(() => readPlacementJournal(f.home, f.epochHash))).toBe("corrupt");
  }
  unlinkSync(file); expect(code(() => readPlacementJournal(f.home, f.epochHash))).toBe("corrupt");
  writeFileSync(file, original, { mode: 0o600 }); expect(readPlacementJournal(f.home, f.epochHash).pending).toBe(false);
});

function seedRecords(f: ReturnType<typeof fixture>, target: number, onePerChunk = false): PlacementRecord {
  let sequence = 0, head = f.epochHash, index = 0, content = "", last: PlacementRecord | undefined;
  const flush = () => { writeFileSync(join(f.dir, `records-${String(index++).padStart(5, "0")}.jsonl`), content, { mode: 0o600 }); content = ""; };
  while (sequence < target) {
    const record = createPlacementRecord(f.epochHash, sequence + 1, head, event(sequence + 1)), encoded = json(record);
    if (Buffer.byteLength(content + encoded) > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) flush();
    content += encoded; sequence++; head = record.seal; last = record;
    if (onePerChunk) flush();
  }
  if (content) flush(); return last!;
}

test("record ceiling is checked before any new fence/intent/chunk effect", () => {
  const f = fixture(); f.activate(); ensurePlacementFence(f.home, f.epochHash, f.opts);
  const last = seedRecords(f, PLACEMENT_JOURNAL_MAX_RECORDS), before = bytes(f.home), phases: PlacementStoragePhase[] = [];
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, event(PLACEMENT_JOURNAL_MAX_RECORDS + 1), last.seal, { ...f.opts, phase: at => phases.push(at) }))).toBe("bound");
  expect(phases).toEqual([]); expect(bytes(f.home)).toEqual(before);
}, 20_000);

test("intent and new chunk are reserved together before the global fence effect", () => {
  const f = fixture(); f.activate(); ensurePlacementFence(f.home, f.epochHash, f.opts);
  let last = seedRecords(f, 251, true), content = "", sequence = 251;
  for (;;) {
    const next = createPlacementRecord(f.epochHash, sequence + 1, last.seal, event(sequence + 1)), encoded = json(next);
    if (Buffer.byteLength(content + encoded) > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) break;
    content += encoded; sequence++; last = next;
  }
  writeFileSync(join(f.dir, "records-00251.jsonl"), content, { mode: 0o600 }); const before = bytes(f.home), phases: PlacementStoragePhase[] = [];
  expect(readPlacementJournal(f.home, f.epochHash).objects).toBe(255);
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, event(sequence + 1), last.seal, { ...f.opts, phase: at => phases.push(at) }))).toBe("bound");
  expect(phases).toEqual([]); expect(bytes(f.home)).toEqual(before);
});
