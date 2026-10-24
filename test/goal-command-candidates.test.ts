import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawGoalCommand, type GoalCommandOptions } from "../src/memory/commands.ts";
import { offerGoalPromotions, type GoalPromotionReport } from "../src/memory/goal-promotion.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { MemoryStore, type Entry } from "../src/memory/store.ts";
import { createStandalonePolicy } from "../src/memory/policy.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "amem-goal-command-"))), base = join(cwd, "memory"), project = "goal-command-project"; let now = Date.parse("2026-10-20T00:00:00.000Z"), closed = false, closes = 0, opens = 0;
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: base, now: () => now, deferPromotions: true, screen: () => "promote" }), close = store.close.bind(store);
  store.close = () => { closes++; closed = true; close(); }; cleanup.push(() => { if (!closed) close(); });
  const candidates = new CandidateStore({ memoryDir: base, now: () => now }); cleanup.push(() => candidates.close());
  const goal = store.goal({ project, scope: "project", title: "public goal", milestones: [], dependsOn: [], actor: "person" });
  now++; const task = `${project}#1@100`; store.goalLink(goal, task, "person"); now++;
  const note = store.note({ op: "note", project, scope: "project", tier: "short", kind: "contract", peer: "original-agent", source: "person", text: "linked short boundary", task, about: [] });
  const options: GoalCommandOptions = { store, project, open: () => { opens++; return store; }, clean: () => true };
  const authored = () => ["log", "local"].flatMap(dir => readdirSync(join(store.dir, dir)).sort().flatMap(name => readFileSync(join(store.dir, dir, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry)));
  const onDone: NonNullable<GoalCommandOptions["onDone"]> = async (fresh, source) => { expect(fresh).toMatchObject({ id: goal, state: "done" }); expect(source.goalOf(goal, project)?.state).toBe("done"); return offerGoalPromotions(source, candidates, project, fresh.id, { policy: () => createStandalonePolicy() }); };
  return { cwd, base, project, store, candidates, goal, note, options, authored, onDone, tick: () => now++, closes: () => closes, opens: () => opens };
}
for (const command of ["done", "state"] as const) test(`${command} done saves state then offers only pending promotion candidates through the optional host callback`, async () => {
  const f = fixture(), before = f.authored().filter(row => row.op === "note"); f.tick();
  const args = command === "done" ? ["done", f.goal, "--json"] : ["state", `goal:${f.goal}`, "done", "--json"];
  const output = JSON.parse(await rawGoalCommand(args, f.cwd, { ...f.options, onDone: f.onDone }));
  expect(output).toMatchObject({ goalId: f.goal, state: "done", promotion: { offered: 1, alreadyOffered: 0, withheld: 0, truncated: false } }); expect(output.promotion.ids).toHaveLength(1);
  expect(f.candidates.get(output.promotion.ids[0], f.project)).toMatchObject({ status: "pending", acceptedNoteId: null, input: { kind: "promotion", goalId: f.goal, target: { id: f.note } } });
  expect(f.authored().filter(row => row.op === "note")).toEqual(before); expect(f.store.get(f.note, f.project)?.tier).toBe("short"); expect(f.store.goalOf(f.goal, f.project)?.state).toBe("done"); expect(f.closes()).toBe(0); expect(f.opens()).toBe(0);
});
test("without a done callback legacy outputs remain byte-identical even with json/custom host names", async () => {
  const f = fixture(), options = { ...f.options, names: { memory: "custom memory", goal: "custom goal" } };
  expect(await rawGoalCommand(["done", f.goal], f.cwd, options)).toBe(`long-term task ${f.goal.slice(0, 8)} is done`); f.tick();
  expect(await rawGoalCommand(["state", f.goal, "done", "--json"], f.cwd, options)).toBe(`long-term task ${f.goal.slice(0, 8)} is done`);
  expect(await rawGoalCommand(["list"], f.cwd, options)).toBe(`no open long-term tasks for ${f.project} (custom goal new <title>)`);
  await expect(rawGoalCommand(["state"], f.cwd, options)).rejects.toThrow("usage: custom goal"); expect(f.candidates.list({ project: f.project })).toEqual([]); expect(f.closes()).toBe(0);
});
test("only done invokes the callback and text counts include truncation without baked host commands", async () => {
  const f = fixture(); let callbacks = 0;
  const report: GoalPromotionReport = { ids: [], offered: 2, alreadyOffered: 1, withheld: 3, truncated: true }, options = { ...f.options, names: { memory: "custom memory", goal: "custom goal" }, onDone: async () => { callbacks++; return report; } };
  f.tick(); expect(await rawGoalCommand(["state", f.goal, "active"], f.cwd, options)).toBe(`long-term task ${f.goal.slice(0, 8)} is active`); expect(callbacks).toBe(0);
  f.tick(); const text = await rawGoalCommand(["done", f.goal], f.cwd, options);
  expect(callbacks).toBe(1); expect(text).toContain("2 offered, 1 already offered, 3 withheld"); expect(text).toContain("truncated"); expect(text).not.toMatch(/\bahub\b|\bamem\b/);
});
test("owned store remains open throughout the awaited callback and closes exactly once afterward", async () => {
  const f = fixture(), entered = deferred(), release = deferred(), { store: _borrowed, ...owned } = f.options;
  const pending = rawGoalCommand(["done", f.goal, "--json"], f.cwd, { ...owned, onDone: async (goal, store) => { expect(store).toBe(f.store); expect(f.closes()).toBe(0); entered.resolve(); await release.promise; expect(store.goalOf(goal.id, f.project)?.state).toBe("done"); return f.onDone(goal, store); } });
  await entered.promise; expect(f.opens()).toBe(1); expect(f.closes()).toBe(0); release.resolve(); expect(JSON.parse(await pending).promotion.offered).toBe(1); expect(f.closes()).toBe(1);
});
test("a failed offer leaves the saved goal done and retry reuses its already-created candidate identity", async () => {
  const f = fixture(); let offered: string[] = []; const before = f.authored().filter(row => row.op === "note");
  await expect(rawGoalCommand(["done", f.goal], f.cwd, { ...f.options, onDone: async (goal, store) => { offered = (await f.onDone(goal, store)).ids; throw Error("fixture lost offer response"); } })).rejects.toThrow("lost offer response");
  expect(f.store.goalOf(f.goal, f.project)?.state).toBe("done"); expect(offered).toHaveLength(1); f.tick();
  const retry = JSON.parse(await rawGoalCommand(["done", f.goal, "--json"], f.cwd, { ...f.options, onDone: f.onDone }));
  expect(retry.promotion).toMatchObject({ ids: [], offered: 0, alreadyOffered: 1 }); expect(f.candidates.list({ project: f.project })).toHaveLength(1); expect(f.candidates.get(offered[0]!, f.project)?.status).toBe("pending"); expect(f.authored().filter(row => row.op === "note")).toEqual(before); expect(f.closes()).toBe(0);
});
test("owned store closes after a rejected callback while preserving the authored done state", async () => {
  const f = fixture(), { store: _borrowed, ...owned } = f.options;
  await expect(rawGoalCommand(["done", f.goal], f.cwd, { ...owned, onDone: async (_goal, store) => { expect(store.goalOf(f.goal, f.project)?.state).toBe("done"); throw Error("fixture offer refused"); } })).rejects.toThrow("offer refused");
  expect(f.opens()).toBe(1); expect(f.closes()).toBe(1); expect(f.authored().some(row => row.op === "goal_state" && row.target === f.goal && row.by === "done")).toBe(true);
});
