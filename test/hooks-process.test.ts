import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { hookBin, hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = hookFixture(); fixtures.push(f); return f; }
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
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
  const receipts = observer.read(); expect(receipts).toHaveLength(2);
  for (const receipt of receipts) {
    for (const marker of markers) expect(JSON.stringify(receipt.argv)).not.toContain(marker);
    expect(receipt.argv).toEqual([process.execPath, observer.worker]);
  }
  expect(f.rows()).toHaveLength(0);
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
  } finally {
    if (nativePid === undefined && existsSync(pidFile)) nativePid = Number(readFileSync(pidFile, "utf8").trim());
    if (nativePid !== undefined && Number.isSafeInteger(nativePid) && nativePid > 0 && alive(nativePid)) {
      const check = Bun.spawnSync(["ps", "-p", String(nativePid), "-o", "pgid=,comm="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(check.stdout.toString());
      if (match && (ownedGroup === undefined || Number(match[1]) === ownedGroup) && /(?:^|\/)sleep$/.test(match[2]!)) try { process.kill(nativePid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}, 5000);
