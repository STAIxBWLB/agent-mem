import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hookNative, hookProcessSignature, type HookNativeUsage } from "../src/hook-native.ts";
import * as resources from "../src/hook-resources.ts";
import { HookWorkerRss, rssSourceCode } from "../src/hook-rss-wire.ts";
import { processSignature } from "../src/memory/platform.ts";

for (const heldPipe of ["stderr", "stdout"] as const) test(`Darwin native rusage reaches its observer before held ${heldPipe} teardown`, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, spawn = Bun.spawn;
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  Object.defineProperty(process, "platform", { value: "darwin" });
  let releaseExit!: (code: number) => void, releasePipe!: () => void, closeStderr!: () => void;
  const exited = new Promise<number>(resolve => { releaseExit = resolve; });
  const pipe = new Promise<void>(resolve => { releasePipe = resolve; });
  const tracker = new HookWorkerRss(100); tracker.frame([0]); tracker.frame([3, 35000, 35000, 2]);
  const received: resources.HookRssReading[] = [];
  const usage: HookNativeUsage = { rssKB: 0, rawRssKB: 0, observe: () => {
    tracker.frame([1, 1, 0]);
    return { started: pid => tracker.frame([1, 1, pid]), finished: reading => {
      received.push(reading); tracker.frame([2, 1, reading.kb, reading.rawKB, rssSourceCode(reading), 0]);
    } };
  } };
  Object.assign(Bun, { spawn(argv: string[]) {
    const marker = argv[4]!;
    return { pid: 101, exited, resourceUsage: () => ({ maxRSS: 64 * 1024 }), stdin: { end() {} }, kill() {},
      stdout: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`\n${marker}:ARMED\nmetadata\n\n${marker}:0\n`));
        if (heldPipe === "stderr") controller.close();
      }, cancel: () => heldPipe === "stdout" ? pipe : undefined }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) {
        closeStderr = () => controller.close(); if (heldPipe === "stdout") controller.close();
      } }),
    };
  } });
  let released = false;
  const releaseHeldPipe = () => { if (!released) { released = true; if (heldPipe === "stderr") closeStderr(); else releasePipe(); } };
  const work = hookNative(["fixture"], {}, () => 1000, usage);
  try {
    expect(received).toEqual([]);
    expect(resources.rssSourcesKnown(tracker.finish(35000, "darwin").rssSources)).toBe(false);
    releaseExit(0); await exited;
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kb: 64, rawKB: 64, source: "platform-rusage", known: true });
    expect(usage.rssSources).toMatchObject({ platformRusage: 1, unavailable: 0 });
    expect(tracker.finish(35000, "darwin").rssSources).toMatchObject({ platformRusage: 2, unavailable: 0 });
    releaseHeldPipe();
    expect(await work).toEqual({ status: 0, stdout: "metadata\n" });
    expect(received).toHaveLength(1);
    expect(usage.rssSources).toMatchObject({ platformRusage: 1, unavailable: 0 });
  } finally {
    releaseExit(0); releaseHeldPipe();
    await work.catch(() => {}); Bun.spawn = spawn; kill.mockRestore(); Object.defineProperty(process, "platform", platform);
  }
});

function existsPid(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function observedPidExit(pid: number, maximumMs: number): Promise<{ gone: boolean; observedMs: number }> {
  const started = performance.now();
  while (existsPid(pid) && performance.now() - started < maximumMs) await Bun.sleep(5);
  return { gone: !existsPid(pid), observedMs: performance.now() - started };
}

test("owned native metadata returns bounded output then reaps its still-live supervisor", async () => {
  const usage = { rssKB: 0, rawRssKB: 0 }, before = performance.now();
  expect(await hookNative(["/usr/bin/printf", "metadata\n"], { PATH: process.env.PATH }, () => 1000 - (performance.now() - before), usage)).toEqual({ status: 0, stdout: "metadata\n" });
  expect(usage.rssKB).toBeGreaterThan(0); expect(usage.rawRssKB).toBeGreaterThan(0);
});

test("owned native identity keeps the portable process-signature format", async () => {
  const usage = { rssKB: 0, rawRssKB: 0 }, before = performance.now();
  const signature = processSignature(process.pid); expect(signature).toBeDefined();
  expect(await hookProcessSignature(() => 1000 - (performance.now() - before), usage)).toBe(signature!);
});

test("a native metadata timeout reaps a blocked command and its descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-native-stop-")), file = join(root, "pid");
  try {
    const before = performance.now(), usage = { rssKB: 0, rawRssKB: 0 };
    await expect(hookNative(["/bin/sh", "-c", 'sleep 30 & child=$!; printf "%s\\n" "$child" > "$1"; wait', "fixture", file], { PATH: process.env.PATH }, () => 1000 - (performance.now() - before), usage)).rejects.toThrow("deadline");
    expect(existsSync(file)).toBe(true);
    const pid = Number(readFileSync(file, "utf8").trim());
    // SIGKILL reaches the whole group before hookNative returns, but init may
    // briefly retain a non-executing zombie grandchild. Observe PID removal instead
    // of asserting scheduler speed; a still-live orphan must still fail this assertion.
    const observed = await observedPidExit(pid, 500);
    expect(existsPid(pid), JSON.stringify(observed)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("native metadata self-reaps its owned group after the calling Bun is SIGKILLed", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-native-parent-death-")), metadata = join(root, "owned.json"), entered = join(root, "entered"), caller = join(root, "caller.ts");
  const native = new URL("../src/hook-native.ts", import.meta.url).pathname;
  const command = 'printf "%s %s\\n" "$$" "$PPID" > "$1"; /bin/sleep 30 & printf "%s\\n" "$!" >> "$1"; wait';
  writeFileSync(caller, `import {writeFileSync} from 'node:fs';import {hookNative} from ${JSON.stringify(native)};
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>{const child=spawn(argv,options);writeFileSync(${JSON.stringify(metadata)},JSON.stringify({caller:process.pid,leader:child.pid}));return child;};
const until=performance.now()+2000;try{await hookNative(['/bin/sh','-c',${JSON.stringify(command)},'fixture',${JSON.stringify(entered)}],{PATH:'/usr/bin:/bin'},()=>until-performance.now(),{rssKB:0,rawRssKB:0});}catch{}`);
  const child = Bun.spawn([process.execPath, "--smol", caller], { stdout: "ignore", stderr: "pipe" });
  let leader: number | undefined, signature: string | undefined, killed = false;
  const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
  const group = (pid: number) => {
    const result = Bun.spawnSync(["/bin/ps", "-ww", "-p", String(pid), "-o", "pgid=,command="], { stdout: "pipe", stderr: "ignore" });
    const output = result.stdout.toString();
    return result.exitCode === 0 && Number(output.trim().split(/\s+/, 1)[0]) === pid && output.includes("amem-hook-native") && output.includes(entered);
  };
  try {
    const start = performance.now(), callerSignature = processSignature(child.pid);
    expect(callerSignature).toBeDefined();
    while ((!existsSync(entered) || !existsSync(metadata) || readFileSync(entered, "utf8").trim().split(/\s+/).length < 3) && performance.now() - start < 2000) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    const owner = JSON.parse(readFileSync(metadata, "utf8")) as { caller: number; leader: number };
    leader = owner.leader;
    const [nativePid, nativeParent, descendantPid] = readFileSync(entered, "utf8").trim().split(/\s+/).map(Number);
    expect(owner.caller).toBe(child.pid); expect(nativeParent).toBe(leader);
    expect(Number.isSafeInteger(leader) && leader > 0).toBe(true); expect(group(leader)).toBe(true);
    signature = processSignature(leader); expect(signature).toBeDefined();
    expect(processSignature(child.pid)).toBe(callerSignature);
    process.kill(child.pid, "SIGKILL"); killed = true; await child.exited;
    // Observe actual exit rather than assuming a sleep means the watchdog fired. This
    // outer fixture bound does not alter the command's explicit 2000 ms library-test budget.
    // The published CLI's 140/150 ms limits are verified separately by measure-hooks-budget.
    const observedUntil = performance.now() + 3000;
    while ([leader, nativePid!, descendantPid!].some(live) && performance.now() < observedUntil) await Bun.sleep(10);
    expect(live(leader)).toBe(false); expect(live(nativePid!)).toBe(false); expect(live(descendantPid!)).toBe(false);
  } finally {
    if (leader && live(leader) && signature && processSignature(leader) === signature && group(leader)) process.kill(-leader, "SIGKILL");
    if (!killed && live(child.pid)) child.kill("SIGKILL");
    await child.exited; await child.stderr.cancel().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test("native completion is refused without proof that its watchdog armed", async () => {
  const spawn = Bun.spawn, usage = { rssKB: 0, rawRssKB: 0 }; let intercepted = false;
  Object.assign(Bun, { spawn(command: string[], options: unknown) {
    if (Array.isArray(command) && command[0] === "/bin/sh" && command[3] === "amem-hook-native") {
      const modified = [...command];
      expect(modified[2]).toContain("%s:ARMED");
      modified[2] = modified[2]!.replace("%s:ARMED", "%s:UNARMED"); intercepted = true;
      return Reflect.apply(spawn, Bun, [modified, options]);
    }
    return Reflect.apply(spawn, Bun, [command, options]);
  } });
  try {
    const before = performance.now();
    await expect(hookNative(["/usr/bin/printf", "otherwise valid metadata"], { PATH: process.env.PATH }, () => 100 - (performance.now() - before), usage)).rejects.toThrow();
    expect(intercepted).toBe(true);
  } finally { Bun.spawn = spawn; }
});


test("the exit observation barrier does not mistake a running child for a reaped process", async () => {
  const child = Bun.spawn(["/bin/sleep", "2"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect((await observedPidExit(child.pid, 20)).gone).toBe(false);
    child.kill("SIGKILL"); await child.exited;
    expect((await observedPidExit(child.pid, 500)).gone).toBe(true);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
});

test.skipIf(process.platform !== "linux")("terminal supervisor telemetry survives a missing late parent VmHWM read", async () => {
  const lateRead = spyOn(resources, "processImageMemory").mockReturnValue({});
  try {
    const usage: HookNativeUsage = { rssKB: 0, rawRssKB: 0 };
    expect(await hookNative(["/usr/bin/printf", "metadata\n"], { PATH: process.env.PATH }, () => 1000, usage)).toEqual({ status: 0, stdout: "metadata\n" });
    expect(usage.rssSources!.vmhwm + usage.rssSources!.vmpeakBound).toBe(1);
    expect(usage.rssSources!.rawFallback + usage.rssSources!.unavailable).toBe(0);
    expect(usage.rssKB).toBeGreaterThan(0);
  } finally { lateRead.mockRestore(); }
});
