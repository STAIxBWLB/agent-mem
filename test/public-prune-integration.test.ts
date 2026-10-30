import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Old from "@staix/agent-mem-v013";
import * as Older from "@staix/agent-mem-v012";
import { MemoryStore, openShardStore, entryId, type NoteInput } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { migrate } from "../src/memory/migrate.ts";
import { readSelector } from "../src/memory/generation.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { preparePublicPruneInput, persistPublicPruneInput } from "../src/memory/public-prune-inputs.ts";
import { readCatalogFresh } from "../src/memory/catalog.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const now = () => Date.parse("2026-10-01T12:00:00.000Z");
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-prune-floor-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const memoryDir = join(home, "memory"), graph = publicPruneGraph(), project = graph.note.project;
  const before = new MemoryStore({ home, now, screen: () => "keep" });
  const { id, at, machine, schema: _schema, ...input } = graph.note;
  expect(before.importNote(input as NoteInput, at, { machine, expectedId: id }).id).toBe(id);
  const { id: _old, ...body } = { ...graph.note, at: "2026-10-01T01:00:00.000Z" }, equal = { ...body, id: entryId(body) };
  const { id: equalId, at: equalAt, machine: equalMachine, schema: _equalSchema, ...equalInput } = equal;
  before.importNote(equalInput as NoteInput, equalAt, { machine: equalMachine, expectedId: equalId }); before.close();
  await migrateShards({ memoryDir, generation: "7".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  const initial = openShardStore({ memoryDir, project, now, screen: () => "keep" });
  expect(initial.get(id, project)?.id).toBe(id); initial.search("Independent", { project, includeCapture: false }); initial.close();
  const profile = resolveShardProfile(memoryDir, { project }), binding = { realm: graph.manifest.realm, receivingGeneration: profile.generation!, selectorRevision: readSelector(memoryDir).revision, inputSetHash: null };
  const registration = persistPublicPruneInput(preparePublicPruneInput({ dir: profile.dir, binding, current: () => binding, input: graph.input }));
  const view = { schema: "agent-mem.public-prune-view/v1" as const, receivingGeneration: profile.generation!, realms: { [`project:${project}`]: registration.inputSetHash } };
  const activate = () => activatePublicPruneView({ memoryDir, mode: "apply", authorizedPerson: true, tty: true, view });
  return { home, memoryDir, graph, project, profile, registration, view, equal, activate };
}

test("R19 real 0.13/0.12 readers preserve v1 and reject both v2 markers without legacy fallback", async () => {
  const f = await fixture();
  for (const core of [Old, Older]) {
    expect(core.readSelector(f.memoryDir)).toEqual(readSelector(f.memoryDir));
    const old = core.openShardStore({ home: f.home, project: f.project, now });
    try { expect(old.get(f.graph.note.id, f.project)?.id).toBe(f.graph.note.id); } finally { old.close(); }
  }
  await f.activate();
  for (const core of [Old, Older]) {
    expect(() => core.readSelector(f.memoryDir)).toThrow();
    expect(() => { const old = core.openShardStore({ home: f.home, project: f.project, now }); old.close(); }).toThrow();
    for (const profile of [undefined, "shared-v1" as const]) expect(() => { const old = new core.MemoryStore({ home: f.home, ...(profile ? { profile } : {}) }); old.close(); }).toThrow();
  }
  expect(readSelector(f.memoryDir).selector?.schema).toBe("agent-mem.profile/v2");
});

test("R20 actual get/list/search/history/intent/relations and rebuild share the exact-ID mask", async () => {
  const f = await fixture(); await f.activate();
  const store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now, screen: () => "keep" });
  try {
    expect(store.profile.foreignPruneFormat).toBe("agent-mem.public-prune-witness/v1");
    expect(existsSync(join(store.dir, "index-v2.db"))).toBe(true); expect(existsSync(join(store.dir, "index.db"))).toBe(true);
    const check = () => {
      expect(store.get(f.graph.note.id, f.project)).toBeUndefined(); expect(store.get(f.equal.id, f.project)?.id).toBe(f.equal.id);
      expect(store.list({ project: f.project, includeSuperseded: true }).map(v => v.id)).not.toContain(f.graph.note.id);
      expect(store.search("Independent", { project: f.project, includeCapture: false }).hits.map(hit => hit.view?.id)).not.toContain(f.graph.note.id);
      expect(store.intentSnapshot(f.project).rows.map(v => v.id)).not.toContain(f.graph.note.id);
      expect(store.recallState(f.project, { person: true, history: true }).views.map(v => v.id)).not.toContain(f.graph.note.id);
      expect(store.related(f.project, ["path:src/public.ts"], 100).map(v => v.id)).not.toContain(f.graph.note.id);
      expect(store.graph(f.project, `mem:${f.graph.note.id}`).nodes).toEqual([]);
    };
    check(); const before = store.derivedTables(); store.rebuild(); check(); expect(store.derivedTables()).toEqual(before);
    // Shared FTS remains a raw corpus, even though candidates are masked before exposing views.
    const db = new Database(join(store.dir, "search.db"), { readonly: true });
    try { expect(db.query("SELECT COUNT(*) AS n FROM docs WHERE ref = ?").get(f.graph.note.id)).toMatchObject({ n: 1 }); } finally { db.close(); }
  } finally { store.close(); }
  const catalog = readCatalogFresh(f.memoryDir).find(row => row.key === f.project); expect(catalog?.curatedAvailable).toBe(true);
});

for (const what of ["map", "set", "input", "tree", "blob"] as const) test(`R15 lost committed ${what} refuses live and fresh readers even after index deletion`, async () => {
  const f = await fixture(); await f.activate();
  const store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now, screen: () => "keep" });
  expect(store.get(f.graph.note.id, f.project)).toBeUndefined();
  const hash = (readSelector(f.memoryDir).selector as {pruneInputSetHash:string}).pruneInputSetHash;
  const file = what === "map" ? join(f.memoryDir, "public-prune-input-sets", hash + ".json")
    : what === "set" ? join(f.profile.dir, "public-prune-input-sets", f.registration.inputSetHash + ".json")
    : what === "input" ? join(f.profile.dir, "public-prune-inputs", f.registration.inputHash! + ".json")
    : join(f.profile.dir, "public-prune-objects", (what === "tree" ? f.graph.rootTree.oid : f.graph.input.source.manifestBlob) + ".git");
  unlinkSync(file);
  try { expect(() => store.list({ project: f.project })).toThrow(); } finally { store.close(); }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(f.profile.dir, "index-v2.db" + suffix), { force: true });
  expect(() => { const next = openShardStore({ memoryDir: f.memoryDir, project: f.project, now }); next.close(); }).toThrow();
});

test("R15 warm verified cache also refuses an archive parent symlink, matching a fresh reader", async () => {
  const f = await fixture(); await f.activate();
  const store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now });
  expect(store.get(f.graph.note.id, f.project)).toBeUndefined();
  const original = join(f.profile.dir, "public-prune-objects"), moved = original + "-moved";
  renameSync(original, moved); symlinkSync(moved, original);
  try { expect(() => store.list({ project: f.project })).toThrow(); } finally { store.close(); }
  expect(() => { const next = openShardStore({ memoryDir: f.memoryDir, project: f.project, now }); next.close(); }).toThrow();
});

test("R21 warm v2 reads do no network/process work, never rewrite native sources or reactivate", async () => {
  const f = await fixture(); await f.activate();
  const store = openShardStore({ memoryDir: f.memoryDir, project: f.project, now });
  store.list({ project: f.project });
  const markers = ["profile.json", "shards.json"].map(name => readFileSync(join(f.memoryDir, name)));
  const spies = [spyOn(globalThis, "fetch"), spyOn(Bun, "spawn"), spyOn(Bun, "spawnSync")];
  try {
    for (let n = 0; n < 5; n++) expect(store.get(f.graph.note.id, f.project)).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); store.close(); }
  expect(["profile.json", "shards.json"].map(name => readFileSync(join(f.memoryDir, name)))).toEqual(markers);
  await expect(migrate({ memoryDir: f.memoryDir, mode: "deactivate", authorizedPerson: true, tty: true })).rejects.toThrow(/forward-only/);
  await expect(migrateShards({ memoryDir: f.memoryDir, mode: "resume", authorizedPerson: true, tty: true })).rejects.toThrow(/forward-only/);
});
