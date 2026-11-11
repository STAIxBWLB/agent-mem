import { stripPrivateSpans } from "./memory/private-spans.ts";

/** Package-owned instruction, never assembled from captured or configured text. */
export const RECORD_INSTRUCTION = [
  "Only when a turn settles a decision, fix, fail or contract, end the final answer with at most 2 records; otherwise none:",
  "amem: <decision|fix|fail|contract|finding> | <repo/path[#symbol],... or - for decision/contract> | <text, max 300 characters>",
  "For fix/fail use symptom/cause -> fix/retry-when. No fences, quotes, secrets or PII.",
].join("\n");

/** Purpose-framed alternative; the canonical Record grammar is unchanged. */
export const RECORD_INSTRUCTION_B = [
  "Future use: keep what code/git/instructions lack. Up to 2 final lines; else none:",
  "amem: <decision|fix|fail|contract|finding> | <repo/path[#symbol],... or - for decision/contract> | <text, max 300 chars; basis:test|log|issue|run; prefix ? if unverified>",
  "fix/fail: symptom/cause -> fix/retry-when. No fences, quotes, secrets or PII.",
].join("\n");
export type RecordInstructionVariant = "a" | "b";
export type RecordInstructionMode = RecordInstructionVariant | "alternate";
export const RECORD_INSTRUCTIONS = Object.freeze({ a: RECORD_INSTRUCTION, b: RECORD_INSTRUCTION_B });
export const RECORD_INSTRUCTION_BYTES = 332;

/** Parity of the persisted session hash is reproducible without the raw session id. */
export function recordInstructionVariant(mode: RecordInstructionMode, sessionKey?: string): RecordInstructionVariant {
  if (mode !== "alternate") return mode;
  return sessionKey && /^[a-f0-9]{16}$/.test(sessionKey) && Number.parseInt(sessionKey.slice(-1), 16) % 2 === 1 ? "b" : "a";
}

/** Data remains untrusted after the one exact package-owned instruction prefix. */
export function recordContextData(context: string): string {
  for (const instruction of Object.values(RECORD_INSTRUCTIONS)) {
    const prefix = `${instruction}\n`;
    if (context.startsWith(prefix)) return context.slice(prefix.length);
  }
  return context;
}

export const RECORD_INPUT_BYTES = 256 * 1024;

const KINDS = ["decision", "fix", "fail", "contract", "finding"] as const;
export type RecordKind = typeof KINDS[number];
export type RecordDropReason = "record_invalid" | "record_count" | "record_length" | "record_policy" | "record_identity" | "record_timestamp";
export interface ParsedRecord { kind: RecordKind; anchors: string[]; text: string; line: string }
export interface ParsedRecordTurn { records: ParsedRecord[]; drops: Partial<Record<RecordDropReason, number>>; incomplete?: true }
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Lexical repository-relative anchors; deleted paths need no filesystem lookup. */
function validAnchor(anchor: string): boolean {
  const parts = anchor.split("#"), path = parts[0]!;
  if (!path || path.startsWith("/") || path.startsWith("~") || /[\\:|<>*?\[\]{}]/.test(path) || controls.test(anchor)
    || parts.length > 2 || parts.length === 2 && (!parts[1] || /\s/.test(parts[1]))) return false;
  return !path.split("/").some(part => !part || part === "." || part === "..");
}

function recordLine(line: string): ParsedRecord | RecordDropReason {
  const fields = /^amem: ([^|\s]+) \| ([^|]+) \| (.*)$/.exec(line);
  if (!fields || controls.test(line)) return "record_invalid";
  const [, kind, rawAnchors, text] = fields;
  if (!(KINDS as readonly string[]).includes(kind!) || !text || text !== text.trim()) return "record_invalid";
  let characters = 0;
  for (const _character of text) if (++characters > 300) return "record_length";
  if ((kind === "fix" || kind === "fail") && !/^.+ -> .+$/u.test(text)) return "record_invalid";
  const anchors = rawAnchors!.split(",").map(anchor => anchor.trim());
  if (rawAnchors === "-") {
    if (kind !== "decision" && kind !== "contract") return "record_invalid";
    anchors.length = 0;
  } else if (!anchors.every(validAnchor)) return "record_invalid";
  return { kind: kind as RecordKind, anchors, text, line: `amem: ${kind} | ${anchors.length ? anchors.join(", ") : "-"} | ${text}` };
}

/** One complete assistant text, including its text blocks; no JSON/model/network/store work. */
export function parseRecordLines(text: string, shouldStop?: () => boolean): ParsedRecordTurn {
  const result: ParsedRecordTurn = { records: [], drops: {} };
  // ponytail: share the native 256 KiB ceiling; larger answers need a bounded streaming parser.
  if (text.length > RECORD_INPUT_BYTES || Buffer.byteLength(text) > RECORD_INPUT_BYTES) return { records: [], drops: { record_length: 1 } };
  const drop = (reason: RecordDropReason) => { result.drops[reason] = (result.drops[reason] ?? 0) + 1; };
  const privateRanges: { start: number; end: number }[] = [];
  stripPrivateSpans(text, (start, end) => privateRanges.push({ start, end }));
  let fence: { character: string; length: number } | undefined, quote = false, offset = 0, rangeIndex = 0;
  for (const chunk of text.split("\n")) {
    if (shouldStop?.()) { result.incomplete = true; break; }
    const newline = offset + chunk.length < text.length, line = newline && chunk.endsWith("\r") ? chunk.slice(0, -1) : chunk;
    const start = offset, end = start + line.length; offset += chunk.length + 1;
    while (privateRanges[rangeIndex] && privateRanges[rangeIndex]!.end <= start) rangeIndex++;
    let safeLine = "", cursor = start, hasPrivate = false, privatePrefix = false, endsPrivate = false;
    for (let index = rangeIndex; privateRanges[index] && privateRanges[index]!.start < end; index++) {
      const range = privateRanges[index]!;
      hasPrivate = true; privatePrefix ||= range.start <= start && range.end > start;
      safeLine += text.slice(cursor, Math.max(cursor, Math.min(range.start, end)));
      cursor = Math.min(end, Math.max(cursor, range.end));
      endsPrivate = range.end <= end;
    }
    safeLine += text.slice(cursor, end);
    if (hasPrivate && !safeLine.trim() && !endsPrivate) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(safeLine);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }; quote = false; continue;
    }
    if (/^\s*>/.test(safeLine)) { quote = true; continue; }
    if (quote) { if (!safeLine.trim()) quote = false; continue; }
    if (hasPrivate) { if (!privatePrefix && line.startsWith("amem:")) drop("record_policy"); continue; }
    if (!line.startsWith("amem:")) continue;
    const record = recordLine(line);
    if (typeof record === "string") drop(record);
    else if (result.records.length >= 2) drop("record_count");
    else result.records.push(record);
  }
  return result;
}

/** Additive numeric intake receipt; an unsupported reader never turns text into capture. */
export type RecordIntakeRefusal = RecordDropReason | "finality-unavailable";
export interface RecordIntakeCounts {
  supported: boolean; found: number; staged: number; duplicatesSkipped: number;
  refused: Partial<Record<RecordIntakeRefusal, number>>;
}
export function recordIntakeCounts(supported = true): RecordIntakeCounts {
  return { supported, found: 0, staged: 0, refused: {}, duplicatesSkipped: 0 };
}
export function recordRefusal(counts: RecordIntakeCounts, reason: RecordIntakeRefusal, count = 1): void {
  counts.refused[reason] = (counts.refused[reason] ?? 0) + count;
}
