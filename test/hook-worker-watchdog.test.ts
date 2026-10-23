import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { processSignature } from "../src/memory/platform.ts";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function group(pid: number): number | undefined {
  const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "pgid="], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? Number(result.stdout.toString().trim()) : undefined;
}

test("an owned hook worker and blocked Git descendants terminate after their calling CLI is SIGKILLed", async () => {
  const f = hookFixture(), bin = join(f.root, "bin"), marker = join(f.root, "blocked-git"), metadata = join(f.root, "owned-worker.json"), caller = join(f.root, "caller.ts");
  const workerSource = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s %s\\n' "$$" "$PPID" > '${marker}'\n/bin/sleep 30 & printf '%s\\n' "$!" >> '${marker}'\nwait\n`, { mode: 0o700 });
  writeFileSync(caller, `import{writeFileSync}from'node:fs';const worker=Bun.spawn([process.execPath,'--smol',${JSON.stringify(workerSource)}],{cwd:${JSON.stringify(f.cwd)},env:{PATH:${JSON.stringify(`${bin}:${f.env.PATH}`)},HOME:${JSON.stringify(f.env.HOME)},AMEM_HOME:${JSON.stringify(f.base)}},detached:true,stdin:Buffer.from(JSON.stringify({cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)},current:'pending-fixture',event:'PostToolUse',maxTokens:1200,ownedGroup:true,deadlineAt:performance.timeOrigin+performance.now()+1500})),stdout:'ignore',stderr:'ignore'});writeFileSync(${JSON.stringify(metadata)},JSON.stringify({caller:process.pid,worker:worker.pid}));await worker.exited;`);
  const callerProcess = Bun.spawn([process.execPath, "--smol", caller], { stdout: "ignore", stderr: "ignore", env: f.env });
  let worker: number | undefined, workerIdentity: string | undefined, native: number | undefined, nativeIdentity: string | undefined, nativeGroup: number | undefined, descendant: number | undefined;
  try {
    const callerIdentity = processSignature(callerProcess.pid); expect(callerIdentity).toBeDefined();
    const readyUntil = performance.now() + 2000;
    while ((!existsSync(marker) || readFileSync(marker, "utf8").trim().split(/\s+/).length < 3) && performance.now() < readyUntil) await Bun.sleep(5);
    expect(existsSync(marker)).toBe(true);
    const owner = JSON.parse(readFileSync(metadata, "utf8"));
    worker = owner.worker;
    [native, , descendant] = readFileSync(marker, "utf8").trim().split(/\s+/).map(Number);
    expect(owner.caller).toBe(callerProcess.pid); expect(group(worker!)).toBe(worker!);
    workerIdentity = processSignature(worker!); nativeIdentity = processSignature(native!); nativeGroup = group(native!);
    expect(workerIdentity).toBeDefined(); expect(nativeIdentity).toBeDefined(); expect(nativeGroup).toBeDefined();
    expect(processSignature(callerProcess.pid)).toBe(callerIdentity);
    callerProcess.kill("SIGKILL"); await callerProcess.exited;
    const goneUntil = performance.now() + 2000;
    while ([worker!, native!, descendant!, nativeGroup!].some(alive) && performance.now() < goneUntil) await Bun.sleep(5);
    expect(alive(worker!)).toBe(false); expect(alive(native!)).toBe(false); expect(alive(descendant!)).toBe(false); expect(alive(nativeGroup!)).toBe(false);
  } finally {
    // Only the original, still-owned groups of this private fixture can be cleaned up.
    if (native && nativeGroup && alive(native) && nativeIdentity && processSignature(native) === nativeIdentity && group(native) === nativeGroup) try { process.kill(-nativeGroup, "SIGKILL"); } catch {}
    if (worker && alive(worker) && workerIdentity && processSignature(worker) === workerIdentity && group(worker) === worker) try { process.kill(-worker, "SIGKILL"); } catch {}
    if (callerProcess.exitCode === null) callerProcess.kill("SIGKILL");
    await callerProcess.exited; f.close();
  }
}, 7000);
