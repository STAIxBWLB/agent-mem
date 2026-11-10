import { captureSessionKey } from "./memory/capture-input.ts";
import { parseRecordLines, RECORD_INPUT_BYTES, type ParsedRecordTurn, type RecordDropReason } from "./hook-record.ts";
import { stripPrivateSpans } from "./memory/private-spans.ts";
import { assertFormatFloor } from "./memory/formats.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { configuredPolicyOptions, recordsEnabled } from "./memory/config.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { HookSpoolFull, stageTranscriptCapture, type PendingHookCapture } from "./hook-spool.ts";
import { appendMetrics } from "./memory/metrics.ts";
import type { HookTranscriptProgress } from "./hook-contract.ts";

export const HOOK_TRANSCRIPT_BYTES = RECORD_INPUT_BYTES;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type SummaryEvent = "Title" | "Recap" | "Compact";
interface Cursor { offset: number; dev: string; ino: string; size: number; title: string; at: string; readStart: number; readAt: string; skipping: number }
/** `deadline` is the hard end of the scan. With `workBudgetMs`, the line loop gets that budget measured from the end of setup
 * (policy, cursor database, read), never past `deadline` (#226 task 110: on a slow runner setup ate a fixed window). */
interface Options { cwd: string; base: string; deadline: number; workBudgetMs?: number; policy?: StandalonePolicyOptions;
  /** Worker-local replay opportunities; no text crosses these callbacks. */
  onPublication?: (pending: PendingHookCapture) => Promise<void>;
  onBackpressure?: () => Promise<boolean>;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Claude's three free texts only; ordinary transcript lines never enter JSON.parse. */
export function transcriptSummary(line: string): { event: SummaryEvent; text: string; at?: string; subagent?: true } | undefined {
  if (!line.includes('"ai-title"') && !line.includes('"away_summary"') && !line.includes('"isCompactSummary"')) return undefined;
  const row = object(JSON.parse(line)); if (!row) return undefined;
  let event: SummaryEvent, text: unknown;
  if (row.type === "ai-title") { event = "Title"; text = row.aiTitle; }
  else if (row.type === "system" && row.subtype === "away_summary") { event = "Recap"; text = row.content; }
  else if (row.type === "user" && row.isCompactSummary === true) {
    event = "Compact"; text = object(row.message)?.content;
    if (Array.isArray(text)) text = text.flatMap(part => { const value = object(part); return value?.type === "text" && typeof value.text === "string" ? [value.text] : []; }).join("\n");
  } else return undefined;
  if (typeof text !== "string" || !text.trim()) return undefined;
  const visibleText = event === "Recap" ? text.replace(/\s*\(disable recaps in \/config\)\s*$/, "") : text;
  return { event, text: visibleText, ...(timestamp(row.timestamp) ? { at: timestamp(row.timestamp)! } : {}), ...(row.isSidechain === true || typeof row.agentId === "string" && row.agentId.length > 0 ? { subagent: true as const } : {}) };
}

/** Only Claude main-session assistant text is a record source. Check the marker before parsing JSON. */
export function transcriptRecords(line: string, shouldStop?: () => boolean): { messageId?: string; at?: string; parsed: ParsedRecordTurn } | undefined {
  if (!line.includes("amem:")) return;
  const row = object(JSON.parse(line));
  if (!row || row.type !== "assistant" || row.isSidechain === true || typeof row.agentId === "string" && row.agentId.length > 0) return;
  const message = object(row.message);
  if (!message || message.role !== undefined && message.role !== "assistant") return;
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap(part => { const value = object(part); return value?.type === "text" && typeof value.text === "string" ? [value.text] : []; }).join("\n") : undefined;
  if (text === undefined || !stripPrivateSpans(text).includes("amem:")) return;
  const messageId = typeof message.id === "string" && message.id.length > 0 && message.id.length <= 256 && message.id.trim() === message.id
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(message.id) ? message.id : undefined;
  if (!messageId) return { parsed: { records: [], drops: { record_identity: 1 } } };
  const at = timestamp(row.timestamp);
  if (!at) return { parsed: { records: [], drops: { record_timestamp: 1 } } };
  return { messageId, at, parsed: parseRecordLines(text, shouldStop) };
}

/** Read only a top-level timestamp token, without parsing ordinary message bodies. */
function transcriptTimestamp(line: string): string | undefined {
  if (!line.includes('"timestamp"')) return;
  let depth = 0, at: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      const start = index++;
      for (; index < line.length; index++) {
        if (line[index] === "\\") index++;
        else if (line[index] === '"') break;
      }
      if (depth === 1 && line.slice(start, index + 1) === '"timestamp"') {
        const value = /^\s*:\s*"([^"\\]+)"/.exec(line.slice(index + 1));
        if (value) at = timestamp(value[1]);
      }
    } else if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
  }
  return at;
}

export function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("transcript cursor unavailable");
  chmodSync(dir, 0o700);
}
export function cursorDatabase(file: string, dev: string, ino: string, size: number): Database {
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd), named = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) throw new Error("transcript cursor unavailable");
    chmodSync(file, 0o600);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = lstatSync(file + suffix, { throwIfNoEntry: false });
      if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || sidecar.size > 1024 * 1024)) throw new Error("transcript cursor unavailable");
      if (sidecar) chmodSync(file + suffix, 0o600);
    }
  } finally { closeSync(fd); }
  const db = new Database(file);
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.transaction(() => {
      db.run("CREATE TABLE IF NOT EXISTS fallback (digest TEXT PRIMARY KEY, at TEXT NOT NULL)");
      db.run("CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL, size INTEGER NOT NULL, title TEXT NOT NULL, at TEXT NOT NULL, readStart INTEGER NOT NULL, readAt TEXT NOT NULL, skipping INTEGER NOT NULL CHECK(skipping IN (0,1)))");
      // One durable initialization commit; persist fallback time and known identity before publication.
      db.query("INSERT OR IGNORE INTO cursor VALUES (1,0,?,?,?,'','',0,?,0)").run(dev, ino, size, new Date().toISOString());
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Private per-session transaction serializes screens and cursor advancement. No path or raw id is persisted. */
export async function scanHookTranscriptTail(input: unknown, options: Options): Promise<HookTranscriptProgress | undefined> {
  const value = object(input);
  if (!value || options.policy?.host || typeof value.transcript_path !== "string" || typeof value.session_id !== "string" || !value.session_id || value.session_id.length > 256) return;
  if (performance.now() >= options.deadline) return { stopReason: "deadline" };
  const cwd = realPath(options.cwd), base = canonicalPath(options.base);
  assertFormatFloor(base, "hook-spool");
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || realPath(value.cwd) !== cwd)) return;
  const policy = createStandalonePolicy(configuredPolicyOptions(base, cwd, options.policy));
  if (!await policy.screen(value)) return;
  const captureRecords = recordsEnabled(base, cwd)
    && !(typeof value.agent_id === "string" && value.agent_id.length > 0);
  const session = captureSessionKey(value.session_id)!;
  if (lstatSync(value.transcript_path).isSymbolicLink()) throw new Error("transcript unavailable");
  const transcript = realPath(value.transcript_path);
  // Parent aliases must not hide a configured deny path behind an allowed spelling.
  if (!await policy.screen({ transcript_path: transcript })) return;
  const fd = openSync(transcript, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db: Database | undefined;
  try {
    const stat = fstatSync(fd), named = lstatSync(value.transcript_path);
    if (!stat.isFile() || stat.nlink !== 1 || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) return;
    const dir = join(base, "hook-transcripts"); privateDirectory(dir);
    db = cursorDatabase(join(dir, `${session}.db`), String(stat.dev), String(stat.ino), stat.size); db.run("BEGIN IMMEDIATE");
    let cursor = db.query("SELECT * FROM cursor WHERE id=1").get() as Cursor;
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.size) || cursor.size < 0 || cursor.at !== "" && !timestamp(cursor.at)
      || !Number.isSafeInteger(cursor.readStart) || cursor.readStart < 0 || !timestamp(cursor.readAt) || ![0, 1].includes(cursor.skipping) || !/^(?:[a-f0-9]{64})?$/.test(cursor.title)) throw new Error("transcript cursor unavailable");
    const reset = cursor.dev !== String(stat.dev) || cursor.ino !== String(stat.ino) || stat.size < cursor.size || stat.size < cursor.offset;
    if (reset || cursor.offset !== cursor.readStart || cursor.size === 0 && stat.size > 0) {
      // Commit reset metadata before staging too: titles without a native timestamp
      // retain their fallback time if the process dies between publication and cursor advance.
      if (reset) { cursor.offset = 0; cursor.at = ""; cursor.skipping = 0; }
      db.query("UPDATE cursor SET offset=?,dev=?,ino=?,size=?,at=?,readStart=?,readAt=?,skipping=? WHERE id=1")
        .run(cursor.offset, String(stat.dev), String(stat.ino), stat.size, cursor.at, cursor.offset, new Date().toISOString(), cursor.skipping);
      db.run("COMMIT"); db.run("BEGIN IMMEDIATE");
      cursor = db.query("SELECT * FROM cursor WHERE id=1").get() as Cursor;
    }
    const bytes = Buffer.alloc(Math.min(HOOK_TRANSCRIPT_BYTES, Math.max(0, stat.size - cursor.offset)));
    const length = readSync(fd, bytes, 0, bytes.length, cursor.offset);
    const after = fstatSync(fd), live = lstatSync(value.transcript_path);
    if (length !== bytes.length || after.size < stat.size || live.dev !== stat.dev || live.ino !== stat.ino || realPath(value.transcript_path) !== transcript) return;
    let start = 0, stopReason: HookTranscriptProgress["stopReason"];
    const recordMetrics = { recordValidRecords: 0, recordBasisRecords: 0, recordUnverifiedRecords: 0 };
    // ponytail: the two-record cap is per native message.id within this scan only; no durable count.
    // A crash after staging but before cursor save has the summaries' duplicate window.
    // Upgrade to a msgid+ordinal receipt if the AC6 live week demonstrates duplicates.
    const recordCounts = new Map<string, number>(), recordDrops: Partial<Record<RecordDropReason, number>> = {};
    const dropRecord = (reason: RecordDropReason, count = 1) => { recordDrops[reason] = (recordDrops[reason] ?? 0) + count; };
    const workStart = performance.now();
    // The caller's deadline is read live (a caller may move it); the work budget only adds an earlier end after setup.
    const due = () => performance.now() >= options.deadline || options.workBudgetMs !== undefined && performance.now() - workStart >= options.workBudgetMs;
    while (start < length && !due()) {
      const newline = bytes.indexOf(10, start);
      if (cursor.skipping) {
        start = newline < 0 ? length : newline + 1;
        if (newline >= 0) cursor.skipping = 0;
        continue;
      }
      if (newline < 0) {
        // ponytail: a JSONL line exceeding the invocation's 256 KiB ceiling is
        // lost, not buffered in memory/home. Upgrade with a bounded streaming extractor.
        if (start === 0 && length === HOOK_TRANSCRIPT_BYTES && stat.size - cursor.offset > length) {
          cursor.skipping = 1; start = length;
          appendMetrics(base, [{ at: new Date().toISOString(), kind: "hook", captureDrops: 1, captureDropReason: "transcript_line_bound" }]);
        }
        break;
      }
      let line: string;
      try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, newline)); }
      catch { start = newline + 1; continue; }
      let records: ReturnType<typeof transcriptRecords>;
      if (captureRecords) try { records = transcriptRecords(line, due); } catch { /* Malformed native JSON is not a record source. */ }
      // Privacy flags and policy metadata belong to the source row, not just its extracted text.
      if (records && !await policy.screen(JSON.parse(line))) { dropRecord("record_policy", Math.max(1, records.parsed.records.length)); records = undefined; }
      let recordPublication: PendingHookCapture | undefined;
      if (records) {
        for (const [reason, count] of Object.entries(records.parsed.drops)) dropRecord(reason as RecordDropReason, count!);
        if (records.parsed.incomplete) { stopReason = "deadline"; break; }
        if (records.messageId && records.at) {
          const admitted = records.parsed.records.slice(0, Math.max(0, 2 - (recordCounts.get(records.messageId) ?? 0)));
          recordMetrics.recordValidRecords += admitted.length;
          recordMetrics.recordBasisRecords += admitted.filter(record => record.text.includes("basis:")).length;
          recordMetrics.recordUnverifiedRecords += admitted.filter(record => record.text.startsWith("?")).length;
        }
        if (records.messageId && records.at) for (const record of records.parsed.records) {
          const count = recordCounts.get(records.messageId) ?? 0;
          if (count >= 2) { dropRecord("record_count"); continue; }
          recordCounts.set(records.messageId, count + 1);
          if (due()) { stopReason = "deadline"; break; }
          const publish = () => stageTranscriptCapture({ agent: "claude", event: "Record", excerpt: record.line, paths: record.anchors,
            at: records!.at, session }, { cwd, base, policy: options.policy, deferAtCapacity: true }, undefined, dropRecord);
          try {
            let staged: PendingHookCapture | undefined;
            try { staged = await publish(); }
            catch (error) {
              if (!(error instanceof HookSpoolFull) || due() || !options.onBackpressure || !await options.onBackpressure() || due()) throw error;
              staged = await publish();
            }
            if (staged) recordPublication = staged;
          } catch (error) {
            if (error instanceof HookSpoolFull) { stopReason = "spool_full"; break; }
            throw error;
          }
        }
        if (stopReason) break;
      }
      let summary: ReturnType<typeof transcriptSummary>;
      try { summary = transcriptSummary(line); } catch { /* Malformed native JSON is not capture. */ }
      if (summary && !await policy.screen(JSON.parse(line))) summary = undefined;
      if (summary) {
        const title = summary.event === "Title" ? hash(summary.text) : "";
        if (!title || title !== cursor.title) {
          try {
            let at = summary.at ?? cursor.at;
            if (!at) {
              // Native timestamps normally identify summaries. Untimed content retains its
              // first fallback across rotation, so an unchanged row cannot get a new receipt.
              const digest = hash(JSON.stringify([summary.event, summary.text, summary.subagent ?? false]));
              db.query("INSERT OR IGNORE INTO fallback VALUES (?,?)").run(digest, cursor.readAt);
              at = (db.query("SELECT at FROM fallback WHERE digest=?").get(digest) as { at: string }).at;
              if (!timestamp(at)) throw new Error("transcript cursor unavailable");
            }
            const publish = () => stageTranscriptCapture({ agent: "claude", event: summary!.event, excerpt: summary!.text, at, session,
              ...(summary!.subagent || typeof value.agent_id === "string" && value.agent_id.length > 0 ? { subagent: true } : {}) }, { cwd, base, policy: options.policy, deferAtCapacity: true }, summary!.event === "Title" ? `title:${cursor.offset + start}` : undefined);
            let staged: PendingHookCapture | undefined;
            try { staged = await publish(); }
            catch (error) {
              if (!(error instanceof HookSpoolFull) || due() || !options.onBackpressure || !await options.onBackpressure() || due()) throw error;
              staged = await publish(); // Same line/receipt, no second read or cursor advance on backpressure.
            }
            if (staged && title) cursor.title = title;
            if (staged) await options.onPublication?.(staged);
          } catch (error) {
            // Advance only through durable/refused rows; a full spool retries this line
            // after the ordinary hook worker drains earlier publications.
            if (error instanceof HookSpoolFull) { stopReason = "spool_full"; break; }
            throw error;
          }
        }
      }
      // Carry timestamps without parsing ordinary messages (including across invocation boundaries).
      const at = transcriptTimestamp(line); if (at) cursor.at = at;
      start = newline + 1;
      // Stage the whole row before optional replay. A slow replay must not restart
      // its first Record forever; the remaining durable publications replay later.
      if (recordPublication && !due()) await options.onPublication?.(recordPublication);
    }
    if (!stopReason && start < length && due()) stopReason = "deadline";
    if (!stopReason && cursor.offset + start < stat.size && length === HOOK_TRANSCRIPT_BYTES) stopReason = "cap";
    if (Object.keys(recordDrops).length) appendMetrics(base, Object.entries(recordDrops).map(([reason, count]) => ({
      at: new Date().toISOString(), kind: "hook", captureDrops: count!, captureDropReason: reason as RecordDropReason,
    })));
    assertFormatFloor(base, "hook-spool");
    db.query("UPDATE cursor SET offset=?,dev=?,ino=?,size=?,title=?,at=?,skipping=? WHERE id=1").run(cursor.offset + start, String(stat.dev), String(stat.ino), stat.size, cursor.title, cursor.at, cursor.skipping);
    db.run("COMMIT");
    return { offset: cursor.offset + start, ...recordMetrics, ...(stopReason ? { stopReason } : {}) };
  } finally {
    try { if (db) { try { db.run("ROLLBACK"); } catch { /* Already committed. */ } db.close(); } } finally { closeSync(fd); }
  }
}
