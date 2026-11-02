export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export const HOOK_INPUT_BYTES = 64 * 1024, HOOK_CONTEXT_BYTES = 1200, HOOK_OUTPUT_BYTES = 8192;
/** `unavailable` (#221): the scan threw, so no progress is known; unlike the others it is a fault, never accepted progress. */
export type HookTranscriptStopReason = "cap" | "deadline" | "spool_full" | "unavailable";
export const HOOK_TRANSCRIPT_STOP_REASONS: readonly HookTranscriptStopReason[] = ["cap", "deadline", "spool_full", "unavailable"];
export interface HookTranscriptProgress { offset?: number; stopReason?: HookTranscriptStopReason }
export function isHookTranscriptProgress(value: unknown): value is HookTranscriptProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => key === "offset" || key === "stopReason")
    && (row.offset !== undefined || row.stopReason !== undefined)
    && (row.offset === undefined || Number.isSafeInteger(row.offset) && (row.offset as number) >= 0)
    && (row.stopReason === undefined || (HOOK_TRANSCRIPT_STOP_REASONS as readonly string[]).includes(row.stopReason as string));
}
