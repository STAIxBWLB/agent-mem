import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore as LegacyMemoryStore } from "@staix/agent-mem-v1";
import { MemoryStore, type Graph, type View } from "../../src/memory/store.ts";
import { GOLDEN_FIXTURES, GOLDEN_NOW, GOLDEN_DEADLINE, fixture } from "./fixtures.ts";
import { Replay, authoredLogs } from "./replay.ts";

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


test("C1 all 13 v1 ops preserve the published legacy reader's full semantic projection", () => {
  expect(new Set(GOLDEN_FIXTURES.map(row => row.entry.op))).toEqual(new Set(["note", "forget", "supersede", "demote", "settle", "goal", "goal_state", "goal_link", "lease", "lease_force", "suggest", "confirm", "reject"]));
  const replay = new Replay();
  cleanup.push(() => replay.close());
  for (const row of GOLDEN_FIXTURES) replay.append(row);
  replay.store.refresh();
  const authored = authoredLogs(replay.store.dir), oldHome = home();
  for (const [path, bytes] of Object.entries(authored)) {
    const folder = path.startsWith("log/") ? "log" : "local";
    mkdirSync(join(oldHome, "memory", folder), { recursive: true });
    writeFileSync(join(oldHome, "memory", path), bytes);
  }
  const received = logs(oldHome);
  const old = new LegacyMemoryStore({ home: oldHome, now: () => GOLDEN_NOW });
  cleanup.push(() => old.close());
  const current = replay.store, id = (name: string) => fixture(name).entry.id;
  const all = sorted(old.list({ project, includeSuperseded: true, limit: 100 }));
  expect(all).toEqual(sorted(current.list({ project, includeSuperseded: true, limit: 100 })));
  const visible = sorted(old.list({ project, limit: 100 }));
  expect(visible).toEqual(sorted(current.list({ project, limit: 100 })));
  expect(visible.map(row => row.id)).toEqual([id("note-replacement"), id("note-demoted"), id("note-settled")].sort());
  expect(all.find(row => row.id === id("v1-note"))?.supersededBy).toBe(id("note-replacement"));
  expect(all.find(row => row.id === id("note-demoted"))).toMatchObject({ tier: "short", expiresAt: GOLDEN_DEADLINE });
  expect(all.find(row => row.id === id("note-settled"))).toMatchObject({ tier: "short", expiresAt: GOLDEN_DEADLINE });
  for (const row of GOLDEN_FIXTURES.filter(row => row.entry.op === "note")) {
    expect(old.get(row.entry.id, project)).toEqual(current.get(row.entry.id, project));
  }
  expect(old.get(id("note-forgotten"), project)).toBeUndefined();
  expect(old.goalOf(id("v1-goal"), project)).toEqual(current.goalOf(id("v1-goal"), project));
  expect(old.goalOf(id("v1-goal"), project)).toMatchObject({ state: "active", title: "fixture goal", links: [{ task: "agent-hub#1@1" }], lease: { holder: "fixture-c", until: GOLDEN_DEADLINE, conflict: [], expired: false } });
  const suggestions = old.suggestions(project).sort((a, b) => a.id.localeCompare(b.id));
  expect(suggestions).toEqual(current.suggestions(project).sort((a, b) => a.id.localeCompare(b.id)));
  expect(suggestions.find(row => row.id === id("v1-suggest"))).toMatchObject({ status: "confirmed", rel: "contradicts" });
  expect(suggestions.find(row => row.id === id("suggest-rejected"))).toMatchObject({ status: "rejected", rel: "same_topic" });
  const graphProjection = (graph: Graph) => ({ nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...graph.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  for (const start of [`mem:${id("v1-note")}`, `mem:${id("note-replacement")}`, `goal:${id("v1-goal")}`, "path:src/public.ts"]) {
    expect(graphProjection(old.graph(project, start, 2, 200))).toEqual(graphProjection(current.graph(project, start, 2, 200)));
  }
  expect(logs(oldHome)).toEqual(received);
  expect(authoredLogs(replay.store.dir)).toEqual(authored);
});
