import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
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
  for (const key of [...FIELDS, "capTrimmed"] as const) if (Number.isSafeInteger(input[key]) && (input[key] as number) >= 0) out[key] = input[key] as number;
  return out;
}
function readTail(fd: number, size: number): string {
  const start = Math.max(0, size - RECORD_VARIANTS_MAX_BYTES), bytes = Buffer.alloc(Math.min(size, RECORD_VARIANTS_MAX_BYTES));
  const length = readSync(fd, bytes, 0, bytes.length, start);
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  if (start) text = text.slice(text.indexOf("\n") + 1);
  return text;
}
/** Same bounded rolling rewrite discipline as resource metrics; this is observational data, never capture history. */
function trim(fd: number, size: number, cutoff: number, room: number): boolean {
  const rows: string[] = [];
  for (const line of readTail(fd, size).split("\n")) {
    if (!line) continue;
    try { const parsed = row(JSON.parse(line)); if (parsed && Date.parse(parsed.at) >= cutoff) rows.push(JSON.stringify(parsed) + "\n"); } catch { /* A malformed observation is not a zero. */ }
  }
  const maximum = RECORD_VARIANTS_MAX_BYTES - room - 32;
  let bytes = 0, from = rows.length;
  while (from > 0 && bytes + Buffer.byteLength(rows[from - 1]!) <= maximum) bytes += Buffer.byteLength(rows[--from]!);
  const capTrimmed = size > RECORD_VARIANTS_MAX_BYTES || from > 0;
  const retained = rows.slice(from);
  if (capTrimmed && retained.length) {
    const last = JSON.parse(retained[retained.length - 1]!) as JournalRow;
    last.capTrimmed = 1;
    retained[retained.length - 1] = JSON.stringify(last) + "\n";
  }
  const kept = retained.join("");
  ftruncateSync(fd, 0);
  if (kept) writeSync(fd, kept);
  return capTrimmed;
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
    let line = JSON.stringify(out) + "\n";
    if (Buffer.byteLength(line) > ROW_BYTES) return;
    const cutoff = now - RECORD_VARIANTS_DAYS * DAY;
    let ageTrim = false;
    if (stat.size) {
      const probe = Buffer.alloc(Math.min(stat.size, ROW_BYTES));
      const length = readSync(fd, probe, 0, probe.length, 0);
      try { const first = row(JSON.parse(probe.subarray(0, length).toString("utf8").split("\n")[0]!)); ageTrim = !first || Date.parse(first.at) < cutoff; }
      catch { ageTrim = true; }
    }
    if (ageTrim || stat.size + Buffer.byteLength(line) + 32 > RECORD_VARIANTS_MAX_BYTES) {
      if (trim(fd, stat.size, cutoff, Buffer.byteLength(line) + 32)) out.capTrimmed = 1;
      line = JSON.stringify(out) + "\n";
    }
    writeSync(fd, line); // O_APPEND, one short write for the observation.
    const after = fstatSync(fd);
    if (after.size > RECORD_VARIANTS_MAX_BYTES) trim(fd, after.size, cutoff, 0);
  } catch { /* Metrics never deny a tool or disclose the input. */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Fail open. */ } }
}
