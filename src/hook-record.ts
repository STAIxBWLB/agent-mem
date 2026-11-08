/** Package-owned instruction, never assembled from captured or configured text. */
export const RECORD_INSTRUCTION = [
  "Only when a turn settles a decision, fix, fail or contract, end the final answer with at most 2 records; otherwise none:",
  "amem: <decision|fix|fail|contract|finding> | <repo/path[#symbol],... or - for decision/contract> | <text, max 300 characters>",
  "For fix/fail use symptom/cause -> fix/retry-when. No fences, quotes, secrets or PII.",
].join("\n");

const KINDS = ["decision", "fix", "fail", "contract", "finding"] as const;
export type RecordKind = typeof KINDS[number];
export type RecordDropReason = "record_invalid" | "record_count" | "record_length" | "record_policy" | "record_identity";
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
  const drop = (reason: RecordDropReason) => { result.drops[reason] = (result.drops[reason] ?? 0) + 1; };
  let fence: { character: string; length: number } | undefined, quote = false;
  for (const line of text.split(/\r?\n/)) {
    if (shouldStop?.()) { result.incomplete = true; break; }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }; quote = false; continue;
    }
    if (/^\s*>/.test(line)) { quote = true; continue; }
    if (quote) { if (!line.trim()) quote = false; continue; }
    if (!line.startsWith("amem:")) continue;
    const record = recordLine(line);
    if (typeof record === "string") drop(record);
    else if (result.records.length >= 2) drop("record_count");
    else result.records.push(record);
  }
  return result;
}
