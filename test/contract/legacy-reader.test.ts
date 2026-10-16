import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore as LegacyMemoryStore } from "@staix/agent-mem-v1";
import { MemoryStore, entryId, type Entry, type Graph, type View } from "../../src/memory/store.ts";
import { V1_OPS } from "../../src/memory/ops-contract.ts";

const NOW = Date.parse("2030-01-01T00:00:00.000Z"), at = new Date(NOW).toISOString();
const project = "agent-hub";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() {
  const dir = mkdtempSync(join(tmpdir(), "amem-legacy-contract-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function current(dir: string) {
  const store = new MemoryStore({ home: dir, now: () => NOW, deferPromotions: true });
  cleanup.push(() => store.close()); return store;
}
function legacy(dir: string) {
  const store = new LegacyMemoryStore({ home: dir, now: () => NOW });
  cleanup.push(() => store.close()); return store;
}
function logs(dir: string): Record<string, string> {
  return Object.fromEntries(["log", "local"].flatMap(tier => {
    const segmentDir = join(dir, "memory", tier);
    mkdirSync(segmentDir, { recursive: true });
    return readdirSync(segmentDir).sort().filter(name => name.endsWith(".jsonl")).map(name => [`${tier}/${name}`, readFileSync(join(segmentDir, name), "utf8")]);
  }));
}
function note(store: MemoryStore | LegacyMemoryStore, text: string): View {
  const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: ["path:src/public.ts"] });
  // Independently construct the expected v1 public view; neither reader supplies the oracle.
  return { id, at, machine: store.machine.id, project, scope: "project", tier: "long", kind: "contract", peer: "person", title: null, source: "person", text, about: ["path:src/public.ts"], task: null, supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false };
}
const sorted = (rows: View[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
function childRead(dir: string): View[] {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./legacy-reader.ts", import.meta.url)), dir], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as View[];
}
function expectOnlyV1Notes(dir: string, expectedCount: number): void {
  const rows = Object.values(logs(dir)).flatMap(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { schema: string; op: string }));
  expect(rows).toHaveLength(expectedCount);
  expect(rows.every(row => row.schema === "agent-hub.memory/v1" && row.op === "note")).toBe(true);
}

test("C1 a read-only published v1 reader never announces itself before new writes", () => {
  const dir = home(), reader = legacy(dir);
  const before = logs(dir);
  expect(reader.list({ project })).toEqual([]);
  expect(logs(dir)).toEqual(before);
  const writer = current(dir), expected = note(writer, "new writer ordinary v1 contract");
  const authored = logs(dir);
  expect(reader.list({ project })).toEqual([expected]);
  expect(logs(dir)).toEqual(authored);
  expectOnlyV1Notes(dir, 1);
});

test("C1 old and new stores share one machine segment with the same v1 projection", () => {
  const dir = home(), old = legacy(dir), next = current(dir);
  const first = note(old, "legacy writer contract"), second = note(next, "current writer contract");
  expect(old.machine.id).toBe(next.machine.id);
  const authored = logs(dir), expected = sorted([first, second]);
  expect(sorted(old.list({ project }))).toEqual(expected);
  expect(sorted(next.list({ project }))).toEqual(expected);
  expect(logs(dir)).toEqual(authored);
  expect(Object.keys(authored).filter(path => path.startsWith("log/"))).toEqual([`log/${old.machine.id}.jsonl`]);
  expectOnlyV1Notes(dir, 2);
});

test("C1 an offline machine can launch a real old reader later without an announcement", () => {
  const online = home(), offline = home(), writer = current(online);
  const first = note(writer, "contract available before offline reader returns");
  const second = note(writer, "contract added while the other machine is offline");
  const sourceBytes = logs(online);
  // Simulate receiving only authored sync segments, never copying a derived index or machine identity.
  for (const [path, bytes] of Object.entries(sourceBytes).filter(([path]) => path.startsWith("log/"))) {
    mkdirSync(join(offline, "memory", "log"), { recursive: true });
    writeFileSync(join(offline, "memory", path), bytes);
  }
  const received = logs(offline);
  expect(childRead(offline)).toEqual(sorted([first, second]));
  expect(logs(offline)).toEqual(received);
  expect(logs(online)).toEqual(sourceBytes);
  expectOnlyV1Notes(offline, 2);
});

test("C1 an old reader launched after a writer compatibility check still sees all ordinary v1 truth", () => {
  const dir = home(), writer = current(dir);
  const first = note(writer, "first compatible contract");
  // The check cannot discover future reader processes; v1-only appends are the invariant.
  expect(writer.list({ project })).toEqual([first]);
  const second = note(writer, "contract after the check and before old reader launch");
  const authored = logs(dir);
  expect(childRead(dir)).toEqual(sorted([first, second]));
  expect(logs(dir)).toEqual(authored);
  expectOnlyV1Notes(dir, 2);
});

test("C1 the actual writer refuses reserved truth-changing and unknown ops before either append path writes", () => {
  const dir = home(), writer = current(dir);
  const expected = note(writer, "ordinary v1 truth survives refused future writes");
  const before = logs(dir);
  // Probe actual runtime entry points: TypeScript's union cannot protect a JavaScript caller.
  const runtime = writer as unknown as {
    appendBody(body: Record<string, unknown>, local: boolean): string;
    importNote(input: Record<string, unknown>, at: string): { id: string; added: boolean };
  };
  for (const op of ["prune", "correct", "lift", "consolidate", "group", "unknown_future_op"]) {
    for (const local of [false, true]) {
      expect(() => runtime.appendBody({ schema: "agent-hub.memory/v1", op, at, machine: writer.machine.id, target: expected.id, actor: "person" }, local)).toThrow();
      expect(logs(dir)).toEqual(before);
    }
    expect(() => runtime.importNote({ op, project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "claude-mem", text: `refused ${op}`, about: [] }, at)).toThrow();
    expect(logs(dir)).toEqual(before);
  }
  expect(writer.list({ project })).toEqual([expected]);
  expect(legacy(dir).list({ project })).toEqual([expected]);
  expect(logs(dir)).toEqual(before);
  expectOnlyV1Notes(dir, 1);
});


test("C1 all 13 real v1 writers preserve authored payloads, placement and the published legacy projection", () => {
  const dir = home(), oldHome = home(), ttl = 86_400_000;
  let now = NOW;
  const writer = new MemoryStore({ home: dir, now: () => now, ttlMs: ttl, deferPromotions: true });
  cleanup.push(() => writer.close());
  const noteIds: string[] = [], goalIds: string[] = [], seen = new Set<string>();
  const graphProjection = (graph: Graph) => ({ nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...graph.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  function parity(): void {
    const authored = logs(dir);
    // Transfer only bytes emitted by real writers, never an index or a golden fixture.
    for (const [path, bytes] of Object.entries(authored)) {
      mkdirSync(join(oldHome, "memory", path.startsWith("log/") ? "log" : "local"), { recursive: true });
      writeFileSync(join(oldHome, "memory", path), bytes);
    }
    const received = logs(oldHome), old = new LegacyMemoryStore({ home: oldHome, now: () => now });
    try {
      for (const includeSuperseded of [false, true]) expect(sorted(old.list({ project, includeSuperseded, limit: 100 }))).toEqual(sorted(writer.list({ project, includeSuperseded, limit: 100 })));
      for (const id of noteIds) expect(old.get(id, project)).toEqual(writer.get(id, project));
      for (const id of goalIds) expect(old.goalOf(id, project)).toEqual(writer.goalOf(id, project));
      expect(old.suggestions(project)).toEqual(writer.suggestions(project));
      for (const start of [...noteIds.map(id => `mem:${id}`), ...goalIds.map(id => `goal:${id}`), "path:src/public.ts"]) expect(graphProjection(old.graph(project, start, 2, 200))).toEqual(graphProjection(writer.graph(project, start, 2, 200)));
      expect(logs(oldHome)).toEqual(received);
      expect(logs(dir)).toEqual(authored);
    } finally { old.close(); }
  }
  function step(fields: Record<string, unknown>, placement: "local" | "log", act: () => unknown): string {
    now++;
    const before = logs(dir), body = { schema: "agent-hub.memory/v1", at: new Date(now).toISOString(), machine: writer.machine.id, ...structuredClone(fields) };
    const id = entryId(body as unknown as Omit<Entry, "id">);
    act();
    const path = `${placement}/${writer.machine.id}.jsonl`;
    // Assert the complete emitted body and exactly one append in the expected segment, including field order.
    expect(logs(dir)).toEqual({ ...before, [path]: (before[path] ?? "") + JSON.stringify({ ...body, id }) + "\n" });
    seen.add(fields.op as string);
    if (fields.op === "note") noteIds.push(id);
    if (fields.op === "goal") goalIds.push(id);
    parity();
    return id;
  }
  function addNote(text: string, tier: "short" | "long" = "long", task?: string, kind: "finding" | "contract" = "finding"): string {
    const input = { op: "note" as const, project, scope: "project" as const, tier, kind, peer: "person", source: "person" as const, text, about: ["path:src/public.ts"], ...(task ? { task } : {}) };
    return step(input, tier === "short" ? "local" : "log", () => writer.note(input));
  }
  const original = addNote("original v1 authority"), replacement = addNote("replacement v1 authority");
  const forgotten = addNote("forgotten v1 finding"), demoted = addNote("demoted v1 finding");
  const task = "agent-hub#1@1", held = addNote("held v1 finding", "short", task);
  step({ op: "forget", target: forgotten, actor: "person" }, "log", () => writer.forget(forgotten, "person", project));
  step({ op: "supersede", target: original, actor: "person", by: replacement }, "log", () => writer.supersede(original, replacement, "person", project));
  const demotionDeadline = new Date(now + 1 + ttl).toISOString();
  step({ op: "demote", target: demoted, actor: "person", by: demotionDeadline }, "log", () => writer.demote(demoted, "person", project));
  const settlementDeadline = new Date(now + 1 + ttl).toISOString();
  step({ op: "settle", target: task, actor: "person", by: settlementDeadline }, "local", () => writer.settle(task, "person"));
  const goalInput = { project, scope: "project" as const, title: "writer compatibility goal", milestones: ["deliver"], dependsOn: [], actor: "person" };
  const goal = step({ op: "goal", ...goalInput }, "log", () => writer.goal(goalInput));
  step({ op: "goal_state", target: goal, by: "active", actor: "person" }, "log", () => writer.goalState(goal, "active", "person"));
  step({ op: "goal_link", target: goal, by: task, actor: "person" }, "log", () => writer.goalLink(goal, task, "person"));
  step({ op: "lease", target: goal, by: new Date(now + 1 + ttl).toISOString(), actor: "person" }, "log", () => writer.take(goal, "person", { ms: ttl }));
  const forcedDeadline = new Date(now + 1 + ttl).toISOString();
  step({ op: "lease_force", target: goal, by: forcedDeadline, actor: "person" }, "log", () => writer.take(goal, "person", { force: true, ms: ttl }));
  const suggestion = step({ op: "suggest", target: replacement, by: `contradicts:${demoted}`, actor: "hub-model" }, "log", () => writer.suggest(replacement, demoted, "contradicts"));
  step({ op: "confirm", target: suggestion, actor: "person" }, "log", () => writer.judge(suggestion, "confirm", "person", project));
  expect(writer.graph(project, `mem:${replacement}`, 1).edges).toContainEqual({ from: `mem:${replacement}`, to: `mem:${demoted}`, rel: "contradicts" });
  step({ op: "reject", target: suggestion, actor: "person" }, "log", () => writer.judge(suggestion, "reject", "person", project));
  expect(writer.graph(project, `mem:${replacement}`, 1).edges.some(edge => edge.rel.includes("contradicts"))).toBe(false);
  expect(writer.list({ project }).map(row => row.id).sort()).toEqual([replacement, demoted, held].sort());
  expect(writer.get(forgotten, project)).toBeUndefined();
  expect(writer.get(original, project)?.supersededBy).toBe(replacement);
  expect(writer.get(demoted, project)).toMatchObject({ tier: "short", expiresAt: demotionDeadline });
  expect(writer.get(held, project)).toMatchObject({ tier: "short", expiresAt: settlementDeadline });
  expect(writer.goalOf(goal, project)).toMatchObject({ state: "active", links: [{ task }], lease: { holder: writer.machine.id, until: forcedDeadline, conflict: [], expired: false } });
  expect(writer.suggestions(project).find(row => row.id === suggestion)?.status).toBe("rejected");

  // Target-local operations must stay local too; a synced-only fixture would miss this writer branch.
  const localTask = "agent-hub#2@2", localOld = addNote("local old", "short", localTask, "contract"), localNew = addNote("local new", "short", localTask, "contract");
  step({ op: "settle", target: localTask, actor: "person", by: new Date(now + 1 + ttl).toISOString() }, "local", () => writer.settle(localTask, "person"));
  step({ op: "demote", target: localOld, actor: "person", by: new Date(now + 1 + ttl).toISOString() }, "local", () => writer.keepShort(localOld, "person"));
  step({ op: "supersede", target: localOld, actor: "person", by: localNew }, "local", () => writer.supersede(localOld, localNew, "person", project));
  step({ op: "forget", target: localNew, actor: "person" }, "local", () => writer.forget(localNew, "person", project));
  expect([...seen].sort()).toEqual([...V1_OPS].sort());
});
