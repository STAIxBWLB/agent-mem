import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, candidateTargetRevision, CANDIDATE_RETENTION, COUNTER_RETENTION, type CandidateInput, type CandidateVerdict, type CounterKey } from "../src/memory/candidates.ts";
import { MemoryStore, type Entry, type NoteInput, type PromotionScreen, type View } from "../src/memory/store.ts";
import { importClaudeMem } from "../src/memory/import.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { syncMemory } from "../src/memory/sync.ts";

const START = Date.parse("2026-10-16T00:00:00.000Z"), PROJECT = "fixture/project";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(screen: PromotionScreen = () => "promote") {
  const base = mkdtempSync(join(tmpdir(), "amem-candidates-")), home = join(base, "owner"), clock = { now: START };
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const memory = new MemoryStore({ home, now: () => clock.now, screen }); cleanup.push(() => memory.close());
  const candidates = new CandidateStore({ home, now: () => clock.now }); cleanup.push(() => candidates.close());
  const note = (text: string, extra: Partial<NoteInput> = {}) => { clock.now++; return memory.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "contract", peer: "codex", text, about: ["path:src/fixture.ts"], source: "person", ...extra }); };
  const target = note("ordinary authority"), view = memory.get(target, PROJECT)!;
  return { base, home, clock, memory, candidates, note, target, view };
}
const targetOf = (view: View) => ({ id: view.id, revision: candidateTargetRevision(view) });
const correction = (view: View, reason = "candidate-only reason"): CandidateInput => ({ project: PROJECT, kind: "correction", target: targetOf(view), proposedText: "candidate-only proposed correction", reason });
const fail = (view?: View): CandidateInput => ({ project: PROJECT, kind: "fail", ...(view ? { target: targetOf(view) } : {}), approach: "candidate-only approach", symptom: "candidate-only symptom", cause: "candidate-only cause", evidenceRefs: ["test:fixture-regression"], retryWhen: "when the fixture precondition changes" });
function authored(memory: MemoryStore): Entry[] {
  return ["log", "local"].flatMap(sub => readdirSync(join(memory.dir, sub)).sort().flatMap(file => readFileSync(join(memory.dir, sub, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry)));
}
const bytes = (memory: MemoryStore) => ["log", "local"].flatMap(sub => readdirSync(join(memory.dir, sub)).sort().map(file => [sub, file, readFileSync(join(memory.dir, sub, file), "utf8")]));
function sidecarCounts(path: string) {
  const db = new Database(path, { readonly: true }); db.run("PRAGMA busy_timeout = 3000");
  try { return ["candidates", "counters"].map(table => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n); }
  finally { db.close(); }
}
const key = (entryId: string, deliveryId = "delivery-1", project = PROJECT): CounterKey => ({ entryId, project, task: "task-1", turn: "turn-1", session: "session-1", deliveryId });
const acceptance = (f: ReturnType<typeof fixture>) => ({ project: PROJECT, actor: "person" as const, verdict: "public" as const, store: f.memory, policy: () => true });

// These prove the library boundary. Hub recall/brief/ask and capture integration live in agent-hub.
test("candidates and counters never enter ordinary list/search/graph/dump/rebuild or claude-mem import", () => {
  const f = fixture(), before = bytes(f.memory), dump = f.memory.dump();
  const id = f.candidates.put(correction(f.view), "public");
  f.candidates.put(fail(f.view), "public"); f.candidates.put({ project: PROJECT, kind: "decay", target: targetOf(f.view), reason: "candidate-only decay" }, "public");
  f.candidates.recordCounter(key(f.target), { rendered: 1, delivered: null }, "public");
  expect(f.memory.list({ project: PROJECT }).map(row => row.id)).toEqual([f.target]);
  expect(f.memory.list({ project: PROJECT, q: "candidate-only" })).toEqual([]);
  expect(JSON.stringify(f.memory.graph(PROJECT, `mem:${f.target}`, 2))).not.toContain(id);
  expect(JSON.stringify(f.memory.graph(PROJECT, `mem:${f.target}`, 2))).not.toContain("candidate-only");
  expect(f.memory.dump()).toBe(dump); f.memory.rebuild(); expect(f.memory.dump()).toBe(dump);
  const source = join(f.base, "claude-mem.db"), db = new Database(source);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)"); db.close();
  const sourceBytes = readFileSync(source);
  expect(importClaudeMem(f.memory, { project: PROJECT, chain: ["project"], db: source, isPii: () => false })).toMatchObject({ read: 0, added: 0 });
  expect(readFileSync(source)).toEqual(sourceBytes); expect(f.memory.dump()).toBe(dump); expect(bytes(f.memory)).toEqual(before);
  expect(f.candidates.get(id, PROJECT)?.status).toBe("pending");
  const counts = sidecarCounts(f.candidates.path);
  expect(() => importClaudeMem(f.memory, { project: PROJECT, chain: ["project"], db: f.candidates.path, isPii: () => false })).toThrow();
  expect(sidecarCounts(f.candidates.path)).toEqual(counts); expect(bytes(f.memory)).toEqual(before);
});

test("sync of a fresh private bare remote carries v1 log rows, never the candidate/counter sidecar", async () => {
  const f = fixture(), remote = join(f.base, "remote"); mkdirSync(remote);
  expect(memoryGitSync(["init", "--bare", "-q", remote], { encoding: "utf8" }).status).toBe(0);
  const candidate = f.candidates.put(correction(f.view), "public"); f.candidates.recordCounter(key(f.target), { rendered: 1 }, "public");
  const before = bytes(f.memory), privateRemote = { remote, visibility: async () => "private" as const };
  expect((await syncMemory(f.memory, privateRemote)).ok).toBe(true);
  const other = new MemoryStore({ home: join(f.base, "other"), now: () => f.clock.now }); cleanup.push(() => other.close());
  expect((await syncMemory(other, privateRemote)).ok).toBe(true);
  expect(other.list({ project: PROJECT }).map(row => row.id)).toEqual([f.target]);
  expect(other.list({ q: "candidate-only" })).toEqual([]); expect(other.dump()).not.toContain(candidate);
  expect(existsSync(join(other.dir, "candidates.db"))).toBe(false);
  const tree = memoryGitSync(["-C", remote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" });
  expect(tree.status).toBe(0); expect(tree.stdout).not.toContain("candidates"); expect(tree.stdout).not.toContain("counter"); expect(tree.stdout).not.toContain("mutation-lock");
  expect(bytes(f.memory)).toEqual(before);
}, 20_000);

test("private, PII and unknown host verdicts persist no candidates or counters", () => {
  const f = fixture(), before = bytes(f.memory);
  for (const verdict of ["private", "pii", "unknown"] as const) {
    for (const input of [correction(f.view), fail(f.view), { project: PROJECT, kind: "decay", target: targetOf(f.view), reason: "private candidate-only marker" } as const]) expect(() => f.candidates.put(input, verdict)).toThrow("privacy");
    expect(() => f.candidates.recordCounter({ ...key(f.target), task: "private marker", session: "PII marker", turn: "unknown marker" }, { rendered: 1, delivered: 1, cited: 1 }, verdict)).toThrow("privacy");
  }
  expect(sidecarCounts(f.candidates.path)).toEqual([0, 0]); expect(bytes(f.memory)).toEqual(before);
});

test("candidate content IDs are immutable, canonical, project-scoped and replay-deduplicated", () => {
  const f = fixture(), input = correction(f.view), id = f.candidates.put(input, "public");
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(f.candidates.put({ ...input }, "public")).toBe(id);
  const reversed = Object.fromEntries(Object.entries(input).reverse()) as CandidateInput;
  expect(f.candidates.put(reversed, "public")).toBe(id);
  if (input.kind !== "correction") throw new Error("fixture kind");
  input.proposedText = "changed input after saving";
  expect(f.candidates.get(id, PROJECT)?.input).toMatchObject({ proposedText: "candidate-only proposed correction" });
  expect(f.candidates.put(input, "public")).not.toBe(id);
  expect(f.candidates.get(id, "other")).toBeUndefined(); expect(f.candidates.list({ project: "other" })).toEqual([]);
  expect(f.candidates.list({ project: PROJECT })).toHaveLength(2);
  const db = new Database(f.candidates.path); db.run("PRAGMA busy_timeout = 3000");
  try { db.query("UPDATE candidates SET payload = ? WHERE id = ?").run(JSON.stringify(input), id); }
  finally { db.close(); }
  expect(() => f.candidates.get(id, PROJECT)).toThrow("hash mismatch");
});

test("candidate and counter input bounds refuse malformed or excessive fields without row writes", () => {
  const f = fixture(), valid = correction(f.view), failed = fail(f.view);
  for (const input of [
    { ...valid, project: " " }, { ...valid, project: "x".repeat(401) }, { ...valid, reason: "" }, { ...valid, reason: "nul\0marker" },
    { ...valid, proposedText: "x".repeat(4001) }, { ...valid, target: { id: f.target.slice(0, 8), revision: targetOf(f.view).revision } },
    { ...valid, target: { id: f.target, revision: "wrong" } }, { ...failed, evidenceRefs: [] }, { ...failed, evidenceRefs: Array(17).fill("test:fixture") },
    { ...failed, evidenceRefs: ["x".repeat(401)] }, { ...failed, approach: "한".repeat(4000), symptom: "한".repeat(4000), cause: "한".repeat(4000), retryWhen: "한".repeat(4000) },
  ]) expect(() => f.candidates.put(input as CandidateInput, "public")).toThrow();
  for (const badKey of [{ ...key(f.target), entryId: f.target.slice(0, 8) }, { ...key(f.target), deliveryId: "" }, { ...key(f.target), deliveryId: "x".repeat(201) }, { ...key(f.target), session: "x".repeat(401) }]) expect(() => f.candidates.recordCounter(badKey, {}, "public")).toThrow();
  for (const rendered of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => f.candidates.recordCounter(key(f.target), { rendered }, "public")).toThrow();
  expect(sidecarCounts(f.candidates.path)).toEqual([0, 0]);
});

for (const change of ["demote", "supersede", "forget", "promote"] as const) test(`candidate target revision refuses acceptance after ${change}`, () => {
  const f = fixture(), target = change === "promote" ? f.note("short target", { tier: "short" }) : f.target;
  const id = f.candidates.put(correction(f.memory.get(target, PROJECT)!), "public");
  if (change === "demote") f.memory.demote(target, "user", PROJECT);
  else if (change === "supersede") expect(f.memory.supersede(target, f.note("replacement"), "user", PROJECT)).toBe(true);
  else if (change === "forget") f.memory.forget(target, "user", PROJECT);
  else {
    const writer = new MemoryStore({ home: f.home, now: () => f.clock.now, screen: () => "promote" }); cleanup.push(() => writer.close());
    expect(writer.promote(target, "user", PROJECT)).toBeDefined();
  }
  const before = bytes(f.memory);
  expect(() => f.candidates.accept(id, acceptance(f))).toThrow("stale");
  expect(bytes(f.memory)).toEqual(before); expect(f.candidates.get(id, PROJECT)?.status).toBe("pending");
});

test("person authority, current policy and callback target mutations are checked before any v1 append", () => {
  const f = fixture(), id = f.candidates.put(correction(f.view), "public"), before = bytes(f.memory);
  let called = false;
  expect(() => f.candidates.accept(id, { ...acceptance(f), actor: "agent", policy: () => { called = true; return true; } })).toThrow("person");
  expect(called).toBe(false);
  expect(() => f.candidates.reject(id, { project: PROJECT, actor: "agent", verdict: "public" })).toThrow("person");
  for (const verdict of ["private", "pii", "unknown"] as CandidateVerdict[]) expect(() => f.candidates.accept(id, { ...acceptance(f), verdict })).toThrow("privacy");
  expect(() => f.candidates.accept(id, { ...acceptance(f), policy: () => false })).toThrow("policy");
  expect(bytes(f.memory)).toEqual(before);
  let afterMutation: ReturnType<typeof bytes> | undefined;
  expect(() => f.candidates.accept(id, { ...acceptance(f), policy: () => { f.memory.demote(f.target, "person", PROJECT); afterMutation = bytes(f.memory); return true; } })).toThrow("stale");
  expect(bytes(f.memory)).toEqual(afterMutation!); expect(f.candidates.get(id, PROJECT)?.status).toBe("pending");
});

for (const kind of ["correction", "fail"] as const) test(`person accepts a ${kind} through its ordinary v1 note and required correction supersession`, () => {
  const f = fixture(), id = f.candidates.put(kind === "correction" ? correction(f.view) : fail(f.view), "public");
  const oldIds = new Set(authored(f.memory).map(row => row.id));
  const result = f.candidates.accept(id, acceptance(f));
  const added = authored(f.memory).filter(row => !oldIds.has(row.id)), notes = added.filter(row => row.op === "note");
  expect(added).toHaveLength(kind === "correction" ? 2 : 1); expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ op: "note", kind: kind === "fail" ? "fail" : "contract", tier: "long", scope: "project", source: "person", project: PROJECT });
  if (notes[0]?.op !== "note") throw new Error("acceptance must append a note");
  expect(notes[0].text).toContain(id); expect(notes[0].text).toContain(candidateTargetRevision(f.view)); expect(notes[0].text).toContain(f.target);
  expect(readFileSync(join(f.memory.dir, "log", `${f.memory.machine.id}.jsonl`), "utf8")).toContain(result.noteId);
  if (kind === "correction") {
    expect(added.filter(row => row.op !== "note")).toMatchObject([{ op: "supersede", target: f.target, by: result.noteId }]);
    expect(f.memory.get(f.target, PROJECT)?.supersededBy).toBe(result.noteId);
  } else expect(added.filter(row => row.op !== "note")).toEqual([]);
  const accepted = bytes(f.memory);
  // A correction changed the target revision itself; a repeated acceptance returns its saved receipt first.
  expect(f.candidates.accept(id, acceptance(f))).toMatchObject({ noteId: result.noteId, alreadyAccepted: true });
  expect(bytes(f.memory)).toEqual(accepted);
  expect(f.candidates.get(id, PROJECT)).toMatchObject({ status: "accepted", acceptedNoteId: result.noteId });
});

test("decay is listing-only and rejected candidates cannot append or replay an acceptance", () => {
  const f = fixture(), decay = f.candidates.put({ project: PROJECT, kind: "decay", target: targetOf(f.view), reason: "old entry" }, "public");
  const id = f.candidates.put(correction(f.view), "public"), before = bytes(f.memory);
  expect(() => f.candidates.accept(decay, acceptance(f))).toThrow("listing-only");
  f.candidates.reject(id, { project: PROJECT, actor: "person", verdict: "public" });
  expect(f.candidates.list({ project: PROJECT }).map(row => row.id)).toEqual([decay]);
  expect(f.candidates.list({ project: PROJECT, status: "rejected" }).map(row => row.id)).toEqual([id]);
  expect(() => f.candidates.accept(id, acceptance(f))).toThrow("rejected");
  expect(bytes(f.memory)).toEqual(before);
});

test("counter unknowns differ from observed zero and idempotent upserts retain delivery/context identity", () => {
  const f = fixture(), base = key(f.target), before = bytes(f.memory), id = f.candidates.recordCounter(base, {}, "public");
  expect(f.candidates.counters(PROJECT)).toMatchObject([{ id, rendered: null, delivered: null, cited: null }]);
  expect(f.candidates.recordCounter(base, { rendered: 0, delivered: null }, "public")).toBe(id);
  expect(f.candidates.counters(PROJECT)).toMatchObject([{ rendered: 0, delivered: null, cited: null }]);
  expect(f.candidates.recordCounter(base, { delivered: 1, cited: 0 }, "public")).toBe(id);
  expect(f.candidates.counters(PROJECT)).toMatchObject([{ rendered: 0, delivered: 1, cited: 0 }]);
  expect(f.candidates.recordCounter(base, { rendered: null }, "public")).toBe(id);
  expect(f.candidates.counters(PROJECT)).toMatchObject([{ rendered: 0, delivered: 1, cited: 0 }]);
  for (const changed of [{ deliveryId: "delivery-2" }, { task: "task-2" }, { turn: "turn-2" }, { session: "session-2" }, { entryId: "f".repeat(32) }]) expect(f.candidates.recordCounter({ ...base, ...changed }, {}, "public")).not.toBe(id);
  expect(f.candidates.counters(PROJECT)).toHaveLength(6);
  expect(f.candidates.counters("other")).toEqual([]);
  const missing = { entryId: f.target, project: PROJECT, deliveryId: "unknown-context" };
  expect(f.candidates.recordCounter(missing, {}, "public")).toBe(f.candidates.recordCounter({ ...missing, task: null, turn: null, session: null }, {}, "public"));
  expect(bytes(f.memory)).toEqual(before);
});

test("candidate retention enforces 500 per project and the 30-day age boundary", () => {
  expect(CANDIDATE_RETENTION).toEqual({ count: 500, ageMs: 30 * 86400_000 });
  const f = fixture(), ids: string[] = [];
  for (let i = 0; i <= CANDIDATE_RETENTION.count; i++) { f.clock.now++; ids.push(f.candidates.put(correction(f.view, `reason ${i}`), "public")); }
  const lastAt = f.clock.now;
  f.clock.now++; f.candidates.put({ ...correction(f.view), project: "other" }, "public");
  expect(f.candidates.list({ project: PROJECT, status: "all" })).toHaveLength(500);
  expect(f.candidates.get(ids[0]!, PROJECT)).toBeUndefined(); expect(f.candidates.get(ids.at(-1)!, PROJECT)).toBeDefined();
  expect(f.candidates.list({ project: "other" })).toHaveLength(1);
  f.clock.now = lastAt + CANDIDATE_RETENTION.ageMs;
  expect(f.candidates.list({ project: PROJECT, status: "all" })).toEqual([]);
  expect(f.candidates.list({ project: "other" })).toHaveLength(1);
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

test("counter retention enforces 10000 per project and the 90-day age boundary with a batched fixture", () => {
  expect(COUNTER_RETENTION).toEqual({ count: 10_000, ageMs: 90 * 86400_000 });
  const f = fixture(), db = new Database(f.candidates.path); db.run("PRAGMA busy_timeout = 3000");
  const n = COUNTER_RETENTION.count + 3, lastAt = START + n - 1;
  try {
    const insert = db.query("INSERT INTO counters (id, project, payload, at, rendered, delivered, cited) VALUES (?, ?, ?, ?, NULL, NULL, NULL)");
    db.transaction(() => {
      for (const project of [PROJECT, "other"]) for (let i = 0; i < (project === PROJECT ? n : 3); i++) {
        const normalized = { ...key(f.target, `delivery-${i}`, project), task: null, turn: null, session: null };
        const id = createHash("sha256").update(canonical({ schema: "agent-mem.counter/v1", key: normalized })).digest("hex");
        insert.run(id, project, canonical(normalized), project === PROJECT ? START + i : lastAt + i + 1);
      }
    }).immediate();
  } finally { db.close(); }
  f.clock.now = lastAt + 10;
  const kept = f.candidates.counters(PROJECT);
  expect(kept).toHaveLength(10_000); expect(kept.some(row => row.key.deliveryId === "delivery-0")).toBe(false);
  expect(kept.some(row => row.key.deliveryId === `delivery-${n - 1}`)).toBe(true); expect(f.candidates.counters("other")).toHaveLength(3);
  f.clock.now = lastAt + COUNTER_RETENTION.ageMs;
  expect(f.candidates.counters(PROJECT)).toEqual([]); expect(f.candidates.counters("other")).toHaveLength(3);
});

for (const policyPasses of [false, true]) test(`correction acceptance with unrelated held notes appends ${policyPasses ? "one note and one supersede" : "no rows"}`, () => {
  const f = fixture(() => "skip"), id = f.candidates.put(correction(f.view), "public"), task = `${PROJECT}#9@1`;
  f.note("unrelated held contract", { tier: "short", task }); expect(f.memory.settle(task, "user")).toBe(0);
  const before = new Set(authored(f.memory).map(row => row.id));
  const enabled = new MemoryStore({ home: f.home, now: () => f.clock.now, screen: () => "promote", deferPromotions: true }); cleanup.push(() => enabled.close());
  if (policyPasses) f.candidates.accept(id, { ...acceptance(f), store: enabled });
  else expect(() => f.candidates.accept(id, { ...acceptance(f), store: enabled, policy: () => false })).toThrow("policy");
  const added = authored(enabled).filter(row => !before.has(row.id));
  expect(added).toHaveLength(policyPasses ? 2 : 0);
  if (policyPasses) {
    expect(added.filter(row => row.op === "note")).toMatchObject([{ op: "note", tier: "long", kind: "contract" }]);
    expect(added.filter(row => row.op !== "note")).toMatchObject([{ op: "supersede", target: f.target }]);
  }
});


test("acceptance refuses wrong stores and an oversized v1 note without changing logs or pending state", () => {
  const f = fixture(), other = fixture(), ordinary = f.candidates.put(correction(f.view), "public"), before = bytes(f.memory);
  expect(() => f.candidates.accept(ordinary, { ...acceptance(f), store: other.memory })).toThrow("memory store");
  const oversized = f.candidates.put({ project: PROJECT, kind: "correction", target: targetOf(f.view), proposedText: "x".repeat(3900), reason: "y".repeat(1000) }, "public");
  expect(() => f.candidates.accept(oversized, acceptance(f))).toThrow("v1 note limit");
  expect(bytes(f.memory)).toEqual(before); expect(f.candidates.get(oversized, PROJECT)?.status).toBe("pending");
});

test("an explicit correction note kind is preserved and supersedes its target", () => {
  const f = fixture(), id = f.candidates.put({ project: PROJECT, kind: "correction", target: targetOf(f.view), proposedText: "a deliberate decision", reason: "person chose a decision", noteKind: "decision" }, "public");
  const result = f.candidates.accept(id, acceptance(f));
  expect(f.memory.get(result.noteId, PROJECT)).toMatchObject({ kind: "decision", tier: "long" });
  expect(f.memory.get(f.target, PROJECT)?.supersededBy).toBe(result.noteId);
});

test("interrupted accepting state refuses automatic replay and appends no v1 rows", () => {
  const f = fixture(), id = f.candidates.put(correction(f.view), "public"), before = bytes(f.memory);
  const acceptedNote = f.memory.withAcceptedNote.bind(f.memory);
  f.memory.withAcceptedNote = (note, work) => acceptedNote(note, () => work(() => { throw new Error("fixture append interrupted before effect"); }));
  try { expect(() => f.candidates.accept(id, acceptance(f))).toThrow("fixture append interrupted"); }
  finally { f.memory.withAcceptedNote = acceptedNote; }
  expect(f.candidates.get(id, PROJECT)?.status).toBe("accepting");
  expect(() => f.candidates.accept(id, acceptance(f))).toThrow("interrupted");
  expect(bytes(f.memory)).toEqual(before);
});


for (const screen of ["keep", "skip"] as const) test(`actual memory promotion screen ${screen} refuses acceptance without any v1 fallback`, () => {
  const f = fixture(), id = f.candidates.put(correction(f.view), "public");
  const denied = new MemoryStore({ home: f.home, now: () => f.clock.now, screen: () => screen }); cleanup.push(() => denied.close());
  const before = bytes(f.memory);
  expect(() => f.candidates.accept(id, { ...acceptance(f), store: denied })).toThrow();
  expect(bytes(f.memory)).toEqual(before); expect(f.candidates.get(id, PROJECT)?.status).toBe("pending");
});

for (const demoted of [false, true]) test(`correction preserves a shared target's source project and synced reach${demoted ? " after demotion" : ""} (X04)`, () => {
  const f = fixture(), target = f.note("shared authority from another project", { project: "source/project", scope: "shared" });
  if (demoted) f.memory.demote(target, "user");
  const view = f.memory.get(target, PROJECT)!;
  expect(view).toMatchObject({ scope: "shared", project: "source/project", local: false, tier: demoted ? "short" : "long" });
  const id = f.candidates.put(correction(view), "public"), before = new Set(authored(f.memory).map(row => row.id));
  const result = f.candidates.accept(id, acceptance(f)), added = authored(f.memory).filter(row => !before.has(row.id));
  expect(added).toHaveLength(2);
  const replacement = f.memory.get(result.noteId, PROJECT)!;
  expect(replacement).toMatchObject({ project: "source/project", scope: "shared", tier: "long", local: false });
  expect(f.memory.get(target, PROJECT)?.supersededBy).toBe(result.noteId);
  expect(f.memory.get(result.noteId, "third/project")?.id).toBe(result.noteId);
  expect(added.filter(row => row.op !== "note")).toMatchObject([{ op: "supersede", target, by: result.noteId }]);
});

test("correction of an ordinary local short target stays short and local while superseding", () => {
  const f = fixture(), target = f.note("local short authority", { tier: "short" }), view = f.memory.get(target, PROJECT)!;
  const id = f.candidates.put(correction(view), "public"), before = new Set(authored(f.memory).map(row => row.id));
  const result = f.candidates.accept(id, acceptance(f));
  expect(f.memory.get(result.noteId, PROJECT)).toMatchObject({ project: PROJECT, tier: "short", scope: "project", local: true });
  const added = authored(f.memory).filter(row => !before.has(row.id));
  expect(added).toHaveLength(2); expect(added.filter(row => row.op !== "note")).toMatchObject([{ op: "supersede", target, by: result.noteId }]);
});


test("absence of a memory promotion screen refuses acceptance rather than authorizing a fallback", () => {
  const f = fixture(), id = f.candidates.put(correction(f.view), "public");
  const unscreened = new MemoryStore({ home: f.home, now: () => f.clock.now, deferPromotions: true }); cleanup.push(() => unscreened.close());
  const before = bytes(f.memory);
  expect(() => f.candidates.accept(id, { ...acceptance(f), store: unscreened })).toThrow();
  expect(bytes(f.memory)).toEqual(before); expect(f.candidates.get(id, PROJECT)?.status).toBe("pending");
});

test("interruption after a correction note but before supersede keeps one note and refuses automatic replay", () => {
  const f = fixture(), id = f.candidates.put(correction(f.view), "public"), before = new Set(authored(f.memory).map(row => row.id));
  const supersede = f.memory.supersede;
  f.memory.supersede = () => { throw new Error("fixture supersede interrupted before effect"); };
  try { expect(() => f.candidates.accept(id, acceptance(f))).toThrow("fixture supersede interrupted"); }
  finally { f.memory.supersede = supersede; }
  const added = authored(f.memory).filter(row => !before.has(row.id));
  expect(added).toHaveLength(1); expect(added[0]).toMatchObject({ op: "note", tier: "long", kind: "contract" });
  expect(f.memory.get(added[0]!.id, PROJECT)?.id).toBe(added[0]!.id);
  expect(f.candidates.get(id, PROJECT)?.status).toBe("accepting"); expect(f.memory.get(f.target, PROJECT)?.supersededBy).toBeNull();
  const interrupted = bytes(f.memory);
  expect(() => f.candidates.accept(id, acceptance(f))).toThrow("interrupted");
  expect(bytes(f.memory)).toEqual(interrupted);
});

test("a competing supersede at the last target read cannot authorize a stale candidate", () => {
  const f = fixture(), id = f.candidates.put(correction(f.view), "public"), replacement = f.note("concurrent replacement");
  const other = new MemoryStore({ home: f.home, now: () => f.clock.now, deferPromotions: true }); cleanup.push(() => other.close());
  const get = f.memory.get.bind(f.memory); let reads = 0, accepted = false;
  f.memory.get = (...args: Parameters<MemoryStore["get"]>) => {
    const current = get(...args);
    if (args[0] === f.target && ++reads === 2) other.supersede(f.target, replacement, "other", PROJECT);
    return current;
  };
  try { f.candidates.accept(id, acceptance(f)); accepted = true; } catch { /* stale or blocked competing mutation must fail closed */ }
  expect(accepted).toBe(false);
  expect(authored(f.memory).filter(row => row.op === "note" && row.text.includes(`Accepted candidate: ${id}`))).toEqual([]);
});

for (const tier of ["short", "long"] as const) test(`acceptance screens the exact persisted ${tier} note id, timestamp and expiry`, () => {
  const f = fixture(), target = f.note("screened authority", { tier }), current = f.memory.get(target, PROJECT)!;
  const id = f.candidates.put(correction(current), "public"); let screened: View | undefined;
  const checked = new MemoryStore({ home: f.home, now: () => f.clock.now, deferPromotions: true, screen: view => {
    screened = structuredClone(view); f.clock.now += 1000; return "promote";
  } }); cleanup.push(() => checked.close());
  const result = f.candidates.accept(id, { ...acceptance(f), store: checked });
  const persisted = checked.get(result.noteId, PROJECT)!;
  expect({ id: persisted.id, at: persisted.at, expiresAt: persisted.expiresAt }).toEqual({ id: screened!.id, at: screened!.at, expiresAt: screened!.expiresAt });
});

test("sync cannot modify segments while a candidate acceptance holds the mutation boundary", async () => {
  const f = fixture(), before = bytes(f.memory); let attemptedNetwork = false;
  let result: ReturnType<typeof syncMemory> | undefined;
  f.memory.withAcceptedNote({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "screen-only fixture", about: [] }, () => {
    result = syncMemory(f.memory, { remote: "unused-fixture-remote", visibility: async () => { attemptedNetwork = true; return "private"; } });
  });
  expect(await result!).toMatchObject({ ok: false, error: "another memory mutation is running on this machine" });
  expect(attemptedNetwork).toBe(false); expect(bytes(f.memory)).toEqual(before);
  expect(existsSync(join(f.memory.dir, "sync.lock"))).toBe(false);
});

test("an accepted mutation refuses a busy derived index before appending any note", () => {
  const f = fixture(), before = bytes(f.memory), index = new Database(join(f.memory.dir, "index.db"));
  index.run("BEGIN IMMEDIATE");
  try {
    expect(() => f.memory.withAcceptedNote({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "must not authorize from a possibly stale index", about: [] }, append => append())).toThrow();
    expect(bytes(f.memory)).toEqual(before);
  } finally { index.run("ROLLBACK"); index.close(); }
});
