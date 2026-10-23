export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export const HOOK_INPUT_BYTES = 64 * 1024, HOOK_CONTEXT_BYTES = 1200, HOOK_OUTPUT_BYTES = 8192;
