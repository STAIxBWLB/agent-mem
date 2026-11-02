import type { BriefOptions } from "./session-brief.ts";
import type { CaptureStore } from "./memory/capture.ts";
import { acceptHookProjectReceipt } from "./hook-project.ts";
import { writeSync } from "node:fs";
import { hookRssReading, hookPeakRssKB } from "./hook-resources.ts";
import { rssSourceCode } from "./hook-rss-wire.ts";
import { resolveAlias } from "./memory/aliases.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES, type HookTranscriptProgress } from "./hook-contract.ts";
import { drainHookCaptures, hookCaptureScope, hookPendingCount } from "./hook-spool.ts";
/** #226: at or above this many pending publications for the cwd (a quarter of its 64 active share) the worker drains first. */
const DRAIN_FIRST_PENDING = 16;
/** Task 110: the scan's line work, counted from the end of its own setup. */
export const SCAN_WORK_MS = 60;
/** Task 110: a scan before the drain ends this long before the slice end so the drain keeps time for at least its first record.
 * Basis: a first committed record costs 1.7-2.3 ms locally (cold store open included); hosted macOS drained 2-3 per final hook. */
export const DRAIN_RESERVE_MS = 25;
/** The scan's own commit allowance before the slice end (unchanged since #221). */
export const SCAN_COMMIT_MS = 20;
/** Task 110: the least scan time a drain-first worker keeps for its deferred scan. */
export const DEFERRED_SCAN_MIN_MS = 25;

/** Task 110 (ruling): the one place that splits a worker's slice between the transcript scan and the spool drain. All times are
 * absolute on the same clock as `sliceEnd`; a window shorter than 5 ms means 'no time' (the scan then reports deadline, #221).
 * - scan-first: the scan works up to SCAN_WORK_MS after its setup and ends DRAIN_RESERVE_MS before the slice end; the drain then
 *   runs to the slice end.
 * - drain-first: the drain always commits its first record, then stops SCAN_COMMIT_MS + DEFERRED_SCAN_MIN_MS before the slice
 *   end; the deferred scan works up to SCAN_WORK_MS after its setup and ends SCAN_COMMIT_MS before the slice end. */
export function sliceBudget(order: "scan-first" | "drain-first", sliceEnd: number) {
  return order === "scan-first"
    ? { scanEnd: (setupDone: number) => Math.min(setupDone + SCAN_WORK_MS, sliceEnd - DRAIN_RESERVE_MS), drainEnd: sliceEnd }
    : { scanEnd: (setupDone: number) => Math.min(setupDone + SCAN_WORK_MS, sliceEnd - SCAN_COMMIT_MS), drainEnd: sliceEnd - SCAN_COMMIT_MS - DEFERRED_SCAN_MIN_MS };
}
/** A window shorter than this is treated as no time. */
export const MIN_WINDOW_MS = 5;

/** #226: options arrive as newline-delimited JSON. A transcript hook first sends the scan options, then (after native
 * metadata) the drain options; other hooks send only the drain options. Total input stays bounded. */
function optionLines(): () => Promise<string | undefined> {
  const reader = Bun.stdin.stream().getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", bytes = 0, done = false;
  return async () => {
    for (;;) {
      const at = pending.indexOf("\n");
      if (at >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); return line; }
      if (done) { const rest = pending; pending = ""; return rest || undefined; }
      const next = await reader.read();
      if (next.done) { done = true; pending += decoder.decode(); continue; }
      bytes += next.value.byteLength;
      // Native input is at most 64 KiB, sent at most twice (scan, then drain); leave bounded room for fixed options.
      if (bytes > 2 * HOOK_INPUT_BYTES + 32 * 1024) throw new Error("input bound");
      pending += decoder.decode(next.value, { stream: true });
    }
  };
}

// Fixed package helper, launched and reaped by each native hook; never registered or resident.
if (import.meta.main) {
  let owned = false;
  let rssTelemetryValid = true;
  const frame = (rss: number[]) => { try { writeSync(1, JSON.stringify({ rss }) + "\n"); } catch { rssTelemetryValid = false; } };
  const progress = (transcript: HookTranscriptProgress) => { try { writeSync(1, JSON.stringify({ transcript }) + "\n"); } catch { rssTelemetryValid = false; } };
  const drain = (value: { startMs?: number; drained: number }) => { try { writeSync(1, JSON.stringify({ drain: value }) + "\n"); } catch { rssTelemetryValid = false; } };
  frame([0]);
  const stop = (): never => {
    if (!rssTelemetryValid) frame([4]);
    const self = hookRssReading(); frame([3, self.kb, self.rawKB, rssSourceCode(self)]);
    // This leader is still alive in the detached group created by hookWorker.
    // Native Git is owned and reaped by the CLI parent, never by this worker.
    if (owned) try { process.kill(-process.pid, "SIGKILL"); } catch { /* No group exists in a direct, non-owned invocation. */ }
    process.exit(0);
  };
  const emit = async (result: unknown) => {
    const body = JSON.stringify({ ...(result as object), complete: true, rssTelemetryValid });
    const rssKB = hookPeakRssKB();
    await Bun.stdout.write(body.slice(0, -1) + `,"rssKB":${rssKB}}\n`);
    stop();
  };
  // Load the capture store while waiting for options, so a drain window is spent draining, not importing.
  const captureModule = import("./memory/capture.ts");
  captureModule.catch(() => { /* Reported where it is awaited. */ });
  // Task 110: the scan module (and the policy and config modules it pulls in) loads in parallel with the stdin read too.
  const transcriptModule = import("./hook-transcript.ts");
  transcriptModule.catch(() => { /* Reported where it is awaited. */ });
  const next = optionLines();
  try {
    let line = await next();
    if (line === undefined) process.exit(0);
    let first = JSON.parse(line) as Record<string, unknown>;
    type Scan = { cwd: string; base: string; transcript: unknown; policy?: BriefOptions["policy"]; deadlineAt: number };
    // #226: scan on the first line, while the parent resolves native metadata. Under spool pressure (16+ of this cwd's pending
    // publications, a quarter of its 64 active share) the scan is deferred until after the drain, so the drain is guaranteed to
    // start: on a slow runner the scan would otherwise spend the whole slice and the spool would livelock (#231 hosted macOS).
    // The count is one bounded readdir and fails closed to the default order.
    let deferred: Scan | undefined;
    const now = () => performance.timeOrigin + performance.now();
    const runScan = async (scan: Scan, until: number, order: "scan-first" | "drain-first") => {
      if (!Number.isFinite(scan.deadlineAt) || hookCaptureScope(scan.cwd, scan.base) === undefined) return;
      // The split comes from sliceBudget (task 110). The scan's hard end is its slice limit (scanEnd with no setup cost); the line
      // loop's SCAN_WORK_MS counts from the end of its own setup inside scanHookTranscriptTail. Out of time is a deadline stop,
      // never a silent call (#221): the harness and the metric must see why nothing advanced.
      const hardEnd = sliceBudget(order, Math.min(scan.deadlineAt, until)).scanEnd(Number.POSITIVE_INFINITY);
      if (hardEnd - now() < MIN_WINDOW_MS) { progress({ stopReason: "deadline" }); return; }
      try {
        const { scanHookTranscriptTail } = await transcriptModule;
        const scanned = await scanHookTranscriptTail(scan.transcript, { cwd: scan.cwd, base: scan.base, policy: scan.policy,
          deadline: performance.now() + (hardEnd - now()), workBudgetMs: SCAN_WORK_MS });
        if (scanned) progress(scanned);
      } catch { progress({ stopReason: "unavailable" }); /* #221: a scan fault is reported, never counted as progress. */ }
    };
    if (first.scan !== undefined) {
      const scan = first.scan as Scan;
      if (hookPendingCount(scan.cwd, scan.base) >= DRAIN_FIRST_PENDING) deferred = scan;
      else await runScan(scan, Number.POSITIVE_INFINITY, "scan-first");
      line = await next();
      if (line === undefined) process.exit(0);
      first = JSON.parse(line) as Record<string, unknown>;
    }
    const options = first as unknown as BriefOptions & { current: string; event: string; identity?: unknown; deadlineAt: number; ownedGroup: boolean; hookStartAt?: number };
    if (!Number.isFinite(options.deadlineAt) || options.ownedGroup !== true) process.exit(0);
    owned = true;
    const remaining = () => options.deadlineAt - (performance.timeOrigin + performance.now());
    const deadlineStop = () => stop();
    if (remaining() <= 0) deadlineStop();
    setTimeout(deadlineStop, remaining()).unref();
    const event = options.event;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) stop();
    const expectedScope = hookCaptureScope(options.cwd, options.base!);
    // A receipt is single-use parent IPC. This worker must never launch a native helper.
    if (event === "SessionStart") stop();
    let project: string | undefined;
    try { project = resolveAlias(options.base!, acceptHookProjectReceipt(options.identity, { cwd: options.cwd, base: options.base!, scope: expectedScope, timeRemaining: remaining })); } catch { /* Independently bound transcript intake can still proceed. */ }
    if (project === undefined) { if (deferred) await runScan(deferred, options.deadlineAt, "drain-first"); stop(); }
    let captured = false;
    // An empty current name selects bounded full-tier recovery; SessionStart stays in the parent.
    if (expectedScope !== undefined) {
      const { CaptureStore } = await captureModule;
      let store: CaptureStore | undefined;
      try {
        // #226 instrumentation: when the drain started (relative to the hook start the parent passed) and how many records it
        // committed, sent before and during the drain so a kill still reports them. A killed drain keeps every record it finished.
        drain({ startMs: Math.round(performance.timeOrigin + performance.now() - (options.hookStartAt ?? options.deadlineAt)), drained: 0 });
        let drainedCount = 0;
        // Drain-first: the drain always commits its first record, then stops SCAN_COMMIT_MS + DEFERRED_SCAN_MIN_MS (45 ms) before
        // the slice end (sliceBudget). Two reasons: the deferred scan keeps its time, and the worker finishes and exits on its own
        // instead of being killed mid-write. A half-slice cap let a fast drain run into the deadline kill, and SQLite's write then
        // outlived the 10 ms reap: abandoned workers went from 1 to 37 on hosted ubuntu (task 110, runs 41502941614 and 41530406951).
        const drainEnd = sliceBudget(deferred ? "drain-first" : "scan-first", options.deadlineAt).drainEnd;
        const drainRemaining = () => drainedCount === 0 ? remaining() : Math.min(remaining(), drainEnd - now());
        const drained = await drainHookCaptures({ ...options, base: options.base!, project: project!, expectedScope, timeRemaining: drainRemaining }, (input, receipt) => {
          store ??= new CaptureStore({ memoryDir: options.base!, project: project!, busyTimeoutMs: 0, cwd: options.cwd });
          const appended = store.append(input, { receipt });
          drain({ drained: ++drainedCount });
          return appended;
        });
        captured = drained.captured.includes(options.current);
      } finally { store?.close(); }
    }
    if (deferred) await runScan(deferred, options.deadlineAt, "drain-first");
    if (hookCaptureScope(options.cwd, options.base!) !== expectedScope) stop();
    await emit({ context: "", captured, valid: true });
  } catch { if (owned) stop(); process.exitCode = 1; }
}
