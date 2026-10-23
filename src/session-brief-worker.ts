import type { BriefOptions } from "./session-brief.ts";
import type { CaptureStore } from "./memory/capture.ts";
import { resolveHookProject } from "./hook-project.ts";
import { hookPeakRssKB } from "./hook-resources.ts";
import { resolveAlias } from "./memory/aliases.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES } from "./hook-contract.ts";
import { drainHookCaptures, hookCaptureScope, quarantineHookScope } from "./hook-spool.ts";
import { createStandalonePolicy } from "./memory/policy.ts";

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
  const stop = (): never => {
    // This leader is still alive in the detached group created by hookWorker, so its
    // native descendants cannot outlive a timeout, transport failure or normal completion.
    if (owned) try { process.kill(-process.pid, "SIGKILL"); } catch { /* No group exists in a direct, non-owned invocation. */ }
    process.exit(0);
  };
  const emit = async (result: unknown) => {
    const body = JSON.stringify({ ...(result as object), complete: true });
    const rssKB = hookPeakRssKB();
    await Bun.stdout.write(body.slice(0, -1) + `,"rssKB":${rssKB}}\n`);
    stop();
  };
  try {
    const options = JSON.parse(await readOptions()) as BriefOptions & { current: string; event: string; deadlineAt: number; ownedGroup: boolean };
    if (!Number.isFinite(options.deadlineAt) || options.ownedGroup !== true) process.exit(0);
    owned = true;
    const remaining = () => options.deadlineAt - (performance.timeOrigin + performance.now());
    if (remaining() <= 0) stop();
    setTimeout(stop, remaining()).unref();
    const policy = createStandalonePolicy(options.policy), event = options.event;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) stop();
    const expectedScope = hookCaptureScope(options.cwd, options.base!) ?? stop();
    let project: string;
    try { project = resolveAlias(options.base!, resolveHookProject({ cwd: options.cwd, base: options.base!, scope: expectedScope, timeRemaining: remaining })); }
    catch {
      quarantineHookScope({ cwd: options.cwd, base: options.base!, scope: expectedScope });
      project = stop();
    }
    let captured = false;
    // Normal SessionStart keeps the parent's durable stage for later replay and spends
    // its short-lived worker on context. An empty current name is mandatory full-tier recovery.
    if (event !== "SessionStart" || !options.current) {
      const { CaptureStore } = await import("./memory/capture.ts");
      let store: CaptureStore | undefined;
      try {
        const drained = await drainHookCaptures({ ...options, base: options.base!, project, expectedScope, timeRemaining: remaining }, (input, receipt) => {
          store ??= new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0 });
          return store.append(input, { receipt });
        });
        captured = drained.captured.includes(options.current);
      } finally { store?.close(); }
    }
    if (event === "SessionStart") {
      const { sessionStartBrief } = await import("./session-brief.ts");
      const result = await sessionStartBrief({ ...options, project,
        timeRemaining: () => options.deadlineAt - (performance.timeOrigin + performance.now()) });
      await emit({ ...result, captured, valid: await policy.screen({ context: result.context }) });
    } else await emit({ context: "", captured, valid: true });
  } catch { if (owned) stop(); process.exitCode = 1; }
}
