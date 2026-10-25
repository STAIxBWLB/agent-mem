import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { DOCTOR_GIT_TIMEOUT_MS, sweepStaleScratch } from "../src/memory/doctor.ts";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-doctor-test-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  expect(memoryGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);   // a real repository: the stale check resolves its root with git
  const project = memoryProjectKey(cwd);
  const note = (text: string, extra: Record<string, unknown> = {}) => { const s = new MemoryStore({ memoryDir: memory, deferPromotions: true }); try { return s.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "me", source: "person", text, about: [], ...extra } as never); } finally { s.close(); } };
  const capture = (agent: string, at: string) => { const c = new CaptureStore({ memoryDir: memory, project, cwd, now: () => Date.parse(at) }); try { c.append({ project, agent, event: "PostToolUse", excerpt: `from ${agent}` }); } finally { c.close(); } };
  return { root, memory, cwd, project, note, capture };
}
async function doctor(r: ReturnType<typeof rig>, args: string[] = ["doctor", "--json"], env: Record<string, string> = {}): Promise<any> {
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = r.memory;
  try { const out = await runCli(args, { cwd: r.cwd, env, stdinTTY: false }); return args.includes("--json") ? JSON.parse(out) : out; }
  finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}
/** Content hash and size of every file, so a before and after comparison sees any byte that changed or any file that appeared. */
function tree(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(join(dir, rel))) return out;
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = join(rel, name), stat = statSync(join(dir, path));
    if (stat.isDirectory()) Object.assign(out, tree(dir, path));
    else out[path] = `${createHash("sha1").update(readFileSync(join(dir, path))).digest("hex").slice(0, 10)}:${stat.size}`;
  }
  return out;
}

/**
 * Every file, byte for byte. Two kinds of SQLite bookkeeping are normalised, nothing else: a `-shm` file (wal-index scratch memory, changed by any read-only open) and an EMPTY
 * `-wal` file. Linux removes both when the last connection closes cleanly and a read-only open of that database creates them again empty (macOS leaves them in place), which
 * Ubuntu CI showed; neither holds data. A `-wal` that holds data is still compared byte for byte, and so is every database, log, lock and sidecar: the reviewer's probe found
 * doctor checkpointing both WALs (53592 to 0 bytes), which this still catches.
 */
function exact(r: ReturnType<typeof rig>) {
  return Object.fromEntries(Object.entries(tree(r.memory)).filter(([file, value]) => !/-shm$/.test(file) && !(/-wal$/.test(file) && value.endsWith(":0"))));
}
/** What a clean close leaves on Linux: no -wal and no -shm beside any database. Applying it on every platform makes macOS take the same path Ubuntu does. */
function cleanClose(r: ReturnType<typeof rig>) { for (const file of Object.keys(tree(r.memory))) if (/-(wal|shm)$/.test(file)) rmSync(join(r.memory, file), { force: true }); }

test("doctor is read-only: a home that was never used stays absent, and the FIRST run on a populated home changes no byte (-wal included)", async () => {
  const r = rig();
  const empty = await doctor(r);
  expect(existsSync(r.memory)).toBe(false);                                   // nothing created for a home nobody used
  for (const name of ["duplicates", "stale", "index"]) expect(empty.sections[name].status).toBe("skipped");
  expect(empty.status).not.toBe("attention");                                  // nothing to check is not a problem
  r.note("a decision about caching"); r.capture("claude", new Date(Date.now() - 86400_000).toISOString());
  const pending = new CandidateStore({ memoryDir: r.memory }); pending.put({ project: r.project, kind: "memory", text: "a candidate" } as never, "public"); pending.close();
  cleanClose(r);                                                              // the state a normal close leaves on Linux, where a read-only open recreates -wal and -shm
  const before = exact(r);                                                    // no warm-up run: the first doctor is the one measured
  const report = await doctor(r);
  expect(exact(r)).toEqual(before);
  const created = Object.keys(tree(r.memory)).filter(file => !/-(wal|shm)$/.test(file));
  expect(created.sort()).toEqual(Object.keys(before).sort());                 // no file other than SQLite's own bookkeeping appeared
  expect(report.sections.candidates).toMatchObject({ status: "ok", count: 1, unshown: 1 });     // doctor never stamps a candidate as shown
  expect(readdirSync(join(r.memory)).includes("readers") ? readdirSync(join(r.memory, "readers")) : []).toEqual([]);   // and takes no reader lease
  const check = new CandidateStore({ memoryDir: r.memory }); try { expect(check.list({ project: r.project, status: "pending" })).toHaveLength(1); } finally { check.close(); }
});

test("doctor leaves a live index that is behind the logs untouched: a foreign machine segment and a writer that died before closing", async () => {
  const r = rig(); r.note("indexed by this machine");
  // Another machine's segment arrives (a sync pull) after this machine's index was last refreshed, so the live index is behind the logs.
  const { machineSegment } = await import("./fakes/foreign-segment.ts");
  machineSegment(r.memory, r.project, "another machine's note");
  const before = exact(r);
  const report = await doctor(r);
  expect(exact(r)).toEqual(before);                                           // not refreshed, not checkpointed, no lease
  expect(report.sections.index.status).toBe("ok");                            // the snapshot is brought level in the scratch copy, as a reader would
  const again = await doctor(r);
  expect(exact(r)).toEqual(before); expect(again.sections.duplicates.notes).toBe(2);   // the foreign note is read from the copy
});

test("doctor never migrates or recreates a work list: a deleted lock file stays deleted, and a log with no index still counts in the brief", async () => {
  const r = rig(); r.note("n");
  const { WorkListStore } = await import("../src/memory/work-lists.ts");
  const work = new WorkListStore({ base: r.memory, project: r.project, policy: () => true });
  await work.write("todo", { task: "a work item that must show in the brief" }); work.close();
  const dir = join(r.memory, "projects", readdirSync(join(r.memory, "projects"))[0]!, "work");
  rmSync(join(dir, "mutation-lock.db"), { force: true });
  const before = exact(r);
  const withIndex = await doctor(r);
  expect(exact(r)).toEqual(before);                                           // the lock file was not recreated, nothing migrated
  expect(existsSync(join(dir, "mutation-lock.db"))).toBe(false);
  expect(withIndex.sections.brief.coverage.work).toBe("complete");
  const small = withIndex.sections.brief.tokens;
  rmSync(join(dir, "index.db"), { force: true }); rmSync(join(dir, "index.db-wal"), { force: true }); rmSync(join(dir, "index.db-shm"), { force: true });
  const noIndex = await doctor(r);
  expect(existsSync(join(dir, "index.db"))).toBe(false);                      // not rebuilt in the home
  expect(noIndex.sections.brief.tokens).toBe(small);                          // the log alone gives the same brief: the work item is not dropped (review finding 3)
  expect(noIndex.sections.brief.coverage.work).toBe("complete");
});

test("measureOnly never reaches the live work list: without a scratch work base the work section is unavailable, not claimed complete", async () => {
  const r = rig(); r.note("n");
  const { WorkListStore } = await import("../src/memory/work-lists.ts");
  const work = new WorkListStore({ base: r.memory, project: r.project, policy: () => true });
  await work.write("todo", { task: "a work item" }); work.close();
  const { sessionStartBrief } = await import("../src/session-brief.ts");
  const before = exact(r);
  const none = await sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project, measureOnly: {} });
  expect(none.coverage.work).toBe("unavailable");                             // never a silent "complete" for a section that was not read
  expect(none.context).not.toContain("a work item");
  expect(exact(r)).toEqual(before);                                           // and the live work list was not opened (no migration, no lock file, no lease)
  const real = await sessionStartBrief({ cwd: r.cwd, base: r.memory, project: r.project });
  expect(real.coverage.work).toBe("complete"); expect(real.context).toContain("a work item");   // the ordinary brief is unchanged
});

test("doctor creates no project, work-list, capture or lease file for a project the home has never seen, while a note-only home still gets its brief cost", async () => {
  const r = rig(); r.note("only a curated note");
  const before = tree(r.memory);
  const report = await doctor(r);
  const created = Object.keys(tree(r.memory)).filter(file => !(file in before));
  expect(created.filter(file => /^projects\/|work|readers\//.test(file))).toEqual([]);
  expect(report.sections.brief).toMatchObject({ status: "ok", coverage: { curated: "complete" } });
  expect(report.sections.brief.tokens).toBeGreaterThan(0);
});

test("doctor reports notes with identical text as duplicates, a note about a deleted path as stale, and an index that equals a rebuild", async () => {
  const r = rig(); writeFileSync(join(r.cwd, "keep.ts"), "x");
  r.note("same words");
  const single = await doctor(r);
  expect(single.sections.duplicates).toMatchObject({ status: "ok", notes: 1, identicalGroups: 0 });
  const s = new MemoryStore({ memoryDir: r.memory }); try { s.note({ op: "note", project: r.project, scope: "project", tier: "long", kind: "finding", peer: "other", source: "person", text: "  Same   words ", about: [] } as never); } finally { s.close(); }
  const twice = await doctor(r);
  expect(twice.sections.duplicates).toMatchObject({ status: "attention", notes: 2, identicalGroups: 1 });   // case and spacing do not hide a duplicate
  expect(twice.sections.duplicates.examples[0]).toHaveLength(2);
  expect(twice.sections.duplicates.examples[0].every((id: string) => /^[a-f0-9]{8}$/.test(id))).toBe(true);   // ids only, never note text
  expect(JSON.stringify(twice)).not.toContain("same words");
  r.note("this refers to a file", { about: ["path:gone/missing.ts"] }); r.note("this refers to a kept file", { about: ["path:keep.ts"] });
  const stale = await doctor(r);
  expect(stale.sections.stale).toMatchObject({ status: "attention", missingReferences: 1 });
  expect(stale.sections.index).toMatchObject({ status: "ok" });
});

test("doctor detects an index that differs from a rebuild of the logs", async () => {
  const r = rig(); r.note("one"); r.note("two");
  expect((await doctor(r)).sections.index.status).toBe("ok");
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(r.memory, "index.db")); db.run("DELETE FROM entries WHERE rowid = (SELECT MIN(rowid) FROM entries)"); db.close();
  const sick = await doctor(r);
  expect(sick.sections.index.status).toBe("attention"); expect(sick.sections.index.hint).toContain("amem rebuild");
  expect(sick.status).toBe("attention");
});

test("capture freshness is reported per CLI, from the hook receipts and the capture rows, and a CLI without a hook is manual", async () => {
  const r = rig(); r.note("n");
  const { applySetup, planSetup } = await import("../src/setup.ts");
  const calls: string[][] = [];
  const entry = join(r.root, "installed", "bin", "amem.js");
  const env = { HOME: r.root, AMEM_HOME: r.memory, CODEX_HOME: join(r.root, ".codex"), KIMI_CODE_HOME: join(r.root, ".kimi-code"), PI_CODING_AGENT_DIR: join(r.root, ".pi", "agent") };
  // The stand-in for `codex mcp add amem -- <bun> <entry> mcp`: what the real CLI would write into the staged CODEX_HOME.
  const native = (argv: string[], staged: Record<string, string | undefined>) => {
    calls.push(argv); const marker = argv.indexOf("--"), launch = argv.slice(marker + 1);
    mkdirSync(staged.CODEX_HOME!, { recursive: true });
    writeFileSync(join(staged.CODEX_HOME!, "config.toml"), Bun.TOML.stringify({ mcp_servers: { amem: { command: launch[0], args: launch.slice(1) } } }));
  };
  const options = { env, entry, native } as never;
  applySetup(planSetup("codex", "apply", options), options);
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  r.capture("codex", tenDaysAgo); r.capture("claude", new Date().toISOString());
  const report = await doctor(r);
  const clis = report.sections.capture.clis;
  expect(clis.codex).toMatchObject({ hook: "registered", capture: "stale", rows: 1 });         // registered by a real setup receipt, last capture older than 7 days
  expect(clis.claude).toMatchObject({ hook: "manual", capture: "fresh", rows: 1 });
  expect(clis.kimi).toMatchObject({ hook: "manual", capture: "never", lastCaptureAt: null, rows: 0 });
  expect(clis.pi).toMatchObject({ hook: "manual", capture: "never" });
  expect(clis.codex.hint).toContain("amem ingest codex");
  expect(report.sections.capture.status).toBe("attention");                                    // a registered hook whose capture went stale
  expect(report.sections.cadence.ingest).toMatchObject({ codex: "session end", claude: "manual", kimi: "manual", pi: "manual" });
  expect(report.sections.cadence.manual).toEqual(["claude", "kimi", "pi"]);
  expect(calls.length).toBeGreaterThan(0);
});

test("a receipt that is not a setup receipt of that CLI is not a registered hook", async () => {
  const r = rig(); r.note("n"); mkdirSync(join(r.memory, "setup"), { recursive: true });
  writeFileSync(join(r.memory, "setup", "codex.json"), JSON.stringify({ target: "kimi", phase: "applied" }));
  writeFileSync(join(r.memory, "setup", "kimi.json"), "{ not json");
  symlinkSync(join(r.memory, "setup", "codex.json"), join(r.memory, "setup", "pi.json"));
  const report = await doctor(r);
  for (const cli of ["codex", "kimi", "pi"]) expect(report.sections.capture.clis[cli].hook).toBe("manual");
});

test("a setup that was prepared but not applied is not a registered hook, and says so", async () => {
  const r = rig(); r.note("n"); mkdirSync(join(r.memory, "setup"), { recursive: true });
  writeFileSync(join(r.memory, "setup", "kimi.json"), JSON.stringify({ target: "kimi", phase: "prepared" }));
  const report = await doctor(r);
  expect(report.sections.capture.clis.kimi).toMatchObject({ hook: "manual", setup: "prepared, not applied" });
  expect(report.sections.cadence.ingest.kimi).toBe("manual");
});

test("reader leases of a live and of a gone process are counted, and doctor itself takes none", async () => {
  const r = rig(); r.note("n");
  mkdirSync(join(r.memory, "readers"), { recursive: true });
  const lease = (pid: number, signature: string) => writeFileSync(join(r.memory, "readers", `${pid}-${signature}.json`), JSON.stringify({ schema: "agent-mem.reader-lease/v1", pid, signature, renewedAt: new Date().toISOString() }));
  const { processSignature } = await import("../src/memory/platform.ts");
  const parentSig = processSignature(process.ppid) ?? "a".repeat(64);
  lease(process.ppid, parentSig); lease(99999999, "b".repeat(64));
  writeFileSync(join(r.memory, "readers", "junk.json"), "{ nope");
  const report = await doctor(r);
  expect(report.sections.readers).toMatchObject({ status: "attention", stale: 1, unreadable: 1 });
  expect(report.sections.readers.live).toBe(1);                                  // the parent's lease only: doctor opens no live store, so it holds none
});

test("the policy section names what is in effect and the brief reports its budget", async () => {
  const r = rig(); r.note("n");
  writeFileSync(join(r.memory, "amem.config.json"), JSON.stringify({ denyPaths: ["secret/"], piiPatterns: ["alice"], briefBytes: 900 }));
  const report = await doctor(r);
  expect(report.sections.policy).toMatchObject({ status: "ok", denyPaths: 1, piiPatterns: 1, briefBytes: 900 });
  expect(report.sections.brief.budget).toBe(900);
});

test("the human report names every section, marks attention and shows the hint", async () => {
  const r = rig(); r.note("n");
  const text = await doctor(r, ["doctor"]);
  for (const name of ["duplicates", "stale", "candidates", "capture", "brief", "index", "readers", "policy", "cadence"]) expect(text).toContain(`${name}:`);
  expect(text).toMatch(/^amem doctor: (ok|attention|unavailable)/);
});

test("doctor is person-only like every other command: an agent marker is refused before the home is opened", async () => {
  const r = rig();
  await expect(runCli(["doctor"], { cwd: r.cwd, env: { CODEX_THREAD_ID: "x" }, stdinTTY: false })).rejects.toThrow(/amem is for the person/);
  expect(existsSync(r.memory)).toBe(false);
});

// ---- #435: the scratch copy never outlives an interrupted doctor ----

/**
 * How a doctor ended by `name` must look to its parent: SIGINT, SIGTERM and SIGHUP are re-raised, so the parent sees the signal itself. SIGQUIT's default action is a core dump,
 * which Bun honours (measured on Linux: a 5.9 GB core file and seconds of delay in a container with `ulimit -c unlimited`), so doctor exits with the status that death would have
 * had, 128 + 3, instead. Ubuntu CI is where this showed: it has core dumps on and the re-raised SIGQUIT outlasted the test's wait.
 */
function ended(child: { signalCode: string | number | null; exitCode: number | null }, name: NodeJS.Signals): void {
  if (name === "SIGQUIT") { expect(child.exitCode, name).toBe(131); expect(child.signalCode, name).toBeNull(); }
  else { expect(child.signalCode, name).toBe(name); }
}

function scratchDirs(tmp: string): string[] { return readdirSync(tmp).filter(name => name.startsWith("amem-doctor-")).sort(); }

/** The real binary, run as `amem doctor` with its own TMPDIR so leftovers are countable, stalled inside doctor by a fake `git` that sleeps: the scratch copy is made before that point. */
async function interruptedDoctor(name: NodeJS.Signals | "SIGKILL", group = true): Promise<{ left: string[]; tmp: string; exit: number | null; signal: string | number | null }> {
  const r = rig(); r.note("a note to copy"); r.capture("claude", new Date().toISOString());
  const tmp = join(r.root, "tmp"); mkdirSync(tmp);
  const fake = join(r.root, "bin"); mkdirSync(fake);
  // Real git for everything, except that once doctor's scratch copy exists the next git call (the stale check's repository lookup) stalls like a hung disk: the interrupt then
  // lands while the scratch is there. Before that point (the CLI's own project lookup) it must behave, or doctor would stall before it has a scratch to remove.
  const realGit = Bun.which("git")!;
  const pidFile = join(r.root, "git.pid");
  writeFileSync(join(fake, "git"), `#!/bin/sh\nfor d in ${JSON.stringify(tmp)}/amem-doctor-*; do [ -d "$d" ] && { echo $$ > ${JSON.stringify(pidFile)}; exec sleep 120; }; done\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const bin = join(import.meta.dir, "../bin/amem.js");
  const env = { ...process.env, AMEM_HOME: r.memory, TMPDIR: tmp, PATH: `${fake}:${process.env.PATH}` } as Record<string, string | undefined>;
  for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "AGENTHUB_PEER_ID", "CLAUDE_CODE_SESSION_ID", "PI_SESSION_ID"]) delete env[key];
  // Its own process group, so one signal can reach doctor and everything it started the way a terminal's Ctrl-C reaches the whole foreground group.
  const child = Bun.spawn([process.execPath, bin, "doctor"], { cwd: r.cwd, env: env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  try {
    // Signal only once git is actually stalled (its pid file exists): a signal sent the instant the scratch appears can land BEFORE doctor spawns that git, and Bun then defers the
    // handler until the loop turns, which a hung synchronous call never lets happen (the stated limit below). That is a different case from the one this test is about.
    for (let i = 0; i < 240 && !existsSync(pidFile); i++) await Bun.sleep(50);
    expect(existsSync(pidFile)).toBe(true);
    expect(scratchDirs(tmp).length).toBe(1);                                                    // the scratch copy exists while doctor runs
    expect(scratchDirs(tmp)[0]).toContain(`amem-doctor-${child.pid}-`);                         // and is named for its owner
    if (group) process.kill(-child.pid, name); else child.kill(name);
    await Promise.race([child.exited, Bun.sleep(12_000)]);
    return { left: scratchDirs(tmp), tmp, exit: child.exitCode, signal: child.signalCode };
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }   // the whole group, so a stalled git is never left behind by a failing test
}

test("a signal in the instant between the scratch being made and doctor going on is still handled: the guard is installed before the directory exists (#435, measured: 4 of 60 runs lost it)", async () => {
  // Deterministic, not a race: a child process runs doctorReport with the test seam `afterScratch`, which signals the process itself the moment the directory exists. If the guard
  // were installed after mkdtemp, that signal would take its default action and strand the directory; installed before, the handler removes it and re-raises the signal.
  const r = rig(); r.note("n");
  const tmp = join(r.root, "tmp"); mkdirSync(tmp);
  const script = join(r.root, "instant.ts");
  writeFileSync(script, `const { doctorReport } = await import(${JSON.stringify(join(import.meta.dir, "../src/memory/doctor.ts"))});
const { MemoryStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/memory/store.ts"))});
const name = process.argv[2] as NodeJS.Signals;
await doctorReport({ home: ${JSON.stringify(r.memory)}, homeSource: "test", cwd: ${JSON.stringify(r.cwd)}, project: ${JSON.stringify(r.project)}, aliases: [], now: Date.now(),
  openCurated: (base: string) => new MemoryStore({ memoryDir: base, deferPromotions: true }), afterScratch: () => { process.kill(process.pid, name); } });
console.log("doctor finished");
`);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    const child = Bun.spawn([process.execPath, script, name], { env: { ...process.env, TMPDIR: tmp }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await Promise.race([child.exited, Bun.sleep(12_000)]);
    ended(child, name);                                                                            // ended by the signal (or its conventional status for SIGQUIT), not by finishing
    expect(scratchDirs(tmp), name).toEqual([]);                                                   // and the directory it had just made is gone
    expect(await new Response(child.stdout).text()).not.toContain("doctor finished");
  }
}, 90_000);

for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) test(`${name} during doctor removes the scratch copy and still ends doctor with that signal (#435)`, async () => {
  const run = await interruptedDoctor(name);
  expect(run.left).toEqual([]);
  ended({ signalCode: run.signal, exitCode: run.exit }, name);                                  // re-raised after the cleanup, so the shell sees the right status
}, 90_000);

/**
 * Doctor, with a stand-in `git` that logs each call made while the scratch copy exists and stalls call number `stallAt` (0: none). Bun runs a signal handler only when the event loop
 * turns, so a signal that reaches doctor ALONE during a synchronous git call is handled once that call returns: this runs doctor, signals it during the stall, then ends the
 * stalled git (what a terminal's group signal does at once), and reports what is left.
 */
async function stalledAt(stallAt: number, name: NodeJS.Signals | null, endGit = true): Promise<{ calls: number; left: string[]; signal: string | number | null; exit: number | null }> {
  const r = rig(); r.note("n"); r.capture("claude", new Date().toISOString());
  const tmp = join(r.root, "tmp"); mkdirSync(tmp);
  const fake = join(r.root, "bin"); mkdirSync(fake);
  const realGit = Bun.which("git")!, count = join(r.root, "git.count"), pidFile = join(r.root, "git.pid");
  writeFileSync(count, "");
  writeFileSync(join(fake, "git"), `#!/bin/sh
for d in ${JSON.stringify(tmp)}/amem-doctor-*; do
  if [ -d "$d" ]; then
    echo x >> ${JSON.stringify(count)}
    n=$(wc -l < ${JSON.stringify(count)} | tr -d ' ')
    [ "$n" = "${stallAt}" ] && { echo $$ > ${JSON.stringify(pidFile)}; exec sleep 120; }
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
  const env = { ...process.env, AMEM_HOME: r.memory, TMPDIR: tmp, PATH: `${fake}:${process.env.PATH}` } as Record<string, string | undefined>;
  for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "AGENTHUB_PEER_ID", "CLAUDE_CODE_SESSION_ID", "PI_SESSION_ID"]) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/amem.js"), "doctor"], { cwd: r.cwd, env: env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const calls = () => readFileSync(count, "utf8").split("\n").filter(Boolean).length;
  try {
    if (name !== null) {
      for (let i = 0; i < 240 && !existsSync(pidFile); i++) await Bun.sleep(50);
      expect(existsSync(pidFile), `git call ${stallAt} was never reached`).toBe(true);
      child.kill(name);                                                                           // doctor alone: its stalled git does not get it
      await Bun.sleep(150); expect(child.exitCode).toBeNull();                                    // still inside the synchronous call
      if (endGit) process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");          // the stalled git ends, the call returns
    }
    await Promise.race([child.exited, Bun.sleep(endGit ? 12_000 : 20_000)]);
    return { calls: calls(), left: scratchDirs(tmp), signal: child.signalCode, exit: child.exitCode };
  } finally { child.kill("SIGKILL"); }
}

test("a signal that reaches doctor alone during ANY git call it makes after the scratch exists still removes the scratch and ends doctor with that signal (#435)", async () => {
  const plain = await stalledAt(0, null);
  expect(plain.exit).toBe(0); expect(plain.left).toEqual([]);
  expect(plain.calls).toBeGreaterThan(1);                                                         // there is more than one place to stall
  for (let k = 1; k <= plain.calls; k++) {
    const run = await stalledAt(k, "SIGTERM");
    expect(run.left, `stalled at git call ${k} of ${plain.calls}`).toEqual([]);
    expect(run.signal, `stalled at git call ${k} of ${plain.calls}`).toBe("SIGTERM");
  }
}, 90_000);

test("a lone signal does not wait for a git that never returns: doctor's own git timeout lets the handler run (#437, measured: 20 s with 4 s calls)", async () => {
  const started = Date.now();
  const run = await stalledAt(1, "SIGTERM", false);                                                // nobody ends the stalled git: only the timeout can
  expect(run.signal).toBe("SIGTERM"); expect(run.left).toEqual([]);
  expect(Date.now() - started).toBeLessThan(DOCTOR_GIT_TIMEOUT_MS + 8_000);
}, 60_000);

test("SIGKILL cannot be handled: the scratch stays, and the next doctor sweeps it because its owner is gone (#435)", async () => {
  const run = await interruptedDoctor("SIGKILL");
  expect(run.left.length).toBe(1);
  const dead = run.left[0]!;
  expect(sweepStaleScratch(run.tmp)).toBe(1);
  expect(existsSync(join(run.tmp, dead))).toBe(false);
}, 90_000);

test("the sweep removes only a scratch directory of a dead owner that this user owns, and nothing else (#435)", () => {
  const tmp = realPath(mkdtempSync(join(tmpdir(), "amem-sweep-"))); cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  const make = (name: string) => { mkdirSync(join(tmp, name)); writeFileSync(join(tmp, name, "log"), "a copy of the notes"); return join(tmp, name); };
  const dead = make("amem-doctor-999999-abcdef"), live = make("amem-doctor-4242-ghijkl"), unknown = make("amem-doctor-31337-mnopqr");
  const other = make("amem-doctor-notes"), longer = make("amem-doctor-123-too-long-suffix"), unrelated = make("keep-me");
  // A link and a plain file, both named like a scratch directory with a DEAD owner: only the name test and the type test stand between them and removal.
  const link = join(tmp, "amem-doctor-999998-stuvwx"); symlinkSync(unrelated, link);
  const file = join(tmp, "amem-doctor-999997-yzabcd"); writeFileSync(file, "not a directory");
  const state: Record<number, boolean> = { 999999: false, 999998: false, 999997: false, 4242: true, 31337: true };
  expect(sweepStaleScratch(tmp, pid => state[pid] ?? true)).toBe(1);
  expect(existsSync(dead)).toBe(false);
  for (const kept of [live, unknown, other, longer, unrelated, file]) expect(existsSync(kept), kept).toBe(true);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);                                           // the link itself is still there (existsSync would follow it)
  expect(readFileSync(join(unrelated, "log"), "utf8")).toBe("a copy of the notes");              // and its target is untouched
});

test("the sweep leaves a dead owner's directory alone when this user does not own it (#435)", () => {
  const tmp = realPath(mkdtempSync(join(tmpdir(), "amem-sweep-"))); cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, "amem-doctor-999999-abcdef"));
  const mine = statSync(join(tmp, "amem-doctor-999999-abcdef")).uid;
  expect(sweepStaleScratch(tmp, () => false, Date.now(), mine + 1)).toBe(0);                      // another user's directory in a shared temp directory: not ours to remove
  expect(sweepStaleScratch(tmp, () => false, Date.now(), mine)).toBe(1);
});

test("doctor itself sweeps a dead run's scratch directory before it makes its own (#435)", async () => {
  const r = rig(); r.note("n");
  const tmp = join(r.root, "tmp"); mkdirSync(tmp);
  mkdirSync(join(tmp, "amem-doctor-999999-abcdef")); writeFileSync(join(tmp, "amem-doctor-999999-abcdef", "log"), "left by a killed doctor");
  mkdirSync(join(tmp, `amem-doctor-${process.pid}-liveRun`));                                      // a live run's directory (this test process): never touched
  const env = { ...process.env, AMEM_HOME: r.memory, TMPDIR: tmp } as Record<string, string | undefined>;
  for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "AGENTHUB_PEER_ID", "CLAUDE_CODE_SESSION_ID", "PI_SESSION_ID"]) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/amem.js"), "doctor"], { cwd: r.cwd, env: env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(scratchDirs(tmp)).toEqual([`amem-doctor-${process.pid}-liveRun`]);
}, 90_000);

test("a scratch directory from before the owner's pid was in the name goes only after a day, and a live run's never does (#435)", () => {
  const tmp = realPath(mkdtempSync(join(tmpdir(), "amem-sweep-"))); cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, "amem-doctor-AbC123"));
  const now = Date.now();
  expect(sweepStaleScratch(tmp, () => true, now)).toBe(0);                                      // an hour old at most: could be a run of an older amem in progress
  expect(sweepStaleScratch(tmp, () => true, now + 25 * 3600_000)).toBe(1);
  expect(existsSync(join(tmp, "amem-doctor-AbC123"))).toBe(false);
  expect(sweepStaleScratch(join(tmp, "does-not-exist"))).toBe(0);                               // an unreadable temp directory is not an error
});

test("an ordinary doctor run leaves no scratch directory and no process handler behind (#435)", async () => {
  const r = rig(); r.note("n");
  const before = (["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const).map(name => process.listenerCount(name)), exits = process.listenerCount("exit");
  const tmp = realPath(tmpdir()), had = scratchDirs(tmp);
  await doctor(r);
  expect((["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const).map(name => process.listenerCount(name))).toEqual(before);
  expect(process.listenerCount("exit")).toBe(exits);
  expect(scratchDirs(tmp).filter(name => !had.includes(name))).toEqual([]);
});
