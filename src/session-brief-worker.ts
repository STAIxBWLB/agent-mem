import type { BriefOptions } from "./session-brief.ts";
import type { CaptureStore } from "./memory/capture.ts";
import { resolveHookProjectAsync } from "./hook-project.ts";
import { writeSync } from "node:fs";
import { hookRssReading, hookPeakRssKB } from "./hook-resources.ts";
import { rssSourceCode } from "./hook-rss-wire.ts";
import type { HookNativeUsage } from "./hook-native.ts";
import { resolveAlias } from "./memory/aliases.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES, type HookTranscriptProgress } from "./hook-contract.ts";
import { drainHookCaptures, hookCaptureScope, quarantineHookScope } from "./hook-spool.ts";
import { createStandalonePolicy } from "./memory/policy.ts";
import { configuredPolicyOptions } from "./memory/config.ts";

async function readOptions(): Promise<string> {
  const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      // Native input is at most64KiB; leave bounded room for fixed host options and policy literals.
      if (bytes > HOOK_INPUT_BYTES + 32 * 1024) throw new Error("input bound");
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Fixed package helper, launched and reaped by each native hook; never registered or resident.
if (import.meta.main) {
  let owned = false;
  let rssTelemetryValid = true;
  const frame = (rss: number[]) => { try { writeSync(1, JSON.stringify({ rss }) + "\n"); } catch { rssTelemetryValid = false; } };
  const progress = (transcript: HookTranscriptProgress) => { try { writeSync(1, JSON.stringify({ transcript }) + "\n"); } catch { rssTelemetryValid = false; } };
  frame([0]);
  let nativeId = 0;
  const nativeUsage: HookNativeUsage = { rssKB: 0, rawRssKB: 0, observe: () => {
    const id = ++nativeId; frame([1, id, 0]);
    return { started: pid => frame([1, id, pid]), finished: value => frame([2, id, value.kb, value.rawKB, rssSourceCode(value), 0]) };
  } };
  const stop = (): never => {
    if (!rssTelemetryValid) frame([4]);
    const self = hookRssReading(); frame([3, self.kb, self.rawKB, rssSourceCode(self)]);
    // This leader is still alive in the detached group created by hookWorker.
    // Native Git uses a separate owned async supervisor with its own native watchdog;
    // a blocked Git cannot prevent this worker's JS deadline from firing.
    if (owned) try { process.kill(-process.pid, "SIGKILL"); } catch { /* No group exists in a direct, non-owned invocation. */ }
    process.exit(0);
  };
  const emit = async (result: unknown) => {
    const body = JSON.stringify({ ...(result as object), complete: true, rssTelemetryValid });
    const rssKB = hookPeakRssKB() + nativeUsage.rssKB;
    await Bun.stdout.write(body.slice(0, -1) + `,"rssKB":${rssKB}}\n`);
    stop();
  };
  try {
    const options = JSON.parse(await readOptions()) as BriefOptions & { current: string; event: string; transcript?: unknown; deadlineAt: number; ownedGroup: boolean };
    if (!Number.isFinite(options.deadlineAt) || options.ownedGroup !== true) process.exit(0);
    owned = true;
    const remaining = () => options.deadlineAt - (performance.timeOrigin + performance.now());
    const deadlineStop = () => { if (options.transcript !== undefined) progress({ stopReason: "deadline" }); stop(); };
    if (remaining() <= 0) deadlineStop();
    setTimeout(deadlineStop, remaining()).unref();
    const policy = createStandalonePolicy(configuredPolicyOptions(options.base!, options.cwd, options.policy)), event = options.event;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) stop();
    const expectedScope = hookCaptureScope(options.cwd, options.base!);
    let project: string | undefined;
    // Overlap the shared resolver's existing origin/metadata reads on a cold cache;
    // serial native launches can exhaust every hook before any binding or replay is published.
    // ponytail: cold identity must still fit one hook deadline. Revalidated durable
    // identity progress is the upgrade if slower native reads keep exhausting that slice.
    try { project = resolveAlias(options.base!, await resolveHookProjectAsync({ cwd: options.cwd, base: options.base!, scope: expectedScope, timeRemaining: remaining, maintainCache: event !== "SessionStart", prefetch: true }, nativeUsage)); }
    catch { /* Native cleanup has settled; independently bound transcript admission can still proceed. */ }
    if ((event === "Stop" || event === "SessionEnd") && options.transcript !== undefined
      && (project !== undefined || expectedScope !== undefined && hookCaptureScope(options.cwd, options.base!) === expectedScope)) {
      try {
        const { scanHookTranscriptTail } = await import("./hook-transcript.ts");
        // Metadata helpers have been reaped and their numeric receipts sent before scanning.
        // Ordinary capture is already durable. Keep the existing 20 ms reserve for
        // the cursor commit and drain before the parent's unchanged worker deadline.
        // ponytail: upgrade to deadline-aware storage operations rather than widening R2.
        const scanned = await scanHookTranscriptTail(options.transcript, { cwd: options.cwd, base: options.base!, policy: options.policy,
          deadline: Math.min(performance.now() + remaining() - 20, performance.now() + 60) });
        if (scanned) progress(scanned);
      } catch { /* A transcript failure must not discard the ordinary hook capture. */ }
    }
    if (project === undefined) {
      if (expectedScope !== undefined) quarantineHookScope({ cwd: options.cwd, base: options.base!, scope: expectedScope });
      stop();
    }
    let captured = false;
    // Normal SessionStart keeps the parent's durable stage for later replay and spends
    // its short-lived worker on context. An empty current name is mandatory full-tier recovery.
    if (expectedScope !== undefined && (event !== "SessionStart" || !options.current)) {
      const { CaptureStore } = await import("./memory/capture.ts");
      let store: CaptureStore | undefined;
      try {
        const drained = await drainHookCaptures({ ...options, base: options.base!, project, expectedScope, timeRemaining: remaining }, (input, receipt) => {
          store ??= new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0, cwd: options.cwd });
          return store.append(input, { receipt });
        });
        captured = drained.captured.includes(options.current);
      } finally { store?.close(); }
    }
    if (hookCaptureScope(options.cwd, options.base!) !== expectedScope) stop();
    if (event === "SessionStart") {
      const { sessionStartBrief } = await import("./session-brief.ts");
      const result = await sessionStartBrief({ ...options, project,
        timeRemaining: () => options.deadlineAt - (performance.timeOrigin + performance.now()) });
      const valid = await policy.screen({ context: result.context });
      if (hookCaptureScope(options.cwd, options.base!) !== expectedScope) stop();
      await emit({ ...result, captured, valid });
    } else await emit({ context: "", captured, valid: true });
  } catch { if (owned) stop(); process.exitCode = 1; }
}
