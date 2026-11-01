import { assertFormatFloor } from "./memory/formats.ts";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { HookSpoolFull, stageTranscriptCapture } from "./hook-spool.ts";
import { appendMetrics } from "./memory/metrics.ts";
import type { HookTranscriptProgress } from "./hook-contract.ts";

export const HOOK_TRANSCRIPT_BYTES = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type SummaryEvent = "Title" | "Recap" | "Compact";
interface Cursor { offset: number; dev: string; ino: string; size: number; title: string; at: string; readStart: number; readAt: string; skipping: number }
interface Options { cwd: string; base: string; deadline: number; policy?: StandalonePolicyOptions }
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

function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("transcript cursor unavailable");
  chmodSync(dir, 0o700);
}
function cursorDatabase(file: string, dev: string, ino: string, size: number): Database {
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
  const session = hash(`amem-session\0${value.session_id}`).slice(0, 16);
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
    while (start < length && performance.now() < options.deadline) {
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
            const staged = await stageTranscriptCapture({ agent: "claude", event: summary.event, excerpt: summary.text, at, session,
              ...(summary.subagent || typeof value.agent_id === "string" && value.agent_id.length > 0 ? { subagent: true } : {}) }, { cwd, base, policy: options.policy, deferAtCapacity: true }, summary.event === "Title" ? `title:${cursor.offset + start}` : undefined);
            if (staged && title) cursor.title = title;
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
    }
    if (!stopReason && start < length && performance.now() >= options.deadline) stopReason = "deadline";
    if (!stopReason && cursor.offset + start < stat.size && length === HOOK_TRANSCRIPT_BYTES) stopReason = "cap";
    assertFormatFloor(base, "hook-spool");
    db.query("UPDATE cursor SET offset=?,dev=?,ino=?,size=?,title=?,at=?,skipping=? WHERE id=1").run(cursor.offset + start, String(stat.dev), String(stat.ino), stat.size, cursor.title, cursor.at, cursor.skipping);
    db.run("COMMIT");
    return { offset: cursor.offset + start, ...(stopReason ? { stopReason } : {}) };
  } finally {
    try { if (db) { try { db.run("ROLLBACK"); } catch { /* Already committed. */ } db.close(); } } finally { closeSync(fd); }
  }
}
