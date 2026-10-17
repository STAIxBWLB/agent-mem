import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, entryId, openShardStore, type Entry, type NoteInput, type NoteEntry, type OpEntry } from "../src/memory/store.ts";
import { migrateShards, shardMigrationStatus } from "../src/memory/shard-migration.ts";
import { shardDir, userShardDir } from "../src/memory/shard.ts";
import { migrate } from "../src/memory/migrate.ts";
import { applyPrune, planPrune, pruneId, pruneRowHash, type PruneRow } from "../src/memory/prune.ts";
import { canonicalJSON } from "../src/memory/generation.ts";

const A = "github.com/example/routing-followup";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home(): string { const dir = mkdtempSync(join(tmpdir(), "amem-shard-route-followup-")); homes.push(dir); return dir; }
const options = (dir: string, mode: "apply" | "resume" | "dry-run") => ({ memoryDir: join(dir, "memory"), mode, authorizedPerson: true, tty: true });
function note(project: string, text: string, shared = false, short = false): NoteInput {
  return { op: "note", project, scope: shared ? "shared" : "project", tier: short ? "short" : "long", kind: "finding", peer: "codex", source: "hub", text, about: [] };
}
function seed(dir: string, input = note(A, "original valid note")) {
  const store = new MemoryStore({ home: dir, screen: () => "keep" }); const id = store.note(input); store.close();
  const memory = join(dir, "memory"), folder = input.tier === "short" ? "local" : "log";
  const name = readdirSync(join(memory, folder)).find(name => name.endsWith(".jsonl"))!;
  const path = `${folder}/${name}`, file = join(memory, path), bytes = readFileSync(file);
  const row = JSON.parse(bytes.toString("utf8").trim()) as Entry;
  return { memory, id, path, file, bytes, row };
}
function later(row: Entry, text: string): Entry {
  if (row.op !== "note") throw new Error("fixture expects a note");
  const { id: _id, ...body } = row;
  const next: Omit<NoteEntry, "id"> = { ...body, text, at: new Date(Date.parse(row.at) + 1000).toISOString() };
  return { ...next, id: entryId(next) } as Entry;
}
const encoded = (row: Entry) => JSON.stringify(row) + "\n";
function historicalOp(source: { file: string; row: Entry }, op: "supersede" | "forget", target: string, by?: string): void {
  const body: Omit<OpEntry, "id"> = { schema: "agent-hub.memory/v1", op, target, actor: "person", machine: source.row.machine,
    at: new Date(Date.parse(source.row.at) + 1000).toISOString(), ...(by ? { by } : {}) };
  appendFileSync(source.file, encoded({ ...body, id: entryId(body) }));
}

test("#119 valid project key user is distinct from the shared user shard", async () => {
  const dir = home(), project = seed(dir, note("user", "project named user"));
  const store = new MemoryStore({ home: dir, screen: () => "keep" }); const shared = store.note(note(A, "shared user fact", true)); store.close();
  await migrateShards(options(dir, "apply"));
  const projectStore = openShardStore({ home: dir, project: "user" }), userStore = openShardStore({ home: dir, user: true });
  try {
    expect(projectStore.list({ project: "user" }).map(row => row.id)).toContain(project.id);
    expect(userStore.list().map(row => row.id)).toContain(shared);
    expect(userStore.list().map(row => row.id)).not.toContain(project.id);
    expect(projectStore.dir).toBe(shardDir(project.memory, "user")); expect(userStore.dir).toBe(userShardDir(project.memory));
  } finally { projectStore.close(); userStore.close(); }
});

test("#119 blank source lines count toward byte checkpoints so a later complete row is not lost", async () => {
  const dir = home(), source = seed(dir);
  writeFileSync(source.file, "\n".repeat(5000) + source.bytes.toString("utf8"));
  await migrateShards(options(dir, "apply"));
  const row = later(source.row, "late append after blank source lines"); appendFileSync(source.file, encoded(row));
  expect(shardMigrationStatus(source.memory).pending.rows).toBe(1);
  expect((await migrateShards(options(dir, "resume"))).counts.rows).toBe(1);
  const store = openShardStore({ home: dir, project: A });
  try { expect(store.list({ project: A }).map(row => row.id)).toContain(row.id); } finally { store.close(); }
});

test("#119 a malformed same-id source line cannot displace the valid authored bytes", async () => {
  const dir = home(), source = seed(dir), malformed = { ...source.row, text: "not covered by the entry hash" };
  writeFileSync(source.file, JSON.stringify(malformed) + "\n" + source.bytes.toString("utf8"));
  const result = await migrateShards(options(dir, "apply"));
  expect(result.counts.skippedRows).toBe(1); expect(result.counts.rows).toBe(1);
  const copied = readFileSync(join(shardDir(source.memory, A), "legacy", source.path), "utf8");
  expect(copied).toBe(source.bytes.toString("utf8"));
  const store = openShardStore({ home: dir, project: A });
  try { expect(store.list({ project: A }).map(row => row.text)).toEqual(["original valid note"]); } finally { store.close(); }
});

test("#119 a legacy source partial tail becomes one row only after its newline arrives", async () => {
  const dir = home(), source = seed(dir), row = later(source.row, "a completed old-format tail");
  const bytes = Buffer.from(encoded(row)), split = Math.floor(bytes.length / 2);
  appendFileSync(source.file, bytes.subarray(0, split));
  expect((await migrateShards(options(dir, "apply"))).counts.tailBytes).toBe(split);
  appendFileSync(source.file, bytes.subarray(split));
  expect(shardMigrationStatus(source.memory).pending.rows).toBe(1);
  await migrateShards(options(dir, "resume")); await migrateShards(options(dir, "resume"));
  const store = openShardStore({ home: dir, project: A });
  try { expect(store.list({ project: A }).filter(view => view.id === row.id)).toHaveLength(1); } finally { store.close(); }
});

test("#119 resume completes a matching copied partial tail by append without changing its existing prefix", async () => {
  const dir = home(), source = seed(dir), row = later(source.row, "row interrupted while being copied");
  const bytes = Buffer.from(encoded(row)), split = Math.floor(bytes.length / 2), copied = join(shardDir(source.memory, A), "legacy", source.path);
  let prefix: Buffer | undefined;
  await expect(migrateShards({ ...options(dir, "apply"), checkpoint: stage => {
    if (stage !== "after-shard") return;
    appendFileSync(source.file, bytes); appendFileSync(copied, bytes.subarray(0, split)); prefix = readFileSync(copied);
    throw new Error("fixture interrupted after partial copied append");
  } })).rejects.toThrow("fixture interrupted");
  await migrateShards(options(dir, "resume"));
  const completed = readFileSync(copied);
  expect(Buffer.from(completed.subarray(0, prefix!.length))).toEqual(Buffer.from(prefix!));
  expect(completed.toString("utf8")).toBe(source.bytes.toString("utf8") + bytes.toString("utf8"));
  const store = openShardStore({ home: dir, project: A });
  try { expect(store.list({ project: A }).map(view => view.id)).toContain(row.id); } finally { store.close(); }
});

test("#119 a nonmatching copied partial tail remains a fail-closed refusal", async () => {
  const dir = home(), source = seed(dir), copied = join(shardDir(source.memory, A), "legacy", source.path);
  await expect(migrateShards({ ...options(dir, "apply"), checkpoint: stage => {
    if (stage !== "after-shard") return;
    appendFileSync(copied, "unrelated partial bytes"); throw new Error("fixture interrupted");
  } })).rejects.toThrow("fixture interrupted");
  const before = readFileSync(copied);
  await expect(migrateShards(options(dir, "resume"))).rejects.toThrow();
  expect(readFileSync(copied)).toEqual(before);
});

test("#119 repeated ids retain both local and fetched-main source placement witnesses", async () => {
  const dir = home(), source = seed(dir, note(A, "same id has local and public witnesses"));
  const localPath = `local/${source.path.split("/")[1]}`;
  writeFileSync(join(source.memory, localPath), source.bytes); rmSync(source.file);
  source.path = localPath; source.file = join(source.memory, localPath);
  const generation = "a".repeat(32), commit = "b".repeat(40), path = `log/${source.path.split("/")[1]}`;
  const generationDir = join(source.memory, "generations", generation), archive = join(generationDir, "bridge-snapshots", commit);
  mkdirSync(dirname(join(archive, path)), { recursive: true }); writeFileSync(join(archive, path), source.bytes);
  const hash = createHash("sha256").update(source.bytes).digest("hex");
  writeFileSync(join(archive, "snapshot.json"), JSON.stringify({ schema: "agent-mem.legacy-snapshot/v1", generation, commit, segments: [{ path, offset: source.bytes.length, hash, tailBytes: 0 }] }));
  writeFileSync(join(generationDir, "bridge-snapshot.json"), JSON.stringify({ schema: "agent-mem.legacy-head/v1", generation, commit }));
  await migrateShards({ ...options(dir, "apply"), generation });
  const copied = join(shardDir(source.memory, A), "legacy"), publicCopy = join(shardDir(source.memory, A), "legacy-main");
  expect(existsSync(join(copied, source.path))).toBe(true);
  expect(existsSync(join(publicCopy, path))).toBe(true);
  expect(readFileSync(join(copied, source.path))).toEqual(source.bytes);
  expect(readFileSync(join(publicCopy, path))).toEqual(source.bytes);
  const store = openShardStore({ home: dir, project: A });
  try { expect(store.prunePort().snapshot().rows.find(row => row.row.id === source.id)).toMatchObject({ own: false, legacy: true, placement: "synced", publicWitness: true }); } finally { store.close(); }
  await migrateShards(options(dir, "resume"));
  expect(readFileSync(join(publicCopy, path))).toEqual(source.bytes);
});

test("#119 sharding a selected generation cannot omit its generation-born curated row", async () => {
  const dir = home(), source = seed(dir), generation = "c".repeat(32);
  await migrate({ memoryDir: source.memory, mode: "apply", generation, authorizedPerson: true, tty: true });
  const generationStore = new MemoryStore({ home: dir, screen: () => "keep" });
  const own = generationStore.note(note(A, "generation-born row must survive shard migration")); generationStore.close();
  const ownDir = join(source.memory, "generations", generation, "log");
  const before = Object.fromEntries(readdirSync(ownDir).filter(name => name.endsWith(".jsonl")).map(name => [name, readFileSync(join(ownDir, name))]));
  await migrateShards(options(dir, "apply"));
  const shard = openShardStore({ home: dir, project: A });
  try { expect(shard.list({ project: A }).map(row => row.id)).toContain(own); } finally { shard.close(); }
  for (const [name, bytes] of Object.entries(before)) expect(readFileSync(join(ownDir, name))).toEqual(bytes);
});

test("#119 positive dead-reader cleanup is retained in the bounded migration journal status and repeated receipts", async () => {
  const dir = home(), source = seed(dir), lease = `999999-${"0".repeat(64)}.json`;
  mkdirSync(join(source.memory, "readers"), { recursive: true });
  writeFileSync(join(source.memory, "readers", lease), JSON.stringify({ schema: "agent-mem.reader-lease/v1", pid: 999999, signature: "0".repeat(64), renewedAt: new Date().toISOString() }) + "\n");
  const applied = await migrateShards(options(dir, "apply"));
  expect(existsSync(join(source.memory, "readers", lease))).toBe(false);
  const evidence = (applied as any).deadLeasesRemoved;
  expect(evidence).toHaveLength(1); expect(evidence[0].lease).toBe(lease);
  expect(new Date(evidence[0].at).toISOString()).toBe(evidence[0].at);
  expect(Object.keys(evidence[0]).sort()).toEqual(["at", "lease"]);
  expect(JSON.parse(readFileSync(join(source.memory, "shards.json"), "utf8")).deadLeasesRemoved).toEqual(evidence);
  expect((shardMigrationStatus(source.memory) as any).deadLeasesRemoved).toEqual(evidence);
  const resumed = await migrateShards(options(dir, "resume"));
  expect(resumed.alreadyActive).toBe(true); expect((resumed as any).deadLeasesRemoved).toEqual(evidence);
  expect(JSON.stringify(evidence)).not.toContain(source.memory);
});

test("#119 selected generation keeps its local birth realm and immutable durable prune on shard rebuild", async () => {
  const dir = home(), source = seed(dir), generation = "d".repeat(32), now = Date.parse("2020-01-04T00:00:00.000Z");
  await migrate({ memoryDir: source.memory, mode: "apply", generation, authorizedPerson: true, tty: true });
  const original = new MemoryStore({ home: dir, now: () => now, screen: () => "keep" });
  const localId = original.note({ ...note(A, "generation local live", false, true), expires: "2099-01-01T00:00:00.000Z" });
  const expired = original.note({ ...note(A, "generation local pruned", false, true), expires: "2020-01-02T00:00:00.000Z" });
  const auth = { project: A, actor: "person" as const, authorize: () => true };
  const plan = planPrune(original.prunePort(), { cutoff: new Date(now).toISOString(), targets: [expired] }, auth);
  expect(plan.rows).toHaveLength(1); applyPrune(original.prunePort(), plan, auth); original.close();
  const oldLocal = join(source.memory, "generations", generation, "local");
  const before = Object.fromEntries(readdirSync(oldLocal).filter(name => name.endsWith(".jsonl")).map(name => [name, readFileSync(join(oldLocal, name))]));
  const result = await migrateShards(options(dir, "apply")); expect(result.generation).toBe(generation);
  const shard = openShardStore({ home: dir, project: A, now: () => now });
  try {
    expect(shard.prunePort().snapshot().rows.find(source => source.row.id === localId)).toMatchObject({ own: true, legacy: false, placement: "local" });
    expect(shard.prunePort().snapshot().pruned).toContain(expired);
    expect(shard.list({ project: A }).map(row => row.id)).toContain(localId);
    const tables = shard.derivedTables(); shard.rebuild(); expect(shard.derivedTables()).toEqual(tables);
  } finally { shard.close(); }
  for (const [name, bytes] of Object.entries(before)) expect(readFileSync(join(oldLocal, name))).toEqual(bytes);
});

test("#119 selected-generation own rows resume after an interrupted shard build without duplication", async () => {
  const dir = home(), source = seed(dir), generation = "e".repeat(32);
  await migrate({ memoryDir: source.memory, mode: "apply", generation, authorizedPerson: true, tty: true });
  const original = new MemoryStore({ home: dir, screen: () => "keep" });
  const id = original.note(note(A, "generation row across interrupted shard build")); original.close();
  await expect(migrateShards({ ...options(dir, "apply"), checkpoint: () => { throw new Error("selected generation build interrupted"); } })).rejects.toThrow("selected generation build interrupted");
  expect((await migrateShards(options(dir, "resume"))).generation).toBe(generation);
  await migrateShards(options(dir, "resume"));
  const shard = openShardStore({ home: dir, project: A });
  try { expect(shard.prunePort().snapshot().rows.filter(source => source.row.id === id)).toHaveLength(1); } finally { shard.close(); }
});

function selectedPruneFixture(twoProjects = false, invalid = false) {
  const dir = home(), source = seed(dir), generation = "f".repeat(32);
  return migrate({ memoryDir: source.memory, mode: "apply", generation, authorizedPerson: true, tty: true }).then(() => {
    const store = new MemoryStore({ home: dir, now: () => Date.parse("2020-01-04T00:00:00.000Z"), screen: () => "keep" });
    const ids = [store.note({ ...note(A, "selected prune A", false, true), expires: "2020-01-02T00:00:00.000Z" }),
      ...(twoProjects ? [store.note({ ...note("github.com/example/second", "selected prune B", false, true), expires: "2020-01-02T00:00:00.000Z" })] : [])];
    const snapshot = store.prunePort().snapshot(), rows = ids.map(id => snapshot.rows.find(source => source.row.id === id)!.row);
    store.close();
    const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation, at: "2020-01-04T00:00:00.000Z", machine: rows[0]!.machine,
      actor: "person", placement: "local", cutoff: "2020-01-04T00:00:00.000Z", targets: rows.map(row => ({ id: row.id, rowHash: invalid ? "0".repeat(64) : pruneRowHash(row),
        expiredAt: "2020-01-02T00:00:00.000Z", basis: { kind: "note" as const, id: row.id, rowHash: pruneRowHash(row) } })).sort((a, b) => a.id.localeCompare(b.id)) };
    const prune = { ...body, id: pruneId(body) }, file = join(source.memory, "generations", generation, "local", `${body.machine}.jsonl`);
    appendFileSync(file, canonicalJSON(prune) + "\n");
    return { dir, source, generation, rows, prune, file };
  });
}

test("#119 multi-project immutable prune translates deterministically to each target shard without cross-project note copies", async () => {
  const f = await selectedPruneFixture(true);
  await migrateShards(options(f.dir, "apply"));
  const translated: string[] = [];
  for (const row of f.rows) {
    if (row.op !== "note") throw new Error("fixture needs notes");
    const shard = openShardStore({ home: f.dir, project: row.project });
    try {
      const snapshot = shard.prunePort().snapshot(); expect(snapshot.pruned).toContain(row.id);
      expect(snapshot.rows.filter(source => source.row.op === "note" && source.row.project !== row.project && source.row.scope !== "shared")).toHaveLength(0);
      const ids = (shard.derivedTables().generation_prunes as { id: string }[]).map(row => row.id);
      expect(ids).toHaveLength(1); expect(ids[0]).not.toBe(f.prune.id); translated.push(ids[0]!);
    } finally { shard.close(); }
  }
  await migrateShards(options(f.dir, "resume"));
  expect(new Set(translated).size).toBe(2);
  expect(readFileSync(f.file, "utf8")).toContain(canonicalJSON(f.prune));
});

test("#119 unprovable selected-generation prune refuses before any shard journal or output effect", async () => {
  const f = await selectedPruneFixture(false, true), before = readFileSync(f.file), selector = readFileSync(join(f.source.memory, "profile.json"));
  await expect(migrateShards(options(f.dir, "apply"))).rejects.toThrow(/prune|proof/i);
  expect(existsSync(join(f.source.memory, "shards.json"))).toBe(false);
  expect(existsSync(join(shardDir(f.source.memory, A), "generation.json"))).toBe(false);
  expect(existsSync(join(f.source.memory, "profile.lock"))).toBe(false);
  expect(readFileSync(f.file)).toEqual(before); expect(readFileSync(join(f.source.memory, "profile.json"))).toEqual(selector);
});

test("#119 cross-project private replacement refuses before copying foreign project text", async () => {
  const dir = home(), source = seed(dir, note(A, "PRIVATE source project", false, true));
  const store = new MemoryStore({ home: dir, screen: () => "keep" });
  store.note({ ...note("github.com/example/foreign", "PRIVATE foreign replacement"), supersedes: source.id }); store.close();
  const before = readFileSync(source.file);
  await expect(migrateShards(options(dir, "apply"))).rejects.toThrow(/cross.project|replacement/i);
  expect(existsSync(join(source.memory, "shards.json"))).toBe(false);
  expect(existsSync(join(shardDir(source.memory, A), "generation.json"))).toBe(false);
  expect(readFileSync(source.file)).toEqual(before);
});

test("#119 shared superseded by private has a separate ids-only dry-run count and an actionable no-effect refusal", async () => {
  const dir = home(), source = seed(dir, note(A, "shared original body", true));
  const store = new MemoryStore({ home: dir, screen: () => "keep" });
  store.note({ ...note("github.com/example/foreign", "PRIVATE replacement body"), supersedes: source.id }); store.close();
  const dry = await migrateShards(options(dir, "dry-run"));
  expect((dry.counts as any).sharedSupersededByPrivate).toBe(1);
  expect((dry.counts as any).sharedSupersededByPrivateIds).toEqual([source.id]);
  expect(dry.counts.refusedRows).toBe(1);
  expect(JSON.stringify(dry)).not.toContain("PRIVATE replacement body"); expect(JSON.stringify(dry)).not.toContain("shared original body");
  await expect(migrateShards(options(dir, "apply"))).rejects.toThrow(/un-supersede.*promote.*shared/i);
  expect(existsSync(join(source.memory, "shards.json"))).toBe(false);
  expect(existsSync(join(shardDir(source.memory, A), "generation.json"))).toBe(false);
});

test("#119 a destination symlink into the legacy source refuses before journal or foreign metadata writes", async () => {
  const dir = home(), source = seed(dir), before = readFileSync(source.file);
  mkdirSync(join(source.memory, "projects"), { recursive: true }); symlinkSync(source.memory, shardDir(source.memory, A));
  await expect(migrateShards(options(dir, "apply"))).rejects.toThrow();
  expect(existsSync(join(source.memory, "shards.json"))).toBe(false);
  expect(existsSync(join(source.memory, "generation.json"))).toBe(false);
  expect(existsSync(join(source.memory, "project.json"))).toBe(false);
  expect(readFileSync(source.file)).toEqual(before);
});

test("#119 a private replacement promoted to a shared terminal no longer triggers the shared-private ceiling", async () => {
  const dir = home(), source = seed(dir, note(A, "shared predecessor", true));
  const store = new MemoryStore({ home: dir, screen: () => "keep" });
  const replacement = store.note({ ...note("github.com/example/foreign", "private predecessor body", false, true), expires: "2099-01-01T00:00:00.000Z" });
  store.close(); historicalOp(source, "supersede", source.id, replacement);
  const writer = new MemoryStore({ home: dir, screen: () => "keep" });
  const promoted = writer.note({ ...note("github.com/example/foreign", "reviewed shared terminal", true), promotedFrom: replacement });
  expect(writer.list().map(row => row.id)).toContain(promoted); expect(writer.list().map(row => row.id)).not.toContain(source.id); writer.close();
  const dry = await migrateShards(options(dir, "dry-run")); expect(dry.counts.sharedSupersededByPrivate).toBe(0);
  await migrateShards(options(dir, "apply"));
  const user = openShardStore({ home: dir, user: true });
  try {
    expect(user.list().map(row => row.id)).toContain(promoted); expect(user.list().map(row => row.id)).not.toContain(source.id);
    expect(user.prunePort().snapshot().rows.some(row => row.row.op === "note" && row.row.text === "private predecessor body")).toBe(false);
  } finally { user.close(); }
});

test("#119 a provably forgotten private terminal replacement is not counted as an effective shared-private edge", async () => {
  const dir = home(), source = seed(dir, note(A, "shared predecessor remains", true));
  const store = new MemoryStore({ home: dir, screen: () => "keep" });
  const replacement = store.note(note("github.com/example/foreign", "forgotten private replacement"));
  store.close(); historicalOp(source, "supersede", source.id, replacement); historicalOp(source, "forget", replacement);
  const before = new MemoryStore({ home: dir, screen: () => "keep" });
  expect(before.list().map(row => row.id)).toContain(source.id); expect(before.list().map(row => row.id)).not.toContain(replacement); before.close();
  const dry = await migrateShards(options(dir, "dry-run")); expect(dry.counts.sharedSupersededByPrivate).toBe(0);
  await migrateShards(options(dir, "apply"));
  const user = openShardStore({ home: dir, user: true });
  try { expect(user.list().map(row => row.id)).toContain(source.id); } finally { user.close(); }
});

test("#119 a forget of a private promotion source reaches its shared copy without copying private text", async () => {
  const dir = home(), source = seed(dir, note(A, "PRIVATE promotion source", false, true));
  const store = new MemoryStore({ home: dir, screen: () => "keep" });
  const shared = store.note({ ...note(A, "reviewed shared copy", true), promotedFrom: source.id });
  store.close();
  // A historical immutable op targets the private source itself, rather than today's get() redirect to its copy.
  historicalOp(source, "forget", source.id);
  const before = new MemoryStore({ home: dir, screen: () => "keep" });
  expect(before.list().map(row => row.id)).not.toContain(shared); before.close();
  await migrateShards(options(dir, "apply"));
  const user = openShardStore({ home: dir, user: true }), project = openShardStore({ home: dir, project: A });
  try {
    expect(user.list().map(row => row.id)).not.toContain(shared); expect(project.list({ project: A }).map(row => row.id)).not.toContain(shared);
    expect(user.prunePort().snapshot().rows.some(row => row.row.op === "note" && row.row.id === source.id)).toBe(false);
    expect(user.prunePort().snapshot().rows.some(row => row.row.op === "forget" && row.row.target === source.id)).toBe(true);
  } finally { project.close(); user.close(); }
});


test("#119 malformed UTF-8 legacy line is counted once without shifting its byte checkpoint", async () => {
  const dir = home(), source = seed(dir);
  appendFileSync(source.file, Buffer.from([255, 10]));
  const dry = await migrateShards(options(dir, "dry-run"));
  expect(dry.counts.skippedRows).toBe(1);
  expect(dry.generation).toMatch(/^[a-f0-9]{32}$/);
  const applied = await migrateShards(options(dir, "apply"));
  expect(applied.counts.skippedRows).toBe(1);
  const next = later(source.row, "valid note after malformed UTF-8 checkpoint");
  appendFileSync(source.file, encoded(next));
  const resumed = await migrateShards(options(dir, "resume"));
  expect(resumed.counts.skippedRows).toBe(0);
  const shard = openShardStore({ home: dir, project: A });
  try { expect(shard.list({ project: A }).map(row => row.id)).toContain(next.id); }
  finally { shard.close(); }
});
