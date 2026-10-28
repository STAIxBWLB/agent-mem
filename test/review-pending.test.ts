import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliContext } from "../src/cli.ts";
import { runHook } from "../src/hooks.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { ptyArgv } from "./fakes/pty.ts";
import { CandidateStore, CANDIDATE_RETENTION, type CandidateInput } from "../src/memory/candidates.ts";
import { CANDIDATE_AGE_MS, CANDIDATE_SHOWN_GRACE_MS, markShown, pendingLine, pendingSummary } from "../src/memory/candidate-pending.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

// agent-mem#40 F7 / AC4: the brief says how many candidates wait, `amem review` walks them, and no candidate expires without having been shown.
const DAY = 86400_000, START = Date.parse("2026-10-01T00:00:00.000Z");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-review-test-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(memory, { recursive: true }); mkdirSync(join(cwd, ".git"), { recursive: true });
  const clock = { now: START }, project = memoryProjectKey(cwd);
  const candidates = new CandidateStore({ memoryDir: memory, now: () => clock.now }); cleanup.push(() => candidates.close());
  const put = (text: string, input: Partial<CandidateInput> = {}) => candidates.put({ project, kind: "memory", text, ...input } as CandidateInput, "public");
  return { root, memory, cwd, project, clock, candidates, put };
}
const rows = (r: ReturnType<typeof rig>) => r.candidates.list({ project: r.project, status: "all" });
async function cli(r: ReturnType<typeof rig>, args: string[], extra: Partial<CliContext> = {}): Promise<string> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.memory;
  try { return await runCli(args, { cwd: r.cwd, env: {}, stdinTTY: true, ...extra }); } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}
const shownAt = (r: ReturnType<typeof rig>, id: string): number | null => {
  const db = new Database(join(r.memory, "candidates.db"), { readonly: true });
  try { return (db.query("SELECT shown_at FROM candidates WHERE id = ?").get(id) as { shown_at: number | null }).shown_at; } finally { db.close(); }
};
const brief = (r: ReturnType<typeof rig>, now = () => r.clock.now) => sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project, now });

// ---- F7: the brief line ----

test("the brief carries one line, N candidates pending and the days left, and a brief with none is unchanged", async () => {
  const r = rig();
  const none = await brief(r);
  expect(none.context).not.toContain("pending");
  r.put("first"); r.clock.now += 3 * DAY; r.put("second");
  const result = await brief(r);
  const lines = result.context.split("\n");
  expect(lines[0]).toStartWith("Untrusted project memory data");
  expect(lines[1]).toBe("2 candidates pending, oldest expires in 27 days");   // created 3 days ago, so 27 of its 30 are left; it is kept until shown regardless
  r.candidates.reject(rows(r).find(candidate => candidate.input.kind === "memory" && candidate.input.text === "first")!.id, { project: r.project, actor: "person", verdict: "public" });
  expect((await brief(r)).context.split("\n")[1]).toBe("1 candidate pending, oldest expires in 30 days");   // the remaining one is the newer, so its own 30
});

test("the line is numbers only: no candidate text or title can reach it, and it fits the byte budget it is reserved from", async () => {
  const r = rig();
  r.put("SECRET-CANDIDATE-BODY", { title: "SECRET-CANDIDATE-TITLE" });
  const result = await sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project, now: () => r.clock.now, maxTokens: 500 });
  expect(result.context).not.toContain("SECRET-CANDIDATE"); expect(result.tokens).toBeLessThanOrEqual(500);
  expect(pendingLine({ count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 })).toBeUndefined();
  // The line is reserved out of the same budget: 162 bytes holds the header and records but not the line, 165 holds it too. Neither brief exceeds its budget.
  const without = await sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project, now: () => r.clock.now, maxTokens: 162 });
  // The brief itself must survive: a line that overran the budget would drive it negative and blank the whole brief.
  expect(without.context).not.toContain("pending"); expect(without.context).toStartWith("Untrusted project memory data"); expect(without.tokens).toBeGreaterThan(0); expect(without.tokens).toBeLessThanOrEqual(162);
  const within = await sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project, now: () => r.clock.now, maxTokens: 165 });
  expect(within.context).toContain("pending"); expect(within.tokens).toBeLessThanOrEqual(165);
  const tiny = await sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project, now: () => r.clock.now, maxTokens: 60 });
  expect(tiny.context).not.toContain("pending");
});

test("the brief reads candidates read-only: it creates no database, adds no column and prunes nothing", async () => {
  const r = rig();
  const fresh = realPath(mkdtempSync(join(tmpdir(), "amem-review-empty-"))); cleanup.push(() => rmSync(fresh, { recursive: true, force: true }));
  expect(pendingSummary(fresh, [r.project], START)).toEqual({ count: 0, oldestExpiresInDays: null, dueWithin7Days: 0, unshown: 0 });
  expect((await import("node:fs")).existsSync(join(fresh, "candidates.db"))).toBe(false);
  // An old database without the column is read as "never shown" and is left as it was.
  const old = realPath(mkdtempSync(join(tmpdir(), "amem-review-old-"))); cleanup.push(() => rmSync(old, { recursive: true, force: true }));
  const db = new Database(join(old, "candidates.db"), { create: true });
  db.run("CREATE TABLE candidates (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, note_id TEXT)");
  db.query("INSERT INTO candidates VALUES ('a', 'p', 'memory', '{}', ?, 'pending', NULL)").run(START); db.close();
  expect(pendingSummary(old, ["p"], START + 29 * DAY)).toMatchObject({ count: 1, unshown: 1 });
  expect(markShown(old, ["p"], START)).toBe(0);                                       // no column: nothing stamped, nothing altered
  const after = new Database(join(old, "candidates.db"), { readonly: true });
  expect((after.query("PRAGMA table_info(candidates)").all() as { name: string }[]).map(column => column.name)).not.toContain("shown_at"); after.close();
});

test("the pending count follows aliases and never counts another project", async () => {
  const r = rig();
  r.put("mine"); r.candidates.put({ project: "another/project", kind: "memory", text: "theirs" }, "public");
  expect(pendingSummary(r.memory, [r.project], r.clock.now).count).toBe(1);
  expect(pendingSummary(r.memory, [r.project, "another/project"], r.clock.now).count).toBe(2);
});

// ---- AC4: no candidate expires without having been shown ----

test("AC4: an unshown candidate survives its 30 days, however old, and a shown one goes only after its grace", () => {
  const r = rig();
  const a = r.put("never shown");
  r.clock.now += CANDIDATE_AGE_MS + 90 * DAY;                                         // four months later
  expect(rows(r).map(candidate => candidate.id)).toEqual([a]);                        // still here: nobody has seen it
  expect(markShown(r.memory, [r.project], r.clock.now, [a])).toBe(1);
  r.clock.now += CANDIDATE_SHOWN_GRACE_MS - 1;
  expect(rows(r)).toHaveLength(1);                                                    // shown, but the grace has not passed
  r.clock.now += 1;
  expect(rows(r)).toEqual([]);                                                        // shown and past grace and age: now it may go
});

test("AC4: a candidate shown a day before its 30th day keeps its full grace past the age", () => {
  const r = rig();
  const a = r.put("shown late");
  r.clock.now += 29 * DAY; markShown(r.memory, [r.project], r.clock.now, [a]);
  r.clock.now += 2 * DAY;                                                             // age passed 1 day ago, shown 2 days ago
  expect(rows(r)).toHaveLength(1);
  r.clock.now += 5 * DAY + 1;                                                         // 7 days after it was shown
  expect(rows(r)).toEqual([]);
});

test("AC4: the first time shown is kept, a later showing never extends it", () => {
  const r = rig();
  const a = r.put("shown twice");
  markShown(r.memory, [r.project], r.clock.now, [a]); const first = shownAt(r, a);
  r.clock.now += 10 * DAY; expect(markShown(r.memory, [r.project], r.clock.now, [a])).toBe(0);
  expect(shownAt(r, a)).toBe(first);
});

test("AC4: a decided candidate expires by age as before, and an accepted or rejected one never blocks the cap", () => {
  const r = rig();
  const a = r.put("rejected one"); r.candidates.reject(a, { project: r.project, actor: "person", verdict: "public" });
  r.clock.now += CANDIDATE_AGE_MS;
  expect(rows(r)).toEqual([]);
});

test("AC4: the count cap evicts decided and shown rows first, never an unshown pending one, and refuses a new candidate instead of dropping one", () => {
  const r = rig();
  const first = r.put("unshown at the bottom of the heap");
  for (let i = 0; i < CANDIDATE_RETENTION.count - 1; i++) { r.clock.now++; r.put(`filler ${i}`); }
  expect(rows(r)).toHaveLength(CANDIDATE_RETENTION.count);
  r.clock.now++;
  expect(() => r.put("one too many")).toThrow("500 unshown candidates await review");
  expect(() => r.put("another")).toThrow("Run `amem review`");
  try { r.put("another"); } catch (error) { expect((error as { code?: string }).code).toBe("candidate_queue_full"); expect((error as Error).name).toBe("CandidateQueueFull"); }        // refused, named, not silently dropped
  expect(rows(r).some(candidate => candidate.id === first)).toBe(true);
  // Once the person has seen and decided some, there is room and the oldest unshown is still kept.
  const victim = rows(r).find(candidate => candidate.id !== first)!;
  r.candidates.reject(victim.id, { project: r.project, actor: "person", verdict: "public" });
  r.clock.now++; r.put("room now");
  expect(rows(r).some(candidate => candidate.id === first)).toBe(true); expect(rows(r).some(candidate => candidate.id === victim.id)).toBe(false);
  // The same candidate proposed again is not a new one and is not refused.
  expect(() => r.put("filler 3")).not.toThrow();
});

test("AC4: a database from before the column gains it on open, keeps its rows, and treats them as unshown", () => {
  const r = rig();
  r.candidates.close();
  const db = new Database(join(r.memory, "candidates.db"));
  db.run("ALTER TABLE candidates DROP COLUMN shown_at"); db.close();
  const reopened = new CandidateStore({ memoryDir: r.memory, now: () => r.clock.now }); cleanup.push(() => reopened.close());
  reopened.put({ project: r.project, kind: "memory", text: "after the upgrade" }, "public");
  const check = new Database(join(r.memory, "candidates.db"), { readonly: true });
  expect((check.query("PRAGMA table_info(candidates)").all() as { name: string }[]).map(column => column.name)).toContain("shown_at"); check.close();
});

test("AC4: review list stamps nothing, with or without a terminal and with or without --json: only review walk, which prints the content, shows a candidate (review finding 5)", async () => {
  const r = rig();
  const a = r.put("one"), b = r.put("two");
  r.candidates.close();
  for (const [args, extra] of [[["review", "list"], {}], [["review", "list", "--json"], {}], [["review", "list"], { stdinTTY: false }], [["review", "list", "--json"], { stdinTTY: false }], [["review", "--json"], {}]] as const) {
    await cli(r, [...args], { ...extra });
    expect(shownAt(r, a), args.join(" ")).toBeNull(); expect(shownAt(r, b)).toBeNull();
  }
  await expect(cli(r, ["review", "list", "--json"], { env: { CLAUDECODE: "fixture" }, stdinTTY: false })).rejects.toThrow("Memory operation unavailable or refused; no partial result is shown.");
  expect(shownAt(r, a)).toBeNull(); expect(shownAt(r, b)).toBeNull();
  // `list </dev/null` as a script or cron runs it: the 7-day clock must not start with nobody reading.
  const real = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/amem.js"), "review", "list"], { cwd: r.cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AMEM_HOME: r.memory }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(real.exitCode).toBe(0); expect(real.stdout.toString()).toContain(a); expect(shownAt(r, a)).toBeNull();
});

// ---- the hook: it tells, it never stamps ----

test("the real SessionStart hook shows the line but NEVER stamps a candidate as shown: only review list and review walk do (claude's ruling)", async () => {
  const f = hookFixture(); cleanup.push(f.close); await f.seed();
  const options = { cwd: f.cwd, base: f.base };
  const store = new CandidateStore({ memoryDir: f.base }); cleanup.push(() => store.close());
  const a = store.put({ project: f.project, kind: "memory", text: "wait for the person" }, "public");
  const stamp = () => { const db = new Database(join(f.base, "candidates.db"), { readonly: true }); try { return (db.query("SELECT shown_at FROM candidates WHERE id = ?").get(a) as { shown_at: number | null }).shown_at; } finally { db.close(); } };
  const shown = await runHook("SessionStart", { prompt: "y" }, options, { deadlineMs: 2000 });
  expect(shown.output!.hookSpecificOutput.additionalContext.split("\n")[1]).toMatch(/^1 candidate pending, oldest expires in \d+ days?$/);   // the person is told
  expect(stamp()).toBeNull();                                                          // but the hook wrote nothing: a line in a context nobody read is not "shown"
  const again = await runHook("SessionStart", { prompt: "z" }, options, { deadlineMs: 2000 });
  expect(again.output!.hookSpecificOutput.additionalContext).toContain("candidate pending"); expect(stamp()).toBeNull();
});

test("the brief reader is read-only: it opens no write handle, so it cannot stamp (the source never imports markShown on the hook path)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/hooks.ts", "../src/session-brief.ts", "../src/session-brief-worker.ts"]) expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toContain("markShown");
});

// ---- amem status ----

test("amem status reports the pending candidates and warns within 7 days of expiry", async () => {
  const r = rig(); r.clock.now = Date.now();                                          // status reads the real clock
  const a = r.put("will be due");
  const quiet = JSON.parse(await cli(r, ["status", "--json"])) as { candidates: { count: number; dueWithin7Days: number; warning?: string } };
  expect(quiet.candidates).toMatchObject({ count: 1, dueWithin7Days: 0 }); expect(quiet.candidates.warning).toBeUndefined();
  r.candidates.close(); markShown(r.memory, [r.project], START, [a]);
  const db = new Database(join(r.memory, "candidates.db")); db.query("UPDATE candidates SET at = ?").run(Date.now() - 25 * DAY); db.close();   // 5 days left
  const due = JSON.parse(await cli(r, ["status", "--json"])) as { candidates: { count: number; dueWithin7Days: number; warning?: string } };
  expect(due.candidates).toMatchObject({ count: 1, dueWithin7Days: 1 }); expect(due.candidates.warning).toContain("within 7 days of expiry");
});

// ---- amem review walk ----

/** A person at the keyboard: `events` records, in order, every line printed (`out:`) and every question asked (`ask:`), so a test can assert what was on screen when a decision was requested. */
function scripted(answers: string[], seen: string[] = [], events: string[] = []): Partial<CliContext> {
  return { write: text => { events.push(`out:${text}`); }, prompt: question => { seen.push(question); events.push(`ask:${question}`); return answers.shift() ?? null; } };
}
const printed = (events: string[]) => events.filter(event => event.startsWith("out:")).map(event => event.slice(4)).join("\n");

test("review walk prints each candidate BEFORE it asks, and stamps it only after the write (review finding 4)", async () => {
  const r = rig();
  const a = r.put("accept me"), b = r.put("reject me"), c = r.put("edit me", { title: "edited title" } as Partial<CandidateInput>), d = r.put("skip me");
  r.candidates.close();
  const events: string[] = [], stampsAtAsk: (number | null)[][] = [];
  const person = scripted(["a", "r", "e", "s"], [], events);
  // At each question, look at what is on screen so far and what is stamped: the candidate being asked about must already be printed, and stamped only because it was.
  const ask = person.prompt!;
  person.prompt = question => { stampsAtAsk.push([a, b, c, d].map(id => shownAt(r, id))); return ask(question); };
  const out = await cli(r, ["review", "walk"], { ...person, edit: initial => `${initial} (edited by the person)` });
  expect(out).toBe("accepted 1, edited 1, rejected 1, skipped 1, failed 0");
  const asks = events.map((event, index) => event.startsWith("ask:") ? index : -1).filter(index => index >= 0);
  expect(asks).toHaveLength(4);
  const texts = ["accept me", "reject me", "edit me", "skip me"];
  asks.forEach((at, index) => {
    const before = events.slice(0, at).filter(event => event.startsWith("out:")).join("\n");
    expect(before, `question ${index + 1} is asked after its candidate is printed`).toContain(texts[index]!);
    expect(before).toContain(`${index + 1}/4`);
    // Oldest first, and the candidate asked about is the one printed last before the question.
    expect(events[at - 1]).toContain(texts[index]!);
  });
  // Stamped at the moment of each question: the candidates up to and including the current one, never a later one.
  stampsAtAsk.forEach((stamps, index) => stamps.forEach((stamp, which) => { if (which <= index) expect(stamp, `candidate ${which + 1} at question ${index + 1}`).not.toBeNull(); else expect(stamp, `candidate ${which + 1} at question ${index + 1}`).toBeNull(); }));
  const after = new CandidateStore({ memoryDir: r.memory, now: () => r.clock.now }); cleanup.push(() => after.close());
  const status = Object.fromEntries(after.list({ project: r.project, status: "all" }).map(candidate => [candidate.input.kind === "memory" ? candidate.input.text : "", candidate.status]));
  expect(status).toEqual({ "accept me": "accepted", "reject me": "rejected", "edit me": "rejected", "skip me": "pending" });
  const store = new MemoryStore({ memoryDir: r.memory, screen: () => "keep" }); cleanup.push(() => store.close());
  const notes = store.list({ project: r.project, limit: 20 }).map(note => note.text);
  expect(notes.some(text => text.includes("accept me"))).toBe(true);
  expect(notes).toContain("edit me (edited by the person)");
  expect(notes.some(text => text.includes("reject me") || text.includes("skip me"))).toBe(false);
});

test("review walk: a stdout that fails to write stamps nothing and asks nothing (the candidate was not shown)", async () => {
  const r = rig();
  const a = r.put("never reaches the screen");
  r.candidates.close();
  const asked: string[] = [];
  await expect(cli(r, ["review", "walk"], { write: () => { throw new Error("EPIPE"); }, prompt: question => { asked.push(question); return "q"; } })).rejects.toThrow("EPIPE");
  expect(asked).toEqual([]); expect(shownAt(r, a)).toBeNull();
});

test("review walk: quit stops without touching the rest, which stay unshown and so cannot expire", async () => {
  const r = rig();
  const a = r.put("first"), b = r.put("second");
  r.candidates.close();
  const events: string[] = [];
  const out = await cli(r, ["review", "walk"], scripted(["q"], [], events));
  expect(out).toContain("accepted 0, edited 0, rejected 0, skipped 0");
  const stamped = [a, b].filter(id => shownAt(r, id) !== null);
  expect(stamped).toHaveLength(1);                                                     // only the one put in front of the person
  expect(await cli(r, ["review", "walk"], scripted([]))).toContain("accepted 0");      // end of input is a quit, not a hang or a crash
});

test("review walk screens what it prints: control characters and an escape sequence in a candidate cannot reach the terminal", async () => {
  const r = rig();
  r.put("clean\u001b[2J\u001b]0;pwned\u0007 text\u202e reversed");
  r.candidates.close();
  const events: string[] = [];
  await cli(r, ["review", "walk"], scripted(["q"], [], events));
  const out = printed(events);
  expect(out).not.toContain("\u001b"); expect(out).not.toContain("\u0007"); expect(out).not.toContain("\u202e"); expect(out).toContain("clean");
});

test("review walk: an accept the policy refuses is reported and leaves the candidate pending; a bad answer skips", async () => {
  const r = rig();
  writeFileSync(join(r.memory, "amem.config.json"), JSON.stringify({ piiPatterns: ["blocked-word"] }));
  const bad = r.put("mentions blocked-word here"), good = r.put("an ordinary one");
  r.candidates.close();
  const events: string[] = [];
  const out = `${printed(events)}${await cli(r, ["review", "walk"], scripted(["a", "zzz"], [], events))}`.replace(/^/, "");
  const all = `${printed(events)}\n${out}`;
  expect(all).toContain("refused by the current standalone privacy policy"); expect(all).toContain("failed 1");
  const after = new CandidateStore({ memoryDir: r.memory, now: () => r.clock.now }); cleanup.push(() => after.close());
  expect(after.get(bad, r.project)!.status).toBe("pending"); expect(after.get(good, r.project)!.status).toBe("pending");
});

test("review walk with nothing pending is available to a marked CLI but still needs terminal output; bare review remains the person list", async () => {
  const r = rig();
  expect(await cli(r, ["review", "walk"], { stdoutTTY: true })).toBe("no candidates pending");
  expect(await cli(r, ["review", "walk"], { env: { CLAUDECODE: "1" }, stdinTTY: false, stdoutTTY: true })).toBe("no candidates pending");
  await expect(cli(r, ["review", "walk"], { stdoutTTY: false })).rejects.toThrow("stdout must be a terminal");
  const a = r.put("listed not walked"); r.candidates.close();
  expect(await cli(r, ["review"], { stdinTTY: false })).toContain(a);                  // scripts keep the list
  expect(await cli(r, ["review", "--json"])).toContain(a);
  expect(await cli(r, ["review", "list"])).toContain(a);
  expect(await cli(r, ["review"], scripted(["q"]))).toContain(a);                      // even on a terminal the bare command lists: walking is `review walk`
  expect(shownAt(r, a)).toBeNull();
});

// ---- claude's round 1 on #418: concurrency, tiers, nits ----

const CHILD = join(import.meta.dir, "fakes", "candidate-child.ts");
async function fleet(mode: "open" | "put", dir: string, project: string, count: number, text = (i: number) => `proposal ${i}`) {
  const procs = Array.from({ length: count }, (_, i) => Bun.spawn([process.execPath, CHILD, mode, dir, project, text(i)], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } }));
  return Promise.all(procs.map(async proc => { const out = await new Response(proc.stdout).text(); await proc.exited; return JSON.parse(out.trim().split("\n").pop()!) as { ok: boolean; error?: string; code?: string | null; id?: string }; }));
}
function mainSchema(dir: string, project: string, rows: number) {
  // The candidates table exactly as main wrote it: no shown_at column.
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "candidates.db"), { create: true }); db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE candidates (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, note_id TEXT)");
  db.run("CREATE TABLE counters (id TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, rendered INTEGER, delivered INTEGER, cited INTEGER)");
  const seed = new CandidateStore({ memoryDir: join(dir, "..", "seed-" + Math.random().toString(16).slice(2)), now: () => START }); cleanup.push(() => seed.close());
  for (let i = 0; i < rows; i++) {
    const input = { project, kind: "memory" as const, text: `legacy ${i}` };
    const id = seed.put(input, "public");
    const row = seed.get(id, project)!;
    db.query("INSERT INTO candidates VALUES (?, ?, 'memory', ?, ?, 'pending', NULL)").run(id, project, JSON.stringify(input), START + i);
    void row;
  }
  db.close();
}

test("finding 1: six processes opening a main-schema candidates.db at once all succeed and the column is added exactly once", async () => {
  for (let trial = 0; trial < 3; trial++) {
    const r = rig(); r.candidates.close();
    const dir = join(r.root, `main-${trial}`, "memory"); mainSchema(dir, r.project, 3);
    const results = await fleet("open", dir, r.project, 6);
    expect(results.filter(result => !result.ok).map(result => result.error), `trial ${trial}`).toEqual([]);
    const db = new Database(join(dir, "candidates.db"), { readonly: true });
    expect((db.query("PRAGMA table_info(candidates)").all() as { name: string }[]).filter(column => column.name === "shown_at")).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) AS n FROM candidates").get() as { n: number }).n).toBe(3); db.close();
  }
}, 120000);

test("finding 1: six processes opening a brand-new home at once all succeed", async () => {
  const r = rig(); r.candidates.close();
  const dir = join(r.root, "fresh-fleet", "memory");
  const results = await fleet("open", dir, r.project, 6);
  expect(results.filter(result => !result.ok).map(result => result.error)).toEqual([]);
}, 60000);

test("finding 2: concurrent puts at the cap never delete an unseen candidate: exactly the free slots are filled, the rest are refused by name", async () => {
  for (let trial = 0; trial < 2; trial++) {
    const r = rig(); r.candidates.close();
    const dir = join(r.root, `cap-${trial}`, "memory"); mkdirSync(dir, { recursive: true });
    const seedStore = new CandidateStore({ memoryDir: dir, now: () => START }); 
    const seeded: string[] = [];
    for (let i = 0; i < CANDIDATE_RETENTION.count - 1; i++) seeded.push(seedStore.put({ project: r.project, kind: "memory", text: `seed ${i}` }, "public"));
    seedStore.close();                                                                  // 499 unseen: one slot is free
    const results = await fleet("put", dir, r.project, 6);
    const accepted = results.filter(result => result.ok), refused = results.filter(result => !result.ok);
    expect(accepted, `trial ${trial}`).toHaveLength(1);                                 // before: 2 were accepted and an unseen seed was deleted
    expect(refused.every(result => result.code === "candidate_queue_full")).toBe(true);
    const check = new CandidateStore({ memoryDir: dir, now: () => START }); cleanup.push(() => check.close());
    const rows = check.list({ project: r.project, status: "all" });
    expect(rows).toHaveLength(CANDIDATE_RETENTION.count);
    for (const id of seeded) expect(rows.some(row => row.id === id), "every seed is still there").toBe(true);
  }
}, 120000);

test("finding 3: the cap evicts decided rows before a shown pending one still inside its grace", () => {
  const r = rig();
  const shown = r.put("shown today, still in grace");
  markShown(r.memory, [r.project], r.clock.now, [shown]);
  r.clock.now += 1;
  const decided = r.put("rejected, but newer"); r.candidates.reject(decided, { project: r.project, actor: "person", verdict: "public" });
  for (let i = 0; i < CANDIDATE_RETENTION.count - 2; i++) { r.clock.now++; r.put(`unseen ${i}`); }
  // 500 rows: shown + decided + 498 unseen. One more fits only by evicting one row, and it must be the decided one, not the shown row owed its grace.
  r.clock.now++; r.put("the one that forces an eviction");
  const left = rows(r).map(row => row.id);
  expect(left).toContain(shown); expect(left).not.toContain(decided);
  expect(rows(r)).toHaveLength(CANDIDATE_RETENTION.count);
});

test("the queue-full error is named, text-free and gives the CLI review path, while the MCP tool maps it to a fixed reply (review nit)", async () => {
  const r = rig();
  for (let i = 0; i < CANDIDATE_RETENTION.count; i++) { r.clock.now++; r.put(`unseen ${i}`); }
  let error: unknown; try { r.put("overflow"); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ name: "CandidateQueueFull", code: "candidate_queue_full", waiting: CANDIDATE_RETENTION.count });
  expect((error as Error).message).toContain("Run `amem review`");
  expect((error as Error).message).not.toContain("overflow");
  // Through a real MCP server: the reply is the fixed sentence, not the generic refusal, and it carries no candidate text.
  const { createMemoryMcp } = await import("../src/mcp-memory.ts");
  const { serveMcp } = await import("../src/mcp.ts");
  void serveMcp;
  const mcp = createMemoryMcp({ cwd: r.cwd, base: r.memory });
  try { await expect(mcp.tools.amem_remember!({ text: "one more proposal" })).rejects.toMatchObject({ code: "candidate_queue_full" }); } finally { mcp.close(); }
});

test("a read-only open that cannot attach to missing -wal/-shm falls back to an immutable read, and status says unavailable rather than a false zero (review nit)", async () => {
  const r = rig();
  r.put("pending in a database whose wal files are gone");
  r.candidates.close();
  const { readdirSync } = await import("node:fs");
  const d = new Database(join(r.memory, "candidates.db")); d.run("PRAGMA wal_checkpoint(TRUNCATE)"); d.close();
  for (const name of readdirSync(r.memory)) if (/^candidates\.db-(wal|shm)$/.test(name)) rmSync(join(r.memory, name));
  expect(readdirSync(r.memory).filter(name => name.startsWith("candidates.db"))).toEqual(["candidates.db"]);
  expect(pendingSummary(r.memory, [r.project], r.clock.now)).toMatchObject({ count: 1, unshown: 1 });       // before: 0 and the brief line vanished
  expect(JSON.parse(await cli(r, ["status", "--json"])).candidates).toMatchObject({ count: 1 });
  // A file that exists but is not a database is "unavailable", never zero.
  writeFileSync(join(r.memory, "candidates.db"), "this is not sqlite");
  expect(pendingSummary(r.memory, [r.project], r.clock.now, true)).toBeNull();
  expect(JSON.parse(await cli(r, ["status", "--json"])).candidates).toEqual({ unavailable: "candidates.db exists but cannot be read" });
});

// ---- claude's round 2 nits on #418 ----

test("review walk refuses to run with stdout redirected: nothing is printed, nothing is stamped, nothing is asked (review nit)", async () => {
  const r = rig();
  const a = r.put("would be stamped unread");
  r.candidates.close();
  const asked: string[] = [];
  // No `write` fixture, so stdout is the real one, and it is not a terminal.
  await expect(cli(r, ["review", "walk"], { stdoutTTY: false, prompt: question => { asked.push(question); return "a"; } })).rejects.toThrow("stdout must be a terminal");
  expect(asked).toEqual([]); expect(shownAt(r, a)).toBeNull();
  // A real process with stdin a pseudo-terminal and stdout a file: the case from the review. `script` gives the child a pty for stdin and stdout, so the redirect is inside it.
  const bun = process.execPath, bin = join(import.meta.dir, "../bin/amem.js"), out = join(r.root, "walk.out");
  // No pipe into stdin here: stdin must stay the pty, or the refusal would be the "terminal on stdin" one and not the stdout one this test is about.
  // The plain command line: the helper adds the `sh -c` (macOS) or relies on `-c` running it through a shell (Linux), so it must not be wrapped in `sh -c` here as well.
  const argv = ptyArgv(`${JSON.stringify(bun)} ${JSON.stringify(bin)} review walk > ${JSON.stringify(out)} 2>&1; echo status:$?`);
  if (argv === undefined) { console.warn("SKIPPED the real-pty half of this test: the `script` utility is not installed here, so there is no pseudo-terminal to give the child (the in-process half above ran)"); return; }
  const run = Bun.spawnSync(argv, { cwd: r.cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AMEM_HOME: r.memory }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(run.stdout.toString()).toContain("status:1");
  const refusal = (await import("node:fs")).readFileSync(out, "utf8");
  expect(refusal).toContain("stdout must be a terminal"); expect(refusal).not.toContain("terminal on stdin");   // the stdout rule fired, not the stdin one
  expect(shownAt(r, a)).toBeNull();                                                         // the unread candidate was never stamped
});

test("ptyArgv builds the argument form each platform's `script` needs, and says nothing when script is missing (review: Ubuntu CI)", () => {
  const present = () => "/usr/bin/script", absent = () => null;
  expect(ptyArgv("CMD", "darwin", present)).toEqual(["script", "-q", "/dev/null", "sh", "-c", "CMD"]);
  expect(ptyArgv("CMD", "linux", present)).toEqual(["script", "-q", "-e", "-c", "CMD", "/dev/null"]);
  expect(ptyArgv("CMD", "linux", absent)).toBeUndefined(); expect(ptyArgv("CMD", "darwin", absent)).toBeUndefined();
  expect(() => ptyArgv("CMD", "win32", present)).toThrow("no known `script` argument form for platform win32");
  // The host's own form really gives a child a terminal: this is what the real-pty test above stands on.
  const real = ptyArgv(`[ -t 0 ] && [ -t 1 ] && echo both-tty || echo not-tty`);
  if (real !== undefined) expect(Bun.spawnSync(real, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }).stdout.toString()).toContain("both-tty");
});

test("a memory candidate proposed as a fail note whose text already carries any label opens as written, so the edit does not repeat a label (review nit)", async () => {
  const { hasFailLabel } = await import("../src/memory/note-add.ts");
  for (const text of ["Cause: the manifest was held in memory", "symptom: it grew\nand grew", "Evidence: log 1", "Retry when: streaming", "Approach: x", "intro line\nRETRY WHEN: later", "a\u2028Cause: forged by a separator"]) expect(hasFailLabel(text), text).toBe(true);
  for (const text of ["just a loose sentence about a failure", "the cause: was memory", "approach to the problem: unclear", ""]) expect(hasFailLabel(text), text).toBe(false);
  const r = rig();
  const labelled = r.put("placeholder", { noteKind: "fail", text: "Cause: the whole manifest was held in memory\nSymptom: memory grew" } as Partial<CandidateInput>);
  r.candidates.close();
  const opened: string[] = [];
  const out = await cli(r, ["review", "walk"], { write: () => {}, prompt: () => "e",
    // The person completes the labelled text: they add the three labels it lacks and keep the two it has, each once.
    edit: initial => { opened.push(initial); return `Approach: stream the rows\n${initial}\nEvidence: log 7\nRetry when: the importer streams\n`; } });
  expect(opened[0]).toBe("Cause: the whole manifest was held in memory\nSymptom: memory grew");     // raw: no template appended, so no label is repeated
  expect(opened[0]!.match(/^cause:/gim)).toHaveLength(1);
  expect(out).toContain("edited 1"); expect(out).toContain("failed 0");
  void labelled;
});

test("the stamp comments and docs no longer claim that review list stamps (review nit)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/memory/candidate-pending.ts", "../src/session-brief.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(text, file).not.toMatch(/`amem review list` (and `review walk` )?(do|does|stamp)/);
    expect(text, file).not.toContain("only `amem review list` and `review walk`");
    expect(text, file).not.toMatch(/the brief line, `amem review list` or/);
  }
});
