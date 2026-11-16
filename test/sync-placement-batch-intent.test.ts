import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { createPlacementRecord, type PlacementEvent } from "../src/memory/sync-placement-journal-format.ts";
import { planPlacementBatchIntent, validatePlacementBatchIntent } from "../src/memory/sync-placement-batch-intent.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const epoch = hash("epoch"), attempt = hash("attempt");
function records(count: number) {
  let head = epoch;
  return Array.from({ length: count }, (_, index) => {
    const event: PlacementEvent = { kind: "hold", reason: "person-local", requestId: hash(`request ${index}`),
      key: { realm: { scope: "user" }, id: hash(`id ${index}`).slice(0, 32), rowHash: hash(`row ${index}`) },
      sourcePlacement: "synced", effectHash: hash(`effect ${index}`) };
    const record = createPlacementRecord(epoch, index + 1, head, event); head = record.seal; return record;
  });
}

test("v2 intent binds a bounded multi-chunk record chain and rejects tampering", () => {
  const input = records(300), intent = planPlacementBatchIntent(epoch, attempt, input, []);
  expect(intent.chunks.length).toBeGreaterThan(1);
  expect(intent.chunks.reduce((count, chunk) => count + chunk.count, 0)).toBe(input.length);
  expect(validatePlacementBatchIntent(JSON.parse(canonicalJSON(intent)), epoch)).toEqual(intent);
  const changed = structuredClone(intent); changed.records[1]!.effectHash = hash("other");
  expect(() => validatePlacementBatchIntent(changed, epoch)).toThrow();
  const gap = structuredClone(intent); gap.chunks[1]!.first++;
  const { seal: _seal, ...body } = gap; gap.seal = hashJSON(body);
  expect(() => validatePlacementBatchIntent(gap, epoch)).toThrow();
});

test("v2 intent retains the existing last-chunk prefix and rolls over when full", () => {
  const input = records(2), prior = [{ name: "records-00000.jsonl", size: 65530, hash: hash("existing") }];
  const intent = planPlacementBatchIntent(epoch, attempt, input, prior);
  expect(intent.chunks[0]).toMatchObject({ name: "records-00001.jsonl", prefixBytes: 0, first: 0, count: 2 });
});

test("v2 validation refuses proxy and accessor inputs without executing them", () => {
  let called = 0;
  const intent = planPlacementBatchIntent(epoch, attempt, records(1), []);
  const hostile = new Proxy(intent, { ownKeys() { called++; throw Error("private"); } });
  expect(() => validatePlacementBatchIntent(hostile, epoch)).toThrow();
  const changed = { ...intent };
  Object.defineProperty(changed, "records", { enumerable: true, get() { called++; throw Error("private"); } });
  expect(() => validatePlacementBatchIntent(changed, epoch)).toThrow();
  expect(called).toBe(0);
});
