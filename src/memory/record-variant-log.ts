import { closeSync, constants, fstatSync, renameSync, unlinkSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MetricSample } from "./metrics.ts";

export const RECORD_VARIANTS_FILE = "record-variants.jsonl";
export const RECORD_VARIANTS_MAX_BYTES = 4 * 1024 * 1024;
export const RECORD_VARIANTS_DAYS = 8;
const DAY = 86400_000, ROW_BYTES = 1024;
const FIELDS = ["recordEnabled", "recordSessions", "recordTurns", "recordTurnsWithRecords", "recordValidRecords", "recordBasisRecords", "recordUnverifiedRecords", "recordInstructionInvalid", "recordInstructionEmitted", "recordBriefBytes", "recordInstructionBytes", "recordInstructionEstimatedTokens"] as const;
type Event = "SessionStart" | "Stop" | "SessionEnd";
interface JournalRow { at: string; event: Event; variant: "a" | "b"; capTrimmed?: number; [key: string]: string | number | undefined }
function row(value: unknown): JournalRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at)) || !["SessionStart", "Stop", "SessionEnd"].includes(input.event as string) || input.variant !== "a" && input.variant !== "b") return;
  if (new Date(Date.parse(input.at)).toISOString() !== input.at) return;
  const out: JournalRow = { at: input.at, event: input.event as Event, variant: input.variant };
  for (const key of [...FIELDS, "capTrimmed", "trimmed"] as const) if (Number.isSafeInteger(input[key]) && (input[key] as number) >= 0) out[key] = input[key] as number;
  return out;
}
function readTail(fd: number, size: number): string {
  const start = Math.max(0, size - RECORD_VARIANTS_MAX_BYTES), bytes = Buffer.alloc(Math.min(size, RECORD_VARIANTS_MAX_BYTES));
  const length = readSync(fd, bytes, 0, bytes.length, start);
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  if (start) text = text.slice(text.indexOf("\n") + 1);
  return text;
}
/**
 * ponytail: bounded observational retention may lose concurrent appends/competing trims
 * between snapshot and rename (or writes to the replaced inode). Readers see a whole file.
 * Upgrade: coordinate append and trim under one lock, or use dated per-day files.
 * Count observed trim markers, never infer a number of lost observations.
 */
function trim(base: string, fd: number, size: number, cutoff: number): void {
  const rows: JournalRow[] = [];
  for (const line of readTail(fd, size).split("\n")) {
    if (!line) continue;
    try { const parsed = row(JSON.parse(line)); if (parsed && Date.parse(parsed.at) >= cutoff) rows.push(parsed); } catch { /* Malformed observations are not zeros. */ }
  }
  if (!rows.length) return;
  rows[rows.length - 1]!.trimmed = 1;
  let encoded = rows.map(value => JSON.stringify(value) + "\n");
  let bytes = encoded.reduce((sum, line) => sum + Buffer.byteLength(line), 0), from = 0;
  while (from < encoded.length && bytes + 32 > RECORD_VARIANTS_MAX_BYTES) bytes -= Buffer.byteLength(encoded[from++]!);
  if (from || size > RECORD_VARIANTS_MAX_BYTES) {
    rows[rows.length - 1]!.capTrimmed = 1;
    encoded[encoded.length - 1] = JSON.stringify(rows[rows.length - 1]) + "\n";
  }
  const kept = encoded.slice(from).join("");
  const temporary = join(base, `${RECORD_VARIANTS_FILE}.tmp-${randomUUID()}`);
  let target: number | undefined;
  try {
    target = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    writeFileSync(target, kept); closeSync(target); target = undefined;
    renameSync(temporary, join(base, RECORD_VARIANTS_FILE));
  } finally {
    if (target !== undefined) closeSync(target);
    try { unlinkSync(temporary); } catch { /* Renamed or not created. */ }
  }
}
/** One short append per hook. Only explicit numeric fields survive; failures never change a hook outcome. */
export function appendRecordVariant(base: string, event: string, sample: MetricSample, now = Date.now()): void {
  if (!["SessionStart", "Stop", "SessionEnd"].includes(event) || sample.recordVariant !== "a" && sample.recordVariant !== "b") return;
  let fd: number | undefined;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    fd = openSync(join(base, RECORD_VARIANTS_FILE), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || typeof process.getuid === "function" && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) return;
    const out = row({ ...sample, at: new Date(now).toISOString(), event, variant: sample.recordVariant })!;
    const line = JSON.stringify(out) + "\n";
    if (Buffer.byteLength(line) > ROW_BYTES) return;
    writeSync(fd, line); // One short O_APPEND write; ordinary calls never read the tail or rewrite.
    const after = fstatSync(fd);
    const probe = Buffer.alloc(Math.min(after.size, ROW_BYTES));
    const length = readSync(fd, probe, 0, probe.length, 0);
    let ageTrim = false;
    try {
      const first = row(JSON.parse(probe.subarray(0, length).toString("utf8").split("\n")[0]!));
      ageTrim = !!first && Date.parse(first.at) < now - 9 * DAY;
    } catch { /* No date evidence: only the size trigger can trim it. */ }
    if (ageTrim || after.size >= RECORD_VARIANTS_MAX_BYTES) trim(base, fd, after.size, now - RECORD_VARIANTS_DAYS * DAY);
  } catch { /* Metrics never deny a tool or disclose the input. */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Fail open. */ } }
}
