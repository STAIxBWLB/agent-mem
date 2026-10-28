import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, candidateTargetRevision } from "../../src/memory/candidates.ts";
import { importClaudeMem } from "../../src/memory/import.ts";
import { memoryGitSync } from "../../src/memory/platform.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { syncMemory } from "../../src/memory/sync.ts";

const PROJECT = "synthetic/c4", MARKER = "CANDIDATE-ONLY-SYNTHETIC", START = Date.parse("2026-10-16T00:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-c4-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: START };
  const memory = new MemoryStore({ home: root, now: () => clock.now, screen: () => "promote" }); cleanup.push(() => memory.close());
  const sidecar = new CandidateStore({ home: root, now: () => START }); cleanup.push(() => sidecar.close());
  const note = (text: string, path: string) => memory.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "contract", peer: "person", text, about: [path], source: "person" });
  const a = note("ordinary authority alpha", "path:src/a.ts"), b = note("ordinary authority beta", "path:src/b.ts");
  const suggestion = memory.suggest(a, b, "same_topic")!;
  const candidate = sidecar.put({ project: PROJECT, kind: "correction", target: { id: a, revision: candidateTargetRevision(memory.get(a, PROJECT)!) }, proposedText: MARKER, reason: `${MARKER} reason` }, "public");
  const counter = sidecar.recordCounter({ entryId: a, project: PROJECT, deliveryId: `${MARKER}-delivery` }, { rendered: 1, delivered: null, cited: null }, "public");
  const ordinary = () => memory.list({ project: PROJECT }).map(view => view.id).sort();
  return { root, memory, sidecar, a, b, suggestion, candidate, counter, ordinary, clock };
}
function noSidecar(text: string, f: ReturnType<typeof fixture>): void {
  expect(text).not.toContain(MARKER); expect(text).not.toContain(f.candidate); expect(text).not.toContain(f.counter);
}
function git(cwd: string, args: string[]): string {
  const result = memoryGitSync(args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("synthetic local git fixture failed");
  return result.stdout.trim();
}

test("C4 list returns only ordinary notes while candidate counter and suggestion ids stay separate", () => {
  const f = fixture(); expect(f.ordinary()).toEqual([f.a, f.b].sort());
  noSidecar(JSON.stringify(f.memory.list({ project: PROJECT })), f);
  expect(f.ordinary()).not.toContain(f.suggestion);
});

test("C4 search cannot find sidecar proposal or counter context as memory text", () => {
  const f = fixture(); expect(f.memory.list({ project: PROJECT, q: MARKER })).toEqual([]);
  expect(f.memory.list({ project: PROJECT, q: f.candidate })).toEqual([]);
  expect(f.memory.list({ project: PROJECT, q: f.counter })).toEqual([]);
  expect(f.memory.list({ project: PROJECT, q: "ordinary" })).toHaveLength(2);
});

test("C4 show resolves ordinary note ids but not candidate counter or suggestion ids", () => {
  const f = fixture();
  for (const id of [f.candidate, f.counter, f.suggestion]) expect(f.memory.get(id, PROJECT)).toBeUndefined();
  expect(f.memory.get(f.a, PROJECT)?.text).toBe("ordinary authority alpha");
});

test("C4 graph labels unconfirmed suggestions and retrieval ignores them until a person confirms", () => {
  const f = fixture(), graph = f.memory.graph(PROJECT, `mem:${f.a}`, 1);
  noSidecar(JSON.stringify(graph), f);
  expect(graph.edges).toContainEqual({ from: `mem:${f.a}`, to: `mem:${f.b}`, rel: "suggested same_topic" });
  expect(graph.edges.some(edge => edge.rel === "same_topic")).toBe(false);
  expect(f.memory.related(PROJECT, ["path:src/a.ts"], 8).map(view => view.id)).toEqual([f.a]);
  // judge returns the pre-write proposal; reread the resulting projection to verify the authored verdict.
  expect(f.memory.judge(f.suggestion, "confirm", "person", PROJECT)?.id).toBe(f.suggestion);
  expect(f.memory.suggestions(PROJECT).find(row => row.id === f.suggestion)?.status).toBe("confirmed");
  expect(f.memory.graph(PROJECT, `mem:${f.a}`, 1).edges).toContainEqual({ from: `mem:${f.a}`, to: `mem:${f.b}`, rel: "same_topic" });
  expect(f.memory.related(PROJECT, ["path:src/a.ts"], 8).map(view => view.id).sort()).toEqual([f.a, f.b].sort());
  f.clock.now++;
  // A later person rejection removes the relation from evidence again, without deleting ordinary notes.
  expect(f.memory.judge(f.suggestion, "reject", "person", PROJECT)?.id).toBe(f.suggestion);
  expect(f.memory.suggestions(PROJECT).find(row => row.id === f.suggestion)?.status).toBe("rejected");
  expect(f.memory.graph(PROJECT, `mem:${f.a}`, 1).edges.some(edge => edge.rel === "same_topic" || edge.rel === "suggested same_topic")).toBe(false);
  expect(f.memory.related(PROJECT, ["path:src/a.ts"], 8).map(view => view.id)).toEqual([f.a]);
  expect(f.ordinary()).toEqual([f.a, f.b].sort());
});

test("C4 import rejects the sidecar as a source and skips provenance-marked model answers", () => {
  const f = fixture(), before = f.memory.dump();
  expect(() => importClaudeMem(f.memory, { project: PROJECT, chain: ["fixture"], db: f.sidecar.path, isPii: () => false })).toThrow();
  expect(f.memory.dump()).toBe(before);
  const file = join(f.root, "synthetic-claude-mem.db"), db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  db.query("INSERT INTO observations VALUES (1, 'fixture', 'model answer', ?, NULL, ?, ?)").run(MARKER, START, JSON.stringify({ peer: "hub-model", source: "ahub ask" })); db.close();
  const bytes = readFileSync(file);
  expect(importClaudeMem(f.memory, { project: PROJECT, chain: ["fixture"], db: file, isPii: () => false })).toMatchObject({ added: 0, skipped: { model: 1 } });
  expect(readFileSync(file)).toEqual(bytes); expect(f.ordinary()).toEqual([f.a, f.b].sort());
  noSidecar(JSON.stringify(f.memory.list({ project: PROJECT })), f);
});

test("C4 sync carries v1 suggestions but never sidecar candidates counters or proposal text", async () => {
  const f = fixture(), remote = join(f.root, "local-bare-remote"); mkdirSync(remote); git(remote, ["init", "--bare", "-q"]);
  expect(await syncMemory(f.memory, { remote, visibility: async () => "private" })).toMatchObject({ ok: true });
  const tracked = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
  expect(tracked.every(file => file === ".gitignore" || /^log\/[a-f0-9]{16}\.jsonl$/.test(file))).toBe(true);
  expect(tracked.some(file => file.includes("candidates") || file.includes("counter"))).toBe(false);
  const logs = tracked.filter(file => file.startsWith("log/")).map(file => git(remote, ["show", `main:${file}`])).join("\n");
  noSidecar(logs, f); expect(logs).toContain(f.suggestion);
  const other = new MemoryStore({ home: join(f.root, "other-home"), now: () => START, screen: () => "promote" }); cleanup.push(() => other.close());
  expect(await syncMemory(other, { remote, visibility: async () => "private" })).toMatchObject({ ok: true });
  expect(other.list({ project: PROJECT }).map(view => view.id).sort()).toEqual([f.a, f.b].sort());
  expect(other.related(PROJECT, ["path:src/a.ts"], 8).map(view => view.id)).toEqual([f.a]);
}, 30_000);

test("C4 rebuild leaves proposals and counters outside all derived v1 tables", () => {
  const f = fixture(), before = f.memory.dump();
  f.memory.rebuild(); expect(f.memory.dump()).toBe(before); noSidecar(f.memory.dump(), f);
  expect(f.ordinary()).toEqual([f.a, f.b].sort());
  expect(f.sidecar.get(f.candidate, PROJECT)?.status).toBe("pending");
  expect(f.sidecar.counters(PROJECT)).toHaveLength(1);
});

test("C4 only explicit acceptance under the current policy can append a candidate-derived ordinary note", () => {
  const f = fixture(), before = f.memory.dump();
  let screened = false;
  const context = { project: PROJECT, actor: "agent" as const, verdict: "public" as const, store: f.memory, policy: () => { screened = true; return true; } };
  expect(f.memory.get(f.a, PROJECT)?.supersededBy).toBeNull(); expect(f.sidecar.get(f.candidate, PROJECT)?.status).toBe("pending"); expect(f.memory.dump()).toBe(before);
  const accepted = f.sidecar.accept(f.candidate, context);
  expect(screened).toBe(true); expect(f.memory.get(accepted.noteId, PROJECT)).toMatchObject({ peer: "agent", source: "person" }); expect(f.memory.get(accepted.noteId, PROJECT)?.text).toContain(MARKER);
  expect(f.memory.get(f.a, PROJECT)?.supersededBy).toBe(accepted.noteId);
  expect(f.sidecar.get(f.candidate, PROJECT)?.status).toBe("accepted");
  expect(f.memory.get(f.counter, PROJECT)).toBeUndefined();
});
