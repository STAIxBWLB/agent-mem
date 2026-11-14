import { createHash } from "node:crypto";
import { looksSecret } from "./screen.ts";
import { isDenied } from "./platform.ts";
import { stripPrivateSpans } from "./private-spans.ts";

export const CAPTURE_MAX_EXCERPT = 2000;
export const CAPTURE_MAX_PATHS = 32;
/** Claude transcript-only events use the existing format-3 transport, never native hook argv. */
export const TRANSCRIPT_CAPTURE_EVENTS: readonly string[] = ["Title", "Recap", "Compact", "Record"];
/** A whole-Record policy refusal, distinct from transient storage failures. No receipt or row was written. */
export class RecordNormalizationRefusal extends Error {
  constructor() {
    super("Record capture would be changed by current caps or screening; check amem.config.json or CaptureStore options, then stage a complete Record that fits the current policy");
    this.name = "RecordNormalizationRefusal";
  }
}
export const TOOL_INPUT_LINE_BYTES = 512;
const TOOL_INPUT_ORDER = ["command", "pattern", "query", "url", "description", "prompt", "skill", "subject"] as const;
const TOOL_INPUT_OMIT = new Set(["content", "old_string", "new_string", "edits"]);
const ROW_OVERHEAD_BYTES = 96;
/** The session key is a fixed-width hash prefix, so it adds a bounded amount covered by the row overhead. */
export const SESSION_KEY = /^[a-f0-9]{16}$/;

/** Existing capture attribution hash; never persist the raw native session id. */
export function captureSessionKey(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256
    ? createHash("sha256").update(`amem-session\0${raw}`).digest("hex").slice(0, 16) : undefined;
}

export interface CaptureFields {
  agent: string; event: string;
  tool?: string; paths?: string[]; status?: string; excerpt?: string;
  /** #173: a 16-hex hash of the native session id (never the raw id), and a subagent marker. Both optional. */
  session?: string; subagent?: boolean;
  /** Tests and the spool replay pin the time; hooks leave it to the store clock. */
  at?: string;
}
export interface NormalizedCaptureFields {
  at: string; agent: string; event: string;
  tool: string | null; paths: string[]; status: string | null; excerpt: string; bytes: number;
  session?: string; subagent?: true;
}

/** Clip a string at a UTF-8 boundary without splitting a code point. */
export function clipCaptureUtf8(text: string, maximumBytes: number): string {
  let out = "", bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) break;
    out += character; bytes += size;
  }
  return out;
}

interface CommandWord { end: number; text: string; complete: boolean; dynamic: boolean }
const commandBreak = (c: string): boolean => /[\s;&|()<>]/.test(c);

/** Read one literal shell word without executing expansions; offsets refer to the unchanged input. */
function commandWord(command: string, start: number): CommandWord {
  let i = start, text = "", quote = "", dynamic = false;
  for (; i < command.length; i++) {
    const c = command[i]!;
    if (!quote && commandBreak(c)) break;
    if (c === quote) { quote = ""; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue; }
    if (c === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === undefined) return { end: command.length, text, complete: false, dynamic };
      if (!quote || /["\\$`\n]/.test(next)) { i++; if (next !== "\n") text += next; continue; }
    }
    if (quote !== "'" && (c === "$" || c === "`")) dynamic = true;
    text += c;
  }
  return { end: i, text, complete: !quote, dynamic };
}

/**
 * Withhold ahub answer provenance before any capture cap. Only literal command words are interpreted, never a shell.
 * ponytail: direct commands and shell lists only; computed program names/wrapper scripts need a shell parser contract.
 * Once an answer is recognized, ambiguous quoting, expansions or redirection withhold its entire remaining tail.
 */
export function withholdAnswerCommand(command: string): string {
  let i = 0, copied = 0, out = "", state: "program" | "subcommand" | "answer" | "other" = "program", answerPrefix = "";
  const replace = (start: number, end: number, value: string) => { out += command.slice(copied, start) + value; copied = end; };
  while (i < command.length) {
    const c = command[i]!;
    if (c === "\n" || /[;&|()]/.test(c)) { state = "program"; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#") { const end = command.indexOf("\n", i); i = end < 0 ? command.length : end; continue; }
    if (c === "<" || c === ">") {
      if (state === "answer") return answerPrefix + " [withheld]";
      state = "other"; i++; continue;
    }
    const start = i, word = commandWord(command, i); i = word.end;
    if (state === "answer" && (!word.complete || word.dynamic)) return answerPrefix + " [withheld]";
    if (state === "program") { state = word.complete && !word.dynamic && /^(?:.*\/)?ahub$/.test(word.text) ? "subcommand" : "other"; continue; }
    if (state === "subcommand") {
      state = word.complete && !word.dynamic && word.text === "answer" ? "answer" : "other";
      if (state === "answer") answerPrefix = out + command.slice(copied, i);
      continue;
    }
    if (state !== "answer") continue;
    const flag = /^(--(?:instructed|other))(=|$)/.exec(word.text);
    if (!flag) continue;
    if (flag[2] === "=") { replace(start, i, `${flag[1]}=[withheld]`); continue; }
    while (i < command.length && /[^\S\n]/.test(command[i]!)) i++;
    if (i === command.length || commandBreak(command[i]!) || command[i] === "#") return answerPrefix + " [withheld]";
    const value = commandWord(command, i);
    if (!value.complete || value.dynamic || value.text.startsWith("--")) return answerPrefix + " [withheld]";
    replace(i, value.end, "[withheld]"); i = value.end;
  }
  return out + command.slice(copied);
}

/** Recover only JSON string boundaries in a truncated argument envelope; never execute or trust its structure. */
function malformedToolArguments(text: string): string {
  const direct = withholdAnswerCommand(text);
  if (direct !== text) return direct;
  if (!/^\s*[\[{]/.test(text)) return text;
  // A direct argv prefix already identifies the command even if its later JSON value is cut short.
  if (/\[\s*"(?:[^"\\]*\/)?ahub"\s*,\s*"answer"/.test(text)) return "[withheld]";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    const start = i++;
    let escaped = false;
    for (; i < text.length; i++) {
      if (!escaped && text[i] === '"') break;
      if (!escaped && text[i] === "\\") escaped = true; else escaped = false;
    }
    const closed = i < text.length;
    // A dangling JSON escape cannot be part of a complete command value.
    const raw = text.slice(start, closed ? i + 1 : escaped ? i - 1 : i) + (closed ? "" : '"');
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value === "string" && withholdAnswerCommand(value) !== value) return "[withheld]";
    } catch {
      if (/\bahub\s+answer\b/.test(raw)) return "[withheld]";
    }
  }
  return text;
}

/** Shape serialized transcript tool arguments without reserializing any unaffected input. */
export function withholdToolArguments(argumentsText: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsText); }
  catch { return malformedToolArguments(argumentsText); }
  const holder: Record<string, unknown> = { value: parsed };
  const stack = [{ parent: holder, key: "value" }];
  let changed = false;
  while (stack.length) {
    const { parent, key } = stack.pop()!, value = parent[key];
    if (typeof value === "string") {
      const shaped = withholdAnswerCommand(value);
      if (shaped !== value) { parent[key] = shaped; changed = true; }
    } else if (value && typeof value === "object") {
      if (Array.isArray(value) && typeof value[0] === "string" && /^(?:.*\/)?ahub$/.test(value[0]) && value[1] === "answer") {
        for (let i = 2; i < value.length; i++) {
          const flag = typeof value[i] === "string" ? /^(--(?:instructed|other))(=|$)/.exec(value[i]) : null;
          if (!flag) continue;
          changed = true;
          if (flag[2] === "=") value[i] = `${flag[1]}=[withheld]`;
          else if (typeof value[i + 1] === "string" && value[i + 1].startsWith("--")) { value.splice(2, value.length - 2, "[withheld]"); break; }
          else value[++i] = "[withheld]";
        }
      }
      for (const child of Object.keys(value)) stack.push({ parent: value as Record<string, unknown>, key: child });
    }
  }
  return changed ? JSON.stringify(holder.value) : argumentsText;
}

/** Deterministic, value-only summary of Claude tool_input. Strip private spans before clipping. */
export function toolInputLine(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const fields = Object.entries(input as Record<string, unknown>)
    .filter(([key, value]) => typeof value === "string" && !TOOL_INPUT_OMIT.has(key.toLowerCase()) && value.length > 0);
  const byKey = new Map(fields);
  const known = TOOL_INPUT_ORDER.filter(key => byKey.has(key));
  const other = fields.map(([key]) => key).filter(key => !(TOOL_INPUT_ORDER as readonly string[]).includes(key)).sort();
  const values = [...known, ...other].map(key => clipCaptureUtf8(
    withholdAnswerCommand(stripPrivateSpans(byKey.get(key) as string)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "), TOOL_INPUT_LINE_BYTES,
  )).filter(Boolean);
  return clipCaptureUtf8(values.join(" | "), TOOL_INPUT_LINE_BYTES).trimEnd();
}

/** Remove private content before joining tool input and content into the persisted excerpt. */
export function toolCaptureExcerpt(inputLine: string, content: string): string {
  const visibleContent = stripPrivateSpans(content);
  return inputLine ? visibleContent ? `${inputLine}\n${visibleContent}` : inputLine : visibleContent;
}

/** Pure capture shaping; no store, project lookup or filesystem operation is loaded or invoked here. */
/** The caps a person's configuration may lower (F4); the built-in caps are the ceiling, so a larger value is ignored. */
export interface CaptureCaps { excerptBytes?: number; paths?: number; denyPaths?: readonly string[] }
export function normalizeCaptureFields(input: CaptureFields, now: () => number = Date.now, screen: (text: string) => boolean = looksSecret, caps: CaptureCaps = {}): NormalizedCaptureFields {
  const maxExcerpt = Math.min(CAPTURE_MAX_EXCERPT, caps.excerptBytes ?? CAPTURE_MAX_EXCERPT), maxPaths = Math.min(CAPTURE_MAX_PATHS, caps.paths ?? CAPTURE_MAX_PATHS);
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  // Canonical UTC ISO text, so text order is time order for eviction (`at < cutoff`) and search (`at >= notBefore`).
  const at = new Date(input.at === undefined ? now() : Date.parse(input.at)).toISOString();
  const tool = str(input.tool, 64) ? input.tool! : null;
  const status = str(input.status, 64) ? input.status! : null;
  const paths = (input.paths ?? []).map(String).filter((p) => p && !isDenied(input.event === "Record" ? p.split("#")[0]! : p, caps.denyPaths ? [...caps.denyPaths] : [])).slice(0, maxPaths).map((p) => p.slice(0, 400));
  // `<private>` spans go first: they are never screened, counted or stored. The cap applies to what is left.
  let excerpt = stripPrivateSpans(input.excerpt ?? "").slice(0, maxExcerpt);
  if (excerpt && screen(excerpt)) excerpt = "[secret-screened]";
  const session = typeof input.session === "string" && SESSION_KEY.test(input.session) ? input.session : undefined;
  const subagent = input.subagent === true;
  return { at, agent: input.agent, event: input.event, tool, paths, status, excerpt,
    bytes: Buffer.byteLength(excerpt) + Buffer.byteLength(JSON.stringify(paths)) + ROW_OVERHEAD_BYTES,
    ...(session ? { session } : {}), ...(subagent ? { subagent: true as const } : {}) };
}

/** Shared by every capture reader: the #173 columns are optional, so a shard without them reads unchanged. */
export const captureAttribution = (r: { session?: string | null; subagent?: number | null }): { session?: string; subagent?: true } =>
  ({ ...(typeof r.session === "string" && SESSION_KEY.test(r.session) ? { session: r.session } : {}), ...(r.subagent === 1 ? { subagent: true as const } : {}) });
