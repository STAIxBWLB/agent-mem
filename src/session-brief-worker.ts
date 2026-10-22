import { sessionStartBrief, type BriefOptions } from "./session-brief.ts";
import { CaptureStore, type CaptureInput } from "./memory/capture.ts";
import { memoryProjectKey } from "./memory/project.ts";
import { resolveAlias } from "./memory/shard.ts";
import { HOOK_EVENTS, HOOK_INPUT_BYTES } from "./hook-contract.ts";
import { realPath } from "./memory/platform.ts";
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
    const options = JSON.parse(await readOptions()) as BriefOptions & { input: unknown; event: string };
    const policy = createStandalonePolicy(options.policy), event = options.event;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) process.exit(0);
    if (!await policy.screen(options.input) || !options.input || typeof options.input !== "object" || Array.isArray(options.input)) process.exit(0);
    const value = options.input as Record<string, unknown>;
    if (value.hook_event_name !== undefined && value.hook_event_name !== event) process.exit(0);
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || realPath(value.cwd) !== realPath(options.cwd))) process.exit(0);
    const tool = value.tool_input && typeof value.tool_input === "object" && !Array.isArray(value.tool_input) ? value.tool_input as Record<string, unknown> : {};
    const paths = [tool.file_path, tool.path, ...(Array.isArray(tool.paths) ? tool.paths : [])].filter((p): p is string => typeof p === "string");
    const content = value.prompt ?? value.last_assistant_message ?? value.tool_response ?? "";
    const project = resolveAlias(options.base!, memoryProjectKey(options.cwd, { repositoryIsolation: true }));
    const candidate: CaptureInput = { project, agent: "claude", event, paths, status: event === "PostToolUseFailure" ? "failed" : "ok",
      ...(typeof value.tool_name === "string" ? { tool: value.tool_name } : {}), excerpt: typeof content === "string" ? content : JSON.stringify(content) };
    if (!await policy.screen(candidate)) process.exit(0);
    // A native hook spends no deadline waiting on another writer: immutable spool is its back-pressure path.
    const store = new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0 });
    try { store.append(candidate); } finally { store.close(); }
    if (event === "SessionStart") {
      const result = await sessionStartBrief({ ...options, project });
      console.log(JSON.stringify({ ...result, captured: true, valid: await policy.screen({ context: result.context }) }));
    } else console.log(JSON.stringify({ context: "", captured: true, valid: true }));
  } catch { process.exitCode = 1; }
}
