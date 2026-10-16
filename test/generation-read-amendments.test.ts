import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, entryId } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { realPath } from "../src/memory/platform.ts";
import { legacyEntries, readLegacySnapshot, SegmentReader } from "../src/memory/bridge.ts";

const G = "f".repeat(32), NOW = Date.parse("2030-01-01T00:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-generation-read-amendments-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const input = (text: string) => ({ op: "note" as const, project: "agent-hub", scope: "project" as const, tier: "long" as const, kind: "finding" as const, peer: "person", source: "person" as const, text, about: ["path:src/public.ts"] });

// Written before bridge/index changes: unknown operations and mismatched IDs are malformed legacy input, not fatal history mutations.
test("legacy malformed lines are skipped and equally counted by dry-run apply and ordinary generation replay", async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const id = old.note(input("valid before malformed rows")), memoryDir = old.dir, machine = old.machine.id;
  old.close();
  const row = JSON.parse(readFileSync(join(memoryDir, "log", `${machine}.jsonl`), "utf8"));
  const bad = Buffer.concat([Buffer.from("not JSON\n" + JSON.stringify({ ...row, op: "unknown-future-op" }) + "\n" + JSON.stringify({ ...row, text: "changed body with old id" }) + "\n"), Buffer.from([255, 10])]);
  appendFileSync(join(memoryDir, "log", `${machine}.jsonl`), bad);
  let skipped = 0;
  const snapshot = readLegacySnapshot(memoryDir, { onMalformed: () => skipped++ });
  expect(skipped).toBe(4);
  expect(legacyEntries(snapshot).map(row => row.id)).toEqual([id]);
  const options = { memoryDir, generation: G, authorizedPerson: true, tty: true, now: () => NOW };
  const dry = await migrate({ ...options, mode: "dry-run" });
  const applied = await migrate({ ...options, mode: "apply" });
  expect(dry.counts?.skippedRows).toBe(4); expect(applied.counts?.skippedRows).toBe(4);
  const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true }); cleanup.push(() => store.close());
  expect(store.list().map(row => row.id)).toEqual([id]);
  const extra = { schema: "agent-hub.memory/v1" as const, at: new Date(NOW + 1).toISOString(), machine, ...input("valid after malformed suffix") };
  appendFileSync(join(memoryDir, "log", `${machine}.jsonl`), Buffer.concat([bad, Buffer.from(JSON.stringify({ ...extra, id: entryId(extra) }) + "\n")]));
  expect(store.list().map(row => row.text).sort()).toEqual(["valid before malformed rows", "valid after malformed suffix"].sort());
  expect(store.bridgeStatus()?.skippedRows).toBe(8);
  const before = store.derivedTables(); store.rebuild(); expect(store.derivedTables()).toEqual(before);
  expect(store.bridgeStatus()?.skippedRows).toBe(8);
});

test("ordinary generation list get graph counts and reopen never spawn Git even when bridge.git exists", async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const id = old.note(input("ordinary no-Git read")), memoryDir = old.dir; old.close();
  await migrate({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const dir = join(memoryDir, "generations", G);
  mkdirSync(join(dir, "bridge.git"), { recursive: true });
  const bin = home(), called = join(bin, "git-called");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf called >> '${called}'\nexit 91\n`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    for (let reopen = 0; reopen < 2; reopen++) {
      const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true });
      try {
        expect(store.get(id)?.text).toBe("ordinary no-Git read");
        expect(store.list().map(row => row.id)).toEqual([id]);
        expect(store.counts().long).toBe(1);
        expect(store.graph("agent-hub", `mem:${id}`, 1).nodes.some(node => node.id === `mem:${id}`)).toBe(true);
      } finally { store.close(); }
    }
    expect(existsSync(called)).toBe(false);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test("generation-born settlement cannot qualify a legacy held note for explicit expiry prune", async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const task = "agent-hub#1@1", id = old.note({ ...input("legacy held finding"), tier: "short", task });
  const memoryDir = old.dir; old.close();
  await migrate({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true }); cleanup.push(() => store.close());
  store.settle(task, "person");
  expect(store.prunePort().snapshot().expiries.some(row => row.targetId === id)).toBe(false);
});

test("a generation duplicate of a legacy full ID never changes that identity's birth provenance", async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const fields = input("legacy full-ID replay"), id = old.note(fields), memoryDir = old.dir; old.close();
  await migrate({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true }); cleanup.push(() => store.close());
  expect(store.note(fields)).toBe(id);
  const internal = store as unknown as { generationIndex: { own(id: string): boolean } };
  expect(internal.generationIndex.own(id)).toBe(false);
});


test("segment counters prove zero-cost unchanged reopen, live suffix hashing and one cold-changed full seed", () => {
  const parent = home(), path = join(parent, "segment.jsonl"), first = Buffer.from("first complete line\n"), next = Buffer.from("next complete line\n");
  writeFileSync(path, first);
  const reader = new SegmentReader(), captured = reader.read(path);
  const prior = { source: "legacy-local", path: "log/fixture.jsonl", ...captured };
  reader.resetMetrics();
  expect(reader.read(path, prior).bytes).toHaveLength(0);
  expect(reader.metrics()).toEqual({ bytesRead: 0, bytesHashed: 0, coldChanged: 0 });
  const reopened = new SegmentReader();
  expect(reopened.read(path, prior).bytes).toHaveLength(0);
  expect(reopened.metrics()).toEqual({ bytesRead: 0, bytesHashed: 0, coldChanged: 0 });
  appendFileSync(path, next);
  const live = reader.read(path, prior);
  expect(live.start).toBe(first.length); expect(live.bytes).toEqual(next);
  expect(reader.metrics().bytesHashed).toBe(next.length);
  expect(reader.metrics().bytesRead).toBe((first.length + next.length) * 2);
  expect(reader.metrics().coldChanged).toBe(0);
  const cold = new SegmentReader(), coldRead = cold.read(path, prior);
  expect(coldRead.hash).toBe(live.hash);
  expect(cold.metrics()).toEqual({ bytesRead: (first.length + next.length) * 2, bytesHashed: first.length + next.length, coldChanged: 1 });
});

test("a rewritten consumed prefix plus file growth cannot masquerade as a valid live append", () => {
  const parent = home(), path = join(parent, "segment.jsonl"), reader = new SegmentReader();
  writeFileSync(path, "immutable prefix\n");
  const prior = { source: "legacy-local", path: "log/fixture.jsonl", ...reader.read(path) };
  writeFileSync(path, "rewritten prefix\nnew suffix\n");
  expect(() => reader.read(path, prior)).toThrow("person inspection required");
  expect(() => new SegmentReader().read(path, prior)).toThrow("person inspection required");
});

test("actual generation readers reuse metadata checkpoints for legacy and own segments across reopen", async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const id = old.note(input("unchanged bridge row")), memoryDir = old.dir; old.close();
  await migrate({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const first = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true });
  const own = first.note(input("unchanged own row"));
  const metrics = (store: MemoryStore) => (store as unknown as { generationIndex: { reader: SegmentReader } }).generationIndex.reader;
  metrics(first).resetMetrics();
  try {
    first.list(); first.get(id); first.get(own); first.counts(); first.graph("agent-hub", `mem:${id}`);
    expect(metrics(first).metrics()).toEqual({ bytesRead: 0, bytesHashed: 0, coldChanged: 0 });
  } finally { first.close(); }
  const reopened = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true });
  try {
    reopened.list(); reopened.get(id); reopened.get(own); reopened.counts();
    expect(metrics(reopened).metrics()).toEqual({ bytesRead: 0, bytesHashed: 0, coldChanged: 0 });
    const before = reopened.derivedTables(); reopened.rebuild(); expect(reopened.derivedTables()).toEqual(before);
    expect(metrics(reopened).metrics().bytesHashed).toBeGreaterThan(0);
  } finally { reopened.close(); }
});


test("recreating only the generation derived index replays captured legacy prefixes instead of treating receipts as consumed rows", async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const first = old.note(input("legacy baseline before migration")), memoryDir = old.dir; old.close();
  await migrate({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true });
  const second = store.note(input("generation baseline after migration")), dir = store.dir;
  expect(store.list().map(row => row.id).sort()).toEqual([first, second].sort()); store.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `index.db${suffix}`), { force: true });
  const recreated = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true });
  try {
    expect(recreated.list().map(row => row.id).sort()).toEqual([first, second].sort());
    const before = recreated.derivedTables(); recreated.rebuild(); expect(recreated.derivedTables()).toEqual(before);
  } finally { recreated.close(); }
});


for (const order of ["generation-first", "legacy-first"] as const) test(`same full-ID settlement keeps both birth-realm memberships: ${order}`, async () => {
  const parent = home(), old = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW });
  const task = "agent-hub#33@1", legacy = old.note({ ...input("legacy realm finding"), tier: "short", task }), memoryDir = old.dir;
  await migrate({ memoryDir, mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true });
  try {
    const own = store.note({ ...input("generation realm finding"), tier: "short", task });
    if (order === "generation-first") { store.settle(task, "person"); old.settle(task, "person"); }
    else { old.settle(task, "person"); store.settle(task, "person"); }
    const snapshot = store.prunePort().snapshot();
    const settleRows = snapshot.rows.filter(source => source.row.op === "settle" && source.row.target === task);
    expect(settleRows).toHaveLength(1);
    expect(settleRows[0]).toMatchObject({ own: true, legacy: true });
    expect(snapshot.expiries.filter(expiry => [legacy, own].includes(expiry.targetId)).map(expiry => expiry.targetId).sort()).toEqual([legacy, own].sort());
    const deadline = new Date(NOW + 14 * 86_400_000).toISOString();
    expect(store.get(legacy)?.expiresAt).toBe(deadline); expect(store.get(own)?.expiresAt).toBe(deadline);
    const before = store.derivedTables(); store.rebuild(); expect(store.derivedTables()).toEqual(before);
  } finally { store.close(); old.close(); }
});
