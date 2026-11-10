import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hookCapturePending } from "../../src/hook-spool.ts";
import { readMetrics } from "../../src/memory/metrics.ts";
import { validRssSources } from "../../src/hook-resources.ts";
import { reportBudgetAdvisory } from "../../scripts/hook-timing-check.ts";
import { measuredHookRss, measuredBudgetHookRss } from "../../scripts/hook-rss-check.ts";
import { hookFixture } from "./hooks-fixture.ts";
import type { HookProcessEvidence, HookLifecycleReceipt, HookWorkerProcess } from "./hooks-process-observer.ts";
import { hookProcessObserver } from "./hooks-process-observer.ts";
import { hookProcessDiagnostic } from "../../scripts/hook-process-diagnostic.ts";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }

/** Only positive decimal PID tokens are usable for observation or cleanup. */
export function timeoutDescendantReceipt(text: string, expected: number) {
  const tokens = text.trim() ? text.trim().split(/\s+/) : [];
  const valid = tokens.every(token => /^[0-9]+$/.test(token) && Number.isSafeInteger(Number(token)) && Number(token) > 0);
  return { pids: tokens.filter(token => /^[0-9]+$/.test(token) && Number.isSafeInteger(Number(token)) && Number(token) > 0).map(Number),
    valid, incomplete: valid && tokens.length < expected, complete: valid && tokens.length === expected };
}
/** An incomplete receipt needs an independent fresh group census, including orphaned descendants. */
export function timeoutOwnedGroupsGone(table: string, groups: readonly number[]): boolean {
  check(groups.length > 0 && groups.every(pid => Number.isSafeInteger(pid) && pid > 0) && new Set(groups).size === groups.length, "R1 owned group identity unavailable");
  const rows = table.split("\n").filter(line => line.trim());
  check(rows.length > 0, "R1 process table unavailable");
  let gone = true;
  for (const line of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    check(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) >= 0
      && Number.isSafeInteger(Number(match[2])) && Number(match[2]) >= 0, "R1 process table unavailable");
    if (groups.includes(Number(match[2]))) gone = false;
  }
  return gone;
}

/** An unreceipted orphan gets only the remainder of the same PID exit barrier. */
export async function timeoutOwnedGroupBarrier(groups: readonly number[], remaining: () => number, census: () => string, pause: () => Promise<unknown>): Promise<boolean> {
  for (;;) {
    if (timeoutOwnedGroupsGone(census(), groups)) return true;
    if (remaining() <= 0) return false;
    await pause();
  }
}

export type TimeoutBranch = "admitted-blocked" | "pre-admission" | "spawned-not-entered";
/** Missing coverage is never inferred from a missing file. The caller separately proves
 * output, durable capture, metrics and a fresh census under the unchanged exit barrier. */
export function timeoutProbeBranch(input: {
  control: boolean; expected: number; parentPid: number; workers: readonly HookWorkerProcess[];
  evidence: readonly HookProcessEvidence[]; lifecycle: readonly HookLifecycleReceipt[];
  entered: boolean; receipt: ReturnType<typeof timeoutDescendantReceipt>; survivors: number;
}): TimeoutBranch {
  const { workers, parentPid, receipt } = input;
  const evidence = input.evidence.filter(row => row.pid === parentPid), life = input.lifecycle.filter(row => row.parentPid === parentPid);
  const attempts = life.filter(row => row.phase === "spawn-attempt");
  check(input.survivors === 0 && receipt.valid && new Set(receipt.pids).size === receipt.pids.length && !life.some(row => row.phase === "truncated" || row.phase === "spawn-failed"), "timeout observation is incomplete or has survivors");
  check(new Set(workers.map(row => row.pid)).size === workers.length && workers.every(row => row.detached), "timeout owned child identity unavailable");
  check(evidence.filter(row => row.phase === "preload").length === 1 && evidence.every(row => row.loads === 1), "timeout preload observation unavailable");
  check(attempts.length === workers.length && evidence.filter(row => row.phase === "attempt").length === workers.length
    && evidence.filter(row => row.phase === "returned").length === workers.length
    && evidence.filter(row => row.phase === "attempt" || row.phase === "returned").every(row => row.exact === 1), "timeout spawn observation incomplete");
  if (input.control) check(workers.length === input.expected && input.entered && receipt.complete && receipt.pids.length === input.expected, "timeout control did not reach every owned blocking command");
  if (workers.length === 0) {
    const expired = evidence.some(row => Number.isFinite(row.remainingUs) && (
      row.phase === "deadline_skip" && row.host === 0 && row.remainingUs! < 5000
      || row.phase === "session-native-deadline-skip" && row.remainingUs! <= 1000));
    check(!input.control && expired && life.length === 0 && !input.entered && receipt.pids.length === 0, "timeout pre-admission guard evidence unavailable");
    return "pre-admission";
  }
  check(workers.length <= input.expected && life.filter(row => row.childPid > 0).every(row => workers.some(worker => worker.pid === row.childPid)), "timeout unobserved owned child");
  for (const worker of workers) {
    const rows = life.filter(row => row.childPid === worker.pid);
    check(rows.filter(row => row.phase === "spawn").length === 1 && rows.some(row => row.phase === "exit")
      && rows.some(row => row.phase === "reap-end" && row.reaped === 1), "timeout owned child lifecycle incomplete");
    check(evidence.some(row => row.phase === "returned" && row.childPid === worker.pid), "timeout spawn return unavailable");
  }
  check(receipt.pids.length <= workers.length, "timeout descendant receipt exceeds owned children");
  return input.entered && receipt.pids.length > 0 ? "admitted-blocked" : "spawned-not-entered";
}

/** One fixture, two callers: bun test uses the explicit host deadline, the dedicated
 * budget step uses the published executable with its unchanged real deadline. */
export async function hookTimeoutProbe(f: ReturnType<typeof hookFixture>, event: "SessionStart" | "PreToolUse" | "Stop", functional: boolean, invocation={run:1,logicalRun:1}) {
  // Required for every real-deadline sample, on both OSes. This calls the same
  // checkout's hookMain through the existing explicit host seam; never resets the
  // bin/amem.js clock below. Failure is fatal, with no added retries or advisory.
  if (!functional) {
    const control = hookFixture();
    try { await hookTimeoutProbe(control, event, true, invocation); }
    finally { control.close(); }
  }
  const observer = hookProcessObserver(f.root, true, undefined, true, true), payload = { hook_event_name: event, cwd: f.cwd, prompt: "public timeout fixture" };
  let nativePids: number[] = [], groups: number[] = [];
  try {
    const start = performance.now();
    const result = functional
      ? f.runFunctional(event, payload, { BUN_OPTIONS: `--preload=${observer.preload}` })
      : f.run(event, payload, { BUN_OPTIONS: `--preload=${observer.preload}` });
    const wallMs = performance.now() - start, workers = observer.read();
    const diagnostic = () => hookProcessDiagnostic({ event, ...invocation, parentPid: result.pid, variant: functional ? "timeout-functional" : "timeout-native",
      expectedOwnedChildren: functional ? (event === "SessionStart" ? 3 : 2) : null, expectation: functional ? "fixture-contract" : "observed-spawn-attempts", workers, evidence: observer.evidence(), lifecycle: observer.lifecycle(result.pid),
      metric: readMetrics(f.base).filter(row => row.kind === "hook").at(-1), cliRawRssMB: result.resourceUsage.maxRSS / 1048576 });
    const expected = event === "SessionStart" ? 3 : 2;
    groups = workers.map(worker => worker.pid);
    const entered = existsSync(observer.entered), pidWitness = existsSync(observer.nativePidFile);
    const receipt = timeoutDescendantReceipt(pidWitness ? readFileSync(observer.nativePidFile, "utf8") : "", expected);
    nativePids = receipt.pids;
    check(result.exitCode === 0 && !result.signalCode, "timeout did not fail open");
    check(result.stdout.length <= 8192 && !/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/.test(result.stdout.toString()), "timeout emitted a native control directive");
    // The captured executable wall time excludes this observational init/reaper barrier.
    // Never accept a zombie as success: its PID must actually disappear too.
    const until = performance.now() + 500;
    while ([...nativePids, ...groups].some(alive) && performance.now() < until) await Bun.sleep(10);
    const survivorError = (groupCensusAtBarrier?: string) => {
      // Keep the same barrier and failure. A leader exit receipt alone cannot identify
      // a surviving command, orphan or zombie; retain the fresh numeric process state.
      const census = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid=,stat="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
      const owned = new Set([...nativePids, ...groups]);
      const processes = census.stdout.toString().split("\n").flatMap(line => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
        return row && (owned.has(Number(row[1])) || groups.includes(Number(row[3])))
          ? [{ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), stat: row[4] }] : [];
      }).slice(0, 128);
      return new Error("owned timeout descendant or leader survived the exit barrier: " + JSON.stringify({ ...diagnostic(),
        descendantReceipt: receipt,
        groupCensusAtBarrier: groupCensusAtBarrier?.split("\n").flatMap(line => {
          const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
          return row && groups.includes(Number(row[2])) ? [{ pid: Number(row[1]), pgid: Number(row[2]) }] : [];
        }).slice(0, 128), processCensus: { exitCode: census.exitCode, signalCode: census.signalCode, processes } }));
    };
    if ([...nativePids, ...groups].some(alive)) throw survivorError();
    {
      let groupCensusAtBarrier = "";
      const gone = await timeoutOwnedGroupBarrier(groups.length ? groups : [result.pid], () => until - performance.now(), () => {
        const census = Bun.spawnSync(["/bin/ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
        check(census.exitCode === 0 && !census.signalCode, "R1 process table unavailable");
        groupCensusAtBarrier = census.stdout.toString();
        return groupCensusAtBarrier;
      }, () => Bun.sleep(10));
      if (!gone) throw survivorError(groupCensusAtBarrier);
    }
    const spool = join(f.base, "hook-spool");
    const retained = [spool, join(spool, ".capacity")].flatMap(dir => (existsSync(dir) ? readdirSync(dir) : [])
      .filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name))
      .map(name => ({ name: name.split(".draining-")[0]!, value: JSON.parse(readFileSync(join(dir, name), "utf8")) })));
    const pending = retained.filter(row => row.value.capture?.event === event && row.value.capture?.excerpt === payload.prompt);
    check(pending.length === 1 && hookCapturePending(f.base, pending[0]!.name), "timeout capture was not retained exactly once");
    check(!f.rows().some(row => row.excerpt === payload.prompt), "blocked command unexpectedly committed capture");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
    const cliRssMB = result.resourceUsage.maxRSS / 1048576;
    check(metric && Number.isFinite(metric.wallMs) && metric.wallMs! >= 0 && Number.isFinite(metric.rssMB) && metric.rssMB! > 0 && Number.isFinite(cliRssMB) && cliRssMB > 0, "timeout metrics unavailable");
    let branch: TimeoutBranch;
    try {
      branch = timeoutProbeBranch({ control: functional, expected, parentPid: result.pid, workers,
        evidence: observer.evidence(), lifecycle: observer.lifecycle(result.pid), entered, receipt, survivors: 0 });
    } catch (error) {
      throw new Error(`${(error as Error).message}: ${JSON.stringify({ ...diagnostic(), entered, pidWitness, descendantReceipt: receipt })}`);
    }
    let descendantReceiptAdvisory = false;
    if (!receipt.complete && branch === "admitted-blocked" && workers.length === expected) {
      check(!functional && receipt.incomplete && Number.isFinite(metric.wallMs) && metric.wallMs! >= 0
        && metric.rssScope === "owned-images" && validRssSources(metric.rssSources), "invalid owned descendant receipt");
      descendantReceiptAdvisory = reportBudgetAdvisory("owned-descendant-receipt", `timeout ${event}`, {
        telemetryValid: true, survivors: 0, abandonedOwnedWorkers: metric.abandonedChildren, receiptIncomplete: true,
      });
      check(descendantReceiptAdvisory, "invalid owned descendant receipt");
    }
    const rss = functional || branch !== "admitted-blocked" || workers.length !== expected ? measuredHookRss(metric, cliRssMB)
      : measuredBudgetHookRss(metric, cliRssMB, { survivors: 0, abandonedOwnedWorkers: metric.abandonedChildren ?? 0 }, `timeout ${event}`);
    // Every invocation reports coverage, including legitimate refusals before fixture entry.
    console.log(JSON.stringify({ diagnostic: "hook-timeout-branch/v1", event, ...invocation, control: functional, branch,
      observedOwnedChildren: workers.length, entered, descendantReceipt: receipt, remainingProcesses: 0 }));
    return { event, branch, wallMs, ...rss, ...(descendantReceiptAdvisory ? { descendantReceiptAdvisory: true } : {}), pending: pending[0]!.name, ownedChildren: workers.length, remainingProcesses: 0 };
  } finally {
    // Only a fresh PID/group/command match from this probe can be signalled on failure.
    for (const nativePid of nativePids.filter(alive)) {
      const result = Bun.spawnSync(["/bin/ps", "-p", String(nativePid), "-o", "pgid=,comm="], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(result.stdout.toString());
      if (match && groups.includes(Number(match[1])) && /(?:^|\/)sleep$/.test(match[2]!)) try { process.kill(nativePid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}
