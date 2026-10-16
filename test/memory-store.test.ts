import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { entryId, extractNodes, looksSecret, MemoryStore, type NoteInput, type PromotionScreen } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { memoryCommand } from "./core-test-support.ts";

// #258: the hub's own memory store: tiers, promotion, expiry, a graph rebuilt from append-only logs.

const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-mem-${name}-`))); dirs.push(d); return d; };
const DAY = 24 * 3600_000;
function store(home: string, clock: { t: number }, screen: PromotionScreen = () => "promote") { const s = new MemoryStore({ home, now: () => clock.t, screen }); stores.push(s); return s; }
const note = (over: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project: "work/app", scope: "project", tier: "short", kind: "finding", peer: "codex", text: "a note", about: [], source: "hub", ...over });

test("tiers: notes on an open task are short-term; approval moves decisions, contracts and fails to long-term, never findings; expiry removes only short-term", () => {
  const home = temp("tiers"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#3@1";
  const ids = Object.fromEntries((["decision", "contract", "fail", "finding"] as const).map((kind) => [kind, s.note(note({ kind, text: `${kind} text`, task }))]));
  expect(s.list().map((v) => v.tier)).toEqual(["short", "short", "short", "short"]);
  // Open task: nothing expires however long it stays open.
  clock.t += 60 * DAY; s.refresh();
  expect(s.list()).toHaveLength(4);
  expect(s.settle(task, "claude")).toBe(3);
  const after = s.list();
  expect(after.filter((v) => v.tier === "long").map((v) => v.kind).sort()).toEqual(["contract", "decision", "fail"]);
  expect(after.find((v) => v.kind === "finding")).toMatchObject({ tier: "short", id: ids.finding });
  // The long-term copies point at their short-term originals, which are hidden.
  expect(after.filter((v) => v.tier === "long").every((v) => Object.values(ids).includes(v.promotedFrom!))).toBe(true);
  // Long-term entries go to the synced log, short-term ones only to the local segment.
  const machine = s.machine.id;
  expect(readFileSync(join(home, "memory", "log", `${machine}.jsonl`), "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l).tier === "long")).toBe(true);
  expect(readFileSync(join(home, "memory", "local", `${machine}.jsonl`), "utf8")).toContain("finding text");
  expect(readFileSync(join(home, "memory", "log", `${machine}.jsonl`), "utf8")).not.toContain("finding text");
  // 14 days after the approval the finding is gone from the index; the long-term entries remain.
  clock.t += 14 * DAY + 1; s.refresh();
  expect(s.list().map((v) => v.kind).sort()).toEqual(["contract", "decision", "fail"]);
  expect(s.get(ids.finding!)).toBeUndefined();
  // A note with no task expires 14 days after it was written.
  s.note(note({ text: "loose" }));
  clock.t += 15 * DAY; s.refresh();
  expect(s.list({ q: "loose" })).toEqual([]);
  expect(statSync(join(home, "memory")).mode & 0o777).toBe(0o700);
});

test("person ops: promote, demote, forget and supersede are entries too, and propagate through the logs", () => {
  const home = temp("ops"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const finding = s.note(note({ text: "keep me" }));
  const long = s.promote(finding, "user")!;
  // The copy is the source's, whoever promotes it: a hub and a person promoting at once write one entry (review of #352).
  expect(s.get(long)).toMatchObject({ tier: "long", promotedFrom: finding, source: "hub" });
  const newer = s.note(note({ tier: "long", kind: "decision", text: "newer decision" }));
  const older = s.note(note({ tier: "long", kind: "decision", text: "older decision" }));
  expect(s.supersede(older, newer, "user")).toBe(true);
  expect(s.list({ q: "decision" }).map((v) => v.text)).toEqual(["newer decision"]);
  expect(s.list({ q: "decision", includeSuperseded: true })).toHaveLength(2);
  s.demote(newer, "user");
  expect(s.get(newer)).toMatchObject({ tier: "short" });
  s.forget(long, "user");
  expect(s.get(long)).toBeUndefined();
  expect(s.get(finding)).toBeUndefined(); // its short-term original stays hidden
  // Forgetting a long-term entry is written to the synced log, so other machines see it.
  expect(readFileSync(join(home, "memory", "log", `${s.machine.id}.jsonl`), "utf8")).toContain('"op":"forget"');
});

test("an incremental index equals a rebuild from the logs, in any order, and bad lines are skipped", () => {
  const home = temp("rebuild"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const a = s.note(note({ tier: "long", kind: "decision", text: "use sqlite", about: ["path:src/a.ts"] }));
  const b = s.note(note({ tier: "long", kind: "fail", text: "polling failed", about: ["path:src/a.ts", "issue:o/r#9"] }));
  s.note(note({ text: "short one", task: "work/app#1@1" }));
  s.supersede(a, b, "user");
  s.settle("work/app#1@1", "claude");
  // Another machine's segment arrives (a sync), written before ours.
  const other = temp("other");
  const t = store(other, { t: Date.parse("2026-09-01T00:00:00Z") });
  t.note(note({ tier: "long", kind: "contract", text: "from the other machine", scope: "shared" }));
  t.forget(t.note(note({ tier: "long", kind: "decision", text: "forgotten there" })), "user");
  const seg = `${t.machine.id}.jsonl`;
  writeFileSync(join(home, "memory", "log", seg), readFileSync(join(other, "memory", "log", seg)));
  appendFileSync(join(home, "memory", "log", seg), "not json\n" + JSON.stringify({ schema: "agent-hub.memory/v1", op: "note", id: "0".repeat(32), text: "tampered" }) + "\n");
  s.refresh();
  const incremental = s.dump();
  expect(s.list({ q: "other machine" })).toHaveLength(1);
  expect(s.list({ q: "forgotten there" })).toHaveLength(0);
  expect(s.list({ q: "tampered" })).toHaveLength(0);
  s.rebuild();
  expect(s.dump()).toBe(incremental);
  // A fresh index (another process, a deleted index.db) reads to the same rows.
  for (const f of readdirSync(join(home, "memory")).filter((n) => n.startsWith("index.db"))) rmSync(join(home, "memory", f));
  const fresh = store(home, clock);
  expect(fresh.dump()).toBe(incremental);
});

test("graph retrieval: entries one or two hops from the task's nodes, a linked fail first, superseded and other projects' entries out", () => {
  const home = temp("graph"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const tick = () => { clock.t += 1000; };
  const old = s.note(note({ tier: "long", kind: "decision", text: "old parser decision", about: ["symbol:parse@src/csv.ts"] })); tick();
  const cur = s.note(note({ tier: "long", kind: "decision", text: "current parser decision", about: ["symbol:parse@src/csv.ts"], supersedes: old })); tick();
  s.note(note({ tier: "long", kind: "fail", text: "regex split fails on quotes", about: ["path:src/csv.ts"] })); tick();
  s.note(note({ tier: "long", kind: "finding", text: "two hops away", about: ["path:src/csv.ts", "path:src/io.ts"] })); tick();
  s.note(note({ tier: "long", kind: "contract", text: "io contract", about: ["path:src/io.ts"] })); tick();
  s.note(note({ project: "work/other", tier: "long", kind: "decision", text: "other project private", about: ["symbol:parse@src/csv.ts"] })); tick();
  s.note(note({ project: "work/other", scope: "shared", tier: "long", kind: "contract", text: "other project shared", about: ["symbol:parse@src/csv.ts"] }));
  const got = s.related("work/app", ["path:src/csv.ts", "symbol:parse@src/csv.ts"], 8);
  expect(got[0]).toMatchObject({ kind: "fail", hops: 1 });
  expect(got.map((v) => v.text)).toContain("current parser decision");
  expect(got.map((v) => v.text)).toContain("other project shared");
  expect(got.map((v) => v.text)).not.toContain("old parser decision");
  expect(got.map((v) => v.text)).not.toContain("other project private");
  expect(got.find((v) => v.text === "io contract")).toMatchObject({ hops: 2 });
  expect(s.related("work/app", ["path:src/csv.ts"], 2)).toHaveLength(2);
  // The dashboard neighbourhood: typed nodes and labelled edges, capped.
  const g = s.graph("work/app", "path:src/csv.ts", 2);
  expect(g.nodes.find((n) => n.id === "path:src/csv.ts")).toMatchObject({ type: "path" });
  expect(g.edges.some((e) => e.rel === "rules_out" && e.to === "path:src/csv.ts")).toBe(true);
  expect(g.edges.some((e) => e.rel === "by" && e.to === "peer:codex")).toBe(true);
  expect(s.graph("work/app", "path:src/csv.ts", 2, 3).nodes).toHaveLength(3);
  expect(cur).toBeTruthy();
});

test("edges are extracted deterministically from refs, plans, existing paths, #N and task #N; secrets are recognised", () => {
  const cwd = temp("project");
  mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src", "real.ts"), "");
  const nodes = extractNodes("see src/real.ts and src/missing.ts, fixes #12 after task #4 (.env is denied)", { cwd, project: "work/app", repo: "o/r", paths: ["./src/a.ts", "../escape.ts"], symbols: ["parse"], task: { id: 7, created: 1 } });
  expect(nodes).toEqual(["issue:o/r#12", "path:src/a.ts", "path:src/real.ts", "symbol:parse@src/a.ts", "task:work/app#4", "task:work/app#7@1"]);
  expect(extractNodes("x", { cwd, project: "p", repo: "r", paths: [".env", "secrets/key.pem"] })).toEqual([]);
  for (const secret of ["-----BEGIN RSA PRIVATE KEY-----", "token: abcdefgh12345", "ghp_" + "a".repeat(36), "AKIAABCDEFGHIJKLMNOP"]) expect(looksSecret(secret)).toBe(true);
  expect(looksSecret("the token budget is 2000")).toBe(false);
});

test("review fixes: deadlines are fixed when written, ids resolve within the project's view, and a cut-short settlement finishes at the next start", () => {
  const home = temp("review"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const short = new MemoryStore({ home, now: () => clock.t, ttlMs: DAY, screen: () => "promote" }); stores.push(short);
  short.note(note({ kind: "finding", text: "one-day finding", task: "work/app#1@1" }));
  short.settle("work/app#1@1", "claude");
  // Another process with a 30-day TTL agrees with the deadline the first one wrote.
  clock.t += 2 * DAY;
  const long = new MemoryStore({ home, now: () => clock.t, ttlMs: 30 * DAY, screen: () => "promote" }); stores.push(long);
  expect(long.list({ q: "one-day" })).toEqual([]);
  long.note(note({ kind: "finding", text: "thirty-day finding", task: "work/app#2@2" }));
  long.settle("work/app#2@2", "claude");
  clock.t += 2 * DAY; short.refresh();
  expect(short.list({ q: "thirty-day" })).toHaveLength(1); // a short-TTL reader does not prune it early
  // Project scope applies to lookups by id.
  const mine = long.note(note({ tier: "long", text: "private to app" }));
  const shared = long.note(note({ tier: "long", text: "shared one", scope: "shared" }));
  expect(long.get(mine, "work/other")).toBeUndefined();
  expect(long.forget(mine, "user", "work/other")).toBeUndefined();
  expect(long.get(shared, "work/other")?.id).toBe(shared);
  expect(long.get(mine, "work/app")?.id).toBe(mine);
  // A crash after the settle entry and before the promotions: the next read finishes them.
  const dec = long.note(note({ kind: "decision", text: "decided before the crash", task: "work/app#3@3" }));
  const settle = { schema: "agent-hub.memory/v1", at: new Date(clock.t).toISOString(), machine: long.machine.id, op: "settle", target: "work/app#3@3", actor: "claude", by: new Date(clock.t + DAY).toISOString() } as const;
  appendFileSync(join(home, "memory", "local", `${long.machine.id}.jsonl`), JSON.stringify({ ...settle, id: entryId(settle) }) + "\n");
  long.refresh();
  expect(long.list({ q: "decided before the crash" })).toMatchObject([{ tier: "long", promotedFrom: dec }]);
  // Restarting after the settlement's deadline: the promotion stands, its source does not come back (review of #352).
  clock.t += 2 * DAY;
  const restarted = new MemoryStore({ home, now: () => clock.t, screen: () => "promote" }); stores.push(restarted);
  expect(restarted.list({ q: "decided before the crash" })).toMatchObject([{ tier: "long", promotedFrom: dec }]);
  // An expired entry is gone from reads at its deadline, before any write or refresh prunes it.
  const idle = restarted.note(note({ kind: "finding", text: "idle expiry" }));
  expect(restarted.get(idle)).toBeDefined();
  clock.t += 15 * DAY;
  expect(restarted.list({ q: "idle expiry" })).toEqual([]);
  expect(restarted.get(idle)).toBeUndefined();
});

test("review of #352: a demoted copy takes its hidden original with it, and malformed synced lines are skipped", () => {
  const home = temp("review2"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const src = s.note(note({ text: "promote me", task: "work/app#9@9" })); // the task stays open
  const copy = s.promote(src, "user")!;
  s.demote(copy, "user");
  clock.t += 15 * DAY; s.refresh();
  expect(s.list({ q: "promote me" })).toEqual([]);
  s.rebuild();
  expect(s.list({ q: "promote me" })).toEqual([]);
  // Hash-valid but missing required fields: skipped with a log line, and the store keeps working.
  for (const bad of [{ schema: "agent-hub.memory/v1", op: "note", kind: "decision", text: "x", about: [] }, { schema: "agent-hub.memory/v1", op: "forget", at: new Date(clock.t).toISOString(), machine: "m" }]) {
    appendFileSync(join(home, "memory", "log", "other.jsonl"), JSON.stringify({ ...bad, id: entryId(bad as never) }) + "\n");
  }
  s.refresh();
  expect(s.note(note({ tier: "long", text: "still works" }))).toBeTruthy();
  expect(s.list({ q: "still works" })).toHaveLength(1);
});

test("review of #352: twice-promoted chains, non-string metadata and provenance nodes", () => {
  const home = temp("review3"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const src = s.note(note({ text: "twice promoted", task: "work/app#5@5" }));
  const one = s.promote(src, "user")!; s.demote(one, "user");
  const two = s.promote(one, "user")!; s.demote(two, "user");
  clock.t += 15 * DAY; s.refresh();
  expect(s.list({ q: "twice promoted" })).toEqual([]);
  s.rebuild();
  expect(s.list({ q: "twice promoted" })).toEqual([]);
  const bad = { schema: "agent-hub.memory/v1", op: "note", at: new Date(clock.t).toISOString(), machine: "m2", project: "work/app", scope: "project", tier: "long", kind: "decision", peer: "codex", text: "x", about: [], source: {} };
  appendFileSync(join(home, "memory", "log", "m2.jsonl"), JSON.stringify({ ...bad, id: entryId(bad as never) }) + "\n");
  s.refresh();
  const kept = s.note(note({ tier: "long", text: "after the bad line" }));
  expect(s.get(kept)).toBeDefined();
  const g = s.graph("work/app", `machine:${s.machine.id}`);
  expect(g.edges).toContainEqual({ from: `mem:${kept}`, to: `machine:${s.machine.id}`, rel: "by" });
  expect(s.graph("work/app", "project:work/app").edges.some((e) => e.rel === "in")).toBe(true);
});

test("review of #352: a segment that shrinks rebuilds the index, and two hops pass through provenance", () => {
  const home = temp("review4"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const other = temp("other4");
  const t = store(other, clock);
  t.note(note({ tier: "long", text: "first from t" })); t.note(note({ tier: "long", text: "second from t" }));
  const seg = `${t.machine.id}.jsonl`;
  writeFileSync(join(home, "memory", "log", seg), readFileSync(join(other, "memory", "log", seg)));
  s.refresh();
  expect(s.list({ q: "from t" })).toHaveLength(2);
  // A sync reset leaves only the first line: the incremental index drops the second, as a rebuild would.
  const firstLine = readFileSync(join(other, "memory", "log", seg), "utf8").split("\n")[0] + "\n";
  writeFileSync(join(home, "memory", "log", seg), firstLine);
  s.refresh();
  expect(s.list({ q: "from t" }).map((v) => v.text)).toEqual(["first from t"]);
  const a = s.note(note({ tier: "long", text: "by codex one", peer: "codex" }));
  const b = s.note(note({ tier: "long", text: "by codex two", peer: "codex" }));
  expect(s.graph("work/app", `mem:${a}`, 2).nodes.map((n) => n.id)).toContain(`mem:${b}`);
});

test("review of #352: a segment rewritten in place without shrinking rebuilds the index", () => {
  const home = temp("review5"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock), other = temp("other5"), t = store(other, clock);
  t.note(note({ tier: "long", text: "original one" })); t.note(note({ tier: "long", text: "original two" }));
  const seg = `${t.machine.id}.jsonl`, file = join(other, "memory", "log", seg);
  writeFileSync(join(home, "memory", "log", seg), readFileSync(file));
  s.refresh();
  expect(s.list({ q: "original" })).toHaveLength(2);
  // History rewritten: the first entry is gone and later entries make the file at least as long as before.
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const extra = t.note(note({ tier: "long", text: "a later and much longer entry ".repeat(4) }));
  const after = readFileSync(file, "utf8").split("\n").filter(Boolean).filter((l) => l !== lines[0]);
  writeFileSync(join(home, "memory", "log", seg), after.join("\n") + "\n");
  s.refresh();
  expect(s.list({ q: "original" }).map((v) => v.text)).toEqual(["original two"]);
  expect(s.get(extra)).toBeDefined();
});

test("review of #352: a rewrite past the first 4 KiB is caught, and mem: ids resolve", () => {
  const home = temp("review6"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock), other = temp("other6"), t = store(other, clock);
  t.note(note({ tier: "long", text: "x".repeat(4000) })); const second = t.note(note({ tier: "long", text: "second original" }));
  const seg = `${t.machine.id}.jsonl`, file = join(other, "memory", "log", seg);
  writeFileSync(join(home, "memory", "log", seg), readFileSync(file));
  s.refresh();
  expect(s.get(second)).toBeDefined();
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const replacement = t.note(note({ tier: "long", text: "second rewritten, and longer than the original line" }));
  const rewritten = [lines[0], readFileSync(file, "utf8").split("\n").filter(Boolean).at(-1)].join("\n") + "\n";
  writeFileSync(join(home, "memory", "log", seg), rewritten);
  s.refresh();
  expect(s.get(second)).toBeUndefined();
  expect(s.get(`mem:${replacement.slice(0, 8)}`)?.id).toBe(replacement);
});

test("review of #352: a newer entry's graph shows what it supersedes, and a fresh home gets one machine id", () => {
  const home = temp("review7"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const old = s.note(note({ tier: "long", text: "old way" }));
  const newer = s.note(note({ tier: "long", text: "new way", supersedes: old }));
  expect(s.graph("work/app", `mem:${newer}`).edges).toContainEqual({ from: `mem:${newer}`, to: `mem:${old}`, rel: "supersedes" });
  const fresh = temp("fresh-home");
  const ids = new Set(Array.from({ length: 5 }, () => { const m = new MemoryStore({ home: fresh }); const id = m.machine.id; m.close(); return id; }));
  expect(ids.size).toBe(1);
  expect(readdirSync(join(fresh, "memory")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("review of #352: a replacement never narrows who sees an entry", () => {
  const home = temp("review8"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const shared = s.note(note({ tier: "long", scope: "shared", text: "shared decision" }));
  const local = s.note(note({ tier: "long", text: "project decision" }));
  const short = s.note(note({ text: "short decision" }));
  expect(s.supersede(shared, local, "user")).toBe(false);
  expect(s.supersede(local, short, "user")).toBe(false);
  expect(s.list({ project: "work/other", q: "shared decision" })).toHaveLength(1);
  expect(s.supersede(local, shared, "user")).toBe(true);
});

test("review of #352: projects are keyed by their origin remote, or by name and directory without one", () => {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  const a = join(temp("ka"), "frontend"), b = join(temp("kb"), "frontend");
  for (const d of [a, b]) { mkdirSync(d); git(d, "init", "-q"); }
  expect(memoryProjectKey(a)).not.toBe(memoryProjectKey(b));
  expect(memoryProjectKey(a)).toMatch(/^frontend@[0-9a-f]{8}$/);
  git(a, "remote", "add", "origin", "git@github.com:Owner/frontend.git");
  git(b, "remote", "add", "origin", "https://github.com/owner/Frontend");
  expect(memoryProjectKey(a)).toBe("github.com/owner/frontend");
  expect(memoryProjectKey(b)).toBe("github.com/owner/frontend"); // the same repository on another machine or path, any case
  git(b, "remote", "set-url", "origin", "ssh://git@github.com:22/Owner/frontend.git");
  expect(memoryProjectKey(b)).toBe("github.com/owner/frontend"); // a URL's port is not part of the repository
  git(b, "remote", "set-url", "origin", "ssh://git@git.example:2222/team/frontend.git");
  expect(memoryProjectKey(b)).toBe("git.example:2222/team/frontend"); // another service on another port is another repository
  git(b, "remote", "set-url", "origin", "ssh://git@[2001:db8::1]/team/frontend.git");
  expect(memoryProjectKey(b)).toBe("[2001:db8::1]/team/frontend"); // a bracketed IPv6 host
  git(b, "remote", "set-url", "origin", "git@[2001:db8::1]:/team/frontend.git");
  expect(memoryProjectKey(b)).toBe("[2001:db8::1]/team/frontend"); // the same absolute path, scp-style
  git(b, "remote", "set-url", "origin", "git@[2001:db8::1]:team/frontend.git");
  expect(memoryProjectKey(b)).toBe("[2001:db8::1]/~/team/frontend"); // relative to the remote home: another repository
  git(b, "remote", "set-url", "origin", "git@github.com:/Owner/frontend.git");
  expect(memoryProjectKey(b)).toBe("github.com/owner/frontend"); // GitHub: every form is one repository
});

test("review of #352: a late short-term note on a settled task gets its own clock, and a forgotten replacement shows the old entry again", () => {
  const home = temp("late"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#5@1";
  s.note(note({ text: "early", task }));
  s.settle(task, "claude");
  clock.t += 20 * DAY;
  const late = s.note(note({ text: "late finding", task }));
  expect(s.get(late, "work/app")?.expiresAt).toBe(new Date(clock.t + 14 * DAY).toISOString());
  const a = s.note(note({ tier: "long", kind: "decision", text: "A" }));
  const b = s.note(note({ tier: "long", kind: "decision", text: "B" }));
  s.supersede(a, b, "user", "work/app");
  expect(s.list({ project: "work/app" }).some((v) => v.id === a)).toBe(false);
  s.forget(b, "user", "work/app");
  expect(s.get(a, "work/app")).toMatchObject({ supersededBy: null });
  expect(s.list({ project: "work/app" }).some((v) => v.id === a)).toBe(true);
});

test("review of #352: a late short-term decision stays short-term, and an expired replacement shows the old entry before any prune", () => {
  const home = temp("late2"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#6@1";
  s.note(note({ text: "early", task }));
  s.settle(task, "claude");
  const late = s.note(note({ kind: "decision", text: "late decision", task }));
  expect(s.get(late, "work/app")).toMatchObject({ tier: "short", expiresAt: new Date(clock.t + 14 * DAY).toISOString() });
  const again = store(home, clock); // reopening reconciles settlements: the late note is not promoted
  expect(again.list({ project: "work/app" }).filter((v) => v.text === "late decision").map((v) => v.tier)).toEqual(["short"]);
  const a = s.note(note({ tier: "long", kind: "decision", text: "A" }));
  const b = s.note(note({ tier: "long", kind: "decision", text: "B" }));
  s.supersede(a, b, "user", "work/app");
  s.demote(b, "user", "work/app");
  clock.t += 15 * DAY; // no refresh, so nothing is pruned yet
  expect(s.list({ project: "work/app" }).map((v) => v.text)).toContain("A");
  // A demoted entry is still synced: a local replacement would reach only this machine.
  const c = s.note(note({ tier: "long", kind: "decision", text: "C" }));
  s.demote(c, "user", "work/app");
  expect(s.supersede(c, s.note(note({ kind: "decision", text: "local D" })), "user", "work/app")).toBe(false);
});

test("review of #352: a superseded source of a settled task is kept for when its replacement goes, and a corrupt machine id fails the store", () => {
  const home = temp("held"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#7@1";
  const a = s.note(note({ kind: "decision", text: "old decision", task }));
  const b = s.note(note({ tier: "long", kind: "decision", text: "new decision" }));
  expect(s.supersede(a, b, "user", "work/app")).toBe(true);
  s.settle(task, "claude");
  clock.t += 30 * DAY; s.refresh();
  s.forget(b, "user", "work/app");
  const shown = s.list({ project: "work/app" }).map((v) => v.text);
  s.rebuild();
  expect(s.list({ project: "work/app" }).map((v) => v.text)).toEqual(shown);
  expect(shown).toContain("old decision");
  const bad = temp("badid");
  mkdirSync(join(bad, "memory")); writeFileSync(join(bad, "memory", "machine.json"), JSON.stringify({ label: "x" }));
  expect(() => new MemoryStore({ home: bad })).toThrow("no valid machine id");
});

test("review of #352: a held source moves to long-term as soon as its replacement is forgotten", () => {
  const home = temp("pending"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#8@1";
  const a = s.note(note({ kind: "fail", text: "regex split fails", task }));
  const b = s.note(note({ tier: "long", kind: "fail", text: "regex split fails on quotes" }));
  s.supersede(a, b, "user", "work/app");
  expect(s.settle(task, "claude")).toBe(0);
  s.forget(b, "user", "work/app");
  expect(s.list({ project: "work/app", q: "regex" }).map((v) => [v.text, v.tier])).toEqual([["regex split fails", "long"]]);
});

test("review of #352: a held source is promoted when its replacement expires while the store is idle, and an unreadable expiry is skipped", () => {
  const home = temp("idle"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#9@1";
  const a = s.note(note({ kind: "contract", text: "parse owns quoting", task }));
  const b = s.note(note({ tier: "long", kind: "contract", text: "parse owns quoting and escapes" }));
  s.supersede(a, b, "user", "work/app");
  s.settle(task, "claude");
  s.demote(b, "user", "work/app");
  clock.t += 15 * DAY; // b expires; no write, no refresh
  const seen = s.list({ project: "work/app", q: "parse owns" }).map((v) => [v.text, v.tier]);
  s.rebuild();
  expect(s.list({ project: "work/app", q: "parse owns" }).map((v) => [v.text, v.tier])).toEqual(seen);
  expect(seen).toEqual([["parse owns quoting", "long"]]);
  const bad = { schema: "agent-hub.memory/v1", at: new Date(clock.t).toISOString(), machine: s.machine.id, op: "note", project: "work/app", scope: "project", tier: "short", kind: "finding", peer: "codex", text: "bad expiry", about: [], source: "hub", expires: "not-a-date" } as const;
  appendFileSync(join(home, "memory", "local", `${s.machine.id}.jsonl`), JSON.stringify({ ...bad, id: entryId(bad) }) + "\n");
  const { expires: _unused, ...rest } = bad;
  const odd = { ...rest, text: "odd tier", tier: "medium" };
  appendFileSync(join(home, "memory", "local", `${s.machine.id}.jsonl`), JSON.stringify({ ...odd, id: entryId(odd) }) + "\n");
  s.refresh();
  expect(s.list({ q: "bad expiry" })).toEqual([]);
  expect(s.list({ q: "odd tier" })).toEqual([]);
});

test("review of #352: a promoted replacement keeps its supersession, and a promotion is dated as its source", () => {
  const home = temp("rebind"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#10@1";
  const a = s.note(note({ tier: "long", kind: "decision", text: "old long decision" }));
  const b = s.note(note({ kind: "decision", text: "new short decision", task }));
  expect(s.supersede(a, b, "user", "work/app")).toBe(false); // a synced entry is never replaced by a local one
  const c = s.note(note({ kind: "decision", text: "older short decision", task }));
  expect(s.supersede(c, b, "user", "work/app")).toBe(true);
  clock.t += DAY;
  s.settle(task, "claude");
  const copy = s.list({ project: "work/app", q: "new short decision" })[0]!;
  expect(copy).toMatchObject({ tier: "long", promotedFrom: b });
  expect(copy.at).toBe(new Date(Date.parse("2026-10-01T00:00:00Z")).toISOString());
  expect(copy.supersedes).toEqual([c]);
  expect(s.list({ project: "work/app", q: "older short decision", includeSuperseded: true })[0]!.supersededBy).toBe(copy.id);
});

test("review of #352: an explicit short note on an open task keeps its own deadline through approval", () => {
  const home = temp("ownclock"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#11@1";
  const id = s.note(note({ kind: "decision", text: "scratch", task }), true);
  const own = new Date(clock.t + 14 * DAY).toISOString();
  expect(s.get(id)?.expiresAt).toBe(own);
  clock.t += 10 * DAY;
  s.settle(task, "claude");
  expect(s.get(id)).toMatchObject({ tier: "short", expiresAt: own });
});

test("review of #352: a short-term id kept past its task's approval reaches the promoted copy", () => {
  const home = temp("kept"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const task = "work/app#12@1";
  const id = s.note(note({ kind: "decision", text: "kept id", task }));
  s.settle(task, "claude");
  const copy = s.list({ q: "kept id" })[0]!;
  expect(copy).toMatchObject({ tier: "long", promotedFrom: id });
  expect(s.get(id)?.id).toBe(copy.id);
  s.forget(id, "user");
  expect(s.list({ q: "kept id" })).toEqual([]);
});

test("review of #352: a supersession that would close a cycle is refused, and an undated settle is skipped", () => {
  const home = temp("cycle"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const [a, b, c] = ["A", "B", "C"].map((text) => s.note(note({ tier: "long", kind: "decision", text })));
  expect(s.supersede(a!, b!, "user")).toBe(true);
  expect(s.supersede(b!, c!, "user")).toBe(true);
  expect(s.supersede(c!, a!, "user")).toBe(false);
  expect(s.list().map((v) => v.text)).toEqual(["C"]);
  const bad = { schema: "agent-hub.memory/v1", at: new Date(clock.t).toISOString(), machine: s.machine.id, op: "settle", target: "work/app#13@1", actor: "claude", by: "not-a-date" } as const;
  appendFileSync(join(home, "memory", "local", `${s.machine.id}.jsonl`), JSON.stringify({ ...bad, id: entryId(bad) }) + "\n");
  s.refresh();
  expect(s.settled("work/app#13@1")).toBe(false);
});

test("review of #352: a cycle made by supersessions written apart drops its earliest relation", () => {
  const home = temp("cycle2"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const [a, b] = ["A", "B"].map((text) => s.note(note({ tier: "long", kind: "decision", text })));
  expect(s.supersede(a!, b!, "user")).toBe(true);
  // Another process, on its own snapshot, records the opposite relation later.
  clock.t += 1000;
  const op = { schema: "agent-hub.memory/v1", at: new Date(clock.t).toISOString(), machine: s.machine.id, op: "supersede", target: b!, by: a!, actor: "user" } as const;
  appendFileSync(join(home, "memory", "log", `${s.machine.id}.jsonl`), JSON.stringify({ ...op, id: entryId(op) }) + "\n");
  s.refresh();
  expect(s.list().map((v) => v.text)).toEqual(["A"]);
});

test("review of #352: a later supersede op wins over an earlier note's own supersedes", () => {
  const home = temp("fold"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const a = s.note(note({ tier: "long", kind: "decision", text: "A" }));
  const b = s.note(note({ tier: "long", kind: "decision", text: "B", supersedes: a }));
  clock.t += 1000;
  const c = s.note(note({ tier: "long", kind: "decision", text: "C" }));
  expect(s.supersede(a, c, "user")).toBe(true);
  expect(s.get(a)?.supersededBy).toBe(c);
  expect(s.get(b)?.supersedes).toEqual([]);
});

test("review of #352: two machines promoting the same demoted entry write one copy", () => {
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const one = store(temp("m1"), clock), twoHome = temp("m2");
  const x = one.note(note({ tier: "long", kind: "decision", text: "shared decision" }));
  one.demote(x, "user");
  // The other machine has the synced log.
  mkdirSync(join(twoHome, "memory", "log"), { recursive: true });
  writeFileSync(join(twoHome, "memory", "log", `${one.machine.id}.jsonl`), readFileSync(join(one.dir, "log", `${one.machine.id}.jsonl`)));
  const two = store(twoHome, clock);
  expect(two.machine.id).not.toBe(one.machine.id);
  clock.t += 1000;
  expect(two.promote(x, "user")).toBe(one.promote(x, "user"));
});

test("review of #352: a read prunes what expired while the store sat idle, so the index equals a rebuild", () => {
  const home = temp("idleprune"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  s.note(note({ text: "short-lived" }));
  clock.t += 15 * DAY;
  expect(s.list()).toEqual([]);
  const before = s.dump();
  s.rebuild();
  expect(s.dump()).toBe(before);
});

test("review of #352: another machine with only the synced copy resolves the original short-term id", () => {
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const one = store(temp("src1"), clock), twoHome = temp("src2");
  const task = "work/app#14@1";
  const id = one.note(note({ kind: "decision", text: "synced copy only", task }));
  one.settle(task, "claude");
  mkdirSync(join(twoHome, "memory", "log"), { recursive: true });
  writeFileSync(join(twoHome, "memory", "log", `${one.machine.id}.jsonl`), readFileSync(join(one.dir, "log", `${one.machine.id}.jsonl`)));
  const two = store(twoHome, clock);
  expect(two.get(id)).toMatchObject({ tier: "long", promotedFrom: id });
});

test("review of #352: --since compares instants, offsets included", () => {
  const home = temp("since"), clock = { t: Date.parse("2026-10-12T14:00:00Z") };
  const s = store(home, clock);
  s.note(note({ tier: "long", kind: "decision", text: "at 14Z" }));
  expect(s.list({ since: "2026-10-12T10:00:00-05:00" })).toEqual([]); // 15:00Z
  expect(s.list({ since: "2026-10-12T08:00:00-05:00" }).map((v) => v.text)).toEqual(["at 14Z"]); // 13:00Z
});

test("review of #352: promoting a replaced entry keeps it replaced, and a non-UTC at is skipped", () => {
  const home = temp("promoteold"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const old = s.note(note({ kind: "decision", text: "old short decision" }));
  const newer = s.note(note({ tier: "long", kind: "decision", text: "new long decision" }));
  expect(s.supersede(old, newer, "user")).toBe(true);
  expect(s.promote(old, "user")).toBeUndefined(); // a replaced entry is not promoted: its replacement is
  expect(s.list().map((v) => v.text)).toEqual(["new long decision"]);
  const off = { schema: "agent-hub.memory/v1", at: "2026-10-01T10:00:00-05:00", machine: s.machine.id, op: "note", project: "work/app", scope: "project", tier: "long", kind: "finding", peer: "codex", text: "offset at", about: [], source: "hub" } as const;
  appendFileSync(join(home, "memory", "log", `${s.machine.id}.jsonl`), JSON.stringify({ ...off, id: entryId(off) }) + "\n");
  s.refresh();
  expect(s.list({ q: "offset at" })).toEqual([]);
});

test("a replaced promoted copy stays replaced on another machine", () => {
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const one = store(temp("rep1"), clock), twoHome = temp("rep2");
  const old = one.note(note({ kind: "decision", text: "old local decision" }));
  const newer = one.note(note({ tier: "long", kind: "decision", text: "newer synced decision" }));
  one.supersede(old, newer, "user");
  expect(one.promote(old, "user")).toBeUndefined();
  mkdirSync(join(twoHome, "memory", "log"), { recursive: true });
  writeFileSync(join(twoHome, "memory", "log", `${one.machine.id}.jsonl`), readFileSync(join(one.dir, "log", `${one.machine.id}.jsonl`)));
  expect(store(twoHome, clock).list().map((v) => v.text)).toEqual(["newer synced decision"]);
});

test("unapproved task notes expire at the backstop; injected command read policy withholds output and propagates errors", async () => {
  const home = temp("orphan"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  s.note(note({ text: "on an abandoned task", task: "work/app#15@1" }));
  clock.t += 179 * DAY;
  expect(s.list({ q: "abandoned" })).toHaveLength(1);
  clock.t += 2 * DAY;
  expect(s.list({ q: "abandoned" })).toEqual([]);
  const cwd = temp("cli"), project = memoryProjectKey(cwd);
  const pii = s.note(note({ project, tier: "long", kind: "decision", text: "call 900101-1234567 about it" }));
  s.note(note({ project, tier: "long", kind: "decision", text: "a clean decision" }));
  const readable = <T extends { text: string }>(rows: T[]) => rows.filter(v => !/\d{6}-\d{7}/.test(v.text));
  const out = await memoryCommand(["list"], cwd, { store: s, readable });
  expect(out).toContain("a clean decision");
  expect(out).not.toContain("900101-1234567");
  expect(out).toContain("1 withheld");
  await expect(memoryCommand(["show", pii], cwd, { store: s, readable })).rejects.toThrow("withheld");
  // Caller policy failure propagates; hub-specific config loading is tested in agent-hub.
  await expect(memoryCommand(["list"], cwd, { store: s, readable: () => { throw new Error("policy unavailable"); } })).rejects.toThrow("policy unavailable");
});

test("review of #352: a note written while the index is locked shows on the next read", () => {
  const home = temp("busy"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock);
  const other = new Database(join(home, "memory", "index.db"));
  other.run("BEGIN IMMEDIATE");
  s.note(note({ tier: "long", kind: "decision", text: "written while locked" })); // the line is saved; the index waits
  other.run("COMMIT");
  other.close();
  expect(s.list({ q: "written while locked" })).toHaveLength(1);
}, 15_000);

test("review of #352: a long-lived store reads what another process wrote, with no write of its own", () => {
  const home = temp("twoproc"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const daemon = store(home, clock), cli = store(home, clock);
  expect(daemon.list()).toEqual([]);
  // The CLI writes while the index is locked, so its own refresh fails, and then it exits.
  const lock = new Database(join(home, "memory", "index.db"));
  lock.run("BEGIN IMMEDIATE");
  const id = cli.note(note({ tier: "long", kind: "decision", text: "from the cli" }));
  lock.run("COMMIT"); lock.close();
  cli.close(); stores.splice(stores.indexOf(cli), 1);
  expect(daemon.list().map((v) => v.id)).toEqual([id]);
}, 15_000);

for (const anotherReader of [false, true]) {
  for (const change of ["goal", "goal state", "goal link", "lease", "suggestion", "suggestion verdict"] as const) {
    test(`review of #378: deferred ${change} is indexed by the next ${anotherReader ? "other store's" : "writer's"} relevant read`, () => {
      const home = temp("deferred-goals"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
      const writer = store(home, clock);
      const goalInput = { project: "work/app", scope: "project" as const, title: "ship memory", milestones: [], dependsOn: [], actor: "user" };
      let goal = change === "goal" ? "" : writer.goal(goalInput);
      const a = writer.note(note({ tier: "long", text: "first decision" }));
      const b = writer.note(note({ tier: "long", text: "second decision" }));
      let suggestion = change === "suggestion verdict" ? writer.suggest(a, b, "same_topic")! : "";
      const reader = anotherReader ? store(home, clock) : writer;
      const task = "work/app#3@1";
      const lock = new Database(join(home, "memory", "index.db"));
      lock.run("BEGIN IMMEDIATE");
      try {
        // The public mutation succeeds because its log line persists, but the index update times out.
        switch (change) {
          case "goal": goal = writer.goal(goalInput); break;
          case "goal state": writer.goalState(goal, "active", "user"); break;
          case "goal link": writer.goalLink(goal, task, "user"); break;
          case "lease": expect(writer.take(goal, "user")).toMatchObject({ ok: true }); break;
          case "suggestion": suggestion = writer.suggest(a, b, "same_topic")!; break;
          case "suggestion verdict": writer.judge(suggestion, "confirm", "user"); break;
        }
      } finally { lock.run("COMMIT"); lock.close(); }
      // No note/list read or explicit refresh may repair the index before the relevant surface reads it.
      switch (change) {
        case "goal": expect(reader.goalOf(goal)?.title).toBe("ship memory"); break;
        case "goal state": expect(reader.goalOf(goal)?.state).toBe("active"); break;
        case "goal link": expect(reader.goalsOfTask(task).map((g) => g.id)).toEqual([goal]); break;
        case "lease": expect(reader.goalOf(goal)?.lease.holder).toBe(writer.machine.id); break;
        case "suggestion": expect(reader.suggestions()).toMatchObject([{ id: suggestion, status: "suggested" }]); break;
        case "suggestion verdict": expect(reader.suggestions()).toMatchObject([{ id: suggestion, status: "confirmed" }]); break;
      }
      const indexed = reader.dump();
      reader.rebuild();
      expect(reader.dump()).toBe(indexed);
    }, 15_000);
  }
}

test("review of #352: every promotion goes through the screen: a note it keeps stays short-term, another project's waits", () => {
  const home = temp("keepshort"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const s = store(home, clock, (v) => v.project !== "work/app" ? "skip" : v.text.includes("data/exports") ? "keep" : "promote");
  const task = "work/app#16@1";
  s.note(note({ kind: "decision", text: "decided about data/exports", task }));
  s.note(note({ kind: "decision", text: "a clean decision", task }));
  s.note(note({ project: "other/app", kind: "decision", text: "another project's decision", task: "other/app#1@1" }));
  expect(s.settle(task, "claude")).toBe(1);
  s.settle("other/app#1@1", "claude");
  expect(s.list().map((v) => [v.text, v.tier]).sort()).toEqual([["a clean decision", "long"], ["another project's decision", "short"], ["decided about data/exports", "short"]]);
  expect(readFileSync(join(home, "memory", "log", `${s.machine.id}.jsonl`), "utf8")).not.toContain("data/exports");
  clock.t += 15 * DAY;
  expect(s.list().map((v) => v.text).sort()).toEqual(["a clean decision", "another project's decision"]); // the other project's still waits, held
  // A store with no screen promotes nothing on its own.
  const bare = new MemoryStore({ home: temp("bare"), now: () => clock.t }); stores.push(bare);
  bare.note(note({ kind: "fail", text: "a fail", task: "work/app#17@1" }));
  expect(bare.settle("work/app#17@1", "claude")).toBe(0);
});

test("injected promotion policy preserves task keys, keeps refused notes short-term and exposes command refusal", async () => {
  const home = temp("screen2"), clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const cwd = temp("screencwd"), project = memoryProjectKey(cwd);
  // The core receives a policy callback; its decisions and task-key inputs are preserved unchanged.
  const screen: PromotionScreen = v => v.task?.endsWith("#4@1791000000000") ? "keep" : "promote";
  const s = store(home, clock, screen);
  s.note(note({ project, kind: "decision", text: "use a row hash to dedupe", task: `${project}#3@1791000000001` }));
  s.note(note({ project, kind: "decision", text: "dedupe by row hash", task: `${project}#4@1791000000000` }));
  s.settle(`${project}#3@1791000000001`, "claude");
  s.settle(`${project}#4@1791000000000`, "claude");
  expect(s.list().map((v) => [v.text, v.tier]).sort()).toEqual([["dedupe by row hash", "short"], ["use a row hash to dedupe", "long"]]);
  const kept = s.list({ q: "dedupe by row hash" })[0]!;
  const before = kept.expiresAt;
  s.promote(kept.id, "user");
  expect(s.get(kept.id)?.expiresAt).toBe(before); // a second refusal never pushes the deadline out
  await expect(memoryCommand(["promote", kept.id], cwd, { store: s })).rejects.toThrow("stays short-term");
});
