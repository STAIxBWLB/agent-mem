import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationIndex } from "../src/memory/generation-index.ts";
import { indexFileName } from "../src/memory/index-file.ts";
import { buildPublicPruneIndex, entryId, machineId, MemoryStore, openShardStore, type Entry, type NoteInput } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { advancePublicPruneView } from "../src/memory/public-prune-advance.ts";
import { canonicalJSON, readSelector } from "../src/memory/generation.ts";
import { aliasedKeys, appendAlias, resolveShardProfile } from "../src/memory/shard.ts";
import { acquireMutation, type MutationHandle } from "../src/memory/mutation.ts";
import { applyPrune, planPrune, pruneId, pruneRowHash, type PruneRow } from "../src/memory/prune.ts";
import { realPath } from "../src/memory/platform.ts";
import { persistPublicPruneInput, preparePublicPruneInput } from "../src/memory/public-prune-inputs.ts";
import type { PublicPruneViewV1 } from "../src/memory/public-prune-view.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const NOW = Date.parse("2026-10-01T12:00:00.000Z"), now = () => NOW;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const PROJECT = publicPruneGraph().note.project, TASK = `${PROJECT}#1@1`, ALIAS = "curated-466-alias";
const note = (text: string, scope: "project" | "shared" = "project"): NoteInput =>
  ({ op: "note", project: PROJECT, scope, tier: "short", kind: "decision", peer: "person", source: "person", task: TASK, text, about: [] });

/** A sharded generation home; `v2` adds the public prune view the same way activation does. */
async function home(v2: boolean, rows = 2) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-gen-index-"))); roots.push(root);
  const memoryDir = join(root, "memory"), graph = publicPruneGraph();
  const legacy = new MemoryStore({ home: root, now, screen: () => "keep" });
  const { id, at, machine, schema: _schema, ...body } = graph.note;
  legacy.importNote(body as NoteInput, at, { machine, expectedId: id });
  for (let index = 0; index < rows; index++) legacy.note({ ...note(`fixture row ${index}`), tier: "long" });
  legacy.close();
  await migrateShards({ memoryDir, generation: "7".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  if (v2) await activatePublicPruneView({ memoryDir, mode: "apply", authorizedPerson: true, tty: true });
  const profile = resolveShardProfile(memoryDir, { project: PROJECT });
  const prepare = (proof = graph, previous: string | null = null) => {
    const target = resolveShardProfile(memoryDir, { project: PROJECT }), selected = readSelector(memoryDir);
    const binding = { realm: proof.manifest.realm, receivingGeneration: target.generation!, selectorRevision: selected.revision, inputSetHash: previous };
    return persistPublicPruneInput(preparePublicPruneInput({ dir: target.dir, binding, current: () => binding, input: proof.input }));
  };
  const view = (realms: Record<string, string>): PublicPruneViewV1 => ({ schema: "agent-mem.public-prune-view/v1", receivingGeneration: profile.generation!, realms });
  const advance = async (value: PublicPruneViewV1) => {
    const handles: MutationHandle[] = [];
    try {
      for (const dir of [...new Set([memoryDir, profile.dir])].sort()) { const handle = acquireMutation(dir); if (handle) handles.push(handle); }
      return await advancePublicPruneView({ memoryDir, view: value, expectedRevision: readSelector(memoryDir).revision, mutations: handles });
    } finally { for (const handle of handles.reverse()) handle(); }
  };
  let initial: string | null = null;
  if (v2) { const first = prepare(); initial = first.inputSetHash; await advance(view({ [`project:${PROJECT}`]: initial })); }
  return { root, memoryDir, profile, initial, view, prepare, advance };
}

const open = (memoryDir: string, extra: Record<string, unknown> = {}) =>
  openShardStore({ memoryDir, project: PROJECT, now, screen: () => "promote", deferPromotions: true, ttlMs: 1000, ...extra });

test("#466 AC1: settle() publishes curated briefs once and promotes through the user overlay and alias shards", async () => {
  const f = await home(false);
  const store = open(f.memoryDir);
  const published = spyOn(MemoryStore.prototype as unknown as { publishCurated: () => void }, "publishCurated");
  const opened = new Set<object>(), kinds = new WeakMap<object, { shardKey?: string; shardUser?: boolean }>();
  const refresh = GenerationIndex.prototype.refresh, rebuild = GenerationIndex.prototype.rebuild;
  const seen = function (this: object & { profile: { shardKey?: string; shardUser?: boolean } }) { opened.add(this); kinds.set(this, this.profile); };
  GenerationIndex.prototype.refresh = function (this: GenerationIndex, ...args: Parameters<typeof refresh>) { seen.call(this); return refresh.apply(this, args); };
  GenerationIndex.prototype.rebuild = function (this: GenerationIndex, ...args: Parameters<typeof rebuild>) { seen.call(this); return rebuild.apply(this, args); };
  try {
    expect(store.profile.shardKey).toBe(PROJECT);
    expect(store.openedSyncTargets()).toHaveLength(2); // this shard plus its user overlay
    store.note(note("project held decision"));
    store.note(note("shared held decision", "shared"));
    store.list({ project: PROJECT }); // registers the handles that already exist
    const existing = new Set(opened);
    published.mockClear(); opened.clear();
    expect(store.settle(TASK, "person")).toBe(2);
    expect(published).toHaveBeenCalledTimes(1);
    // The publication reused this handle, so it indexed no second copy of this shard.
    expect([...opened].filter((handle) => !existing.has(handle) && kinds.get(handle)?.shardKey === PROJECT && !kinds.get(handle)?.shardUser)).toEqual([]);
    expect(store.list({ project: PROJECT }).filter((row) => row.task === TASK).every((row) => row.tier === "long")).toBe(true);
  } finally {
    GenerationIndex.prototype.refresh = refresh; GenerationIndex.prototype.rebuild = rebuild;
    published.mockRestore(); store.close();
  }
});

test("#466 AC1: a reconciled store still publishes once for a settlement across its alias shards", async () => {
  const f = await home(false), machine = machineId(f.memoryDir).id;
  appendAlias(f.memoryDir, { alias: ALIAS, key: PROJECT, actor: "person", machine });
  expect(aliasedKeys(f.memoryDir, PROJECT)).toEqual([ALIAS]);
  const store = open(f.memoryDir, { reconcile: { canonical: PROJECT, aliases: [ALIAS] }, createAliases: true });
  const published = spyOn(MemoryStore.prototype as unknown as { publishCurated: () => void }, "publishCurated");
  try {
    store.note(note("project held decision"));
    published.mockClear();
    // Multi-project publication still opens a store per project; the settlement itself runs one publication (#466 plan).
    expect(store.settle(TASK, "person")).toBe(1);
    expect(published).toHaveBeenCalledTimes(1);
    expect(store.list({ project: PROJECT }).find((row) => row.task === TASK)?.tier).toBe("long");
  } finally { published.mockRestore(); store.close(); }
});

test("#466 AC3: a reopened v2 shard proves its stored foreign stamp instead of rebuilding every table", async () => {
  const f = await home(true);
  const first = open(f.memoryDir);
  const file = join(f.profile.dir, indexFileName(true));
  const stampOf = (db: Database) => (db.query("SELECT value FROM generation_state WHERE key='foreignStamp'").get() as { value: string } | null)?.value;
  const before = new Database(file);
  const stored = stampOf(before); before.close();
  expect(stored).toBeString();
  first.close();

  const rebuilds: (string | undefined)[] = [], rebuild = GenerationIndex.prototype.rebuild;
  GenerationIndex.prototype.rebuild = function (this: GenerationIndex, ...args: Parameters<typeof rebuild>) { rebuilds.push(this.profile.shardKey); return rebuild.apply(this, args); };
  try {
    const reopened = open(f.memoryDir);
    try {
      expect(rebuilds.filter((key) => key === PROJECT)).toEqual([]); // this shard proved its stamp; its user overlay may open fresh
      expect(reopened.list({ project: PROJECT }).length).toBeGreaterThan(0);
      const after = new Database(file), stamped = stampOf(after); after.close();
      expect(stamped).toBe(stored);
    } finally { reopened.close(); }
  } finally { GenerationIndex.prototype.rebuild = rebuild; }
});

test("#466: opening a v2 shard builds i5 without changing the old i4 index", async () => {
  const f = await home(true), old = join(f.profile.dir, indexFileName(true, 4)), current = join(f.profile.dir, indexFileName(true));
  for (const suffix of ["", "-wal", "-shm"]) rmSync(current + suffix, { force: true });
  const legacy = new Database(old, { create: true });
  legacy.run("PRAGMA user_version = 4");
  legacy.run("CREATE TABLE generation_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  legacy.query("INSERT INTO generation_state VALUES (?, ?)").run("legacy-only", "unchanged");
  legacy.close();
  const before = readFileSync(old), store = open(f.memoryDir);
  try { expect(store.list({ project: PROJECT }).length).toBeGreaterThan(0); } finally { store.close(); }
  expect(readFileSync(old)).toEqual(before);
  const built = new Database(current, { readonly: true });
  try {
    expect((built.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    expect((built.query("SELECT value FROM generation_state WHERE key='foreignStamp'").get() as { value: string } | null)?.value).toBe(f.initial!);
  } finally { built.close(); }
});

test("#466 AC3: incremental indexing equals rebuild() on v2 and v3, generation_state included", async () => {
  for (const v2 of [true, false]) {
    const f = await home(v2);
    const store = open(f.memoryDir);
    try {
      store.note(note("incremental decision"));
      store.settle(TASK, "person");
      const incremental = store.derivedTables();
      if (v2) expect(incremental.generation_state?.length).toBeGreaterThan(0);
      store.rebuild();
      expect(store.derivedTables()).toEqual(incremental);
      if (v2) {
        const stamped = new Database(join(f.profile.dir, indexFileName(true)));
        const value = (stamped.query("SELECT value FROM generation_state WHERE key='foreignStamp'").get() as { value: string }).value;
        stamped.close();
        expect((incremental.generation_state as { key: string; value: string }[]).some((row) => row.key === "foreignStamp" && row.value === value)).toBe(true);
      }
    } finally { store.close(); }
  }
});

test("#466 AC3: a one-line append skips the target rewrite and the foreign replay, and still equals rebuild()", async () => {
  for (const v2 of [true, false]) {
    const f = await home(v2);
    const store = open(f.memoryDir);
    const probe = v2 ? new Database(join(f.profile.dir, indexFileName(true))) : undefined;
    try {
      store.list({ project: PROJECT });
      const sentinel = () => !!probe?.query("SELECT 1 FROM generation_foreign_inputs WHERE id='sentinel-299'").get();
      const targets = () => (probe ? (probe.query("SELECT id FROM generation_targets ORDER BY id").all() as { id: string }[]) : []);
      probe?.query("INSERT OR REPLACE INTO generation_foreign_inputs VALUES ('sentinel-299')").run();
      const targetsBefore = targets();
      store.note(note("one line appended after the seed"));
      store.list({ project: PROJECT });
      if (v2) {
        expect(sentinel()).toBe(true); // neither stamp nor foreign membership moved: the proof was not replayed
        expect(targets()).toEqual(targetsBefore); // and no prune row arrived, so the reduction did not move either
        probe?.query("DELETE FROM generation_foreign_inputs WHERE id='sentinel-299'").run(); // the probe's own row must not reach the comparison
      }
      const incremental = store.derivedTables();
      store.rebuild();
      expect(store.derivedTables()).toEqual(incremental);
    } finally { probe?.close(); store.close(); }
  }
});

test("#466 AC3: a prune-row append still recomputes the reduction, restores the proof's targets and equals rebuild()", async () => {
  const f = await home(true);
  const store = open(f.memoryDir);
  const probe = new Database(join(f.profile.dir, indexFileName(true)));
  try {
    const expiring = { ...note("row the person prunes"), expires: new Date(NOW - 1000).toISOString() };
    const id = store.note(expiring);
    store.list({ project: PROJECT });
    const port = store.prunePort(), auth = { project: PROJECT, actor: "person" as const, authorize: () => true };
    const plan = planPrune(port, { cutoff: new Date(NOW).toISOString() }, auth);
    expect(plan.rows.map(row => row.payload.targets.map(target => target.id)).flat()).toContain(id);
    probe.query("INSERT OR REPLACE INTO generation_foreign_inputs VALUES ('sentinel-299')").run();
    expect(applyPrune(port, plan, auth).completed).toEqual([plan.rows[0]!.payload.id]);
    store.list({ project: PROJECT });
    const targets = (probe.query("SELECT id FROM generation_targets ORDER BY id").all() as { id: string }[]).map(row => row.id);
    expect(targets).toContain(id); // the reduction ran and pruned the expired row
    expect(!!probe.query("SELECT 1 FROM generation_foreign_inputs WHERE id='sentinel-299'").get()).toBe(true); // the stamp did not move, so only the proof's target tail ran
    probe.query("DELETE FROM generation_foreign_inputs WHERE id='sentinel-299'").run(); // the probe's own row must not reach the comparison
    const incremental = store.derivedTables();
    store.rebuild();
    expect(store.derivedTables()).toEqual(incremental);
  } finally { probe.close(); store.close(); }
});

test("#466 AC3: a row the committed proof names is never skipped, while an unrelated one is", async () => {
  const f = await home(true), store = open(f.memoryDir);
  const probe = new Database(join(f.profile.dir, indexFileName(true)));
  try {
    store.list({ project: PROJECT });
    const foreign = (probe.query("SELECT id FROM generation_foreign_rows ORDER BY id LIMIT 1").get() as { id: string } | null)?.id;
    if (!foreign) throw new Error("the fixture committed no foreign row");
    const index = (store as unknown as { generationIndex: GenerationIndex }).generationIndex;
    const satisfied = (id: string) => (index as unknown as { foreignBatchSatisfied(touched: readonly string[], resolved: { set: string | undefined }): boolean }).foreignBatchSatisfied([id], { set: undefined });
    expect(satisfied(foreign)).toBe(false); // a re-proved hash of this row is still the only thing that can refuse it
    expect(satisfied("0".repeat(32))).toBe(true);
  } finally { probe.close(); store.close(); }
});

test("#466 AC3: an append that moves nothing still refuses a damaged committed proof", async () => {
  const f = await home(true), store = open(f.memoryDir), probe = new Database(join(f.profile.dir, indexFileName(true)));
  const objects = join(f.profile.dir, "public-prune-objects"), damaged = join(f.root, "damaged-prune-object");
  try {
    expect(store.list({ project: PROJECT }).length).toBeGreaterThan(0);
    const [object] = readdirSync(objects);
    if (!object) throw new Error("the fixture committed no prune object");
    // Written by hand rather than through note(): a write publishes curated briefs, and that path reads the proof
    // too, which would refuse before the index was ever asked to.
    const { line } = probe.query("SELECT line FROM generation_rows ORDER BY id LIMIT 1").get() as { line: string };
    const body = JSON.parse(line) as Record<string, unknown>;
    delete body.id; body.text = "one unrelated line written while the committed proof is damaged"; body.at = new Date(NOW - 500).toISOString();
    const appended = canonicalJSON({ ...body, id: entryId(body as Parameters<typeof entryId>[0]) }) + "\n";
    renameSync(join(objects, object), damaged);
    try {
      appendFileSync(join(f.profile.dir, "local", `${store.machine.id}.jsonl`), appended);
      // The stamp still matches and the line names nothing the proof does, so the reduction and the row hashes are
      // rightly skipped; the proof's own files are read anyway, and their loss refuses here as it does on an
      // unchanged refresh and in rebuild().
      expect(() => store.list({ project: PROJECT })).toThrow();
    } finally { renameSync(damaged, join(objects, object)); }
    expect(store.list({ project: PROJECT }).length).toBeGreaterThan(0); // the restored proof reads again
  } finally { probe.close(); store.close(); }
});

test("#466 AC3: a prune waiting for its target row is reduced once that row arrives", async () => {
  const f = await home(true), store = open(f.memoryDir), probe = new Database(join(f.profile.dir, indexFileName(true)));
  const log = join(f.profile.dir, "local", `${store.machine.id}.jsonl`);
  const targets = () => (probe.query("SELECT id FROM generation_targets ORDER BY id").all() as { id: string }[]).map(row => row.id);
  try {
    store.list({ project: PROJECT });
    const { line } = probe.query("SELECT line FROM generation_rows ORDER BY id LIMIT 1").get() as { line: string };
    const at = new Date(NOW).toISOString(), expiredAt = new Date(NOW - 1000).toISOString();
    const body = JSON.parse(line) as Record<string, unknown>;
    delete body.id; body.at = at; body.expires = expiredAt; body.text = "the row a prune waits for";
    const entry = { ...body, id: entryId(body as Parameters<typeof entryId>[0]) } as unknown as Entry;
    const rowHash = pruneRowHash(entry);
    const prune: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation: f.profile.generation!, at, machine: store.machine.id, actor: "person", placement: "local", cutoff: at, targets: [{ id: entry.id, rowHash, expiredAt, basis: { kind: "note", id: entry.id, rowHash } }] };
    appendFileSync(log, canonicalJSON({ ...prune, id: pruneId(prune) }) + "\n");
    store.list({ project: PROJECT });
    expect(targets()).not.toContain(entry.id); // the prune is pending: neither its target nor its basis is indexed yet
    appendFileSync(log, canonicalJSON(entry) + "\n");
    store.list({ project: PROJECT });
    expect(targets()).toContain(entry.id); // the arriving row moved the reduction, so it was recomputed
  } finally { probe.close(); store.close(); }
});

test("#466 AC3: an unchanged refresh does not replay the foreign tables, while a new stamp does", async () => {
  const f = await home(true);
  const store = open(f.memoryDir);
  const file = join(f.profile.dir, indexFileName(true));
  const probe = new Database(file);
  const sentinel = () => !!probe.query("SELECT 1 FROM generation_foreign_inputs WHERE id='sentinel-466'").get();
  try {
    probe.query("INSERT OR REPLACE INTO generation_foreign_inputs VALUES ('sentinel-466')").run();
    store.list({ project: PROJECT });
    expect(sentinel()).toBe(true); // neither prunes nor the foreign stamp changed: no full-table rewrite
    const registration = f.prepare(publicPruneGraph({ note: { text: "second public prune view row" } }), f.initial);
    await f.advance(f.view({ [`project:${PROJECT}`]: registration.inputSetHash }));
    store.list({ project: PROJECT });
    expect(sentinel()).toBe(false); // the stamp moved, so the membership was replayed
  } finally { probe.close(); store.close(); }
});

test("#466 AC3: an unchanged refresh still refuses a shard whose committed foreign proof was damaged", async () => {
  const f = await home(true), store = open(f.memoryDir);
  const sets = join(f.profile.dir, "public-prune-input-sets"), moved = join(f.root, "damaged-committed-set");
  try {
    expect(store.list({ project: PROJECT }).length).toBeGreaterThan(0);
    const [name] = readdirSync(sets);
    if (!name) throw new Error("the fixture committed no foreign input set");
    renameSync(join(sets, name), moved);
    try {
      // The stamp still matches, so nothing is rewritten; the committed proof is re-read anyway and its loss refuses the read.
      expect(() => store.list({ project: PROJECT })).toThrow();
    } finally { renameSync(moved, join(sets, name)); }
    expect(store.list({ project: PROJECT }).length).toBeGreaterThan(0); // the restored proof reads again
  } finally { store.close(); }
});

test("#466 AC3: the witness stamp never moves the activation source hash", async () => {
  const f = await home(false);
  const before = buildPublicPruneIndex(f.profile); // the shard before it carries a public prune view
  await activatePublicPruneView({ memoryDir: f.memoryDir, mode: "apply", authorizedPerson: true, tty: true });
  const registration = f.prepare();
  await f.advance(f.view({ [`project:${PROJECT}`]: registration.inputSetHash }));
  const stamped = resolveShardProfile(f.memoryDir, { project: PROJECT });
  expect(stamped.foreignPruneFormat).toBeString();
  const after = buildPublicPruneIndex(stamped); // activation and every later rebuild write the stamp
  expect(after.sourceHash).toBe(before.sourceHash); // witness state, not a source row: activation must not move it
  const probe = new Database(join(f.profile.dir, indexFileName(true)));
  try { expect((probe.query("SELECT value FROM generation_state WHERE key='foreignStamp'").get() as { value: string } | null)?.value).toBeString(); }
  finally { probe.close(); }
});

test("#466 AC2: a held writer does not fail or empty a read, and the read marks itself stale as the legacy path does", async () => {
  const f = await home(true);
  const diagnostics: string[] = [], store = open(f.memoryDir, { log: (line: string) => diagnostics.push(line) });
  const sourceLog = join(store.dir, "log", `${store.machine.id}.jsonl`);
  /** The flag `MemoryStore` sets on a read whose index update failed, and the shared-v1 path's own stale signal. */
  const stale = () => (store as unknown as { stale: boolean }).stale;
  const lock = new Database(join(f.profile.dir, indexFileName(true)));
  lock.run("PRAGMA busy_timeout = 3000");
  try {
    store.note({ ...note("row that opens this shard's synced log"), tier: "long" });
    const before = store.list({ project: PROJECT }).map((row) => row.id);
    expect(before.length).toBeGreaterThan(0);
    expect(stale()).toBe(false);
    lock.run("BEGIN IMMEDIATE");
    lock.query("INSERT INTO generation_targets VALUES ('probe-466-held')").run();
    // A durable row no index can take while the writer holds the lock, written out of band so one busy_timeout is spent.
    const { id: _id, ...rest } = JSON.parse(readFileSync(sourceLog, "utf8").trim().split("\n").find((line) => (JSON.parse(line) as { tier?: string }).tier === "long")!) as Record<string, unknown>;
    const added = entryId({ ...rest, text: "written while the writer held the lock" } as never);
    appendFileSync(sourceLog, `${JSON.stringify({ ...rest, text: "written while the writer held the lock", id: added })}\n`);
    diagnostics.length = 0;
    let seen: string[] = [];
    expect(() => { seen = store.list({ project: PROJECT }).map((row) => row.id); }).not.toThrow();
    expect(seen).toEqual(before); // stale rows, never empty and never an escalated lock error
    expect(stale()).toBe(true); // the refusal is recorded, not swallowed into a read that looks current
    expect(diagnostics.filter((line) => line.startsWith("hub memory index not updated yet:"))).toHaveLength(1);
    lock.run("ROLLBACK");
    expect(store.list({ project: PROJECT }).map((row) => row.id)).toContain(added); // the next read catches up
    expect(stale()).toBe(false); // and the flag clears only on a read that took the index
  } finally { lock.close(); store.close(); }
}, 20000);

