import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hookCapturePending } from "../../src/hook-spool.ts";
import { readMetrics } from "../../src/memory/metrics.ts";
import { hookFixture } from "./hooks-fixture.ts";
import { hookProcessObserver } from "./hooks-process-observer.ts";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }

/** One fixture, two callers: bun test uses the explicit host deadline, the dedicated
 * budget step uses the published executable with its unchanged real deadline. */
export async function hookTimeoutProbe(f: ReturnType<typeof hookFixture>, event: "SessionStart" | "PreToolUse", functional: boolean) {
  const observer = hookProcessObserver(f.root, true), payload = { hook_event_name: event, cwd: f.cwd, prompt: "public timeout fixture" };
  let nativePids: number[] = [], groups: number[] = [];
  try {
    const start = performance.now();
    const result = functional
      ? f.runFunctional(event, payload, { BUN_OPTIONS: `--preload=${observer.preload}` })
      : f.run(event, payload, { BUN_OPTIONS: `--preload=${observer.preload}` });
    const wallMs = performance.now() - start, workers = observer.read();
    check(workers.length === (event === "SessionStart" ? 3 : 1), "timeout probe did not observe every owned child");
    groups = workers.map(worker => worker.pid);
    check(workers.every(worker => worker.detached), "timeout child did not own its process group");
    check(existsSync(observer.entered) && existsSync(observer.nativePidFile), "timeout fixture did not reach its owned blocking command");
    nativePids = readFileSync(observer.nativePidFile, "utf8").trim().split(/\s+/).map(Number);
    check(nativePids.length === workers.length && nativePids.every(pid => Number.isSafeInteger(pid) && pid > 0), "invalid owned descendant receipt");
    check(result.exitCode === 0 && !result.signalCode, "timeout did not fail open");
    check(result.stdout.length <= 8192 && !/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/.test(result.stdout.toString()), "timeout emitted a native control directive");
    // The captured executable wall time excludes this observational init/reaper barrier.
    // Never accept a zombie as success: its PID must actually disappear too.
    const until = performance.now() + 500;
    while ([...nativePids, ...groups].some(alive) && performance.now() < until) await Bun.sleep(10);
    check(![...nativePids, ...groups].some(alive), "owned timeout descendant or leader survived the exit barrier");
    const spool = join(f.base, "hook-spool");
    const retained = readdirSync(spool).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
      .map(name => ({ name: name.split(".draining-")[0]!, value: JSON.parse(readFileSync(join(spool, name), "utf8")) }));
    const pending = retained.filter(row => row.value.capture?.event === event && row.value.capture?.excerpt === payload.prompt);
    check(pending.length === 1 && hookCapturePending(f.base, pending[0]!.name), "timeout capture was not retained exactly once");
    check(!f.rows().some(row => row.excerpt === payload.prompt), "blocked command unexpectedly committed capture");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
    const cliRssMB = result.resourceUsage.maxRSS / 1048576;
    check(metric && Number.isFinite(metric.rssMB) && metric.rssMB! > 0 && cliRssMB > 0, "timeout metrics unavailable");
    return { event, wallMs, rssMB: Math.max(cliRssMB, metric.rssMB!), pending: pending[0]!.name, ownedChildren: workers.length, remainingProcesses: 0 };
  } finally {
    // Only a fresh PID/group/command match from this probe can be signalled on failure.
    for (const nativePid of nativePids.filter(alive)) {
      const result = Bun.spawnSync(["/bin/ps", "-p", String(nativePid), "-o", "pgid=,comm="], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(result.stdout.toString());
      if (match && groups.includes(Number(match[1])) && /(?:^|\/)sleep$/.test(match[2]!)) try { process.kill(nativePid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}
