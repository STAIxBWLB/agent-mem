import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hookCapturePending } from "../src/hook-spool.ts";
import { hookBin, hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = hookFixture(); fixtures.push(f); return f; }
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

interface AcceptedCapture { event: string; excerpt: string }
function pendingCaptures(f: ReturnType<typeof hookFixture>, item: AcceptedCapture) {
  const dir = join(f.base, "hook-spool");
  if (!existsSync(dir)) return [];
  const matches = readdirSync(dir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
    .map(name => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .filter(value => value.schema === "agent-mem.hook-capture/v1" && value.cwd === f.cwd && value.capture?.event === item.event && value.capture?.excerpt === item.excerpt);
  for (const value of matches) {
    expect(value.capture.agent).toBe("claude"); expect(Number.isFinite(Date.parse(value.capture.at))).toBe(true);
    expect(Array.isArray(value.capture.paths)).toBe(true); expect(value.capture.paths.length).toBeLessThanOrEqual(32);
    expect(Number.isFinite(value.capture.bytes)).toBe(true); expect(Buffer.byteLength(value.capture.excerpt)).toBeLessThanOrEqual(8000);
  }
  return matches;
}
function replayThroughHooks(f: ReturnType<typeof hookFixture>, accepted: AcceptedCapture[]) {
  const barriers: AcceptedCapture[] = []; let rows = f.rows();
  const matching = (item: AcceptedCapture) => rows.filter(row => row.event === item.event && row.excerpt === item.excerpt && row.project === f.project);
  // Real accepted work drives replay. The final barrier itself may still be durably pending.
  for (let i = 0; i < 4; i++) {
    const excerpt = `process replay barrier ${i}`, result = f.run("PostToolUse", { prompt: excerpt });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toMatch(/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/);
    barriers.push({ event: "PostToolUse", excerpt }); rows = f.rows();
    if (accepted.every(item => matching(item).length === 1 && pendingCaptures(f, item).length === 0)) break;
  }
  for (const item of accepted) {
    expect(matching(item)).toHaveLength(1); expect(pendingCaptures(f, item)).toHaveLength(0);
  }
  // The original exactly-once row above is the positive control; a new barrier may remain pending.
  for (const item of barriers) {
    const saved = matching(item), pending = pendingCaptures(f, item);
    expect(saved.length).toBeLessThanOrEqual(1); expect(pending.length).toBeLessThanOrEqual(1);
    expect(saved.length === 1 || pending.length === 1).toBe(true);
    // A committed row can retain its same-time acknowledgement claim until the next replay.
    if (saved.length && pending.length) expect(saved[0]!.at).toBe(pending[0]!.capture.at);
  }
  expect(rows).toHaveLength(accepted.length + barriers.filter(item => matching(item).length === 1).length);
  return rows;
}


test("SessionStart never exposes raw private or secret native input in observed fixed-worker argv", () => {
  const f = fixture(), observer = hookProcessObserver(f.root);
  const markers = ["PRIVATE_NATIVE_ARGV_SENTINEL", "SYNTHETIC_PASSWORD_ARGV_SENTINEL"];
  for (const payload of [{ private: true, prompt: markers[0] }, { prompt: `password: ${markers[1]}` }]) {
    const result = Bun.spawnSync([process.execPath, "--preload", observer.preload, hookBin, "hook", "SessionStart"], {
      cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd: f.cwd, ...payload })), stdout: "pipe", stderr: "pipe", timeout: 3000,
    });
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("");
  }
  expect(observer.read()).toHaveLength(0); expect(f.rows()).toHaveLength(0);
  const control = Bun.spawnSync([process.execPath, "--preload", observer.preload, hookBin, "hook", "SessionStart"], {
    cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", cwd: f.cwd, prompt: "public argv observer control" })), stdout: "pipe", stderr: "pipe", timeout: 3000,
  });
  expect(control.exitCode).toBe(0);
  const receipts = observer.read(); expect(receipts).toHaveLength(1);
  for (const receipt of receipts) {
    for (const marker of markers) expect(JSON.stringify(receipt.argv)).not.toContain(marker);
    expect(receipt.argv).toEqual([process.execPath, "--smol", observer.worker]);
  }
  const rows = replayThroughHooks(f, [{ event: "SessionStart", excerpt: "public argv observer control" }]);
  for (const marker of markers) expect(JSON.stringify(rows)).not.toContain(marker);
});

for (const event of ["SessionStart", "PreToolUse"] as const) test(`${event} timeout terminates its observed owned native descendant and fails open within R2`, async () => {
  const f = fixture(), observer = hookProcessObserver(f.root, true);
  const pidFile = observer.nativePidFile, entered = observer.entered;
  let nativePid: number | undefined, ownedGroup: number | undefined;
  try {
    const start = performance.now();
    const result = Bun.spawnSync([process.execPath, "--preload", observer.preload, hookBin, "hook", event], {
      cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: event, cwd: f.cwd, prompt: "public timeout fixture" })), stdout: "pipe", stderr: "pipe", detached: true, timeout: 3000,
    });
    const wallMs = performance.now() - start;
    const workers = observer.read(); expect(workers).toHaveLength(1);
    ownedGroup = workers[0]!.detached ? workers[0]!.pid : result.pid;
    expect(existsSync(entered), `stdout=${result.stdout.toString()} stderr=${result.stderr.toString()} wall=${wallMs}`).toBe(true); expect(existsSync(pidFile)).toBe(true);
    nativePid = Number(readFileSync(pidFile, "utf8").trim()); expect(Number.isSafeInteger(nativePid) && nativePid > 0).toBe(true);
    expect(result.exitCode).toBe(0); expect(result.stdout.length).toBeLessThanOrEqual(8192);
    expect(result.stdout.toString()).not.toMatch(/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/);
    expect(wallMs).toBeLessThan(150);
    // Allow the OS init/reaper to finish an already killed orphan; this does not extend the CLI wall budget.
    const until = performance.now() + 500;
    while (alive(nativePid) && performance.now() < until) await Bun.sleep(10);
    expect(alive(nativePid)).toBe(false);
    expect(alive(workers[0]!.pid)).toBe(false);
    const spool = join(f.base, "hook-spool");
    const retained = readdirSync(spool).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
      .map(name => ({ name: name.split(".draining-")[0]!, value: JSON.parse(readFileSync(join(spool, name), "utf8")) }));
    const pending = retained.filter(row => row.value.capture?.event === event && row.value.capture?.excerpt === "public timeout fixture");
    expect(pending).toHaveLength(1);
    expect(hookCapturePending(f.base, pending[0]!.name)).toBe(true);
    expect(f.rows().filter(row => row.excerpt === "public timeout fixture")).toHaveLength(0);
    const accepted = [{ event, excerpt: "public timeout fixture" }];
    for (const marker of ["healthy follow-up", "second healthy follow-up"]) {
      const healthy = f.run(event, { prompt: marker }); expect(healthy.exitCode).toBe(0);
      accepted.push({ event, excerpt: marker });
    }
    replayThroughHooks(f, accepted);
    expect(hookCapturePending(f.base, pending[0]!.name)).toBe(false);
  } finally {
    if (nativePid === undefined && existsSync(pidFile)) nativePid = Number(readFileSync(pidFile, "utf8").trim());
    if (nativePid !== undefined && Number.isSafeInteger(nativePid) && nativePid > 0 && alive(nativePid)) {
      const check = Bun.spawnSync(["ps", "-p", String(nativePid), "-o", "pgid=,comm="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(check.stdout.toString());
      if (match && (ownedGroup === undefined || Number(match[1]) === ownedGroup) && /(?:^|\/)sleep$/.test(match[2]!)) try { process.kill(nativePid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}, 5000);
