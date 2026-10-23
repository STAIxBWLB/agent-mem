import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJSON } from "../src/memory/generation.ts";
import { entryId, MEMORY_SCHEMA, type OpEntry, type NoteEntry, type GoalEntry } from "../src/memory/store.ts";
import { pruneId, type PruneRow } from "../src/memory/prune.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { decodeShardPack, encodeShardPacks, SHARD_PACK_MAX_BYTES, SHARD_SYNC_SCHEMA, ShardSyncFormatError, shardSyncDescriptor, shardSyncLabel, shardSyncRef, type ShardSyncRealm, type ShardSyncRow } from "../src/memory/shard-sync-format.ts";

const G = "a".repeat(32), otherG = "b".repeat(32), project = "github.com/fixture/private-repository";
const realm: ShardSyncRealm = { scope: "project", key: project };
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function note(n = 0, extra: Partial<Omit<NoteEntry, "id">> = {}): NoteEntry {
  const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: "2026-10-24T00:00:00.000Z", machine: "legacy ../ machine with spaces", project,
    scope: "project", tier: "long", kind: "contract", peer: "codex", text: `original body ${n}`, title: "original title", task: `${project}#12@1000`,
    about: ["path:src/source.ts", "peer:claude"], source: "hub", ...extra };
  return { ...body, id: entryId(body) };
}
function goal(scope: "project" | "shared" = "project"): GoalEntry {
  const body: Omit<GoalEntry, "id"> = { schema: MEMORY_SCHEMA, op: "goal", at: "2026-10-24T00:00:00.000Z", machine: "goal-author", project, scope,
    title: "original goal", milestones: ["one", "two"], dependsOn: [], actor: "person" };
  return { ...body, id: entryId(body) };
}
function prune(generation = G, placement: "local" | "synced" = "synced"): PruneRow {
  const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation, at: "2026-10-24T00:00:00.000Z", machine: "c".repeat(16), actor: "person", placement,
    cutoff: "2026-10-23T00:00:00.000Z", targets: [{ id: "1".repeat(32), rowHash: "2".repeat(64), expiredAt: "2026-10-22T00:00:00.000Z", basis: { kind: "note", id: "1".repeat(32), rowHash: "2".repeat(64) } }] };
  return { ...body, id: pruneId(body) };
}
function rawPack(bytes: Buffer, machine = note().machine): [string, Buffer] { return [`rows/${digest(machine)}/${digest(bytes)}.jsonl`, bytes]; }
function decode(rows: ShardSyncRow[], selected: ShardSyncRealm = realm, generation = G): ShardSyncRow[] {
  return [...encodeShardPacks(rows)].flatMap(([path, bytes]) => decodeShardPack(path, bytes, selected, generation));
}

test("stable project and user refs/descriptors contain no local generation or raw-key path", () => {
  expect(shardSyncRef(realm)).toBe(`refs/heads/amem/p/${shardKeyHash(project)}`);
  expect(shardSyncRef({ scope: "user" })).toBe("refs/heads/amem/u");
  expect(JSON.parse(shardSyncDescriptor(realm))).toEqual({ schema: SHARD_SYNC_SCHEMA, scope: "project", key: project });
  expect(JSON.parse(shardSyncDescriptor({ scope: "user" }))).toEqual({ schema: SHARD_SYNC_SCHEMA, scope: "user" });
  expect(shardSyncDescriptor({ ...realm, generation: G } as ShardSyncRealm)).not.toContain(G);
  expect(shardSyncLabel(realm)).toBe(`project shard ${shardKeyHash(project)}`); expect(shardSyncLabel({ scope: "user" })).toBe("user shard");
  expect(shardSyncLabel(realm)).not.toContain(project);
});

test("packs preserve original canonical payloads, ids and complete attribution, hashing arbitrary original machine names", () => {
  const first = note(1), second = note(2, { machine: "another / original author", peer: "claude", source: "claude-mem" });
  const expected = [first, second, goal()], packs = encodeShardPacks(expected);
  expect(packs.size).toBe(3);
  for (const [path, bytes] of packs) {
    expect(path).toMatch(/^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/); expect(path).not.toContain("legacy");
    expect(bytes.toString()).toEndWith("\n");
    for (const line of bytes.toString().trimEnd().split("\n")) expect(line).toBe(canonicalJSON(JSON.parse(line)));
  }
  expect(decode(expected).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
  expect([...encodeShardPacks([...expected].reverse())]).toEqual([...packs]);
  expect(decode([first, first])).toEqual([first, first]);
});

test("immutable packs chunk whole rows within one MiB and retain every unique row in stable id order", () => {
  const rows = Array.from({ length: 400 }, (_, n) => note(n, { text: `${n}:` + "public payload ".repeat(260) }));
  const packs = encodeShardPacks(rows);
  expect(packs.size).toBeGreaterThan(1);
  const output = [...packs].flatMap(([path, bytes]) => {
    expect(bytes.length).toBeLessThanOrEqual(SHARD_PACK_MAX_BYTES); expect(bytes.length).toBeGreaterThan(0);
    return decodeShardPack(path, bytes, realm, G);
  });
  expect(output).toHaveLength(rows.length);
  expect(output.map(row => row.id)).toEqual(rows.map(row => row.id).sort());
  expect(new Set(output.map(row => row.id)).size).toBe(rows.length);
});

test("tampered path/body, invalid UTF-8 and incomplete rows fail closed with neutral shard-labelled errors", () => {
  const [path, bytes] = [...encodeShardPacks([note()])][0]!;
  const changed = Buffer.from(bytes!); changed[0] = changed[0]! ^ 1;
  expect(() => decodeShardPack(path!, changed, realm, G)).toThrow(ShardSyncFormatError);
  expect(() => decodeShardPack("../" + path, bytes!, realm, G)).toThrow(ShardSyncFormatError);
  for (const bad of [Buffer.from(bytes!.subarray(0, -1)), Buffer.from([255, 10]), Buffer.from("\n"), Buffer.from('{"not":"a valid row"}\n')]) {
    const [badPath] = rawPack(bad);
    expect(() => decodeShardPack(badPath, bad, realm, G)).toThrow(ShardSyncFormatError);
  }
  const [wrongAuthor] = rawPack(bytes!, "wrong machine");
  expect(() => decodeShardPack(wrongAuthor, bytes!, realm, G)).toThrow("pack author mismatch");
  const invalidId = Buffer.from(canonicalJSON({ ...note(), text: "PRIVATE-DIAGNOSTIC-CANARY" }) + "\n"), [badPath] = rawPack(invalidId);
  try { decodeShardPack(badPath, invalidId, realm, G); throw new Error("expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ShardSyncFormatError); expect((error as Error).message).toContain(shardSyncLabel(realm)); expect((error as Error).message).not.toContain("PRIVATE-DIAGNOSTIC-CANARY"); }
});

test("realm ownership rejects wrong project or placement and never publishes local-only operations", () => {
  for (const row of [note(0, { project: "foreign-project" }), note(0, { scope: "shared" }), goal("shared")]) expect(() => decode([row])).toThrow("row scope mismatch");
  for (const row of [note(), goal()]) expect(() => decode([row], { scope: "user" })).toThrow("row scope mismatch");
  const shared = note(0, { scope: "shared" }); expect(decode([shared, goal("shared")], { scope: "user" })).toEqual(expect.arrayContaining([shared, goal("shared")]));
  expect(() => encodeShardPacks([note(0, { tier: "short" })])).toThrow("invalid public row");
  const body: Omit<OpEntry, "id"> = { schema: MEMORY_SCHEMA, op: "settle", at: "2026-10-24T00:00:00.000Z", machine: "original author", target: "private-task", by: "2026-10-25T00:00:00.000Z", actor: "codex" };
  expect(() => encodeShardPacks([{ ...body, id: entryId(body) }])).toThrow("invalid public row");
  expect(() => encodeShardPacks([prune(G, "local")])).toThrow("invalid public row");
});

test("same-generation public prune is structurally accepted, but any foreign-generation prune refuses the whole pack", () => {
  const row = prune(); expect(decode([row])).toEqual([row]);
  // This format result alone never proves the target/basis public witness; the engine must validate the complete realm source set.
  const foreign = prune(otherG);
  expect(() => decode([foreign])).toThrow(`${shardSyncLabel(realm)}: foreign-generation prune`);
  expect(() => decode([note(0, { machine: foreign.machine }), foreign])).toThrow("foreign-generation prune");
});

test("same id with a different payload is rejected instead of silently winning", () => {
  const row = note();
  expect(() => encodeShardPacks([row, { ...row, text: "different body" }])).toThrow("row id collision");
});
