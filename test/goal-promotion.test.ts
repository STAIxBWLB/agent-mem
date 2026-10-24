import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, candidateInputId, candidateTargetRevision, type CandidateInput } from "../src/memory/candidates.ts";
import { GOAL_PROMOTION_LIMIT, offerGoalPromotions } from "../src/memory/goal-promotion.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "../src/memory/policy.ts";
import { MEMORY_SCHEMA, MemoryStore, entryId, openShardStore, type NoteEntry, type NoteInput, type PromotionScreen, type View } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(mode: "legacy" | "generation" | "shards" = "legacy", screen: PromotionScreen = () => "promote", deferPromotions = true) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-goal-promotion-"))), base = join(root, "memory"), project = "goal-project"; let now = Date.parse("2026-10-20T00:00:00.000Z");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  if (mode !== "legacy") { const seed = new MemoryStore({ memoryDir: base, deferPromotions: true }); seed.close();
    if (mode === "generation") await migrate({ memoryDir: base, generation: "d".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
    else await migrateShards({ memoryDir: base, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  }
  const store = mode === "shards" ? openShardStore({ memoryDir: base, project, now: () => now, screen, deferPromotions }) : new MemoryStore({ memoryDir: base, now: () => now, screen, deferPromotions }); cleanup.push(() => store.close());
  const candidates = new CandidateStore({ memoryDir: base, now: () => now }); cleanup.push(() => candidates.close());
  const note = (extra: Partial<NoteInput> = {}) => { now++; return store.note({ op: "note", project, scope: "project", tier: "short", kind: "contract", peer: "original-agent", source: "hub", text: "a linked public boundary", about: [], ...extra }); };
  const goal = (task = `${project}#1@100`) => { now++; const id = store.goal({ project, scope: "project", title: "public goal", milestones: [], dependsOn: [], actor: "person" }); now++; store.goalLink(id, task, "person"); now++; store.goalState(id, "done", "person"); return { id, task }; };
  const policy = (options: StandalonePolicyOptions = {}) => () => createStandalonePolicy(options);
  const offer = (id: string, options: StandalonePolicyOptions = {}) => offerGoalPromotions(store, candidates, project, id, { policy: policy(options) });
  const bytes = () => readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => [join(row.parentPath, row.name), readFileSync(join(row.parentPath, row.name), "utf8")]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  const accept = (id: string, actor: "person" | "agent" = "person", permitted = true) => candidates.accept(id, { project, actor, verdict: "public", store, policy: () => permitted });
  return { root, base, project, store, candidates, note, goal, offer, policy, bytes, accept, clock: () => now, tick: () => now++ };
}
function promotedId(view: View): string {
  const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: view.at, machine: view.machine, project: view.project, scope: view.scope, tier: "long", kind: view.kind, peer: view.peer, text: view.text, about: [...view.about], promotedFrom: view.id, source: view.source as NoteEntry["source"], ...(view.title ? { title: view.title } : {}), ...(view.task ? { task: view.task } : {}) };
  return entryId(body);
}
for (const mode of ["legacy", "generation", "shards"] as const) test(`goal ${mode} offer stays local; person acceptance uses canonical existing promotion identity`, async () => {
  const f = await fixture(mode), goal = f.goal(), target = f.note({ task: goal.task }), original = f.store.get(target, f.project)!, before = f.bytes();
  const report = await f.offer(goal.id); expect(report).toMatchObject({ offered: 1, alreadyOffered: 0, withheld: 0, truncated: false }); expect(f.bytes()).toEqual(before);
  const id = report.ids[0]!, candidate = f.candidates.get(id, f.project)!; expect(candidate.input).toEqual({ project: f.project, kind: "promotion", goalId: goal.id, target: { id: target, revision: candidateTargetRevision(original) } });
  expect(() => f.accept(id, "agent")).toThrow("person"); expect(f.bytes()).toEqual(before);
  const accepted = f.accept(id), expected = promotedId(original); expect(accepted.noteId).toBe(expected);
  expect(f.store.get(expected, f.project)).toMatchObject({ id: expected, tier: "long", at: original.at, machine: original.machine, peer: original.peer, source: original.source, text: original.text, promotedFrom: target });
  expect(f.store.get(expected, f.project)?.text).not.toContain("Accepted candidate:");
  const authored = f.bytes(); const get = f.store.get.bind(f.store); f.store.get = () => { throw Error("accepted replay must not resolve a stale target"); };
  try { expect(f.accept(id)).toEqual({ ...accepted, alreadyAccepted: true }); } finally { f.store.get = get; }
  expect(f.bytes()).toEqual(authored);
});
test("goal offers task, about-task and about-goal shorts, excluding unlinked, long and foreign-local entries", async () => {
  const f = await fixture(), goal = f.goal();
  const task = f.note({ task: goal.task }), aboutTask = f.note({ text: "via task", about: [`task:${goal.task}`] }), aboutGoal = f.note({ text: "via goal", about: [`goal:${goal.id}`] });
  f.note({ text: "unlinked" }); f.note({ text: "long linked", task: goal.task, tier: "long" }); f.note({ text: "foreign local", task: goal.task, project: "foreign-project" });
  const report = await f.offer(goal.id), ids = report.ids.map(id => (f.candidates.get(id, f.project)!.input as Extract<CandidateInput, { kind: "promotion" }>).target.id);
  expect(ids.sort()).toEqual([task, aboutTask, aboutGoal].sort());
});
test("exact proposal identity handles existing rejected/pending candidates without resurrecting them", async () => {
  const f = await fixture(), goal = f.goal(); f.note({ task: goal.task });
  const first = await f.offer(goal.id), id = first.ids[0]!; f.candidates.reject(id, { project: f.project, actor: "person", verdict: "public" });
  const get = f.candidates.list.bind(f.candidates); f.candidates.list = () => { throw Error("offering must not depend on capped/status-filtered candidate lists"); };
  try { expect(await f.offer(goal.id)).toMatchObject({ ids: [], offered: 0, alreadyOffered: 1 }); } finally { f.candidates.list = get; }
  expect(f.candidates.get(id, f.project)?.status).toBe("rejected");
});
test("private goal/target and current policy tightening withhold offers without curated mutation", async () => {
  const f = await fixture(), goal = f.goal(), target = f.note({ task: goal.task }), before = f.bytes(); let deny = false;
  const policy = () => createStandalonePolicy({ piiPatterns: deny ? ["linked public"] : [], host: { screen: async value => { if ((value as { kind?: string }).kind === "promotion") { await Promise.resolve(); deny = true; } return true; } } });
  expect(await offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy })).toMatchObject({ ids: [], offered: 0, withheld: 1 }); expect(f.bytes()).toEqual(before); expect(f.store.get(target, f.project)?.tier).toBe("short");
  expect(await f.offer(goal.id, { piiPatterns: ["public goal"] })).toMatchObject({ ids: [], offered: 0, withheld: 1 });
});
test("goal and target changes after awaited screening refuse before candidate put", async () => {
  for (const changed of ["target", "goal", "binding"] as const) {
    const f = await fixture(), goal = f.goal(), target = f.note({ task: goal.task }); let drifted = false;
    const policy = () => createStandalonePolicy({ host: { screen: async value => { if ((value as { kind?: string }).kind === "promotion") { await Promise.resolve(); drifted = true; if (changed === "target") f.store.forget(target, "person", f.project); if (changed === "goal") { f.tick(); f.store.goalState(goal.id, "active", "person"); } } return true; } } });
    const run = offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy, assertCurrent: () => { if (changed === "binding" && drifted) throw Error("binding moved"); } });
    if (changed === "target") expect(await run).toMatchObject({ ids: [], withheld: 1 }); else await expect(run).rejects.toThrow();
    expect(f.candidates.list({ project: f.project, kind: "promotion" })).toEqual([]);
  }
});
test("promotion acceptance rejects stale revisions, reopened goals and denied policy while staying pending", async () => {
  for (const changed of ["revision", "goal", "policy"] as const) {
    const f = await fixture(), goal = f.goal(), target = f.note({ task: goal.task }), id = (await f.offer(goal.id)).ids[0]!;
    if (changed === "revision") f.store.forget(target, "person", f.project);
    if (changed === "goal") { f.tick(); f.store.goalState(goal.id, "active", "person"); }
    const before = f.bytes(); expect(() => f.accept(id, "person", changed !== "policy")).toThrow(); expect(f.bytes()).toEqual(before); expect(f.candidates.get(id, f.project)?.status).toBe("pending");
  }
});
test("ordinary unsupported/declined promote result stays pending and can be accepted after policy permits", async () => {
  let permit = false; const f = await fixture("legacy", () => permit ? "promote" : "skip"), goal = f.goal(), target = f.note({ task: goal.task }), id = (await f.offer(goal.id)).ids[0]!, before = f.bytes(), expected = promotedId(f.store.get(target, f.project)!);
  expect(() => f.accept(id)).toThrow("remains pending"); expect(f.candidates.get(id, f.project)?.status).toBe("pending"); expect(f.bytes()).toEqual(before);
  permit = true; expect(f.accept(id).noteId).toBe(expected);
});
test("a thrown promotion after append remains accepting and never automatically replays", async () => {
  const f = await fixture(), goal = f.goal(); f.note({ task: goal.task }); const id = (await f.offer(goal.id)).ids[0]!, promote = f.store.promote.bind(f.store); let calls = 0;
  f.store.promote = (...args) => { calls++; promote(...args); throw Error("fixture append interrupted"); };
  expect(() => f.accept(id)).toThrow("interrupted"); expect(f.candidates.get(id, f.project)?.status).toBe("accepting"); const before = f.bytes();
  expect(() => f.accept(id)).toThrow("interrupted"); expect(calls).toBe(1); expect(f.bytes()).toEqual(before); f.store.promote = promote;
});
test("shared-source goal-linked promotion preserves foreign source reach", async () => {
  const f = await fixture("shards"), goal = f.goal(), target = f.note({ project: "foreign-source", scope: "shared", task: goal.task }), original = f.store.get(target, f.project)!;
  const offered = await f.offer(goal.id); expect(offered.offered).toBe(1); const accepted = f.accept(offered.ids[0]!);
  expect(f.store.get(accepted.noteId, f.project)).toMatchObject({ project: "foreign-source", scope: "shared", peer: original.peer, source: original.source, tier: "long" });
});
test("goal offer limit is explicit and proposal identity lookup is independent of listing caps", async () => {
  const f = await fixture(), goal = f.goal(); for (let i = 0; i < 3; i++) f.note({ text: `linked ${i}`, task: goal.task });
  expect(await offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy: f.policy(), limit: 2 })).toMatchObject({ offered: 2, truncated: true });
  expect(() => candidateInputId({ project: f.project, kind: "promotion", goalId: "bad", target: { id: "a".repeat(32), revision: "b".repeat(64) } })).toThrow();
  await expect(offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy: f.policy(), limit: GOAL_PROMOTION_LIMIT + 1 })).rejects.toThrow();
});
test("a reconciled alias handle promotes the raw source canonically while proposals use the canonical project", async () => {
  const f = await fixture(), goal = f.goal(), target = f.note({ task: goal.task }), original = f.store.get(target, f.project)!, canonical = "canonical-project";
  const store = new MemoryStore({ memoryDir: f.base, now: f.clock, deferPromotions: true, screen: () => "promote", reconcile: { canonical, aliases: [f.project] } }); cleanup.push(() => store.close());
  const candidates = new CandidateStore({ memoryDir: f.base, now: f.clock, reconcile: { canonical, aliases: [f.project] } }); cleanup.push(() => candidates.close());
  const offered = await offerGoalPromotions(store, candidates, canonical, goal.id, { policy: f.policy() }); expect(offered.offered).toBe(1);
  expect(candidates.get(offered.ids[0]!, canonical)?.input.project).toBe(canonical);
  const result = candidates.accept(offered.ids[0]!, { project: canonical, actor: "person", verdict: "public", store, policy: () => true });
  expect(result.noteId).toBe(promotedId(original)); expect(f.store.get(result.noteId, f.project)?.project).toBe(f.project);
});
test("offer reads defer an otherwise automatic held-note promotion", async () => {
  let permit = false; const f = await fixture("legacy", () => permit ? "promote" : "skip", false), goal = f.goal(), target = f.note({ task: goal.task });
  f.tick(); expect(f.store.settle(goal.task, "person")).toBe(0);
  const held = f.store.withDeferredPromotions(() => f.store.get(target, f.project)!); expect(held).toMatchObject({ tier: "short", expiresAt: null });
  permit = true; const before = f.bytes(); expect((await f.offer(goal.id)).offered).toBe(1); expect(f.bytes()).toEqual(before); expect(f.store.withDeferredPromotions(() => f.store.get(target, f.project)?.tier)).toBe("short");
});
test("repeated bounded offers advance past known proposals to the rest of the linked notes", async () => {
  const f = await fixture(), goal = f.goal(), targets = Array.from({ length: 5 }, (_, i) => f.note({ text: `progress linked ${i}`, task: goal.task })), before = f.bytes();
  const batches = [];
  for (const count of [2, 2, 1]) {
    const result = await offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy: f.policy(), limit: 2 });
    expect(result.offered).toBe(count); expect(result.ids).toHaveLength(count); batches.push(result);
  }
  expect(batches.map(row => row.alreadyOffered)).toEqual([0, 2, 4]); expect(batches.map(row => row.truncated)).toEqual([true, true, false]);
  const ids = batches.flatMap(row => row.ids); expect(new Set(ids).size).toBe(5);
  expect(ids.map(id => (f.candidates.get(id, f.project)!.input as Extract<CandidateInput, { kind: "promotion" }>).target.id).sort()).toEqual(targets.sort());
  expect(await offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy: f.policy(), limit: 2 })).toMatchObject({ ids: [], offered: 0, alreadyOffered: 5, truncated: false }); expect(f.bytes()).toEqual(before);
});
test("promotion acceptance receives current goal metadata so newly private goal policy refuses before effects", async () => {
  const f = await fixture(), goal = f.goal(), target = f.note({ task: goal.task }), id = (await f.offer(goal.id)).ids[0]!, before = f.bytes(); let checked = false;
  const tightened = createStandalonePolicy({ piiPatterns: ["public goal"] });
  expect(() => f.candidates.accept(id, { project: f.project, actor: "person", verdict: "public", store: f.store, policy: (_candidate, currentTarget, _note, currentGoal) => {
    checked = true; expect(currentTarget?.id).toBe(target); expect(currentGoal).toMatchObject({ id: goal.id, title: "public goal", state: "done" });
    return tightened.screenStandalone(currentGoal);
  } })).toThrow("policy");
  expect(checked).toBe(true); expect(f.bytes()).toEqual(before); expect(f.candidates.get(id, f.project)?.status).toBe("pending"); expect(f.store.get(target, f.project)?.tier).toBe("short");
});

test("a previously opened generation cannot offer after its selector changed before invocation", async () => {
  const f = await fixture("generation"), goal = f.goal(); f.note({ task: goal.task });
  await migrate({ memoryDir: f.base, mode: "deactivate", authorizedPerson: true, tty: true });
  const before = f.bytes(); let screens = 0;
  await expect(offerGoalPromotions(f.store, f.candidates, f.project, goal.id, { policy: () => { screens++; return createStandalonePolicy(); } })).rejects.toThrow("selector changed");
  expect(screens).toBe(0); expect(f.candidates.list({ project: f.project })).toEqual([]); expect(f.bytes()).toEqual(before);
});
