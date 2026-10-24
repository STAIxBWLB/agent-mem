import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { realPath } from "../src/memory/platform.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { SYNC_BACKOFF_BASE_MS, SYNC_BACKOFF_CAP_MS, SYNC_INTERVAL_MS, SYNC_STATE_FILE, nextSyncAt, readSyncState, recordSyncAttempt, remoteConfigured, STOP_SIGNALS, stopSignal, syncDue, syncOutcome, syncWaitMs, usableState } from "../src/memory/sync-cadence.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { ptyArgv } from "./fakes/pty.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const T0 = Date.parse("2026-10-24T10:00:00.000Z"), MIN = 60_000;
function temp(): string { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-cadence-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test("the wait is the hourly interval after a success and doubles from 15 minutes to a one-day cap after failures", () => {
  expect(syncWaitMs(0)).toBe(SYNC_INTERVAL_MS);
  expect([1, 2, 3, 4, 5, 6, 7, 8].map(syncWaitMs)).toEqual([15, 30, 60, 120, 240, 480, 960, 1440].map(m => m * MIN));
  expect(syncWaitMs(30)).toBe(SYNC_BACKOFF_CAP_MS); expect(syncWaitMs(1)).toBe(SYNC_BACKOFF_BASE_MS);
});

test("due follows the stamp: no history is due, a recent attempt is not, and --force always is", () => {
  const home = temp();
  expect(syncDue(readSyncState(home), T0)).toBe(true);
  recordSyncAttempt(home, true, T0);
  const ok = readSyncState(home);
  expect(ok).toEqual({ lastAttemptAt: new Date(T0).toISOString(), lastOkAt: new Date(T0).toISOString(), failures: 0 });
  expect(syncDue(ok, T0 + SYNC_INTERVAL_MS - 1)).toBe(false); expect(syncDue(ok, T0 + SYNC_INTERVAL_MS)).toBe(true);
  expect(syncDue(ok, T0 + 1, true)).toBe(true);
  recordSyncAttempt(home, false, T0 + 2 * SYNC_INTERVAL_MS);
  const failed = readSyncState(home);
  expect(failed.failures).toBe(1); expect(failed.lastOkAt).toBe(new Date(T0).toISOString());     // a failure keeps the last success
  expect(nextSyncAt(failed)).toBe(T0 + 2 * SYNC_INTERVAL_MS + 15 * MIN);
  recordSyncAttempt(home, false, T0 + 3 * SYNC_INTERVAL_MS);
  expect(readSyncState(home).failures).toBe(2);
  recordSyncAttempt(home, true, T0 + 4 * SYNC_INTERVAL_MS);
  expect(readSyncState(home).failures).toBe(0);                                                  // a success clears the backoff
});

test("a damaged, oversized, linked or hand-edited stamp is no history (due now), never a crash, and the stamp never holds an error text", () => {
  const home = temp(); const file = join(home, SYNC_STATE_FILE);
  for (const bad of ["{ nope", "[]", JSON.stringify({ lastAttemptAt: "yesterday", lastOkAt: 5, failures: -3 }), "x".repeat(10_000)]) {
    writeFileSync(file, bad);
    const state = readSyncState(home);
    expect(state.failures).toBe(0); expect(syncDue(state, T0)).toBe(true);
  }
  writeFileSync(file, JSON.stringify({ lastAttemptAt: new Date(T0).toISOString(), lastOkAt: null, failures: 1e9 }));
  expect(readSyncState(home).failures).toBeLessThanOrEqual(30);
  rmSync(file); symlinkSync(join(home, "elsewhere"), file);
  expect(readSyncState(home).lastAttemptAt).toBeNull();
  rmSync(file); recordSyncAttempt(home, false, T0);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["failures", "lastAttemptAt", "lastOkAt"]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("recording an attempt in a home that cannot be written never throws", () => {
  const home = temp(); writeFileSync(join(home, "blocked"), "a file, not a directory");
  expect(() => recordSyncAttempt(join(home, "blocked", "inside"), true, T0)).not.toThrow();
});

test("a configured remote is read from the repository config without a git process and without ever returning the URL", () => {
  const home = temp();
  expect(remoteConfigured(home)).toBe(false);
  mkdirSync(join(home, ".git"), { recursive: true }); writeFileSync(join(home, ".git", "config"), "[core]\n\tbare = false\n");
  expect(remoteConfigured(home)).toBe(false);
  writeFileSync(join(home, ".git", "config"), '[remote "origin"]\n\turl = https://token@example.invalid/x.git\n');
  expect(remoteConfigured(home)).toBe(true);
  const other = temp(); mkdirSync(join(other, "shard-sync", "objects.git"), { recursive: true });
  writeFileSync(join(other, "shard-sync", "objects.git", "config"), '[remote "origin"]\n\turl = x\n');
  expect(remoteConfigured(other)).toBe(false);                                         // a shard cache left behind in a home that is not split is not the active repository
  writeFileSync(join(other, "shards.json"), "{}");                                     // only the file's presence selects the split layout (its content is validated elsewhere)
  expect(remoteConfigured(other)).toBe(true);
});

test("a generation home is read at its own repository: its remote counts, the legacy repository beside it does not (review: P2)", async () => {
  const { migrate } = await import("../src/memory/migrate.ts");
  const { syncGenerationMemory } = await import("../src/memory/generation-sync.ts");
  const G = "c".repeat(32), root = temp(), url = join(root, "remote.git");
  expect(memoryGitSync(["init", "--bare", "-q", url], { encoding: "utf8" }).status).toBe(0);
  const legacy = new MemoryStore({ home: root, profile: "shared-v1", deferPromotions: true }), memoryDir = legacy.dir;
  legacy.note({ op: "note", project: "p", scope: "project", tier: "long", kind: "decision", peer: "me", source: "person", text: "legacy input", about: [] });
  legacy.close();
  expect(remoteConfigured(memoryDir)).toBe(false);
  await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home: root, profile: { generation: G }, deferPromotions: true });
  try {
    expect(remoteConfigured(memoryDir)).toBe(false);                                                    // active generation, no remote yet
    mkdirSync(join(memoryDir, ".git"), { recursive: true }); writeFileSync(join(memoryDir, ".git", "config"), '[remote "origin"]\n\turl = x\n');
    expect(remoteConfigured(memoryDir)).toBe(false);                                                    // the legacy repository's remote is not the generation's
    expect((await syncGenerationMemory(store, { remote: url, visibility: async () => "private" })).ok).toBe(true);
    expect(remoteConfigured(memoryDir)).toBe(true);                                                     // the generation's own repository now has one
  } finally { store.close(); }
});

// ---- the CLI, against a real local bare remote ----
function rig() {
  const root = temp(), memory = join(root, "memory"), cwd = join(root, "repo"), remote = join(root, "remote.git");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  expect(memoryGitSync(["init", "--bare", "-q", remote], { encoding: "utf8" }).status).toBe(0);
  const project = memoryProjectKey(cwd);
  const s = new MemoryStore({ memoryDir: memory, deferPromotions: true });
  try { s.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "me", source: "person", text: "a public decision", about: [] } as never); } finally { s.close(); }
  const run = async (args: string[], tty = true): Promise<string> => {
    const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = memory;
    try { return await runCli(args, { cwd, env: {}, stdinTTY: tty, visibility: async () => "private" }); }
    finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
  };
  return { root, memory, cwd, remote, run, stamp: () => readSyncState(memory) };
}

test("sync --if-due without a configured remote does nothing, creates nothing and stamps nothing", async () => {
  const r = rig();
  expect(await r.run(["sync", "--if-due"])).toBe("no sync remote configured: nothing to do");
  expect(JSON.parse(await r.run(["sync", "--if-due", "--json"]))).toEqual({ ok: true, skipped: "no sync remote configured" });
  expect(existsSync(join(r.memory, SYNC_STATE_FILE))).toBe(false); expect(existsSync(join(r.memory, ".git"))).toBe(false);
});

test("sync --if-due syncs when due, stamps the success, and is then skipped until the interval has passed", async () => {
  const r = rig();
  expect(await r.run(["sync", "--remote", r.remote])).toContain("synced");               // a person sets the remote once: a plain sync, which stamps too
  const first = r.stamp(); expect(first.failures).toBe(0); expect(first.lastOkAt).not.toBeNull();
  const skipped = JSON.parse(await r.run(["sync", "--if-due", "--json"]));
  expect(skipped).toMatchObject({ ok: true, skipped: "not due", failures: 0 });
  expect(Date.parse(skipped.nextAttemptAt)).toBe(Date.parse(first.lastAttemptAt!) + SYNC_INTERVAL_MS);
  expect(r.stamp()).toEqual(first);                                                       // a skipped run neither syncs nor re-stamps
  expect(await r.run(["sync", "--if-due"])).toContain("sync not due until");
  const old = new Date(Date.now() - 2 * SYNC_INTERVAL_MS).toISOString();
  writeFileSync(join(r.memory, SYNC_STATE_FILE), JSON.stringify({ lastAttemptAt: old, lastOkAt: old, failures: 0 }));
  expect(await r.run(["sync", "--if-due"])).toContain("synced");
  expect(Date.parse(r.stamp().lastAttemptAt!)).toBeGreaterThan(Date.parse(old));
});

test("a failed sync stamps a failure and backs off; --force overrides the backoff; a success clears it", async () => {
  const r = rig();
  await r.run(["sync", "--remote", r.remote]);
  rmSync(r.remote, { recursive: true, force: true });                                      // the remote vanishes: every sync now fails
  const old = new Date(Date.now() - 2 * SYNC_INTERVAL_MS).toISOString();
  writeFileSync(join(r.memory, SYNC_STATE_FILE), JSON.stringify({ lastAttemptAt: old, lastOkAt: old, failures: 0 }));
  await expect(r.run(["sync", "--if-due"])).rejects.toThrow(/sync/);
  expect(r.stamp().failures).toBe(1);
  const wait = JSON.parse(await r.run(["sync", "--if-due", "--json"]));
  expect(wait).toMatchObject({ skipped: "not due", failures: 1 });
  expect(Date.parse(wait.nextAttemptAt) - Date.parse(r.stamp().lastAttemptAt!)).toBe(15 * MIN);
  await expect(r.run(["sync", "--if-due", "--force"])).rejects.toThrow(/sync/);            // --force ignores the backoff and fails again
  expect(r.stamp().failures).toBe(2);
  expect(memoryGitSync(["init", "--bare", "-q", r.remote], { encoding: "utf8" }).status).toBe(0);
  expect(await r.run(["sync", "--if-due", "--force"])).toContain("synced");
  expect(r.stamp()).toMatchObject({ failures: 0 });
});

test("--force and --if-due are refused where they do not belong, and a scheduled sync still needs a terminal", async () => {
  const r = rig();
  await expect(r.run(["sync", "--force"])).rejects.toThrow("--force only applies with sync --if-due");
  await expect(r.run(["sync", "--if-due"], false)).rejects.toThrow("terminal on stdin");
  await expect(r.run(["list", "--if-due"])).rejects.toThrow(/unknown option/);
  expect(existsSync(join(r.memory, SYNC_STATE_FILE))).toBe(false);
});

test("doctor reports the sync cadence: no remote, then a due remote, stale and failing ones, never a URL", async () => {
  const r = rig();
  const report = async () => JSON.parse(await r.run(["doctor", "--json"], false)).sections.cadence;
  expect((await report()).sync).toMatchObject({ remote: "none", due: false });
  await r.run(["sync", "--remote", r.remote]);
  const ok = await report();
  expect(ok.sync).toMatchObject({ remote: "configured", failures: 0, due: false }); expect(ok.status).toBe("ok");
  expect(ok.sync.schedule).toContain("amem sync --if-due"); expect(ok.sync.schedule).toContain("registers no sync hook");
  expect(JSON.stringify(ok)).not.toContain(r.remote);                                       // the remote URL never reaches the report
  const old = new Date(Date.now() - 10 * 86400_000).toISOString();
  writeFileSync(join(r.memory, SYNC_STATE_FILE), JSON.stringify({ lastAttemptAt: old, lastOkAt: old, failures: 0 }));
  expect(await report()).toMatchObject({ status: "attention", hint: expect.stringContaining("no recent successful sync") });
  const now = new Date().toISOString();
  writeFileSync(join(r.memory, SYNC_STATE_FILE), JSON.stringify({ lastAttemptAt: now, lastOkAt: now, failures: 3 }));
  expect(await report()).toMatchObject({ status: "attention", hint: expect.stringContaining("failed repeatedly") });
});

test("a failed sync reported through --json is stamped as a failure, not a success (review finding 4)", async () => {
  const r = rig();
  await r.run(["sync", "--remote", r.remote]);
  rmSync(r.remote, { recursive: true, force: true });                                      // the remote vanishes: sync returns {ok:false} under --json instead of throwing
  const out = JSON.parse(await r.run(["sync", "--if-due", "--force", "--json"]));
  expect(out.ok).toBe(false);
  const stamp = r.stamp();
  expect(stamp.failures).toBe(1);
  expect(stamp.lastOkAt).not.toBe(stamp.lastAttemptAt);                                    // a failure never becomes the last success
  expect(JSON.parse(await r.run(["sync", "--if-due", "--json"]))).toMatchObject({ skipped: "not due", failures: 1 });   // so the backoff holds for a JSON caller too
  const doc = JSON.parse(await r.run(["doctor", "--json"], false)).sections.cadence;
  expect(doc.sync.failures).toBe(1); expect(doc.sync.lastOkAt).not.toBe(doc.sync.lastAttemptAt);
});

test("a future stamp is no history: it neither blocks --if-due nor claims a success, and doctor shows no negative age (nit)", async () => {
  const r = rig();
  await r.run(["sync", "--remote", r.remote]);
  const future = new Date(Date.now() + 5 * 86400_000).toISOString();
  writeFileSync(join(r.memory, SYNC_STATE_FILE), JSON.stringify({ lastAttemptAt: future, lastOkAt: future, failures: 4 }));
  expect(usableState(readSyncState(r.memory), Date.now())).toEqual({ lastAttemptAt: null, lastOkAt: null, failures: 0 });
  expect(await r.run(["sync", "--if-due"])).toContain("synced");                         // due, not blocked for five days
  const doc = JSON.parse(await r.run(["doctor", "--json"], false)).sections.cadence;
  writeFileSync(join(r.memory, SYNC_STATE_FILE), JSON.stringify({ lastAttemptAt: future, lastOkAt: future, failures: 4 }));
  const shown = JSON.parse(await r.run(["doctor", "--json"], false)).sections.cadence.sync;
  expect(shown.lastOkAt).toBeNull(); expect(shown.failures).toBe(0); expect(doc.sync.remote).toBe("configured");
});

test("only a transport failure backs the schedule off: a refusal no remote ever saw is not stamped (nit)", async () => {
  expect(syncOutcome(undefined)).toBe("ok");
  for (const local of ["another sync is running on this machine", "another memory mutation is running on this machine", "another generation sync is running or its owner is unknown", "no sync remote: a person sets one", "the sync remote is public; memory syncs only to a private remote", "the configured privacy policy declines 1 long-term entry: abcd1234", "amem sync: usage: amem sync [--remote <private git url>]", "this machine's long-term segment cannot be read, so it was not screened"]) expect(syncOutcome(local)).toBe("local");
  for (const failed of ["fetch failed: could not read from remote", "push failed: rejected", "merge failed: conflict", "commit failed: x", "something nobody has heard of"]) expect(syncOutcome(failed)).toBe("failed");
  const r = rig();
  await r.run(["sync", "--remote", r.remote]);
  const before = r.stamp();
  writeFileSync(join(r.memory, "amem.config.json"), JSON.stringify({ piiPatterns: ["public decision"] }));   // the policy now declines the one note: a local refusal
  await expect(r.run(["sync", "--force", "--if-due"])).rejects.toThrow(/privacy policy/);
  expect(r.stamp()).toEqual(before);                                                       // not stamped: no remote was reached, nothing to back off from
});

test("the --if-due deadline reaches git's transport children: an ssh stand-in that sleeps is gone after the abort (review finding 5)", async () => {
  const { syncGit } = await import("../src/memory/sync.ts");
  const root = temp(), pidFile = join(root, "child.pid"), fakeSsh = join(root, "fake-ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 60\n`, { mode: 0o755 });
  const repo = join(root, "repo"); mkdirSync(repo);
  expect(memoryGitSync(["init", "-q", repo], { encoding: "utf8" }).status).toBe(0);
  expect(memoryGitSync(["-C", repo, "remote", "add", "origin", "ssh://example.invalid/x.git"], { encoding: "utf8" }).status).toBe(0);
  const saved = process.env.GIT_SSH_COMMAND; process.env.GIT_SSH_COMMAND = fakeSsh;
  const controller = new AbortController();
  try {
    const running = syncGit(repo, ["fetch", "-q", "origin"], controller.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    expect(existsSync(pidFile)).toBe(true);                                                // git started its transport child
    const child = Number(readFileSync(pidFile, "utf8").trim());
    controller.abort();
    await running;
    for (let i = 0; i < 100; i++) { try { process.kill(child, 0); } catch { break; } await Bun.sleep(50); }
    let alive = true; try { process.kill(child, 0); } catch { alive = false; }
    expect(alive).toBe(false);                                                             // the transport child died with git, not 60 seconds later
  } finally { if (saved === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved; }
});

test("every way a terminal ends an --if-due run (Ctrl-C, SIGTERM, SIGHUP, SIGQUIT) stops it, a second one is still handled, and the handlers are removed afterwards (review: sighup orphans git)", async () => {
  const { EventEmitter } = await import("node:events");
  expect([...STOP_SIGNALS]).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
  for (const name of STOP_SIGNALS) {
    const emitter = new EventEmitter(), stop = stopSignal(60_000, emitter);
    expect(stop.signal.aborted).toBe(false); expect(emitter.listenerCount(name)).toBe(1);
    emitter.emit(name);
    expect(stop.signal.aborted).toBe(true);
    expect(emitter.listenerCount(name)).toBe(1);                                                 // `on`, not `once`: still installed, so a second signal is not the default action
    emitter.emit(name); emitter.emit(name);
    stop.dispose(); for (const other of STOP_SIGNALS) expect(emitter.listenerCount(other)).toBe(0);
  }
  const quiet = new EventEmitter(), idle = stopSignal(60_000, quiet); idle.dispose();
  expect(idle.signal.aborted).toBe(false); expect(quiet.listenerCount("SIGHUP")).toBe(0);
  const soon = stopSignal(30, new EventEmitter());
  await Bun.sleep(80); expect(soon.signal.aborted).toBe(true); soon.dispose();                  // the deadline still fires
});

/**
 * The real binary under a pty, syncing through a fake ssh that records its own pid and amem's, then sleeps like a stalled network. `end` ends the run the way a person (or a
 * closing terminal) would; the answer is what is still alive afterwards. git runs in its own process group during --if-due, so none of this reaches git by itself.
 */
async function endedRun(end: (amem: number, group: number) => void | Promise<void>): Promise<{ sshAlive: boolean; gitAlive: boolean; status: string; message: string; stamp: ReturnType<typeof readSyncState>; skipped?: string }> {
  const root = temp(), memory = join(root, "memory"), cwd = join(root, "repo"), sshFile = join(root, "ssh.pid"), amemFile = join(root, "amem.pid"), gitFile = join(root, "git.pid"), fakeSsh = join(root, "fake-ssh");
  mkdirSync(cwd, { recursive: true }); expect(memoryGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
  // ssh <- git <- amem: record all three, then stall.
  writeFileSync(fakeSsh, `#!/bin/sh\necho $$ > ${JSON.stringify(sshFile)}\nps -o ppid= -p $$ | tr -d ' ' > ${JSON.stringify(gitFile)}\nps -o ppid= -p $(cat ${JSON.stringify(gitFile)}) | tr -d ' ' > ${JSON.stringify(amemFile)}\nexec sleep 120\n`, { mode: 0o755 });
  const s = new MemoryStore({ memoryDir: memory, deferPromotions: true });
  try { s.note({ op: "note", project: memoryProjectKey(cwd), scope: "project", tier: "long", kind: "decision", peer: "me", source: "person", text: "a public decision", about: [] } as never); } finally { s.close(); }
  const bin = join(import.meta.dir, "../bin/amem.js"), out = join(root, "out.txt");
  const argv = ptyArgv(`cd ${JSON.stringify(cwd)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} sync --if-due --force --remote ssh://example.invalid/x.git > ${JSON.stringify(out)} 2>&1; echo status:$?`);
  if (argv === undefined) return { sshAlive: false, gitAlive: false, status: "", message: "", stamp: readSyncState(memory), skipped: "the `script` utility is not installed, so no pty could be driven" };
  const env = { ...process.env, AMEM_HOME: memory, GIT_SSH_COMMAND: fakeSsh }; for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "AGENTHUB_PEER_ID", "CLAUDE_CODE_SESSION_ID", "PI_SESSION_ID"]) delete (env as Record<string, unknown>)[key];
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let ssh = 0, git = 0, amem = 0, status = "";
  try {
    for (let i = 0; i < 200 && !(existsSync(amemFile) && readFileSync(amemFile, "utf8").trim()); i++) await Bun.sleep(50);
    expect(existsSync(sshFile)).toBe(true);                                                      // the sync reached git's transport
    ssh = Number(readFileSync(sshFile, "utf8").trim()); git = Number(readFileSync(gitFile, "utf8").trim()); amem = Number(readFileSync(amemFile, "utf8").trim());
    expect(alive(ssh) && alive(git)).toBe(true); expect(amem).toBeGreaterThan(1); expect(git).not.toBe(amem);
    await end(amem, amem);
    for (let i = 0; i < 120 && (alive(ssh) || alive(git)); i++) await Bun.sleep(50);
    const result = { sshAlive: alive(ssh), gitAlive: alive(git) };
    await Promise.race([child.exited, Bun.sleep(3000)]);
    status = await Promise.race([new Response(child.stdout).text(), Bun.sleep(1000).then(() => "")]);
    return { ...result, status, message: existsSync(out) ? readFileSync(out, "utf8") : "", stamp: readSyncState(memory) };
  } finally { for (const pid of [ssh, git]) if (pid && alive(pid)) process.kill(pid, "SIGKILL"); child.kill(); }
}
const signalAmem = (name: NodeJS.Signals) => (amem: number) => { process.kill(amem, name); };

test("the real binary: Ctrl-C during `sync --if-due --force` stops git and its ssh transport child, and stamps a failure it can explain (review finding 5, end to end)", async () => {
  const r = await endedRun(signalAmem("SIGINT"));
  if (r.skipped) { console.log(`SKIPPED: ${r.skipped}`); return; }
  expect(r.sshAlive).toBe(false); expect(r.gitAlive).toBe(false);                                // the transport child and git are gone, not 120 seconds later
  expect(r.status).toMatch(/status:1/); expect(r.message).toContain("fetch failed");             // amem exits 1 and says why (never a URL)
  expect(r.stamp.failures).toBe(1);                                                              // an interrupted transport is a failure to back off from
});

for (const name of ["SIGHUP", "SIGQUIT", "SIGTERM"] as const) test(`the real binary: ${name} during --if-due leaves no git and no ssh behind (review: sighup orphans git)`, async () => {
  const r = await endedRun(signalAmem(name));
  if (r.skipped) { console.log(`SKIPPED: ${r.skipped}`); return; }
  expect(r.sshAlive).toBe(false); expect(r.gitAlive).toBe(false);
});

test("the real binary: a second Ctrl-C while git is being stopped still leaves nothing behind", async () => {
  // Three Ctrl-Cs in a row, as a person hammering the key sends them. amem may already have exited when a later one arrives (that is the point: it stops quickly), so a gone
  // process is not an error here. What must hold is that none of them ever strands git: with `once` the second one fell to the default action and ended amem before git.
  const r = await endedRun(amem => { for (let i = 0; i < 3; i++) { try { process.kill(amem, "SIGINT"); } catch { /* already exited */ } } });
  if (r.skipped) { console.log(`SKIPPED: ${r.skipped}`); return; }
  expect(r.sshAlive).toBe(false); expect(r.gitAlive).toBe(false);
});

test("the real binary: SIGHUP to the whole foreground group, as a closing terminal sends it, leaves nothing behind (review: sighup orphans git)", async () => {
  // A terminal close signals amem's foreground group; git is in its own group, so only amem (and the shell around it) receive this.
  const r = await endedRun((amem) => { try { process.kill(-amem, "SIGHUP"); } catch { process.kill(amem, "SIGHUP"); } });
  if (r.skipped) { console.log(`SKIPPED: ${r.skipped}`); return; }
  expect(r.sshAlive).toBe(false); expect(r.gitAlive).toBe(false);
});

test("a process that exits while a deadline git is running takes git and its ssh child with it, whatever ended it (the exit handler; review: sighup orphans git)", async () => {
  const root = temp(), sshFile = join(root, "ssh.pid"), fakeSsh = join(root, "fake-ssh"), script = join(root, "dies.ts");
  writeFileSync(fakeSsh, `#!/bin/sh\necho $$ > ${JSON.stringify(sshFile)}\nexec sleep 120\n`, { mode: 0o755 });
  const repo = join(root, "repo"); mkdirSync(repo);
  expect(memoryGitSync(["init", "-q", repo], { encoding: "utf8" }).status).toBe(0);
  expect(memoryGitSync(["-C", repo, "remote", "add", "origin", "ssh://example.invalid/x.git"], { encoding: "utf8" }).status).toBe(0);
  // A caller that has a stop signal, runs git, and is then ended by something none of the four handlers sees: an uncaught throw.
  writeFileSync(script, `const { syncGit } = await import(${JSON.stringify(join(import.meta.dir, "../src/memory/sync.ts"))});
const controller = new AbortController();
syncGit(${JSON.stringify(repo)}, ["fetch", "-q", "origin"], controller.signal);
await Bun.sleep(1500);
throw new Error("amem died for some other reason");
`);
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, GIT_SSH_COMMAND: fakeSsh }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let ssh = 0;
  try {
    for (let i = 0; i < 100 && !existsSync(sshFile); i++) await Bun.sleep(50);
    expect(existsSync(sshFile)).toBe(true);
    ssh = Number(readFileSync(sshFile, "utf8").trim());
    expect(alive(ssh)).toBe(true);
    await child.exited;
    for (let i = 0; i < 60 && alive(ssh); i++) await Bun.sleep(50);
    expect(alive(ssh)).toBe(false);                                                              // not left at ppid 1 for two minutes
  } finally { if (ssh && alive(ssh)) process.kill(ssh, "SIGKILL"); child.kill(); }
});

test("amem never registers a sync hook or a resident process: no setup, hook or ingest source mentions sync, and the cadence module starts no process or timer", () => {
  for (const file of ["../src/setup.ts", "../src/setup-owned.ts", "../src/setup-toml.ts", "../src/hooks.ts", "../src/hook-native.ts", "../src/hook-spool.ts", "../src/ingest.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(text, file).not.toMatch(/\bsync\b.*\b(SessionEnd|session_shutdown)\b|\b(SessionEnd|session_shutdown)\b.*\bsync\b|amem sync|syncMemory|sync-cadence/);
  }
  const cadence = readFileSync(new URL("../src/memory/sync-cadence.ts", import.meta.url), "utf8");
  expect(cadence).not.toMatch(/Bun\.spawn|child_process|setInterval|setTimeout|detached/);
});
