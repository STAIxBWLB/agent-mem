import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export interface LongMemEvalTurn { role: string; content: string; has_answer?: boolean }
export interface LongMemEvalQuestion {
  question_id: string; question_type: string; question: string; question_date: string;
  haystack_session_ids: string[]; haystack_dates: string[]; haystack_sessions: LongMemEvalTurn[][];
  answer_session_ids: string[];
}
const QUERY_BYTES = 64 * 1024, METADATA_BYTES = 4096, MAX_SESSIONS = 65536;
const DEFAULT_CHUNK = 1024 * 1024, DEFAULT_QUESTION = 128 * 1024 * 1024, BLOCK_BYTES = 64 * 1024;
class InputError extends Error {}
const fail = (reason: string): never => { throw new InputError(`LongMemEval input: ${reason}`); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function string(value: unknown, field: string, max = METADATA_BYTES): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) return fail(`invalid ${field}`);
  return value;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) return fail(`invalid ${field}`);
  return Array.from(value, item => string(item, field));
}

/** UTC only: explicit calendar checks reject normalization such as February 30 or 24:00. */
export function parseBenchmarkDate(text: string): number {
  if (typeof text !== "string" || text.length > 128) return fail("invalid date");
  const official = /^(\d{4})\/(\d{2})\/(\d{2}) \((Sun|Mon|Tue|Wed|Thu|Fri|Sat)\) (\d{2}):(\d{2})$/.exec(text);
  const iso = official ? null : /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(text);
  if (!official && !iso) return fail("invalid date");
  const match = official ?? iso!, year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(official ? match[5] : match[4] ?? 0), minute = Number(official ? match[6] : match[5] ?? 0);
  const second = Number(official ? 0 : match[6] ?? 0), millis = official ? 0 : Number((match[7] ?? "").padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return fail("invalid date");
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fail("invalid date");
  if (official && ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] !== official[4]) return fail("invalid date");
  let offset = 0;
  if (iso?.[8] && iso[8] !== "Z") {
    const zone = iso[8], hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return fail("invalid date");
    offset = (zone[0] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000;
  }
  return date.getTime() - offset;
}

/** Return only benchmark inputs. In particular, answer and unknown fields cannot enter retrieval. */
export function validateQuestion(raw: unknown): LongMemEvalQuestion {
  if (!object(raw)) return fail("question must be an object");
  const question_id = string(raw.question_id, "question_id"), question_type = string(raw.question_type, "question_type");
  const question = string(raw.question, "question", QUERY_BYTES), question_date = string(raw.question_date, "question_date", 128);
  try { parseBenchmarkDate(question_date); } catch { return fail("invalid question_date"); }
  const haystack_session_ids = strings(raw.haystack_session_ids, "haystack_session_ids"), haystack_dates = strings(raw.haystack_dates, "haystack_dates");
  if (!Array.isArray(raw.haystack_sessions) || haystack_session_ids.length !== haystack_dates.length || haystack_dates.length !== raw.haystack_sessions.length) return fail("haystack array alignment mismatch");
  const ids = new Set(haystack_session_ids);
  for (const date of haystack_dates) try { parseBenchmarkDate(date); } catch { return fail("invalid haystack_dates"); }
  const answer_session_ids = strings(raw.answer_session_ids, "answer_session_ids");
  if (!question_id.endsWith("_abs")) {
    if (!answer_session_ids.length) return fail("missing gold answer session IDs");
    if (answer_session_ids.some(id => !ids.has(id))) return fail("gold answer session ID missing from haystack");
  }
  const haystack_sessions: LongMemEvalTurn[][] = Array.from(raw.haystack_sessions, session => {
    if (!Array.isArray(session)) return fail("invalid haystack session");
    return Array.from(session, turn => {
      if (!object(turn) || typeof turn.content !== "string") return fail("invalid haystack turn");
      const role = string(turn.role, "turn role", 64);
      if (Object.hasOwn(turn, "has_answer") && typeof turn.has_answer !== "boolean") return fail("invalid has_answer");
      return { role, content: turn.content, ...(typeof turn.has_answer === "boolean" ? { has_answer: turn.has_answer } : {}) };
    });
  });
  return { question_id, question_type, question, question_date, haystack_session_ids, haystack_dates, haystack_sessions, answer_session_ids };
}

/** Coalesce tiny source chunks: chunkBytes=1 must not create one retained Buffer object per byte. */
class QuestionBytes {
  private blocks: Buffer[] = [];
  private block: Buffer | undefined;
  private used = 0;
  private bytes = 0;
  constructor(private readonly max: number) {}
  append(chunk: Buffer, question: number): void {
    if (this.bytes + chunk.length > this.max) return fail(`question ${question} exceeds maxQuestionBytes`);
    this.bytes += chunk.length; let from = 0;
    while (from < chunk.length) {
      if (!this.block) this.block = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, this.max));
      const count = Math.min(this.block.length - this.used, chunk.length - from);
      chunk.copy(this.block, this.used, from, from + count); this.used += count; from += count;
      if (this.used === this.block.length) { this.blocks.push(this.block); this.block = undefined; this.used = 0; }
    }
  }
  take(question: number): LongMemEvalQuestion {
    if (this.block) this.blocks.push(this.block.subarray(0, this.used));
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(this.blocks, this.bytes))); }
    catch { return fail(`question ${question} has invalid JSON or UTF-8`); }
    finally { this.blocks = []; this.block = undefined; this.used = 0; this.bytes = 0; }
    try { return validateQuestion(raw); }
    catch (error) {
      if (error instanceof InputError) return fail(`question ${question}: ${error.message.slice("LongMemEval input: ".length)}`);
      return fail(`question ${question} has invalid schema`);
    }
  }
}

export interface LongMemEvalReadOptions { chunkBytes?: number; maxQuestionBytes?: number }
/** One object is parsed at a time; only the yielded question and current bounded read chunk survive yield. */
export async function* readLongMemEvalQuestions(file: string, options: LongMemEvalReadOptions = {}): AsyncGenerator<LongMemEvalQuestion> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK, maxQuestionBytes = options.maxQuestionBytes ?? DEFAULT_QUESTION;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || !Number.isSafeInteger(maxQuestionBytes) || maxQuestionBytes < 1) return fail("invalid reader bounds");
  const collected = new QuestionBytes(maxQuestionBytes);
  let mode: "start" | "first" | "next" | "object" | "separator" | "done" = "start", quote = false, escaped = false, question = 0;
  const stack: number[] = [];
  const completed = () => mode === "done";
  let stream: ReturnType<typeof createReadStream>;
  try { stream = createReadStream(file, { highWaterMark: chunkBytes }); } catch { return fail("benchmark file read failed"); }
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer; let start = mode === "object" ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (mode !== "object") {
          if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue;
          if (mode === "start" && byte === 91) { mode = "first"; continue; }
          if ((mode === "first" || mode === "separator") && byte === 93) { mode = "done"; continue; }
          if (mode === "separator" && byte === 44) { mode = "next"; continue; }
          if ((mode === "first" || mode === "next") && byte === 123) {
            mode = "object"; quote = false; escaped = false; stack.push(byte); start = i; question++; continue;
          }
          return fail(`invalid array structure near question ${question + 1}`);
        }
        if (quote) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) quote = false;
        } else if (byte === 34) quote = true;
        else if (byte === 123 || byte === 91) stack.push(byte);
        else if (byte === 125 || byte === 93) {
          if (stack.pop() !== (byte === 125 ? 123 : 91)) return fail(`invalid object structure in question ${question}`);
          if (!stack.length) {
            collected.append(chunk.subarray(start, i + 1), question);
            const value = collected.take(question); mode = "separator"; start = -1;
            yield value;
          }
        }
      }
      if (mode === "object") collected.append(chunk.subarray(start), question);
    }
    if (!completed()) return fail(`incomplete array near question ${question + 1}`);
  } catch (error) {
    if (error instanceof InputError) throw error;
    return fail("benchmark file read failed");
  } finally { stream.destroy(); }
}

export async function hashLongMemEvalFile(file: string): Promise<{ sha256: string; bytes: number }> {
  let stream: ReturnType<typeof createReadStream>;
  try { stream = createReadStream(file); } catch { return fail("benchmark file hash failed"); }
  const hash = createHash("sha256"); let bytes = 0;
  try {
    for await (const chunk of stream) { hash.update(chunk); bytes += (chunk as Buffer).length; }
    return { sha256: hash.digest("hex"), bytes };
  } catch { return fail("benchmark file hash failed"); }
  finally { stream.destroy(); }
}
