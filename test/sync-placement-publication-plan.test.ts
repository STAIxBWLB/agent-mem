import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { PLACEMENT_FORMAT, validatePlacementProfile } from "../src/memory/sync-placement-format.ts";
import { planSyncPlacementActivation, type SyncPlacementActivationContext } from "../src/memory/sync-placement-plan.ts";
import { PLACEMENT_EPOCH_SCHEMA, placementEpochHash, createPlacementRecord, SyncPlacementJournalError, type PlacementEpoch, type PlacementEvent } from "../src/memory/sync-placement-journal-format.ts";
import { preparePlacementEpoch, ensurePlacementFence, readPlacementJournal, appendPlacementEvent, type PlacementStorageOptions, type PlacementStoragePhase } from "../src/memory/sync-placement-journal-storage.ts";
import { planPlacementPublication, validatePlacementPublicationBundle, publicationBytes, publicationFileNames, type PlacementPublicationSource, type PlacementPublicationDecision } from "../src/memory/sync-placement-publication-plan.ts";
import { preparePlacementPublication, readPlacementPublication, recordPlacementPublicationPhase } from "../src/memory/sync-placement-publication-storage.ts";

const h = (x: string) => hashJSON(x), key = { realm: { scope: "user" as const }, id: "d".repeat(32), rowHash: h("row") };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const json = (x: unknown) => canonicalJSON(x) + "\n";
const event = (n: number): PlacementEvent => ({ requestId: h("request" + n), effectHash: h("effect" + n), key, sourcePlacement: "synced", kind: "hold", reason: "person-local" });
function fixture(reserved = 1) {
  const home = mkdtempSync(join(tmpdir(), "amem-publication-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const generation = "a".repeat(32), profile = { schema: "agent-mem.profile/v2", kind: "generation", generation, foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: h("prunes") };
  const shards = { schema: "agent-mem.shards/v2", generation, phase: "active", selectorRevision: hashJSON(profile), sources: [], machine: { id: "b".repeat(16), label: "publication fixture" } };
  const context: SyncPlacementActivationContext = { profile, shards, homeHash: h(home), sourceHash: h("source"), aliasesHash: h("aliases"), policyHash: h("policy"), realms: [],
    writers: [{ writerId: h("writer"), pin: h("pin"), version: "1.0.0", publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true };
  const epoch: PlacementEpoch = { schema: PLACEMENT_EPOCH_SCHEMA, publicationFormat: PLACEMENT_FORMAT, generation, homeHash: context.homeHash, contextHash: hashJSON(context), nonce: "e".repeat(32) };
  const epochHash = placementEpochHash(epoch), activation = planSyncPlacementActivation(context, epochHash), mutation = acquireMutation(home);
  if (!mutation) throw Error("fixture lock unavailable"); cleanup.push(mutation);
  const opts: PlacementStorageOptions = { mutation, assertCurrent() {} };
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 }); writeFileSync(join(home, "shards.json"), json(shards), { mode: 0o600 });
  preparePlacementEpoch(home, epoch, activation, opts);
  const active = validatePlacementProfile(activation.targetProfile);
  writeFileSync(join(home, "profile.json"), json(active), { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), json({ ...shards, schema: "agent-mem.shards/v3", selectorRevision: hashJSON(active), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
  ensurePlacementFence(home, epochHash, opts);
  const recordSizes: number[] = []; let head = epochHash;
  for (let i = 0; i < reserved; i++) { const record = createPlacementRecord(epochHash, i + 1, head, event(i + 1)); recordSizes.push(publicationBytes(record).length); head = record.seal; }
  const input = { epochHash, generation, homeHash: context.homeHash, contextHash: hashJSON(context), markerHash: h("markers"), sourceHash: context.sourceHash, aliasesHash: context.aliasesHash,
    policyHash: context.policyHash, remoteHash: h("remote"), journal: { sequence: 0, headHash: epochHash }, reservedRecords: reserved, reservedRecordBytes: recordSizes, createdUnixSeconds: 123456,
    targets: [{ realm: key.realm, refHash: h("ref"), expectedRemoteHead: null, expectedCacheHead: null, descriptorHash: h("descriptor"), exportSetHash: h("export"), tree: "1".repeat(40), commit: "2".repeat(40) }] };
  const items = { sources: [{ realm: key.realm, source: "generation" as const, pathHash: h("path"), dev: "1", ino: "2", byteLength: 4, hash: h("prefix"), mtimeNs: "3", ctimeNs: "4" }],
    decisions: [{ key, eligible: false, sourcePlacement: "synced" as const, reason: "person-local" as const, dependencies: [] }],
    objects: [{ targetIndex: 0, type: "blob" as const, path: "shard.json", oid: "3".repeat(40), sha256: h("descriptor"), size: 100 }] };
  const bundle = planPlacementPublication(input, items), dir = join(home, "sync-placement", "epochs", epochHash);
  return { home, epochHash, bundle, opts, dir, input, items };
}
function code(work: () => unknown): string {
  try { work(); } catch (error) { expect(error).toBeInstanceOf(SyncPlacementJournalError); return (error as SyncPlacementJournalError).code; }
  throw Error("expected refusal");
}
function state(dir: string): Record<string, string> { return Object.fromEntries(readdirSync(dir).sort().map(name => [name, h(readFileSync(join(dir, name)).toString("base64"))])); }
function artifact(f: ReturnType<typeof fixture>) {
  recordPlacementPublicationPhase(f.home, f.epochHash, f.bundle.root.seal, "artifact-built", { exportHash: h("artifacts") }, f.opts);
  return readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).facts[0]!;
}
function intent(f: ReturnType<typeof fixture>) {
  const built = artifact(f);
  recordPlacementPublicationPhase(f.home, f.epochHash, f.bundle.root.seal, "publication-intent", { artifactFactHash: built.seal, policyHash: f.bundle.root.policyHash, policyCheckUnixMs: 123456000 }, f.opts);
  return readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).facts[1]!;
}

test("publication plan is deterministic, detached, body-free and closes source/object/chunk hashes", () => {
  const f = fixture(); expect(planPlacementPublication(f.input, f.items)).toEqual(f.bundle);
  f.items.sources[0]!.ino = "999"; expect(f.bundle.chunks[0]!.items[0]).toMatchObject({ ino: "2" });
  const changed = structuredClone(f.bundle); changed.chunks[0]!.items[0] = { ...changed.chunks[0]!.items[0], ino: "3" } as PlacementPublicationSource;
  expect(() => validatePlacementPublicationBundle(changed)).toThrow();
  expect(() => planPlacementPublication(f.input, { ...f.items, objects: [{ ...f.items.objects[0]!, path: "/private/source.jsonl" }] })).toThrow();
  expect(() => planPlacementPublication({ ...f.input, reservedRecordBytes: [2049] }, f.items)).toThrow();
  expect(() => planPlacementPublication({ ...f.input, reservedRecordBytes: [] }, f.items)).toThrow();
});

test("chunking supports more than snapshot's 4096 nodes without increasing 64KiB/20k limits", () => {
  const f = fixture(0), decisions: PlacementPublicationDecision[] = Array.from({ length: 1200 }, (_, n) => ({ ...f.items.decisions[0]!, key: { ...key, id: n.toString(16).padStart(32, "0") } }));
  const bundle = planPlacementPublication(f.input, { ...f.items, decisions });
  expect(bundle.chunks.filter(c => c.kind === "decisions").length).toBeGreaterThan(1);
  expect(bundle.chunks.every(c => publicationBytes(c).length <= 65536)).toBe(true);
  expect(validatePlacementPublicationBundle(bundle)).toEqual(bundle);
  expect(() => planPlacementPublication(f.input, { ...f.items, decisions: [...decisions, decisions[0]!] })).toThrow();
});

test("hostile getters/proxies are refused without invocation or payload disclosure", () => {
  const f = fixture(); let calls = 0;
  const hostile = { ...f.input, journal: Object.defineProperty({}, "sequence", { enumerable: true, get() { calls++; throw Error("private payload"); } }) };
  expect(() => planPlacementPublication(hostile as typeof f.input, f.items)).toThrow(); expect(calls).toBe(0);
  expect(() => planPlacementPublication(new Proxy(f.input, { getPrototypeOf() { calls++; throw Error("private payload"); } }), f.items)).toThrow(); expect(calls).toBe(0);
});

test("plan reserves phase objects, blocks unrelated/release appends and permits exact tagged records", () => {
  const f = fixture(); preparePlacementPublication(f.home, f.bundle, f.opts);
  expect(readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal)).toMatchObject({ phase: "prepared", pending: false, reservedRecords: 1, consumedRecords: 0 });
  expect(readPlacementJournal(f.home, f.epochHash).publicationReservation).toMatchObject({ attemptHash: f.bundle.root.seal, reservedRecords: 1, consumedRecords: 0 });
  const before = state(f.dir);
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts))).toBe("busy");
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, { requestId: h("release"), effectHash: h("release-effect"), key, sourcePlacement: "synced", kind: "release" }, f.epochHash,
    { ...f.opts, publicationAttemptHash: f.bundle.root.seal }))).toBe("busy");
  expect(state(f.dir)).toEqual(before);
  const result = appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, { ...f.opts, publicationAttemptHash: f.bundle.root.seal });
  expect(result.already).toBe(false);
  expect(readPlacementJournal(f.home, f.epochHash).publicationReservation?.consumedRecords).toBe(1);
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, event(2), result.record.seal, { ...f.opts, publicationAttemptHash: f.bundle.root.seal }))).toBe("bound");
});

test("exact reserved record bytes are checked before any fence/intent effect", () => {
  const f = fixture(), bundle = planPlacementPublication({ ...f.input, reservedRecordBytes: [f.input.reservedRecordBytes[0]! - 1] }, f.items);
  preparePlacementPublication(f.home, bundle, f.opts); const before = state(f.dir);
  expect(code(() => appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, { ...f.opts, publicationAttemptHash: bundle.root.seal }))).toBe("conflict");
  expect(state(f.dir)).toEqual(before); expect(existsSync(join(f.home, "sync-placement", "active.json"))).toBe(true);
});

test("phase chain is exact, monotone and unknown completion releases the pending fence", () => {
  const f = fixture(0); preparePlacementPublication(f.home, f.bundle, f.opts);
  expect(code(() => recordPlacementPublicationPhase(f.home, f.epochHash, f.bundle.root.seal, "publication-intent", { artifactFactHash: h("wrong"), policyHash: f.input.policyHash, policyCheckUnixMs: 1 }, f.opts))).toBe("pending");
  const sent = intent(f), before = state(f.dir);
  recordPlacementPublicationPhase(f.home, f.epochHash, f.bundle.root.seal, "publication-intent", { artifactFactHash: readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).facts[0]!.seal, policyHash: f.input.policyHash, policyCheckUnixMs: 123456000 }, f.opts);
  expect(state(f.dir)).toEqual(before);
  recordPlacementPublicationPhase(f.home, f.epochHash, f.bundle.root.seal, "completed", { intentFactHash: sent.seal, journal: f.input.journal, outcomeHash: h("unknown"), outcome: "unknown" }, f.opts);
  expect(readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal)).toMatchObject({ phase: "completed", pending: false });
  expect(readPlacementJournal(f.home, f.epochHash).publicationReservation).toBeUndefined();
  expect(appendPlacementEvent(f.home, f.epochHash, event(1), f.epochHash, f.opts).already).toBe(false);
});

const preparationPhases: PlacementStoragePhase[] = ["publication-slot-written", "publication-slot-fsync", "publication-chunk-written", "publication-chunk-fsync", "publication-root-written", "publication-root-fsync"];
for (const at of preparationPhases) test("exact retained preparation recovers after " + at, () => {
  const f = fixture(); let fired = false;
  expect(() => preparePlacementPublication(f.home, f.bundle, { ...f.opts, phase(phase) { if (!fired && phase === at) { fired = true; throw Error("crash"); } } })).toThrow();
  expect(fired).toBe(true); preparePlacementPublication(f.home, f.bundle, f.opts);
  expect(readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).phase).toBe("prepared");
});
for (const part of ["root", "chunk-00000"] as const) test("torn " + part + " blocks readers and resumes only its exact prefix", () => {
  const f = fixture(); preparePlacementPublication(f.home, f.bundle, f.opts);
  const file = join(f.dir, `publication-${f.bundle.root.seal}-${part}.json`), bytes = readFileSync(file);
  writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)), { mode: 0o600 });
  expect(() => readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal)).toThrow();
  // Root is the final prepare acknowledgement. Simulate a crash before it was fully written as well.
  if (part !== "root") writeFileSync(join(f.dir, `publication-${f.bundle.root.seal}-root.json`), Buffer.alloc(0), { mode: 0o600 });
  preparePlacementPublication(f.home, f.bundle, f.opts);
  expect(readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).pending).toBe(false);
});

test("torn phase retains pending status and only the same sealed fact can complete", () => {
  const f = fixture(); preparePlacementPublication(f.home, f.bundle, f.opts); artifact(f);
  const file = join(f.dir, `publication-${f.bundle.root.seal}-artifact.json`), bytes = readFileSync(file);
  writeFileSync(file, bytes.subarray(0, bytes.length - 10), { mode: 0o600 });
  expect(readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).pending).toBe(true);
  expect(() => recordPlacementPublicationPhase(f.home, f.epochHash, f.bundle.root.seal, "artifact-built", { exportHash: h("different") }, f.opts)).toThrow();
  artifact(f); expect(readPlacementPublication(f.home, f.epochHash, f.bundle.root.seal).pending).toBe(false);
});

test("another unfinished attempt and the joint 256-object bound refuse before any write", () => {
  const f = fixture(); preparePlacementPublication(f.home, f.bundle, f.opts);
  const another = planPlacementPublication({ ...f.input, createdUnixSeconds: 123457 }, f.items), before = state(f.dir);
  expect(() => preparePlacementPublication(f.home, another, f.opts)).toThrow(); expect(state(f.dir)).toEqual(before);
  const g = fixture(0), huge = planPlacementPublication({ ...g.input, reservedRecords: 20000, reservedRecordBytes: Array(20000).fill(2048) }, g.items), stable = state(g.dir); let phases = 0;
  expect(code(() => preparePlacementPublication(g.home, huge, { ...g.opts, phase() { phases++; } }))).toBe("bound");
  expect(phases).toBe(0); expect(state(g.dir)).toEqual(stable);
  expect(publicationFileNames(huge.root).every(name => !existsSync(join(g.dir, name)))).toBe(true);
});


test("publication preparation requires an existing matching durable fence without creating it", () => {
  const f = fixture(); unlinkSync(join(f.home, "sync-placement", "active.json")); const before = state(f.dir); let phases = 0;
  expect(() => preparePlacementPublication(f.home, f.bundle, { ...f.opts, phase() { phases++; } })).toThrow();
  expect(phases).toBe(0); expect(state(f.dir)).toEqual(before); expect(existsSync(join(f.home, "sync-placement", "active.json"))).toBe(false);
});


test("publication decisions preserve exact safe compiler refusal reasons", () => {
  const f = fixture(0);
  for (const reason of ["journal-hold", "source-local", "unsupported-reference", "unverified-prune", "related-local"] as const) {
    const bundle = planPlacementPublication(f.input, { ...f.items, decisions: [{ ...f.items.decisions[0]!, reason }] });
    expect(bundle.chunks.find(c => c.kind === "decisions")!.items[0]).toMatchObject({ reason });
  }
});
