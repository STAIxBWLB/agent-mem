/**
 * #226 redesign: the bounded transcript scan runs in its own short-lived child, started at hook start and killed by
 * the parent at the scan deadline. It runs the unchanged scanHookTranscriptTail. Its durable publication (fsync) can
 * outlive the kill in the kernel; the parent never waits for that (bounded reap), so the hook still meets its deadline.
 * Fixed package helper: never registered, never resident, no network or model call.
 */
import { writeSync } from "node:fs";
import { HOOK_INPUT_BYTES, type HookTranscriptProgress } from "./hook-contract.ts";
import { hookRssReading } from "./hook-resources.ts";
import { rssSourceCode } from "./hook-rss-wire.ts";
import { hookCaptureScope } from "./hook-spool.ts";
import type { StandalonePolicyOptions } from "./memory/policy.ts";

async function readOptions(): Promise<string> {
  const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > HOOK_INPUT_BYTES + 32 * 1024) throw new Error("input bound");
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

if (import.meta.main) {
  let owned = false, rssTelemetryValid = true;
  const frame = (rss: number[]) => { try { writeSync(1, JSON.stringify({ rss }) + "\n"); } catch { rssTelemetryValid = false; } };
  const progress = (transcript: HookTranscriptProgress) => { try { writeSync(1, JSON.stringify({ transcript }) + "\n"); } catch { rssTelemetryValid = false; } };
  frame([0]);
  const stop = (): never => {
    if (!rssTelemetryValid) frame([4]);
    const self = hookRssReading(); frame([3, self.kb, self.rawKB, rssSourceCode(self)]);
    try { writeSync(1, JSON.stringify({ complete: true }) + "\n"); } catch { /* The parent then treats the scan as not completed. */ }
    if (owned) try { process.kill(-process.pid, "SIGKILL"); } catch { /* No group exists in a direct, non-owned invocation. */ }
    process.exit(0);
  };
  try {
    const options = JSON.parse(await readOptions()) as { cwd: string; base: string; transcript: unknown; policy?: StandalonePolicyOptions; deadlineAt: number; ownedGroup: boolean };
    if (!Number.isFinite(options.deadlineAt) || options.ownedGroup !== true) process.exit(0);
    owned = true;
    const remaining = () => options.deadlineAt - (performance.timeOrigin + performance.now());
    if (remaining() <= 0) { progress({ stopReason: "deadline" }); stop(); }
    // The worker scanned only for a cwd with a known capture scope; the scan child keeps that guard.
    if (hookCaptureScope(options.cwd, options.base) === undefined) stop();
    try {
      const { scanHookTranscriptTail } = await import("./hook-transcript.ts");
      const scanned = await scanHookTranscriptTail(options.transcript, { cwd: options.cwd, base: options.base, policy: options.policy, deadline: performance.now() + remaining() });
      if (scanned) progress(scanned);
    } catch { progress({ stopReason: "unavailable" }); /* #221: a scan fault is reported, never counted as progress. */ }
    stop();
  } catch { if (owned) stop(); process.exitCode = 1; }
}
