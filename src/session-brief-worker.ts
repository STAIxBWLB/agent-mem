import type { BriefOptions } from "./session-brief.ts";
import type { CaptureStore } from "./memory/capture.ts";
import { acceptHookProjectReceipt } from "./hook-project.ts";
import { writeSync } from "node:fs";
import { hookRssReading, hookPeakRssKB } from "./hook-resources.ts";
import { rssSourceCode } from "./hook-rss-wire.ts";
import { resolveAlias } from "./memory/aliases.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES, type HookTranscriptProgress } from "./hook-contract.ts";
import { drainHookCaptures, hookCaptureScope, quarantineHookScope } from "./hook-spool.ts";

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
  try {
    const options = JSON.parse(await readOptions()) as BriefOptions & { current: string; event: string; identity?: unknown; transcript?: unknown; deadlineAt: number; ownedGroup: boolean };
    if (!Number.isFinite(options.deadlineAt) || options.ownedGroup !== true) process.exit(0);
    owned = true;
    const remaining = () => options.deadlineAt - (performance.timeOrigin + performance.now());
    const deadlineStop = () => { if (options.transcript !== undefined) progress({ stopReason: "deadline" }); stop(); };
    if (remaining() <= 0) deadlineStop();
    setTimeout(deadlineStop, remaining()).unref();
    const event = options.event;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) stop();
    const expectedScope = hookCaptureScope(options.cwd, options.base!);
    // A receipt is single-use parent IPC. This worker must never launch a native helper.
    if (event === "SessionStart") stop();
    let project: string | undefined;
    try { project = resolveAlias(options.base!, acceptHookProjectReceipt(options.identity, { cwd: options.cwd, base: options.base!, scope: expectedScope, timeRemaining: remaining })); } catch { /* Independently bound transcript intake can still proceed. */ }
    if ((event === "Stop" || event === "SessionEnd") && options.transcript !== undefined
      && (project !== undefined || expectedScope !== undefined && hookCaptureScope(options.cwd, options.base!) === expectedScope)) {
      try {
        const { scanHookTranscriptTail } = await import("./hook-transcript.ts");
        const scanned = await scanHookTranscriptTail(options.transcript, { cwd: options.cwd, base: options.base!, policy: options.policy,
          deadline: Math.min(performance.now() + remaining() - 20, performance.now() + 60) });
        if (scanned) progress(scanned);
      } catch { /* Ordinary durable capture is independent. */ }
    }
    if (project === undefined) stop();
    let captured = false;
    // An empty current name selects bounded full-tier recovery; SessionStart stays in the parent.
    if (expectedScope !== undefined) {
      const { CaptureStore } = await import("./memory/capture.ts");
      let store: CaptureStore | undefined;
      try {
        const drained = await drainHookCaptures({ ...options, base: options.base!, project: project!, expectedScope, timeRemaining: remaining }, (input, receipt) => {
          store ??= new CaptureStore({ memoryDir: options.base!, project: project!, busyTimeoutMs: 0, cwd: options.cwd });
          return store.append(input, { receipt });
        });
        captured = drained.captured.includes(options.current);
      } finally { store?.close(); }
    }
    if (hookCaptureScope(options.cwd, options.base!) !== expectedScope) stop();
    await emit({ context: "", captured, valid: true });
  } catch { if (owned) stop(); process.exitCode = 1; }
}
