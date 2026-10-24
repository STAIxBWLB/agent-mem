import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProject } from "../src/memory/project-export.ts";
import { importProject } from "../src/memory/project-import.ts";
import { appendAlias, ensureShardDescriptor } from "../src/memory/shard.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { entryId, MEMORY_SCHEMA, MemoryStore, openShardStore, type NoteEntry } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(name: string): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), `amem-${name}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, base: join(dir, "memory") };
}
const project = "github.com/o/portable";
function populate(dir: string, base: string): MemoryStore {
  ensureShardDescriptor(base, project);
  const store = new MemoryStore({ home: dir, deferPromotions: true });
  cleanup.push(() => store.close());
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "person", title: "Portable decision", text: "Keep the original entry identity.", about: ["path:src/memory/store.ts"] });
  return store;
}

test("JSONL export re-imports curated notes with the same entry ids and is idempotent", async () => {
  const source = home("portable-source"), target = home("portable-target");
  const original = populate(source.dir, source.base);
  const expected = original.list().map(view => view.id);
  const file = join(source.dir, "project.jsonl");
  const exported = await exportProject(source.base, project, { to: file, format: "jsonl" });
  expect(exported.format).toBe("jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines[0]).toMatchObject({ type: "header", project });
  expect(lines.some(row => row.type === "curated")).toBe(true);

  const restored = new MemoryStore({ home: target.dir, deferPromotions: true });
  cleanup.push(() => restored.close());
  const first = await importProject(restored, { from: file, project, policy: () => true });
  expect(first).toMatchObject({ read: 1, added: 1, skipped: { invalid: 0, policy: 0 } });
  expect(restored.list().map(view => view.id)).toEqual(expected);
  expect(restored.list()[0]).toMatchObject({ title: "Portable decision", machine: original.list()[0]!.machine, at: original.list()[0]!.at });
  expect((await importProject(restored, { from: file, project, policy: () => true })).added).toBe(0);
});

test("JSONL uses authored rows so task, demotion, supersession and alias state cannot change entry ids", async () => {
  const source = home("authored-source"), target = home("authored-target"), alias = "old-portable";
  const original = populate(source.dir, source.base);
  const task = original.note({ op: "note", project, scope: "project", tier: "short", kind: "decision", peer: "kimi", source: "hub", text: "Open-task short note", task: `${project}#1@1`, about: [] });
  const old = original.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "person", text: "Superseded note", about: [] });
  const replacement = original.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "person", text: "Replacement note", about: [] });
  expect(original.supersede(old, replacement, "person", project)).toBe(true);
  const demoted = original.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "kimi", source: "person", text: "Demoted note", about: [] });
  original.demote(demoted, "person", project);
  const aliased = original.note({ op: "note", project: alias, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "person", text: "Aliased note", about: [] });
  appendAlias(source.base, { alias, key: project, actor: "person", machine: "fixture" });
  appendAlias(target.base, { alias, key: project, actor: "person", machine: "fixture" });
  const file = join(source.dir, "authored.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });
  const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "curated");
  expect(rows.every(row => row.value.schema === "agent-hub.memory/v1" && row.value.op === "note")).toBe(true);
  expect(rows.find(row => row.value.id === task)?.value.expires).toBeUndefined();
  expect(rows.find(row => row.value.id === demoted)?.value.tier).toBe("long");
  expect(rows.find(row => row.value.id === replacement)?.value.supersedes).toBeUndefined();
  expect(rows.find(row => row.value.id === aliased)?.value.project).toBe(alias);

  const restored = new MemoryStore({ home: target.dir, deferPromotions: true, reconcile: { canonical: project, aliases: [alias] } });
  cleanup.push(() => restored.close());
  const result = await importProject(restored, { from: file, project, policy: () => true });
  expect(result).toMatchObject({ read: 6, added: 6, skipped: { invalid: 0, policy: 0 } });
  expect(restored.portableNotes(project).map(note => note.id).sort()).toEqual([task, old, replacement, demoted, aliased, original.list({ includeSuperseded: true }).find(view => view.title === "Portable decision")!.id].sort());
});

test("a split target routes an imported alias note to its existing alias shard", async () => {
  const source = home("split-source"), target = home("split-target"), alias = "old-split";
  const original = populate(source.dir, source.base);
  const aliased = original.note({ op: "note", project: alias, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "person", text: "Split alias note", about: [] });
  appendAlias(source.base, { alias, key: project, actor: "person", machine: "fixture" });
  const file = join(source.dir, "split.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });

  const seed = new MemoryStore({ home: target.dir, deferPromotions: true }); seed.close();
  ensureShardDescriptor(target.base, project); ensureShardDescriptor(target.base, alias);
  appendAlias(target.base, { alias, key: project, actor: "person", machine: "fixture" });
  await migrateShards({ memoryDir: target.base, mode: "apply", authorizedPerson: true, tty: true });
  const restored = openShardStore({ memoryDir: target.base, project, deferPromotions: true, createAliases: true, reconcile: { canonical: project, aliases: [alias] } });
  cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true })).toMatchObject({ read: 2, added: 2, skipped: { invalid: 0 } });
  expect(restored.portableNotes(project).find(note => note.id === aliased)?.project).toBe(alias);
});

test("legacy absent source, null optional fields and empty text survive the id round trip", async () => {
  const source = home("legacy-source"), target = home("legacy-target");
  ensureShardDescriptor(source.base, project);
  const legacy = new MemoryStore({ home: source.dir, deferPromotions: true }); cleanup.push(() => legacy.close());
  const body = { schema: MEMORY_SCHEMA, at: "2026-01-01T00:00:00.000Z", machine: "legacy-fixture", op: "note", project,
    scope: "project", tier: "long", kind: "finding", peer: "legacy", title: null, text: "Legacy optional fields", about: [] } as unknown as Omit<NoteEntry, "id">;
  const id = entryId(body);
  appendFileSync(join(legacy.dir, "log", `${legacy.machine.id}.jsonl`), `${JSON.stringify({ ...body, id })}\n`, { mode: 0o600 });
  legacy.refresh();
  const empty = legacy.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "legacy", source: "person", text: "", about: [] });
  const file = join(source.dir, "legacy.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true })).toMatchObject({ read: 2, added: 2, skipped: { invalid: 0 } });
  expect(restored.list().map(view => view.id).sort()).toEqual([id, empty].sort());
});

test("a correctly hashed malformed note is rejected before any append", async () => {
  const target = home("malformed-target");
  const body = { schema: MEMORY_SCHEMA, at: "2026-01-01T00:00:00.000Z", machine: "legacy-fixture", op: "note", project,
    scope: "project", tier: "long", kind: "finding", peer: "legacy", source: "person", text: "Malformed expiry", about: [], expires: "not-a-date" } as unknown as Omit<NoteEntry, "id">;
  const value = { ...body, id: entryId(body) }, file = join(target.dir, "malformed.jsonl");
  await Bun.write(file, `${JSON.stringify({ schema: "agent-mem.project-export/v1", project, type: "header", aliases: [] })}\n${JSON.stringify({ schema: "agent-mem.project-export/v1", project, type: "curated", value })}\n`);
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true })).toMatchObject({ read: 1, added: 0, skipped: { invalid: 1 } });
  expect(restored.list()).toEqual([]);
});

test("Markdown export is person-readable and uses the same screened project rows", async () => {
  const source = home("markdown-source");
  const original = populate(source.dir, source.base), view = original.list()[0]!;
  const file = join(source.dir, "project.md");
  await exportProject(source.base, project, { to: file, format: "markdown" });
  const markdown = readFileSync(file, "utf8");
  expect(markdown).toStartWith(`# Project export "${project}"`);
  expect(markdown).toContain("## Curated notes");
  expect(markdown).toContain(view.id);
  expect(markdown).toContain("    Keep the original entry identity.");
});

test("project re-import applies policy and refuses a different project or a missing header", async () => {
  const source = home("policy-source"), target = home("policy-target");
  const original = populate(source.dir, source.base);
  original.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "kimi", source: "person", text: "PRIVATE-MARKER", about: [] });
  const file = join(source.dir, "project.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true });
  cleanup.push(() => restored.close());
  const result = await importProject(restored, { from: file, project, policy: note => !note.text.includes("PRIVATE-MARKER") });
  expect(result).toMatchObject({ read: 2, added: 1, skipped: { policy: 1 } });
  expect(restored.list().some(view => view.text.includes("PRIVATE-MARKER"))).toBe(false);
  await expect(importProject(restored, { from: file, project: "github.com/o/other", policy: () => true })).rejects.toThrow(/project mismatch/);
  const invalid = join(source.dir, "invalid.jsonl");
  await Bun.write(invalid, `${JSON.stringify({ schema: "agent-mem.project-export/v1", project, type: "curated", value: {} })}\n`);
  await expect(importProject(restored, { from: invalid, project, policy: () => true })).rejects.toThrow(/header first/);
  const link = join(source.dir, "linked.jsonl"); symlinkSync(file, link);
  await expect(importProject(restored, { from: link, project, policy: () => true })).rejects.toThrow();
});
