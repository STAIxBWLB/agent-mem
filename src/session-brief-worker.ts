import type { BriefOptions } from "./session-brief.ts";
import { CaptureStore } from "./memory/capture.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { resolveAlias } from "./memory/shard.ts";
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
  try {
    const options = JSON.parse(await readOptions()) as BriefOptions & { current: string; event: string; deadlineAt: number };
    if (!Number.isFinite(options.deadlineAt)) process.exit(0);
    const remaining = () => options.deadlineAt - (performance.timeOrigin + performance.now());
    if (remaining() <= 0) process.exit(0);
    setTimeout(() => process.exit(0), remaining()).unref();
    const policy = createStandalonePolicy(options.policy), event = options.event;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) process.exit(0);
    const expectedScope = hookCaptureScope(options.cwd, options.base!);
    if (!expectedScope) process.exit(0);
    let project: string;
    try { project = resolveAlias(options.base!, memoryProjectKey(options.cwd, { repositoryIsolation: true, strictGitErrors: true })); }
    catch {
      quarantineHookScope({ cwd: options.cwd, base: options.base!, scope: expectedScope });
      process.exit(0);
    }
    let store: CaptureStore | undefined;
    let captured = false;
    try {
      const drained = await drainHookCaptures({ ...options, base: options.base!, project, expectedScope, timeRemaining: event === "SessionStart" ? () => remaining() - 80 : remaining }, (input, receipt) => {
        store ??= new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0 });
        return store.append(input, { receipt });
      });
      captured = drained.captured.includes(options.current);
    } finally { store?.close(); }
    if (event === "SessionStart") {
      const { sessionStartBrief } = await import("./session-brief.ts");
      const result = await sessionStartBrief({ ...options, project,
        timeRemaining: () => options.deadlineAt - (performance.timeOrigin + performance.now()) });
      console.log(JSON.stringify({ ...result, captured, valid: await policy.screen({ context: result.context }) }));
    } else console.log(JSON.stringify({ context: "", captured, valid: true }));
  } catch { process.exitCode = 1; }
}
