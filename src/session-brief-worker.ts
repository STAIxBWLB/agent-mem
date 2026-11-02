import type { BriefOptions } from "./session-brief.ts";
import type { CaptureStore } from "./memory/capture.ts";
import { acceptHookProjectReceipt } from "./hook-project.ts";
import { writeSync } from "node:fs";
import { hookRssReading, hookPeakRssKB } from "./hook-resources.ts";
import { rssSourceCode } from "./hook-rss-wire.ts";
import { resolveAlias } from "./memory/aliases.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES, type HookTranscriptProgress } from "./hook-contract.ts";
import { drainHookCaptures, hookCaptureScope } from "./hook-spool.ts";

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
  const next = optionLines();
  try {
    let line = await next();
    if (line === undefined) process.exit(0);
    let first = JSON.parse(line) as Record<string, unknown>;
    if (first.scan !== undefined) {
      // #226: scan first, while the parent resolves native metadata. A fault is reported, never counted as progress (#221).
      const scan = first.scan as { cwd: string; base: string; transcript: unknown; policy?: BriefOptions["policy"]; deadlineAt: number };
      if (Number.isFinite(scan.deadlineAt) && hookCaptureScope(scan.cwd, scan.base) !== undefined) {
        const remainingScan = () => scan.deadlineAt - (performance.timeOrigin + performance.now());
        try {
          const { scanHookTranscriptTail } = await import("./hook-transcript.ts");
          const scanned = await scanHookTranscriptTail(scan.transcript, { cwd: scan.cwd, base: scan.base, policy: scan.policy,
            deadline: Math.min(performance.now() + remainingScan() - 20, performance.now() + 60) });
          if (scanned) progress(scanned);
        } catch { progress({ stopReason: "unavailable" }); }
      }
      line = await next();
      if (line === undefined) process.exit(0);
      first = JSON.parse(line) as Record<string, unknown>;
    }
    const options = first as unknown as BriefOptions & { current: string; event: string; identity?: unknown; deadlineAt: number; ownedGroup: boolean };
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
    if (project === undefined) stop();
    let captured = false;
    // An empty current name selects bounded full-tier recovery; SessionStart stays in the parent.
    if (expectedScope !== undefined) {
      const { CaptureStore } = await captureModule;
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
