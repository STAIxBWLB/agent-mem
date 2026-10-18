import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { rebuildCatalog } from "../src/memory/catalog.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { shardDir } from "../src/memory/shard.ts";
import { MemoryStore, openShardStore, setMachineLabel, type NoteInput } from "../src/memory/store.ts";

const A = "github.com/example/curated-a", B = "github.com/example/curated-b";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() {
  const dir = mkdtempSync(join(tmpdir(), "amem-curated-shard-followup-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const note = (project: string, text: string, shared = false): NoteInput => ({ op: "note", project, scope: shared ? "shared" : "project", tier: "long", kind: "finding", peer: "codex", source: "person", text, about: [] });
function legacy(dir: string) {
  const store = new MemoryStore({ home: dir });
  const a = store.note(note(A, "alpha local fact")), b = store.note(note(B, "beta private fact"));
  const shared = store.note(note(B, "shared user recall token", true));
  const sharedGoal = store.goal({ project: B, scope: "shared", title: "cross-project shared goal", milestones: [], dependsOn: [], actor: "person" });
  store.close();
  return { a, b, shared, sharedGoal };
}
const migrate = (dir: string) => migrateShards({ memoryDir: join(dir, "memory"), mode: "apply", authorizedPerson: true, tty: true });
function project(dir: string, key = A) {
  const store = openShardStore({ home: dir, project: key }); cleanup.push(() => store.close()); return store;
}

test("#15 a capture-born descriptor initializes its first curated shard without changing capture or work", async () => {
  const dir = home(); legacy(dir);
  const key = "github.com/example/capture-only", onlyCapture = new CaptureStore({ home: dir, project: key });
  onlyCapture.append({ project: key, agent: "codex", event: "Stop", excerpt: "capture-only preserved" }); onlyCapture.close();
  const work = join(shardDir(join(dir, "memory"), key), "work"); mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "keep.txt"), "work remains independent");
  await migrate(dir);
  const store = project(dir, key);
  expect(store.dir).toBe(shardDir(join(dir, "memory"), key));
  expect(store.profile.home).toBe(join(dir, "memory"));
  const id = store.note(note(key, "first curated note"));
  expect(store.list({ project: key }).map(row => row.id)).toContain(id);
  expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("work remains independent");
  const reopened = new CaptureStore({ home: dir, project: key });
  try { expect(reopened.rows().map(row => row.excerpt)).toEqual(["capture-only preserved"]); } finally { reopened.close(); }
});

for (const surface of ["list", "search", "goals"] as const) test(`#15 project ${surface} retains user-scope visibility while excluding sibling private data`, async () => {
  const dir = home(), ids = legacy(dir); await migrate(dir);
  const store = project(dir);
  if (surface === "list") {
    const found = store.list({ project: A }).map(row => row.id);
    expect(found).toContain(ids.a); expect(found).toContain(ids.shared); expect(found).not.toContain(ids.b);
  } else if (surface === "search") {
    expect(store.search("shared user recall token", { project: A, includeCapture: false }).hits.map(hit => hit.view?.id)).toContain(ids.shared);
    expect(store.search("beta private fact", { project: A, includeCapture: false }).hits.map(hit => hit.view?.id)).not.toContain(ids.b);
  } else expect(store.goals(A).map(goal => goal.id)).toContain(ids.sharedGoal);
});

test("#15 a project-to-user supersession keeps its lifecycle before and after sharding", async () => {
  const dir = home(), source = new MemoryStore({ home: dir });
  const old = source.note(note(A, "supersession token old")), replacement = source.note(note(B, "supersession token replacement", true));
  expect(source.supersede(old, replacement, "person", A)).toBe(true);
  expect(source.list({ project: A }).map(row => row.id)).not.toContain(old);
  source.close(); await migrate(dir);
  const store = project(dir);
  expect(store.list({ project: A }).map(row => row.id)).not.toContain(old);
  expect(store.list({ project: A }).map(row => row.id)).toContain(replacement);
  const user = openShardStore({ home: dir, user: true }); cleanup.push(() => user.close());
  expect(user.forget(replacement, "person")?.id).toBe(replacement);
  expect(store.list({ project: A }).map(row => row.id)).toContain(old);
  const before = store.derivedTables(); store.rebuild(); expect(store.derivedTables()).toEqual(before);
});

test("#15 relabeling the same machine does not invalidate already sealed curated shards", async () => {
  const dir = home(), ids = legacy(dir); await migrate(dir);
  const before = JSON.parse(readFileSync(join(dir, "memory", "machine.json"), "utf8"));
  const changed = setMachineLabel(join(dir, "memory"), "renamed laptop");
  expect(changed.id).toBe(before.id);
  expect(project(dir).list({ project: A }).map(row => row.id)).toContain(ids.a);
});

test("#15 catalog rebuild derives curated counts even when the disposable shard index is removed", async () => {
  const dir = home(); legacy(dir); await migrate(dir);
  const before = rebuildCatalog({ home: dir }).find(row => row.key === A)!;
  expect(before.curatedEntries).toBe(1);
  const index = join(shardDir(join(dir, "memory"), A), "index.db");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(index + suffix, { force: true });
  const after = rebuildCatalog({ home: dir }).find(row => row.key === A)!;
  expect(after.curatedEntries).toBe(before.curatedEntries);
  expect(after.curatedLastAt).toBe(before.curatedLastAt);
});

test("#15 catalog rebuild refreshes deferred curated appends instead of trusting an older index", async () => {
  const dir = home(); legacy(dir); await migrate(dir);
  const store = openShardStore({ home: dir, project: A });
  try { expect(store.importNote(note(A, "deferred curated append"), "2050-01-01T00:00:00.000Z").added).toBe(true); }
  finally { store.close(); }
  const row = rebuildCatalog({ home: dir }).find(item => item.key === A)!;
  expect(row.curatedEntries).toBe(2);
  expect(row.curatedLastAt).toBe("2050-01-01T00:00:00.000Z");
});

test("#15 catalog inspection never initializes curated metadata for a capture-only descriptor", () => {
  const dir = home(), capture = new CaptureStore({ home: dir, project: A });
  capture.append({ project: A, agent: "codex", event: "Stop", excerpt: "capture only" }); capture.close();
  const row = rebuildCatalog({ home: dir }).find(item => item.key === A)!;
  expect(row.curatedEntries).toBe(0); expect(row.curatedLastAt).toBeNull();
  const shard = shardDir(join(dir, "memory"), A);
  expect(existsSync(join(shard, "generation.json"))).toBe(false);
  expect(existsSync(join(shard, "generation-seal.json"))).toBe(false);
});

test("#15 unreadable curated index storage fails catalog derivation instead of reporting an empty shard", async () => {
  const dir = home(); legacy(dir); await migrate(dir);
  const index = join(shardDir(join(dir, "memory"), A), "index.db");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(index + suffix, { force: true });
  mkdirSync(index);
  expect(() => rebuildCatalog({ home: dir })).toThrow();
});
