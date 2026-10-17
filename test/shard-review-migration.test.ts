import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryId, MemoryStore, openShardStore, type Entry, type NoteInput, type NoteEntry, type OpEntry } from "../src/memory/store.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { pruneId, pruneRowHash, type PruneRow } from "../src/memory/prune.ts";
import { shardDir, userShardDir } from "../src/memory/shard.ts";
const A = "github.com/review/a", B = "github.com/review/b";
const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home() { const dir = mkdtempSync(join(tmpdir(), "amem-review-migration-")); homes.push(dir); return dir; }
const opts = (dir: string, mode: "apply" | "resume" | "dry-run") => ({ memoryDir: join(dir, "memory"), mode, authorizedPerson: true, tty: true });
const note = (project: string, text: string): NoteInput => ({ op: "note", project, text, scope: "project", tier: "long", kind: "finding", peer: "codex", source: "hub", about: [] });
function seed(dir: string) {
  const store = new MemoryStore({ home: dir, screen: () => "keep" }); const id = store.note(note(A, "initial source")); store.close();
  const memory = join(dir, "memory"), file = join(memory, "log", readdirSync(join(memory, "log")).find(name => name.endsWith(".jsonl"))!);
  const row = JSON.parse(readFileSync(file, "utf8").trim()) as Entry;
  if (row.op !== "note") throw new Error("fixture seed must be a note");
  return { memory, file, row, id };
}
function appendNote(source: ReturnType<typeof seed>, text: string) {
  const { id: _id, ...prior } = source.row;
  const body: Omit<NoteEntry, "id"> = { ...prior, text, at: new Date(Date.parse(source.row.at) + 1000).toISOString() };
  const row = { ...body, id: entryId(body) } as Entry;
  appendFileSync(source.file, canonicalJSON(row) + "\n"); return row;
}
function appendOp(source: ReturnType<typeof seed>, op: OpEntry["op"], target: string, by?: string) {
  const body: Omit<OpEntry, "id"> = { schema: "agent-hub.memory/v1", op, target, actor: "person", machine: source.row.machine, at: new Date(Date.parse(source.row.at) + 2000).toISOString(), ...(by ? { by } : {}) };
  const row = { ...body, id: entryId(body) }; appendFileSync(source.file, canonicalJSON(row) + "\n"); return row;
}

test("#119 F2 unrelated shard-native tail does not become a migration copy tail", async () => {
  const dir = home(), source = seed(dir); await migrateShards(opts(dir, "apply"));
  const native = join(shardDir(source.memory, A), "log", `${source.row.machine}.jsonl`), tail = '{"native":"unfinished';
  appendFileSync(native, tail); const before = readFileSync(native);
  const next = appendNote(source, "late legacy row beside unrelated native tail");
  await migrateShards(opts(dir, "resume"));
  expect(readFileSync(native)).toEqual(before);
  expect(JSON.parse(readFileSync(join(source.memory, "shards.json"), "utf8")).phase).toBe("active");
  const shard = openShardStore({ home: dir, project: A });
  try { expect(shard.list({ project: A }).map(row => row.id)).toContain(next.id); } finally { shard.close(); }
});

test("#119 F2 mismatched touched copy tail refuses before changing the active journal", async () => {
  const dir = home(), source = seed(dir); await migrateShards(opts(dir, "apply"));
  const journal = join(source.memory, "shards.json"), before = readFileSync(journal);
  const copy = join(shardDir(source.memory, A), "legacy", "log", `${source.row.machine}.jsonl`);
  appendFileSync(copy, '{"different":"unfinished'); const copyBefore = readFileSync(copy);
  appendNote(source, "planned copy append cannot overwrite tail");
  await expect(migrateShards(opts(dir, "resume"))).rejects.toThrow(/tail.*(inspect|recover)|inspect.*tail/i);
  expect(readFileSync(journal)).toEqual(before); expect(readFileSync(copy)).toEqual(copyBefore);
});

for (const op of ["forget", "suggest", "confirm"] as const) test(`#119 F4 dangling ${op} remains ids-only metadata and does not block dry run or apply`, async () => {
  const dir = home(), source = seed(dir), absent = "7".repeat(32);
  const row = appendOp(source, op, absent, op === "suggest" ? `same_topic:${source.id}` : undefined);
  const dry = await migrateShards(opts(dir, "dry-run"));
  expect((dry.counts as any).danglingRows).toBe(1); expect((dry.counts as any).danglingIds).toEqual([row.id]);
  expect(JSON.stringify(dry)).not.toContain("initial source");
  await migrateShards(opts(dir, "apply"));
  const file = join(userShardDir(source.memory), "legacy", "log", `${source.row.machine}.jsonl`);
  expect(readFileSync(file, "utf8")).toContain(canonicalJSON(row));
  expect(readFileSync(file, "utf8")).not.toContain("initial source");
});

test("#119 F4 dangling forget still applies when its target arrives on a later resume", async () => {
  const dir = home(), source = seed(dir), { id: _id, ...base } = source.row;
  const body: Omit<NoteEntry, "id"> = { ...base, text: "late forgotten target", at: new Date(Date.parse(source.row.at) + 1000).toISOString() };
  const target = { ...body, id: entryId(body) } as Entry; appendOp(source, "forget", target.id);
  await migrateShards(opts(dir, "apply")); appendFileSync(source.file, canonicalJSON(target) + "\n");
  await migrateShards(opts(dir, "resume"));
  const shard = openShardStore({ home: dir, project: A });
  try { expect(shard.list({ project: A }).map(row => row.id)).not.toContain(target.id); } finally { shard.close(); }
});

test("#119 F8 cross-private refusal has distinct ids-only count and an append-only remedy", async () => {
  const dir = home(), source = seed(dir), store = new MemoryStore({ home: dir, screen: () => "keep" });
  store.note({ ...note(B, "PRIVATE foreign replacement"), supersedes: source.id }); store.close();
  const dry = await migrateShards(opts(dir, "dry-run"));
  expect((dry.counts as any).crossPrivateReplacement).toBe(1); expect((dry.counts as any).crossPrivateReplacementIds).toEqual([source.id]);
  expect(dry.counts.sharedSupersededByPrivate).toBe(0); expect(JSON.stringify(dry)).not.toContain("PRIVATE foreign replacement");
  await expect(migrateShards(opts(dir, "apply"))).rejects.toThrow(new RegExp(`${source.id}.*un-supersede.*promote.*shared`, "i"));
  expect(existsSync(join(source.memory, "shards.json"))).toBe(false);
});

async function translatedFixture() {
  const dir = home(), source = seed(dir), generation = "d".repeat(32);
  await migrate({ memoryDir: source.memory, mode: "apply", generation, authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home: dir, now: () => Date.parse("2020-01-04T00:00:00.000Z"), screen: () => "keep" });
  const ids = [A, B].map(project => store.note({ ...note(project, `expired ${project}`), tier: "short", expires: "2020-01-02T00:00:00.000Z" }));
  const snapshot = store.prunePort().snapshot(), rows = ids.map(id => snapshot.rows.find(row => row.row.id === id)!.row); store.close();
  const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation, at: "2020-01-04T00:00:00.000Z", machine: source.row.machine, actor: "person", placement: "local", cutoff: "2020-01-04T00:00:00.000Z", targets: rows.map(row => ({ id: row.id, rowHash: pruneRowHash(row), expiredAt: "2020-01-02T00:00:00.000Z", basis: { kind: "note" as const, id: row.id, rowHash: pruneRowHash(row) } })).sort((a, b) => a.id.localeCompare(b.id)) };
  appendFileSync(join(source.memory, "generations", generation, "local", `${source.row.machine}.jsonl`), canonicalJSON({ ...body, id: pruneId(body) }) + "\n");
  await expect(migrateShards({ ...opts(dir, "apply"), checkpoint: () => { throw new Error("receipt fixture interruption"); } })).rejects.toThrow("receipt fixture interruption");
  return { dir, source, rows };
}

test("#119 F12 matching partial translation receipt is completed only by appending its remainder", async () => {
  const f = await translatedFixture(), path = join(shardDir(f.source.memory, A), "prune-translations.jsonl"), complete = readFileSync(path), prefix = complete.subarray(0, 47);
  writeFileSync(path, prefix);
  await migrateShards(opts(f.dir, "resume"));
  expect(readFileSync(path)).toEqual(complete); expect(readFileSync(path).subarray(0, prefix.length)).toEqual(prefix);
  await migrateShards(opts(f.dir, "resume")); expect(readFileSync(path)).toEqual(complete);
});

test("#119 F12 unrelated translation receipt tail refuses before any activation change", async () => {
  const f = await translatedFixture(), path = join(shardDir(f.source.memory, A), "prune-translations.jsonl"), journal = join(f.source.memory, "shards.json");
  writeFileSync(path, '{"unrelated":'); const before = readFileSync(journal), tail = readFileSync(path);
  await expect(migrateShards(opts(f.dir, "resume"))).rejects.toThrow(/receipt.*(inspect|recover)|inspect.*receipt/i);
  expect(readFileSync(path)).toEqual(tail); expect(readFileSync(journal)).toEqual(before);
});
