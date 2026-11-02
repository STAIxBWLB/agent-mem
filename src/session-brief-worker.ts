import type { BriefOptions } from "./session-brief.ts";
import type { CaptureStore } from "./memory/capture.ts";
import { acceptHookProjectReceipt } from "./hook-project.ts";
import { writeSync } from "node:fs";
import { hookRssReading, hookPeakRssKB } from "./hook-resources.ts";
import { rssSourceCode } from "./hook-rss-wire.ts";
import { resolveAlias } from "./memory/aliases.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES, type HookTranscriptProgress } from "./hook-contract.ts";
import { drainHookCaptures, hookCaptureScope, hookReplayBudget } from "./hook-spool.ts";
/** Existing allowance for the scan's own cursor commit; the parent also retains its cleanup reserve. */
const SCAN_COMMIT_MS = 20;

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
  let owned = false, rssTelemetryValid = true;
  let lastProgress: HookTranscriptProgress | undefined;
  const frame = (rss: number[]) => { try { writeSync(1, JSON.stringify({ rss }) + "\n"); } catch { rssTelemetryValid = false; } };
  const progress = (transcript: HookTranscriptProgress) => {
    lastProgress = { ...lastProgress, ...transcript, ...(lastProgress?.stopReason === "unavailable" ? { stopReason: "unavailable" as const } : {}) };
    try { writeSync(1, JSON.stringify({ transcript: lastProgress }) + "\n"); } catch { rssTelemetryValid = false; }
  };
  const drain = (value: { startMs?: number; drained: number }) => { try { writeSync(1, JSON.stringify({ drain: value }) + "\n"); } catch { rssTelemetryValid = false; } };
  frame([0]);
  const stop = (): never => {
    if (!rssTelemetryValid) frame([4]);
    const self = hookRssReading(); frame([3, self.kb, self.rawKB, rssSourceCode(self)]);
    if (owned) try { process.kill(-process.pid, "SIGKILL"); } catch { /* A direct unowned invocation has no group. */ }
    process.exit(0);
  };
  const emit = async (result: unknown) => {
    const body = JSON.stringify({ ...(result as object), complete: true, rssTelemetryValid });
    const rssKB = hookPeakRssKB();
    await Bun.stdout.write(body.slice(0, -1) + `,"rssKB":${rssKB}}\n`);
    stop();
  };
  // Ordinary hooks preload only the store, as before. They must not pay for a transcript module they never use.
  const captureModule = import("./memory/capture.ts");
  captureModule.catch(() => { /* Reported when the drain awaits it. */ });
  const next = optionLines(), now = () => performance.timeOrigin + performance.now();
  let store: CaptureStore | undefined;
  try {
    const line = await next();
    if (line === undefined) stop();
    const first = JSON.parse(line) as Record<string, unknown>;
    type Scan = { cwd: string; base: string; transcript: unknown; policy?: BriefOptions["policy"]; deadlineAt: number };
    type DrainOptions = BriefOptions & { current: string; event: string; identity?: unknown; deadlineAt: number; ownedGroup: boolean; hookStartAt?: number };
    const scan = first.scan as Scan | undefined;
    const deadlineAt = scan?.deadlineAt ?? first.deadlineAt;
    if (!Number.isFinite(deadlineAt) || first.ownedGroup !== true) stop();
    owned = true;
    const end = deadlineAt as number;
    if (now() >= end) { if (scan) progress({ stopReason: "deadline" }); stop(); }
    setTimeout(() => { if (scan) progress({ stopReason: "deadline" }); stop(); }, end - now()).unref();

    // Read the native receipt while scan setup runs. Publication callbacks await it only when replay can proceed.
    const drainLine = scan ? next() : Promise.resolve(line);
    const ready = (async () => {
      const text = await drainLine;
      if (text === undefined) return undefined;
      const options = JSON.parse(text) as DrainOptions;
      if (options.ownedGroup !== true || options.deadlineAt !== end || !(HOOK_EVENTS as readonly string[]).includes(options.event) || options.event === "SessionStart") return undefined;
      const expectedScope = hookCaptureScope(options.cwd, options.base!);
      let project: string | undefined;
    try { project = resolveAlias(options.base!, acceptHookProjectReceipt(options.identity, { cwd: options.cwd, base: options.base!, scope: expectedScope, timeRemaining: () => end - now() })); } catch { /* A bound scan may still stage without a project. */ }
      return { options, expectedScope, project };
    })();
    ready.catch(() => { /* The scan/final drain reports failure inside the owned helper. */ });
    const budget = hookReplayBudget();
    let drainedCount = 0, captured = false, drainStarted = false;
    const replay = async (until: number) => {
      if (!budget.files || !budget.bytes || until - now() < 8) return false;
      const context = await ready;
      if (!context?.project || context.expectedScope === undefined || Math.min(end, until) - now() < 8) return false;
      const { options, expectedScope, project } = context;
      const { CaptureStore } = await captureModule;
      const remaining = () => Math.min(end, until) - now();
      if (remaining() < 8) return false;
      if (!drainStarted) {
        drain({ startMs: Math.round(now() - (options.hookStartAt ?? end)), drained: drainedCount });
        drainStarted = true;
      }
      const drained = await drainHookCaptures({ ...options, base: options.base!, project, expectedScope, timeRemaining: remaining, replayBudget: budget }, (input, receipt) => {
        store ??= new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0, cwd: options.cwd });
        const appended = store.append(input, { receipt });
        drain({ drained: ++drainedCount }); // DB commit or durable capture-spool acknowledgement, as in the existing contract.
        return appended;
      });
      captured ||= drained.captured.includes(options.current);
      return drained.captured.length > 0;
    };
    let context: Awaited<typeof ready>;
    try {
      if (scan) {
        const scanEnd = end - SCAN_COMMIT_MS;
        if (scanEnd - now() < 5) progress({ stopReason: "deadline" });
        else try {
          const { scanHookTranscriptTail } = await import("./hook-transcript.ts");
          const scanned = await scanHookTranscriptTail(scan.transcript, {
            cwd: scan.cwd, base: scan.base, policy: scan.policy, deadline: performance.now() + (scanEnd - now()),
            // Same existing oldest-first drain and one shared budget, never a new 32-file allowance per publication.
            onPublication: async () => { await replay(scanEnd); },
            onBackpressure: () => replay(scanEnd),
          });
          if (scanned) progress(scanned);
        } catch { progress({ stopReason: "unavailable" }); }
      }
      context = await ready;
      await replay(end); // Newly staged summaries get their final commit opportunity in this hook too.
    } finally { store?.close(); }
    if (!context?.project || hookCaptureScope(context.options.cwd, context.options.base!) !== context.expectedScope) stop();
    await emit({ context: "", captured, valid: true });
  } catch { if (owned) stop(); process.exitCode = 1; }
}
