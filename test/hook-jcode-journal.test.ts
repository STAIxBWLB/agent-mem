import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
import { jcodeJournalTarget } from "../src/hook-jcode.ts";
import { scanJcodeJournal } from "../src/hook-jcode-journal.ts";
import { drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const SESSION = "session_fixture_1700000000000_abcdef0123456789";
function rig() {
  const f = hookFixture(); fixtures.push(f);
  const jhome = join(f.root, "jcode-home"), sessions = join(jhome, "sessions"); mkdirSync(sessions, { recursive: true });
  const journal = join(sessions, `${SESSION}.journal.jsonl`);
  const project = memoryProjectKey(realPath(f.cwd));
  const line = (meta: Record<string, unknown>) => JSON.stringify({ meta: { parent_id: null, working_dir: f.cwd, updated_at: "2026-11-08T05:00:00.000Z", compaction: null, ...meta }, append_messages: [{ role: "user", content: "SECRET-BODY ghp_" + "b".repeat(36) }] }) + "\n";
  const env = (extra: Record<string, string> = {}) => ({ JCODE_HOME: jhome, JCODE_HOOK_EVENT: "turn_end", JCODE_HOOK_SESSION_ID: SESSION, JCODE_HOOK_CWD: f.cwd, JCODE_HOOK_STATUS: "ok", JCODE_HOOK_LAST_ASSISTANT_TEXT: "", JCODE_HOOKS_DISABLED: "1", ...extra });
  const turn = (extra: Record<string, string> = {}) => {
    const entry = join(f.root, "functional-hook.ts");
    if (!existsSync(entry)) f.runFunctional("SessionEnd", "not json");
    return Bun.spawnSync([process.execPath, "--smol", entry, "jcode"], { cwd: f.cwd, env: { ...f.env, ...env(extra) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000 });
  };
  const rows = () => { const c = new CaptureStore({ home: f.root, project }); try { return c.rows({ project }).filter(r => r.event === "Title" || r.event === "Compact"); } finally { c.close(); } };
  /** Run turns until the staged rows are drained (the replay needs a later hook of the same project). */
  const settle = (want: (r: ReturnType<typeof rows>) => boolean) => { for (let i = 0; i < 6 && !want(rows()); i++) turn({ JCODE_HOOK_LAST_ASSISTANT_TEXT: `barrier ${i}` }); return rows(); };
  const target = { cwd: f.cwd, session: SESSION, journal };
  return { f, jhome, journal, project, line, env, turn, rows, settle, target };
}
const summaryRows = (rows: { event: string }[]) => rows.map(r => r.event).sort();

test("target: derived from the session id and JCODE_HOME, with no directory scan; hostile ids are refused", () => {
  const r = rig();
  expect(jcodeJournalTarget(r.env() as never, r.f.root)?.journal).toBe(r.journal);
  expect(jcodeJournalTarget({ ...r.env(), JCODE_HOME: undefined } as never, "/h")?.journal).toBe(`/h/.jcode/sessions/${SESSION}.journal.jsonl`);
  for (const id of ["../x", "a/b", "", ".hidden/..", "x\0y"]) expect(jcodeJournalTarget(r.env({ JCODE_HOOK_SESSION_ID: id }) as never, "/h")).toBeUndefined();
  expect(jcodeJournalTarget(r.env({ JCODE_HOOK_EVENT: "post_tool" }) as never, "/h")).toBeUndefined();
  expect(jcodeJournalTarget(r.env({ JCODE_HOME: "relative" }) as never, "/h")).toBeUndefined();
});

test("AC1: a title and a compaction each stage once across repeated turn_end calls, as jcode rows, without bodies", () => {
  const r = rig();
  writeFileSync(r.journal, r.line({ title: "Refactor the spool" }) + r.line({ title: "Refactor the spool", compaction: { summary_text: "Decided to shard the spool.", covers_up_to_turn: 12, original_turn_count: 12, compacted_count: 12 } }));
  r.turn(); r.turn(); r.turn();
  let rows = r.settle(x => x.length >= 2);
  expect(summaryRows(rows)).toEqual(["Compact", "Title"]);
  expect(rows.every(x => x.agent === "jcode")).toBe(true);
  expect(rows.find(x => x.event === "Compact")!.excerpt).toBe("Decided to shard the spool.");
  expect(rows.map(x => x.excerpt).join("\n")).not.toContain("SECRET-BODY");
  // A changed title adds exactly one more Title; an unchanged journal adds nothing.
  appendFileSync(r.journal, r.line({ title: "Spool sharding", compaction: { summary_text: "Decided to shard the spool.", covers_up_to_turn: 12 } }));
  r.turn(); r.turn();
  rows = r.settle(x => x.length >= 3);
  expect(summaryRows(rows)).toEqual(["Compact", "Title", "Title"]);
});

test("AC1: an inode replacement resumes correctly and repeats nothing already staged", () => {
  const r = rig();
  writeFileSync(r.journal, r.line({ title: "One", compaction: { summary_text: "first summary", covers_up_to_turn: 3 } }));
  r.turn(); r.settle(x => x.length >= 2);
  // Checkpoint: jcode replaces the journal (new inode) with a fresh delta carrying the same meta plus a newer compaction.
  const next = join(r.jhome, "sessions", "next.tmp");
  writeFileSync(next, r.line({ title: "One", compaction: { summary_text: "first summary", covers_up_to_turn: 3 } }) + r.line({ title: "One", compaction: { summary_text: "second summary", covers_up_to_turn: 9 } }));
  renameSync(next, r.journal);
  r.turn();
  const rows = r.settle(x => x.length >= 3);
  expect(rows.filter(x => x.event === "Compact").map(x => x.excerpt).sort()).toEqual(["first summary", "second summary"]);
  expect(rows.filter(x => x.event === "Title")).toHaveLength(1);
});

test("AC1: an oversized line is bounded-skipped and counted, and a later line is still read", async () => {
  const r = rig();
  writeFileSync(r.journal, JSON.stringify({ meta: { title: "Huge" }, append_messages: ["x".repeat(300 * 1024)] }) + "\n");
  r.turn();
  appendFileSync(r.journal, r.line({ title: "After the big line" }));
  r.turn();
  const metrics = readdirSync(r.f.base).includes("metrics.jsonl") ? Bun.file(join(r.f.base, "metrics.jsonl")).text() : Promise.resolve("");
  expect(await metrics).toContain("transcript_line_bound");
  const rows = r.settle(x => x.some(y => y.excerpt === "After the big line"));
  expect(rows.map(x => x.excerpt)).toContain("After the big line");
});

test("AC1: symlinked and hardlinked journals and deny paths are refused", async () => {
  const r = rig();
  const real = join(r.f.root, "elsewhere.jsonl"); writeFileSync(real, r.line({ title: "Symlinked" }));
  symlinkSync(real, r.journal);
  await expect(scanJcodeJournal(r.target, { base: r.f.base, deadline: performance.now() + 2000 })).rejects.toThrow();
  rmSync(r.journal);
  writeFileSync(r.journal, r.line({ title: "Hardlinked" })); linkSync(r.journal, join(r.f.root, "alias.jsonl"));
  expect(await scanJcodeJournal(r.target, { base: r.f.base, deadline: performance.now() + 2000 })).toBeUndefined();
  r.turn(); r.turn();
  expect(r.rows()).toEqual([]);
  rmSync(join(r.f.root, "alias.jsonl"));
  expect(await scanJcodeJournal(r.target, { base: r.f.base, deadline: performance.now() + 2000, policy: { denyPaths: ["jcode-home"] } })).toBeUndefined();
  expect(r.rows()).toEqual([]);
});

test("AC1: a secret in the summary drops the row", () => {
  const r = rig();
  writeFileSync(r.journal, r.line({ title: "Fine title", compaction: { summary_text: `Remember the token ghp_${"c".repeat(36)} for later`, covers_up_to_turn: 5 } }));
  r.turn();
  const rows = r.settle(x => x.some(y => y.event === "Title"));
  expect(summaryRows(rows)).toEqual(["Title"]);
  r.turn(); r.turn();
  expect(summaryRows(r.rows())).toEqual(["Title"]);
});

test("AC2: a jcode Compact row is preferred in the SessionStart brief like Claude's", () => {
  const r = rig();
  const c = new CaptureStore({ home: r.f.root, project: r.project });
  try {
    for (const agent of ["claude", "jcode"]) c.append({ project: r.project, agent, event: "Compact", at: agent === "claude" ? "2026-11-08T01:00:00.000Z" : "2026-11-08T02:00:00.000Z", paths: [], excerpt: `${agent} compact summary`, session: "0123456789abcdef" });
    const { rows } = c.readBriefSummaries(4);
    expect(rows.map(x => `${x.agent}:${x.event}`)).toEqual(["jcode:Compact", "claude:Compact"]);
  } finally { c.close(); }
});

test("review P1: the work budget covers publication, so many compactions stop early and the next call publishes only the rest, exactly once", async () => {
  const r = rig(); const N = 12;   // below the existing summary intake cap, so every row can be drained
  writeFileSync(r.journal, Array.from({ length: N }, (_, i) => r.line({ title: "Many compactions", compaction: { summary_text: `compaction summary ${i}`, covers_up_to_turn: i + 1 } })).join(""));
  // A fake clock that advances 1 per read: the 12-line parse fits the budget, the publication phase does not.
  let now = 0; const clock = () => (now += 1);
  const first = await scanJcodeJournal(r.target, { base: r.f.base, deadline: 1e9, workBudgetMs: 30, clock });
  expect(first?.stopReason).toBe("deadline");
  // Count what the first call staged without running a hook turn (a real turn would scan with a full budget and finish the journal).
  const spool = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith("hook-")).length : 0;
  const stagedFirst = spool(join(r.f.base, "hook-spool")) + spool(join(r.f.base, "hook-spool", ".capacity"));
  expect(stagedFirst).toBeGreaterThan(0); expect(stagedFirst).toBeLessThan(N);
  // The cursor did not pass the unpublished lines, so repeated bounded calls finish the job and never duplicate a row.
  const outcomes: unknown[] = [];
  for (let i = 0; i < 40; i++) { now = 0; outcomes.push(await scanJcodeJournal(r.target, { base: r.f.base, deadline: 1e9, workBudgetMs: 30, clock })); }
  expect(outcomes.at(-1)).toMatchObject({ offset: expect.any(Number) });
  // Staging is complete here. Drain the durable spool directly with a generous time limit.
  const capture = new CaptureStore({ home: r.f.root, project: r.project });
  try { for (let i = 0; i < 5; i++) await drainHookCaptures({ cwd: r.f.cwd, base: r.f.base, project: r.project, expectedScope: hookCaptureScope(r.f.cwd, r.f.base), timeRemaining: () => 5000 }, (row, receipt) => capture.append(row, { receipt })); }
  finally { capture.close(); }
  const rows = r.rows();
  const compacts = rows.filter(x => x.event === "Compact").map(x => x.excerpt).sort();
  expect(compacts).toEqual(Array.from({ length: N }, (_, i) => `compaction summary ${i}`).sort());
  expect(rows.filter(x => x.event === "Title")).toHaveLength(1);
});

test("review P2: a row whose own meta.working_dir names another project is not staged under this hook's cwd; a missing working_dir keeps it", async () => {
  const r = rig(); const other = join(r.f.root, "other-project"); mkdirSync(other, { recursive: true });
  writeFileSync(r.journal,
    r.line({ title: "Other project title", working_dir: other, compaction: { summary_text: "belongs to the other project", covers_up_to_turn: 1 } })
    + r.line({ title: "This project title", working_dir: r.f.cwd, compaction: { summary_text: "belongs to this project", covers_up_to_turn: 2 } })
    + r.line({ title: "This project title", working_dir: undefined as never, compaction: { summary_text: "no working dir recorded", covers_up_to_turn: 3 } }));
  r.turn(); r.turn();
  const rows = r.settle(x => x.length >= 3);
  expect(rows.filter(x => x.event === "Compact").map(x => x.excerpt).sort()).toEqual(["belongs to this project", "no working dir recorded"]);
  expect(rows.map(x => x.excerpt)).not.toContain("belongs to the other project");
  // The newest line decides the title: it is this project's, so exactly one Title; a newest line from another project stages none.
  expect(rows.filter(x => x.event === "Title").map(x => x.excerpt)).toEqual(["This project title"]);
  appendFileSync(r.journal, r.line({ title: "Moved elsewhere", working_dir: other }));
  r.turn(); r.turn(); r.settle(() => false);
  expect(r.rows().filter(x => x.event === "Title").map(x => x.excerpt)).toEqual(["This project title"]);
});
