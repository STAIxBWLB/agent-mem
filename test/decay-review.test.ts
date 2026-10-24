import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { applyDecay, decayPreview } from "../src/memory/decay-review.ts";
import type { Counter } from "../src/memory/candidates.ts";
import { realPath } from "../src/memory/platform.ts";
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-decay-"))), base = join(root, "memory"), project = "decay-project";
  let now = Date.parse("2026-01-01T00:00:00.000Z"); const clock = () => now;
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, now: clock, deferPromotions: true, screen: () => "promote" }); closes.push(() => store.close());
  const note = (extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "old public decision", about: [], ...extra });
  const bytes = () => readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => [join(row.parentPath, row.name), readFileSync(join(row.parentPath, row.name), "utf8")]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  return { store, project, note, clock, bytes, advance: (days: number) => { now += days * 86400_000; } };
}
test("decay preview keeps exact age/project/goal selection and authors no rows", () => {
  const f = fixture(), old = f.note(), foreign = f.note({ project: "other", scope: "shared" });
  const goal = f.store.goal({ project: f.project, scope: "project", title: "protected goal", milestones: [], dependsOn: [], actor: "person" });
  f.store.goalLink(goal, "project#1@1", "person");
  const task = f.note({ task: "project#1@1" }), about = f.note({ about: [`goal:${goal}`] }), viaTask = f.note({ about: ["task:project#1@1"] });
  f.advance(90); expect(decayPreview(f.store, f.project, { now: f.clock }).entries).toHaveLength(0); f.advance(1);
  const recent = f.note(), before = f.bytes(), plan = decayPreview(f.store, f.project, { now: f.clock });
  expect(plan.entries.map(row => row.target.id)).toEqual([old]); expect(f.bytes()).toEqual(before); expect(plan.citationHistory).toBe("unknown"); expect(plan.citedExemptions).toBeNull();
  for (const id of [foreign, task, about, viaTask, recent]) expect(plan.entries.some(row => row.target.id === id)).toBe(false);
  f.store.goalState(goal, "done", "person"); expect(decayPreview(f.store, f.project, { now: f.clock }).entries.map(row => row.target.id)).toEqual(expect.arrayContaining([old, task, about, viaTask]));
});
test("recent positive citations only exempt; unknown or zero observations never add an entry", () => {
  const f = fixture(), cited = f.note(), unknown = f.note({ text: "unknown citation history" }); f.advance(91); const recent = f.note();
  const counter = (entryId: string, count: number | null, at = new Date(f.clock()).toISOString()): Counter => ({ id: "counter", key: { entryId, project: f.project, deliveryId: "delivery" }, createdAt: at, rendered: null, delivered: null, cited: count });
  const counters = [counter(cited, 1), counter(unknown, null), counter(recent, 0)];
  const plan = decayPreview(f.store, f.project, { now: f.clock, counters: () => counters }); expect(plan.entries.map(row => row.target.id)).toEqual([unknown]); expect(plan.citedExemptions).toBe(1);
  expect(decayPreview(f.store, f.project, { now: f.clock, counters: () => { throw Error("unavailable"); } }).entries.map(row => row.target.id)).toEqual(expect.arrayContaining([cited, unknown]));
  expect(decayPreview(f.store, f.project, { now: f.clock, counters: () => [] }).entries.some(row => row.target.id === recent)).toBe(false);
});
test("default apply demotes only named previewed ids; bulk and forget require confirmation/person", () => {
  const f = fixture(), first = f.note({ text: "first" }), second = f.note({ text: "second" }); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }), before = f.bytes();
  expect(() => applyDecay(f.store, plan, { actor: "agent", confirmed: true })).toThrow("person");
  expect(() => applyDecay(f.store, plan, { actor: "person" })).toThrow("confirmation");
  expect(() => applyDecay(f.store, plan, { actor: "person", ids: [first], forget: true })).toThrow("confirmation"); expect(f.bytes()).toEqual(before);
  expect(applyDecay(f.store, plan, { actor: "person", ids: [first], now: f.clock })).toEqual({ action: "demote", ids: [first] });
  expect(f.store.get(first, f.project)?.tier).toBe("short"); expect(f.store.get(second, f.project)?.tier).toBe("long");
  const next = decayPreview(f.store, f.project, { now: f.clock }); expect(applyDecay(f.store, next, { actor: "person", confirmed: true, forget: true, now: f.clock }).ids).toEqual([second]); expect(f.store.get(second, f.project)).toBeUndefined();
});
test("a changed member refuses the entire selected batch before any earlier target effect", () => {
  const f = fixture(), first = f.note({ text: "first" }), second = f.note({ text: "second" }); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }); f.store.demote(second, "person", f.project); const before = f.bytes();
  expect(() => applyDecay(f.store, plan, { actor: "person", confirmed: true, now: f.clock })).toThrow(); expect(f.bytes()).toEqual(before); expect(f.store.get(first, f.project)?.tier).toBe("long");
});
test("new goal protection, citation or privacy denial after preview refuses without target writes", () => {
  for (const changed of ["goal", "citation", "policy"] as const) {
    const f = fixture(), goal = f.store.goal({ project: f.project, scope: "project", title: "goal", milestones: [], dependsOn: [], actor: "person" });
    f.store.goalState(goal, "done", "person"); const id = f.note({ about: [`goal:${goal}`] }); f.advance(91);
    const plan = decayPreview(f.store, f.project, { now: f.clock }); if (changed === "goal") f.store.goalState(goal, "active", "person");
    const before = f.bytes(), counters: Counter[] = changed === "citation" ? [{ id: "counter", key: { project: f.project, entryId: id, deliveryId: "new" }, createdAt: new Date(f.clock()).toISOString(), cited: 1, delivered: null, rendered: null }] : [];
    expect(() => applyDecay(f.store, plan, { actor: "person", confirmed: true, now: f.clock, counters: () => counters, screen: () => changed !== "policy" })).toThrow(); expect(f.bytes()).toEqual(before);
  }
});
