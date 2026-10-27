import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProject } from "../src/memory/project-export.ts";
import { importProject } from "../src/memory/project-import.ts";
import { appendAlias, ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
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
  const first = await importProject(restored, { from: file, project, policy: () => true, confirm: true });
  expect(first).toMatchObject({ read: 1, added: 1, skipped: { invalid: 0, policy: 0 } });
  expect(restored.list().map(view => view.id)).toEqual(expected);
  expect(restored.list()[0]).toMatchObject({ title: "Portable decision", machine: original.list()[0]!.machine, at: original.list()[0]!.at });
  expect((await importProject(restored, { from: file, project, policy: () => true, confirm: true })).added).toBe(0);
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
  const result = await importProject(restored, { from: file, project, policy: () => true, confirm: true });
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
  expect(await importProject(restored, { from: file, project, policy: () => true, confirm: true })).toMatchObject({ read: 2, added: 2, skipped: { invalid: 0 } });
  expect(restored.portableNotes(project).find(note => note.id === aliased)?.project).toBe(alias);
});

test("a split import refuses an unopened alias owner before appending its canonical row", async () => {
  const source = home("unopened-alias-source"), target = home("unopened-alias-target"), alias = "unopened-portable";
  const original = populate(source.dir, source.base);
  original.note({ op: "note", project: alias, scope: "project", tier: "long", kind: "decision", peer: "kimi", source: "person", text: "Alias row follows canonical row", about: [] });
  appendAlias(source.base, { alias, key: project, actor: "person", machine: "fixture" });
  const file = join(source.dir, "unopened-alias.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });

  const seed = new MemoryStore({ home: target.dir, deferPromotions: true }); seed.close();
  ensureShardDescriptor(target.base, project);
  await migrateShards({ memoryDir: target.base, mode: "apply", authorizedPerson: true, tty: true });
  appendAlias(target.base, { alias, key: project, actor: "person", machine: "fixture" });
  ensureShardDescriptor(target.base, alias);
  expect(existsSync(join(shardDir(target.base, alias), "generation.json"))).toBe(false);
  const restored = openShardStore({ memoryDir: target.base, project, deferPromotions: true, reconcile: { canonical: project, aliases: [alias] } });
  cleanup.push(() => restored.close());
  const log = join(restored.dir, "log", `${restored.machine.id}.jsonl`), before = existsSync(log) ? readFileSync(log, "utf8") : "";
  await expect(importProject(restored, { from: file, project, policy: () => true, confirm: true })).rejects.toThrow("entry does not belong to this curated shard");
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
  expect(restored.portableNotes(project)).toEqual([]);
  expect(existsSync(join(shardDir(target.base, alias), "generation.json"))).toBe(false);
});

test("legacy absent source, null optional fields and empty text survive the id round trip", async () => {
  const source = home("legacy-source"), target = home("legacy-target");
  ensureShardDescriptor(source.base, project);
  const legacy = new MemoryStore({ home: source.dir, deferPromotions: true }); cleanup.push(() => legacy.close());
  const body = { schema: MEMORY_SCHEMA, at: "2026-01-01T00:00:00.000Z", machine: "legacy-fixture", op: "note", project,
    scope: "project", tier: "long", kind: "finding", peer: "legacy", title: null, text: "Legacy optional fields", about: [], supersedes: null, promotedFrom: null } as unknown as Omit<NoteEntry, "id">;
  const id = entryId(body);
  appendFileSync(join(legacy.dir, "log", `${legacy.machine.id}.jsonl`), `${JSON.stringify({ ...body, id })}\n`, { mode: 0o600 });
  legacy.refresh();
  const empty = legacy.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "legacy", source: "person", text: "", about: [] });
  const file = join(source.dir, "legacy.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true, confirm: true })).toMatchObject({ read: 2, added: 2, skipped: { invalid: 0 } });
  expect(restored.list().map(view => view.id).sort()).toEqual([id, empty].sort());
});

test("a correctly hashed malformed note is rejected before any append", async () => {
  const target = home("malformed-target");
  const body = { schema: MEMORY_SCHEMA, at: "2026-01-01T00:00:00.000Z", machine: "legacy-fixture", op: "note", project,
    scope: "project", tier: "long", kind: "finding", peer: "legacy", source: "person", text: "Malformed expiry", about: [], expires: "not-a-date" } as unknown as Omit<NoteEntry, "id">;
  const value = { ...body, id: entryId(body) }, file = join(target.dir, "malformed.jsonl");
  await Bun.write(file, `${JSON.stringify({ schema: "agent-mem.project-export/v1", project, type: "header", aliases: [] })}\n${JSON.stringify({ schema: "agent-mem.project-export/v1", project, type: "curated", value })}\n`);
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true, confirm: true })).toMatchObject({ read: 1, added: 0, skipped: { invalid: 1 } });
  expect(restored.list()).toEqual([]);
});

test("Markdown export keeps metadata in code blocks and preserves lone carriage returns as line breaks", async () => {
  const source = home("markdown-source");
  const original = populate(source.dir, source.base), view = original.list()[0]!;
  original.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "kimi", source: "hub", title: "<img src=x onerror=alert(1)>", text: "first\rsecond", about: [] });
  const file = join(source.dir, "project.md");
  await exportProject(source.base, project, { to: file, format: "markdown" });
  const markdown = readFileSync(file, "utf8");
  expect(markdown).toStartWith(`# Project export "${project}"`);
  expect(markdown).toContain("## Curated notes");
  expect(markdown).toContain(view.id);
  expect(markdown).toContain("    Keep the original entry identity.");
  expect(markdown).toContain("    first\n    second");
  expect(markdown).toContain(`\n    {"id":"${view.id}"`);
  expect(markdown).not.toContain(`\n{"id":"${view.id}"`);
  expect(markdown).not.toContain("\r");
});

test("Markdown escapes the project name in its heading", async () => {
  const source = home("markdown-heading"), hostile = "github.com/o/<img>";
  ensureShardDescriptor(source.base, hostile);
  const original = new MemoryStore({ home: source.dir, deferPromotions: true }); cleanup.push(() => original.close());
  original.note({ op: "note", project: hostile, scope: "project", tier: "long", kind: "finding", peer: "kimi", source: "person", text: "safe", about: [] });
  const file = join(source.dir, "heading.md");
  await exportProject(source.base, hostile, { to: file, format: "markdown" });
  const markdown = readFileSync(file, "utf8");
  expect(markdown.split("\n")[0]).toContain('github.com/o/&lt;img&gt;');
  expect(markdown.split("\n")[0]).not.toContain('github.com/o/<img>');
});

test("project re-import applies policy and refuses a different project or a missing header", async () => {
  const source = home("policy-source"), target = home("policy-target");
  const original = populate(source.dir, source.base);
  original.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "kimi", source: "person", text: "PRIVATE-MARKER", about: [] });
  const file = join(source.dir, "project.jsonl");
  await exportProject(source.base, project, { to: file, format: "jsonl" });
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true });
  cleanup.push(() => restored.close());
  const result = await importProject(restored, { from: file, project, policy: note => !note.text.includes("PRIVATE-MARKER"), confirm: true });
  expect(result).toMatchObject({ read: 2, added: 1, skipped: { policy: 1 } });
  expect(restored.list().some(view => view.text.includes("PRIVATE-MARKER"))).toBe(false);
  await expect(importProject(restored, { from: file, project: "github.com/o/other", policy: () => true, confirm: true })).rejects.toThrow(/project mismatch/);
  const invalid = join(source.dir, "invalid.jsonl");
  await Bun.write(invalid, `${JSON.stringify({ schema: "agent-mem.project-export/v1", project, type: "curated", value: {} })}\n`);
  await expect(importProject(restored, { from: invalid, project, policy: () => true, confirm: true })).rejects.toThrow(/header first/);
  const link = join(source.dir, "linked.jsonl"); symlinkSync(file, link);
  await expect(importProject(restored, { from: link, project, policy: () => true, confirm: true })).rejects.toThrow();
});

function noteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: MEMORY_SCHEMA, at: "2026-01-01T00:00:00.000Z", machine: "crafted", op: "note", project,
    scope: "project", tier: "long", kind: "finding", peer: "legacy", source: "person", text: "Crafted note", about: [], ...overrides };
}

async function craftedFile(dir: string, name: string, bodies: Record<string, unknown>[]): Promise<string> {
  const file = join(dir, name), header = { schema: "agent-mem.project-export/v1", project, type: "header", aliases: [] };
  const rows = bodies.map(body => ({ schema: "agent-mem.project-export/v1", project, type: "curated", value: { ...body, id: entryId(body as unknown as Omit<NoteEntry, "id">) } }));
  await Bun.write(file, `${[header, ...rows].map(row => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

test("preview reports provenance and validation refuses external relations, future rows, unknown fields and normalized identities before any append", async () => {
  const target = home("security-target"), restored = new MemoryStore({ home: target.dir, deferPromotions: true });
  cleanup.push(() => restored.close());
  const existing = restored.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "Existing person note", about: [] });
  const file = await craftedFile(target.dir, "security.jsonl", [
    noteBody({ text: "Valid person row" }),
    noteBody({ text: "Valid hub row", source: "hub", peer: "agent" }),
    noteBody({ text: "External relation", supersedes: existing }),
    noteBody({ text: "Future row", at: "9999-01-01T00:00:00.000Z" }),
    noteBody({ text: "Shared row", scope: "shared" }),
    noteBody({ text: "Unknown field", unexpected: "must not persist" }),
    noteBody({ text: "Private <private>secret</private>" }),
    noteBody({ text: "x".repeat(5000) }),
  ]);
  const preview = await importProject(restored, { from: file, project, policy: () => true });
  expect(preview).toMatchObject({ applied: false, read: 8, added: 0, wouldAdd: 2, skipped: { invalid: 6 },
    provenance: { source: { person: 1, hub: 1 }, peer: { legacy: 1, agent: 1 }, scope: { project: 2 }, machine: { crafted: 2 } } });
  expect(restored.list({ includeSuperseded: true }).map(note => note.id)).toEqual([existing]);
  expect(restored.get(existing, project)?.text).toBe("Existing person note");
  const applied = await importProject(restored, { from: file, project, policy: () => true, confirm: true });
  expect(applied).toMatchObject({ applied: true, added: 2, wouldAdd: 2, skipped: { invalid: 6 } });
  expect(restored.list({ includeSuperseded: true })).toHaveLength(3);
  expect(restored.list({ includeSuperseded: true }).some(note => note.text.includes("Private"))).toBe(false);
  expect(applied.warnings.join(" ")).toMatch(/Supersede, demote, settle and forget operations are not exported/);
});

test("relationships may target another row in the same file", async () => {
  const target = home("relations-target"), old = noteBody({ text: "Old row" }), oldId = entryId(old as unknown as Omit<NoteEntry, "id">);
  const file = await craftedFile(target.dir, "relations.jsonl", [old, noteBody({ text: "Replacement row", supersedes: oldId })]);
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true, confirm: true })).toMatchObject({ read: 2, added: 2, skipped: { invalid: 0 } });
});

for (const reversed of [false, true]) test(`policy-refused relation targets invalidate dependent rows before import, reversed=${reversed}`, async () => {
  const target = home("policy-relations"), refused = noteBody({ text: "PRIVATE-MARKER", machine: "refused-machine" });
  const refusedId = entryId(refused as unknown as Omit<NoteEntry, "id">);
  const child = noteBody({ text: "Supersedes a refused row", supersedes: refusedId });
  const childId = entryId(child as unknown as Omit<NoteEntry, "id">);
  const grandchild = noteBody({ text: "Promoted from an invalidated relation", promotedFrom: childId });
  const independent = noteBody({ text: "Independent accepted row", machine: "accepted-machine" });
  const bodies = [refused, child, grandchild, independent];
  const file = await craftedFile(target.dir, "policy-relations.jsonl", reversed ? bodies.reverse() : bodies);
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  const policy = (note: { text: string }) => !note.text.includes("PRIVATE-MARKER");
  const preview = await importProject(restored, { from: file, project, policy });
  expect(preview).toMatchObject({ read: 4, added: 0, wouldAdd: 1, skipped: { invalid: 2, policy: 1 }, provenance: { machine: { "accepted-machine": 1 } } });
  expect(restored.portableNotes(project)).toEqual([]);
  expect(await importProject(restored, { from: file, project, policy, confirm: true })).toMatchObject({ added: 1, skipped: { invalid: 2, policy: 1 } });
  expect(restored.portableNotes(project).map(note => note.text)).toEqual(["Independent accepted row"]);
});

test("shared scope requires an explicit person opt-in", async () => {
  const target = home("shared-target"), file = await craftedFile(target.dir, "shared.jsonl", [noteBody({ scope: "shared", text: "Shared imported note" })]);
  const restored = new MemoryStore({ home: target.dir, deferPromotions: true }); cleanup.push(() => restored.close());
  expect(await importProject(restored, { from: file, project, policy: () => true, confirm: true })).toMatchObject({ added: 0, skipped: { invalid: 1 } });
  expect(await importProject(restored, { from: file, project, policy: () => true, confirm: true, allowShared: true })).toMatchObject({ added: 1, skipped: { invalid: 0 } });
});
