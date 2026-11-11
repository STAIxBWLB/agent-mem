import type { RecordIntakeCounts } from "./hook-record.ts";
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export const HOOK_INPUT_BYTES = 64 * 1024, HOOK_CONTEXT_BYTES = 1200, HOOK_OUTPUT_BYTES = 8192;
/** `unavailable` (#221): the scan threw, so no progress is known; unlike the others it is a fault, never accepted progress. */
export type HookTranscriptStopReason = "cap" | "deadline" | "spool_full" | "unavailable";
export const HOOK_TRANSCRIPT_STOP_REASONS: readonly HookTranscriptStopReason[] = ["cap", "deadline", "spool_full", "unavailable"];
export interface HookRecordCounts { recordValidRecords: number; recordBasisRecords: number; recordUnverifiedRecords: number }
export interface HookTranscriptProgress extends Partial<HookRecordCounts> { offset?: number; stopReason?: HookTranscriptStopReason; records?: RecordIntakeCounts }
export function isHookTranscriptProgress(value: unknown): value is HookTranscriptProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["offset", "stopReason", "recordValidRecords", "recordBasisRecords", "recordUnverifiedRecords", "records"].includes(key))
    && (row.records === undefined || isRecordIntakeCounts(row.records))
    && (["recordValidRecords", "recordBasisRecords", "recordUnverifiedRecords"].every(key => row[key] === undefined)
      || ["recordValidRecords", "recordBasisRecords", "recordUnverifiedRecords"].every(key => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0)
        && (row.recordBasisRecords as number) <= (row.recordValidRecords as number) && (row.recordUnverifiedRecords as number) <= (row.recordValidRecords as number))
    && (row.offset !== undefined || row.stopReason !== undefined)
    && (row.offset === undefined || Number.isSafeInteger(row.offset) && (row.offset as number) >= 0)
    && (row.stopReason === undefined || (HOOK_TRANSCRIPT_STOP_REASONS as readonly string[]).includes(row.stopReason as string));
}

/** The worker protocol permits only bounded numeric receipts, never captured text. */
function isRecordIntakeCounts(value: unknown): value is RecordIntakeCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const numeric = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (Object.keys(row).length !== 5 || !Object.keys(row).every(key => ["supported", "found", "staged", "duplicatesSkipped", "refused"].includes(key))
    || typeof row.supported !== "boolean" || !numeric(row.found) || !numeric(row.staged) || !numeric(row.duplicatesSkipped)
    || row.staged > row.found || row.duplicatesSkipped > row.found || (!row.supported && row.staged !== 0)
    || !row.refused || typeof row.refused !== "object" || Array.isArray(row.refused)) return false;
  const reasons = ["record_invalid", "record_count", "record_length", "record_policy", "record_identity", "record_timestamp", "finality-unavailable"];
  return Object.entries(row.refused).every(([reason, count]) => reasons.includes(reason) && numeric(count))
    && Object.values(row.refused).reduce<number>((sum, count) => sum + (count as number), 0) + row.staged + row.duplicatesSkipped <= row.found;
}
