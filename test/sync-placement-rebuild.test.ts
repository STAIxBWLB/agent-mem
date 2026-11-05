import { expect, test } from "bun:test";
import fixture from "./fixtures/sync-placement-journal.json";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { PLACEMENT_FORMAT } from "../src/memory/sync-placement-format.ts";
import {
  PLACEMENT_ACTIVE_FENCE_SCHEMA, PLACEMENT_JOURNAL_MAX_RECORDS, PLACEMENT_JOURNAL_MAX_OBJECTS,
  PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_ROOT_MAX_BYTES,
  SyncPlacementJournalError, validatePlacementEpoch, validatePlacementActiveFence, validatePlacementEvent, validatePlacementRecord,
  createPlacementRecord, placementEpochHash, placementKeyId, type PlacementEvent,
} from "../src/memory/sync-placement-journal-format.ts";
import { PlacementProjection, rebuildPlacementProjection } from "../src/memory/sync-placement-projection.ts";

const epoch = () => validatePlacementEpoch(fixture.epoch);
const event = (at: number): PlacementEvent => {
  const { schema: _schema, epochHash: _epoch, sequence: _sequence, previousHash: _previous, seal: _seal, ...value } = fixture.records[at]!;
  return validatePlacementEvent(value);
};
const key = () => event(0).key;
function rejected(work: () => unknown, code?: string): void {
  expect(work).toThrow(SyncPlacementJournalError);
  try { work(); } catch (error) { if (code) expect((error as SyncPlacementJournalError).code).toBe(code); expect((error as Error).message).not.toContain("private-canary"); }
}

test("static journal fixture seals and independent expected states match incremental and complete rebuild", () => {
  const initial = epoch(), projection = new PlacementProjection(initial);
  expect(placementEpochHash(initial)).toBe(fixture.epochHash); expect(projection.headHash).toBe(fixture.epochHash); expect(projection.states()).toEqual([]);
  for (const [at, raw] of fixture.records.entries()) {
    projection.apply(raw);
    expect(projection.sequence).toBe(at + 1); expect(projection.headHash).toBe(raw.seal);
    expect(rebuildPlacementProjection(initial, fixture.records.slice(0, at + 1)).states()).toEqual(projection.states());
    if (at === 3) expect<unknown>(projection.states()).toEqual(fixture.expectedAfterRelease);
  }
  expect<unknown>(projection.states()).toEqual(fixture.expectedStates); expect(projection.headHash).toBe(fixture.expectedHead);
  const complete = rebuildPlacementProjection(initial, fixture.records); expect<unknown>(complete.states()).toEqual(fixture.expectedStates);
  expect(placementKeyId(key())).toBe(hashJSON(key()));
  expect(JSON.stringify(projection.states())).not.toContain("private-canary");
});

test("old release request cannot replay after a later hold or advance the frontier on conflict", () => {
  const projection = rebuildPlacementProjection(epoch(), fixture.records.slice(0, 5)), before = projection.states(), previous = projection.headHash;
  const release = event(3), replay = createPlacementRecord(projection.epochHash, 6, projection.headHash, release);
  rejected(() => projection.apply(replay), "conflict"); expect(projection.states()).toEqual(before); expect(projection.headHash).toBe(previous); expect(projection.sequence).toBe(5);
  expect(projection.get(key())?.reasons).toEqual(["related-local"]);
  const receipt = projection.request(release.requestId)!; expect(receipt.sequence).toBe(4); expect(receipt.kind).toBe("release");
  receipt.key.rowHash = "a".repeat(64); expect(projection.request(release.requestId)!.key.rowHash).toBe(key().rowHash);
});

test("hold reasons stay sticky, release alone clears them and recorded exposure never becomes unpublished", () => {
  const projection = rebuildPlacementProjection(epoch(), fixture.records.slice(0, 2));
  expect(projection.get(key())?.reasons).toEqual(["person-local", "personal-data"]);
  projection.apply(fixture.records[2]); expect(projection.get(key())?.held).toBe(true); expect(projection.get(key())?.exposure).toBe("unknown");
  projection.apply(fixture.records[3]); expect(projection.get(key())?.held).toBe(false);
  for (const row of fixture.records.slice(4, 7)) projection.apply(row);
  expect(projection.get(key())).toMatchObject({ held: true, reasons: ["related-local"], exposure: "published" });
  expect<unknown>(projection.get(key())?.attempts).toEqual(fixture.expectedStates.find(state => state.key.id === key().id)!.attempts);
  const next = createPlacementRecord(projection.epochHash, 8, projection.headHash, { ...event(3), requestId: "a".repeat(64), sourcePlacement: "local" });
  projection.apply(next); expect(projection.get(key())).toMatchObject({ sourcePlacement: "local", held: false, exposure: "published" });
});

test("same physical realm and id cannot change row hash; different realms remain separate", () => {
  const projection = rebuildPlacementProjection(epoch(), fixture.records.slice(0, 1));
  const changed = createPlacementRecord(projection.epochHash, 2, projection.headHash, { ...event(0), requestId: "a".repeat(64), key: { ...key(), rowHash: "b".repeat(64) } });
  rejected(() => projection.apply(changed), "conflict"); rejected(() => projection.get(changed.key), "conflict");
  const another = createPlacementRecord(projection.epochHash, 2, projection.headHash, { ...event(0), requestId: "a".repeat(64), key: { ...changed.key, realm: { scope: "project", keyHash: "c".repeat(64) } } });
  projection.apply(another); expect(projection.states()).toHaveLength(2);
  const detached = projection.states(); detached[0]!.reasons.length = 0; detached[0]!.key.id = "b".repeat(32);
  expect(projection.states().every(state => state.held)).toBe(true);
});

test("per-attempt identity and committed proof conflicts cannot overwrite retained publication evidence", () => {
  const projection = rebuildPlacementProjection(epoch(), fixture.records.slice(0, 6)), committed = event(5);
  if (committed.kind !== "publication-committed") throw Error("fixture kind");
  for (const outcome of [{ ...committed.outcome, remoteHash: "a".repeat(64) }, { ...committed.outcome, refHash: "a".repeat(64) },
    { ...committed.outcome, commit: "a".repeat(40) }, { ...committed.outcome, proofHash: "a".repeat(64) }]) {
    const row = createPlacementRecord(projection.epochHash, 7, projection.headHash, { ...committed, requestId: "b".repeat(64), outcome });
    rejected(() => projection.apply(row), "conflict"); expect(projection.sequence).toBe(6); expect(projection.get(key())?.exposure).toBe("published");
  }
});

test("unknown/future/ambiguous-extra fields and malformed closed records refuse without leaking input", () => {
  const first = fixture.records[0]!, hold = event(0);
  for (const raw of [{ ...fixture.epoch, planSeal: "private-canary" }, { ...fixture.epoch, schema: "future" }, { ...fixture.epoch, nonce: fixture.epoch.nonce + "\n" }]) rejected(() => validatePlacementEpoch(raw));
  for (const raw of [{ ...hold, extra: "private-canary" }, { ...hold, kind: "future" }, { ...hold, reason: "private-canary" }, { ...hold, sourcePlacement: "maybe" }, { ...hold, requestId: hold.requestId + "\n" }, { ...hold, outcome: {} },
    { ...event(3), reason: "person-local" }, { ...event(2), outcome: { ...(event(2) as { outcome: object }).outcome, commit: "a".repeat(40) } }]) rejected(() => validatePlacementEvent(raw));
  for (const raw of [{ ...first, extra: "private-canary" }, { ...first, schema: "future" }, { ...first, seal: "a".repeat(64) }, { ...first, sequence: 0 }, { ...first, previousHash: "b".repeat(64) }]) rejected(() => validatePlacementRecord(raw));
  const skipped = createPlacementRecord(fixture.epochHash, 2, fixture.epochHash, event(1)); rejected(() => new PlacementProjection(epoch()).apply(skipped), "corrupt");
  const wrongEpoch = { ...epoch(), nonce: "0".repeat(32) }, foreign = createPlacementRecord(placementEpochHash(wrongEpoch), 1, placementEpochHash(wrongEpoch), hold);
  rejected(() => new PlacementProjection(epoch()).apply(foreign), "corrupt");
});

test("active fence is a closed body-free fact and epoch bounds are fixed", () => {
  const value = { schema: PLACEMENT_ACTIVE_FENCE_SCHEMA as typeof PLACEMENT_ACTIVE_FENCE_SCHEMA, epochHash: fixture.epochHash, homeHash: fixture.epoch.homeHash, generation: fixture.epoch.generation };
  expect(validatePlacementActiveFence(value)).toEqual(value);
  rejected(() => validatePlacementActiveFence({ ...value, body: "private-canary" }));
  rejected(() => validatePlacementActiveFence({ ...value, epochHash: fixture.epochHash + "\n" }));
  expect(PLACEMENT_JOURNAL_MAX_RECORDS).toBe(20_000); expect(PLACEMENT_JOURNAL_MAX_OBJECTS).toBe(256);
  expect(PLACEMENT_JOURNAL_CHUNK_MAX_BYTES).toBe(64 * 1024); expect(PLACEMENT_JOURNAL_ROOT_MAX_BYTES).toBe(256 * 1024);
  rejected(() => createPlacementRecord(fixture.epochHash, 20_001, fixture.epochHash, event(0)), "bound");
  rejected(() => rebuildPlacementProjection(epoch(), Array.from({ length: 20_001 }, () => fixture.records[0])), "bound");
  expect(epoch().publicationFormat).toBe(PLACEMENT_FORMAT);
});

test("pure validators do not invoke getter, proxy, coercion or serialization hooks", () => {
  let calls = 0;
  const bad = Object.defineProperty({ ...fixture.epoch }, "generation", { enumerable: true, get() { calls++; return "a".repeat(32); } });
  rejected(() => validatePlacementEpoch(bad));
  const proxy = new Proxy(fixture.epoch, { getPrototypeOf() { calls++; throw Error("private-canary"); }, ownKeys() { calls++; return []; } });
  rejected(() => validatePlacementEpoch(proxy));
  const value = { toJSON() { calls++; return fixture.epochHash; } };
  rejected(() => createPlacementRecord(value as never, 1, fixture.epochHash, event(0)));
  const input = [fixture.records[0]]; Object.defineProperty(input, "0", { get() { calls++; return fixture.records[0]; }, enumerable: true });
  rejected(() => rebuildPlacementProjection(epoch(), input)); expect(calls).toBe(0);
});
