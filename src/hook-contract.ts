export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export const HOOK_INPUT_BYTES = 64 * 1024, HOOK_CONTEXT_BYTES = 1200, HOOK_OUTPUT_BYTES = 8192;
export interface HookTranscriptProgress { offset?: number; stopReason?: "cap" | "deadline" | "spool_full" }
export function isHookTranscriptProgress(value: unknown): value is HookTranscriptProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => key === "offset" || key === "stopReason")
    && (row.offset !== undefined || row.stopReason !== undefined)
    && (row.offset === undefined || Number.isSafeInteger(row.offset) && (row.offset as number) >= 0)
    && (row.stopReason === undefined || ["cap", "deadline", "spool_full"].includes(row.stopReason as string));
}
