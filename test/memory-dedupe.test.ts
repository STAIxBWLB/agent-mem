import { afterEach, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { memoryCommand } from "./core-test-support.ts";
import { memoryProjectKey } from "../src/memory/project.ts";

const dirs: string[] = [], stores: MemoryStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "ahub-dedupe-"))); dirs.push(d); return d; };
let clock = Date.parse("2026-10-14T00:00:00Z");
const open = () => { const s = new MemoryStore({ home: temp(), now: () => clock++ }); stores.push(s); return s; };
const project = "github.com/o/app", at = "2026-10-12T00:00:00.000Z";
const note = (text = "legacy imported note", over: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "codex", text, about: [], source: "hub", ...over });
const segment = (s: MemoryStore) => join(s.dir, "log", `${s.machine.id}.jsonl`);
const bytes = (s: MemoryStore) => new Map(readdirSync(join(s.dir, "log")).map((f) => [f, readFileSync(join(s.dir, "log", f), "utf8")]));
function prefix(s: MemoryStore, before: Map<string, string>) { for (const [f, b] of before) expect(readFileSync(join(s.dir, "log", f), "utf8").startsWith(b)).toBe(true); }
function rebuild(s: MemoryStore) { const dump = s.dump(); s.rebuild(); expect(s.dump()).toBe(dump); }
function legacy(count = 3) {
  const s = open(), ids: string[] = [];
  // Independent pre-fix machines imported one tuple with checkout-dependent about values.
  for (let i = 0; i < count; i++) {
    const old = open();
    ids.push(old.importNote(note(undefined, { source: "claude-mem", about: [`path:src/${i}.ts`] }), at).id);
    copyFileSync(segment(old), join(s.dir, "log", `${old.machine.id}.jsonl`));
  }
  s.refresh();
  return { s, ids: ids.sort() };
}
const visible = (s: MemoryStore) => s.list({ project }).filter((v) => v.source === "claude-mem").map((v) => v.id).sort();

test("legacy dedupe lists without writes, applies append-only, repeats without writes, and forget removes the whole tuple", () => {
  const { s, ids } = legacy();
  const before = bytes(s);
  expect(visible(s)).toHaveLength(3);
  expect(s.dedupe(project).groups).toHaveLength(1);
  expect(bytes(s)).toEqual(before);
  expect(s.dedupe(project, true).applied).toBe(2);
  expect(visible(s)).toEqual([ids[0]!]);
  prefix(s, before); rebuild(s);
  const done = bytes(s);
  expect(s.dedupe(project, true)).toMatchObject({ groups: [], applied: 0 });
  expect(bytes(s)).toEqual(done);
  s.forget(ids[0]!, "user", project);
  expect(visible(s)).toEqual([]);
  expect(s.list({ project, includeSuperseded: true })).toEqual([]);
  rebuild(s);
});

test("dedupe preserves an existing internal relation even when its source has the smallest id", () => {
  const { s, ids: [a, b, c] } = legacy();
  expect(s.supersede(a!, b!, "user", project)).toBe(true);
  expect(s.dedupe(project, true).applied).toBe(1);
  expect(visible(s)).toEqual([b!]);
  expect(s.get(a!)!.supersededBy).toBe(b!);
  expect(s.get(c!)!.supersededBy).toBe(b!);
  rebuild(s);
});

test("dedupe sends a single remaining head to the newest valid outside terminal, preserving both personal replacements", () => {
  const { s, ids: [a, b, c] } = legacy();
  const x = s.note(note("person replacement X")), y = s.note(note("person replacement Y"));
  expect(s.supersede(b!, x, "user", project)).toBe(true);
  expect(s.supersede(c!, y, "user", project)).toBe(true);
  expect(s.dedupe(project, true).applied).toBe(1);
  expect(s.get(a!)!.supersededBy).toBe(y);
  expect(s.get(b!)!.supersededBy).toBe(x);
  expect(s.get(c!)!.supersededBy).toBe(y);
  expect(visible(s)).toEqual([]);
  expect(s.list({ project }).map((v) => v.id).sort()).toEqual([x, y].sort());
  const done = bytes(s);
  expect(s.dedupe(project, true)).toMatchObject({ groups: [], applied: 0 });
  expect(bytes(s)).toEqual(done); rebuild(s);
});

test("a later personal replacement of a non-head redirects the last head on the next dedupe", () => {
  const { s, ids } = legacy();
  s.dedupe(project, true);
  const z = s.note(note("new intent Z"));
  expect(s.supersede(ids[1]!, z, "user", project)).toBe(true);
  expect(s.dedupe(project, true).applied).toBe(1);
  expect(s.get(ids[0]!)!.supersededBy).toBe(z);
  expect(visible(s)).toEqual([]);
  expect(s.dedupe(project, true)).toMatchObject({ groups: [], applied: 0 });
  rebuild(s);
});

test("a local outside terminal that cannot reach the synced heads is ignored", () => {
  const { s, ids: [a, b, c] } = legacy();
  // A local duplicate may be replaced locally; its terminal cannot replace the synced heads.
  const old = open();
  const local = old.importNote(note(undefined, { source: "claude-mem", tier: "short", about: ["path:local.ts"] }), at).id;
  // The historical import remains within the normal fourteen-day short-term lifetime.
  const localLines = readFileSync(join(old.dir, "local", `${old.machine.id}.jsonl`), "utf8");
  appendFileSync(join(s.dir, "local", `${s.machine.id}.jsonl`), localLines);
  s.refresh();
  if (!s.get(local)) throw new Error("local legacy fixture expired");
  const target = s.note(note("local replacement", { tier: "short" }));
  expect(s.supersede(local, target, "user", project)).toBe(true);
  expect(s.dedupe(project, true).applied).toBe(2);
  expect(visible(s)).toEqual([a!]);
  expect(s.get(b!)!.supersededBy).toBe(a!); expect(s.get(c!)!.supersededBy).toBe(a!);
  expect(s.get(local)!.supersededBy).toBe(target);
});

test("dedupe CLI is project scoped and supports a read-only JSON plan and explicit apply", async () => {
  const cwd = temp(), key = memoryProjectKey(cwd), s = open();
  for (const i of [0, 1]) {
    const old = open(); old.importNote(note(undefined, { project: key, source: "claude-mem", about: [`path:src/${i}.ts`] }), at);
    copyFileSync(segment(old), join(s.dir, "log", `${old.machine.id}.jsonl`));
  }
  s.refresh();
  const before = bytes(s);
  expect(JSON.parse(await memoryCommand(["dedupe", "--json"], cwd, { store: s })).groups).toHaveLength(1);
  expect(bytes(s)).toEqual(before);
  expect(JSON.parse(await memoryCommand(["dedupe", "--apply", "--json"], cwd, { store: s })).applied).toBe(1);
  expect(s.dedupe(project).groups).toEqual([]);
});
