import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { applyDecay, decayPreview, DecayApplyError } from "../src/memory/decay-review.ts";
import type { Counter } from "../src/memory/candidates.ts";
import { realPath } from "../src/memory/platform.ts";
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
function fixture(ttlMs?: number) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-decay-"))), base = join(root, "memory"), project = "decay-project";
  let now = Date.parse("2026-01-01T00:00:00.000Z"); const clock = () => now;
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, now: clock, ...(ttlMs === undefined ? {} : { ttlMs }), deferPromotions: true, screen: () => "promote" }); closes.push(() => store.close());
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
test("person and agent actors apply only named previewed ids; bulk and forget require confirmation", () => {
  const f = fixture(), first = f.note({ text: "first" }), second = f.note({ text: "second" }), third = f.note({ text: "third" }); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }), before = f.bytes();
  expect(() => applyDecay(f.store, plan, { actor: "invalid" as "person", confirmed: true })).toThrow("valid actor");
  expect(() => applyDecay(f.store, plan, { actor: "agent" })).toThrow("confirmation");
  expect(() => applyDecay(f.store, plan, { actor: "person", ids: [first], forget: true })).toThrow("confirmation"); expect(f.bytes()).toEqual(before);
  expect(applyDecay(f.store, plan, { actor: "agent", ids: [first], now: f.clock })).toEqual({ action: "demote", ids: [first], expiresAt: plan.demoteExpiresAt });
  expect(f.store.get(first, f.project)?.tier).toBe("short"); expect(f.store.get(second, f.project)?.tier).toBe("long"); expect(f.store.get(third, f.project)?.tier).toBe("long");
  const demote = f.bytes().flatMap(([, content]) => content.split("\n").filter(Boolean).map(line => JSON.parse(line) as { op?: string; target?: string; actor?: string }))
    .find(entry => entry.op === "demote" && entry.target === first);
  expect(demote?.actor).toBe("agent");
  const next = decayPreview(f.store, f.project, { now: f.clock }); expect(applyDecay(f.store, next, { actor: "person", ids: [second], now: f.clock }).ids).toEqual([second]);
  const final = decayPreview(f.store, f.project, { now: f.clock }); expect(applyDecay(f.store, final, { actor: "agent", ids: [third], forget: true, confirmed: true, now: f.clock }).ids).toEqual([third]);
  expect(f.store.get(second, f.project)?.tier).toBe("short"); expect(f.store.get(third, f.project)).toBeUndefined();
  const ops = f.bytes().flatMap(([, content]) => content.split("\n").filter(Boolean).map(line => JSON.parse(line) as { op?: string; target?: string; actor?: string }));
  expect(ops.find(entry => entry.op === "demote" && entry.target === second)?.actor).toBe("person");
  expect(ops.find(entry => entry.op === "forget" && entry.target === third)?.actor).toBe("agent");
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

test("retained positive citations exempt old deliveries even with a shorter decay age", () => {
  const f = fixture(), id = f.note(); f.advance(60);
  const counters: Counter[] = [{ id: "old-delivery", key: { project: f.project, entryId: id, deliveryId: "old" }, createdAt: new Date(f.clock() - 59 * 86400_000).toISOString(), rendered: 1, delivered: 1, cited: 1 }];
  expect(decayPreview(f.store, f.project, { now: f.clock, days: 5, counters: () => counters })).toMatchObject({ entries: [], citedExemptions: 1, citationHistory: "unknown" });
  counters[0]!.cited = 0; expect(decayPreview(f.store, f.project, { now: f.clock, days: 5, counters: () => counters }).entries.map(row => row.target.id)).toEqual([id]);
});
test("an I/O failure reports completed, uncertain failed and untouched remaining ids", () => {
  const f = fixture(); for (let n = 0; n < 3; n++) f.note({ text: `partial target ${n}` }); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }), ids = plan.entries.map(row => row.target.id), demote = f.store.demote.bind(f.store); let calls = 0;
  f.store.demote = (...args) => { if (++calls === 2) throw Error("EIO simulated"); return demote(...args); };
  let failure: unknown; try { applyDecay(f.store, plan, { actor: "person", confirmed: true, now: f.clock }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DecayApplyError);
  expect(failure).toMatchObject({ applied: [ids[0]!], failed: ids[1]!, remaining: [ids[2]!] });
  expect((failure as DecayApplyError).report).toEqual({ action: "demote", applied: [ids[0]!], failed: ids[1]!, remaining: [ids[2]!], expiresAt: plan.demoteExpiresAt });
  expect(f.store.get(ids[0]!, f.project)).toMatchObject({ tier: "short", expiresAt: plan.demoteExpiresAt });
  expect(f.store.get(ids[1]!, f.project)?.tier).toBe("long"); expect(f.store.get(ids[2]!, f.project)?.tier).toBe("long"); expect(calls).toBe(2);
});
test("expired displayed demotion deadline refuses the entire batch before effects", () => {
  const f = fixture(), id = f.note(); f.advance(91); const plan = decayPreview(f.store, f.project, { now: f.clock }); f.advance(15); const before = f.bytes();
  expect(() => applyDecay(f.store, plan, { actor: "person", confirmed: true, now: f.clock })).toThrow("expiry is spent"); expect(f.bytes()).toEqual(before); expect(f.store.get(id, f.project)?.tier).toBe("long");
});

test("the failed target is reported as uncertain even when its append preceded the exception", () => {
  const f = fixture(); for (let n = 0; n < 3; n++) f.note({ text: `uncertain target ${n}` }); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }), ids = plan.entries.map(row => row.target.id), demote = f.store.demote.bind(f.store); let calls = 0;
  f.store.demote = (...args) => { const result = demote(...args); if (++calls === 2) throw Error("EIO after append"); return result; };
  let failure: unknown; try { applyDecay(f.store, plan, { actor: "person", confirmed: true, now: f.clock }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ applied: [ids[0]!], failed: ids[1]!, remaining: [ids[2]!] });
  expect((failure as DecayApplyError).render()).toContain("failed target may have changed");
  (failure as DecayApplyError).jsonOutput = true; expect(JSON.parse((failure as DecayApplyError).render()).failedMayHaveChanged).toBe(true);
  expect(f.store.get(ids[1]!, f.project)?.tier).toBe("short"); expect(f.store.get(ids[2]!, f.project)?.tier).toBe("long"); expect(calls).toBe(2);
});

test("forget preflights every expansion and refuses a protected hidden import copy before any prefix effect", () => {
  const f = fixture(), prefix = f.note({ text: "unrelated prefix stays long" }), at = new Date(f.clock()).toISOString();
  const first = f.store.importNote({ op: "note", project: f.project, scope: "project", tier: "long", kind: "contract", peer: "original", source: "claude-mem", text: "same imported tuple", task: "import-task-0", about: ["path:copy0.ts"] }, at).id;
  const other = new MemoryStore({ memoryDir: join(f.store.profile.home, "separate-import-fixture"), now: f.clock, deferPromotions: true });
  let second: string;
  try {
    second = other.importNote({ op: "note", project: f.project, scope: "project", tier: "long", kind: "contract", peer: "original", source: "claude-mem", text: "same imported tuple", task: "import-task-1", about: ["path:copy1.ts"] }, at).id;
    copyFileSync(join(other.dir, "log", `${other.machine.id}.jsonl`), join(f.store.dir, "log", `${other.machine.id}.jsonl`));
  } finally { other.close(); }
  f.store.refresh(); expect(f.store.dedupe(f.project, true).applied).toBe(1);
  const [visible, hidden] = [first, second!].sort();
  const goal = f.store.goal({ project: f.project, scope: "project", title: "protected imported copy", milestones: [], dependsOn: [], actor: "person" });
  f.store.goalLink(goal, hidden === first ? "import-task-0" : "import-task-1", "person"); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }); expect(plan.entries.map(row => row.target.id).sort()).toEqual([prefix, visible!].sort());
  const before = f.bytes(); let refusal: unknown;
  try { applyDecay(f.store, plan, { actor: "person", confirmed: true, forget: true, ids: [prefix, visible!], now: f.clock }); } catch (error) { refusal = error; }
  expect(f.bytes()).toEqual(before); expect(f.store.get(prefix, f.project)?.tier).toBe("long");
  expect(refusal).toBeInstanceOf(Error); expect((refusal as Error).message).toContain("expands beyond reviewed exact entries");
  expect(f.store.list({ project: f.project, includeSuperseded: true }).map(row => row.id)).toEqual(expect.arrayContaining([visible!, hidden!]));
  expect(() => f.store.forget(visible!, "person", f.project, true)).toThrow("expands beyond"); expect(f.bytes()).toEqual(before);
  // Existing direct person forget remains a group operation after its separate review.
  f.store.forget(visible!, "person", f.project); expect(f.store.list({ project: f.project, includeSuperseded: true }).map(row => row.id)).not.toContain(hidden!);
});

test("explicit demotion expiry is canonical future UTC and never exceeds configured TTL plus one hour", () => {
  for (const ttlMs of [undefined, 2 * 86400_000]) {
    const f = fixture(ttlMs), id = f.note(), deadline = f.store.shortExpiry(), upper = Date.parse(deadline) + 3600_000, before = f.bytes();
    for (const expiry of [new Date(f.clock()).toISOString(), new Date(f.clock() - 1).toISOString(), new Date(upper + 1).toISOString(), "not-a-date", deadline.replace("Z", "+00:00")]) {
      expect(() => f.store.demote(id, "person", f.project, expiry)).toThrow("expiry"); expect(f.bytes()).toEqual(before);
    }
    const allowed = new Date(upper).toISOString(); f.store.demote(id, "person", f.project, allowed); expect(f.store.get(id, f.project)?.expiresAt).toBe(allowed);
  }
});
test("an overlong displayed expiry refuses the entire decay batch before any demote attempt", () => {
  const f = fixture(); f.note({ text: "expiry prefix one" }); f.note({ text: "expiry prefix two" }); f.advance(91);
  const plan = decayPreview(f.store, f.project, { now: f.clock }), before = f.bytes(), demote = f.store.demote.bind(f.store); let calls = 0;
  f.store.demote = (...args) => { calls++; return demote(...args); };
  const forged = { ...plan, demoteExpiresAt: new Date(Date.parse(plan.demoteExpiresAt) + 3600_001).toISOString() };
  let refusal: unknown; try { applyDecay(f.store, forged, { actor: "person", confirmed: true, now: f.clock }); } catch (error) { refusal = error; }
  expect(calls).toBe(0); expect(f.bytes()).toEqual(before); expect(refusal).toBeInstanceOf(Error); expect((refusal as Error).message).toContain("expiry");
});
