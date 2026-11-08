import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { assertFormatFloor } from "./memory/formats.ts";
import { appendMetrics } from "./memory/metrics.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { createStandalonePolicy, type StandalonePolicyOptions } from "./memory/policy.ts";
import { HookSpoolFull, stageTranscriptCapture } from "./hook-spool.ts";
import { cursorDatabase, HOOK_TRANSCRIPT_BYTES, privateDirectory } from "./hook-transcript.ts";
import type { HookTranscriptProgress } from "./hook-contract.ts";

// #216: jcode writes `<sessions>/<stem>.journal.jsonl`, one `{"meta":{...},"append_messages":[...]}` line per save. Only `meta.title` and
// `meta.compaction.summary_text` are read. Message bodies, reasoning and the snapshot are never parsed: the meta object is sliced out
// before `,"append_messages"` (an unescaped quote cannot occur inside a JSON string, so that marker cannot hide in text).
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const META = '{"meta":', BODIES = ',"append_messages"', TITLE_BYTES = 512;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
interface Cursor { offset: number; dev: string; ino: string; size: number; title: string; at: string; readStart: number; readAt: string; skipping: number }
/** `clock` is a test seam (default `performance.now`): the deadline and the work budget are both read from it. */
export interface JcodeJournalOptions { base: string; deadline: number; workBudgetMs?: number; policy?: StandalonePolicyOptions; clock?: () => number }

/** The meta object of one journal line, parsed without touching the message bodies. */
export function journalMeta(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith(META)) return undefined;
  const end = line.indexOf(BODIES, META.length);
  const text = end >= 0 ? line.slice(META.length, end) : line.endsWith("}") ? line.slice(META.length, -1) : "";
  if (!text) return undefined;
  try { return object(JSON.parse(text)); } catch { return undefined; }
}

/**
 * Stage a `Title` row when the journal's title changed and a `Compact` row for each compaction not yet seen, from at most 256 KiB of new
 * journal bytes inside the caller's deadline. A private per-session cursor (device, inode, offset, last title hash, seen compactions)
 * makes repeated turn_end calls and a checkpoint that replaces the journal (new inode) idempotent. Fails open: any fault is the caller's.
 */
export async function scanJcodeJournal(target: { cwd: string; session: string; journal: string }, options: JcodeJournalOptions): Promise<HookTranscriptProgress | undefined> {
  if (options.policy?.host) return;
  const clock = options.clock ?? (() => performance.now());
  if (clock() >= options.deadline) return { stopReason: "deadline" };
  const cwd = realPath(target.cwd), base = canonicalPath(options.base);
  assertFormatFloor(base, "hook-spool");
  const policy = createStandalonePolicy(configuredPolicyOptions(base, cwd, options.policy));
  const session = hash(`amem-session\0${target.session}`).slice(0, 16);
  if (!lstatSync(target.journal, { throwIfNoEntry: false })) return;
  if (lstatSync(target.journal).isSymbolicLink()) throw new Error("jcode journal unavailable");
  const journal = realPath(target.journal);
  if (!await policy.screen({ transcript_path: journal })) return;
  const fd = openSync(journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db: Database | undefined;
  try {
    const stat = fstatSync(fd), named = lstatSync(target.journal);
    if (!stat.isFile() || stat.nlink !== 1 || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) return;
    const dir = join(base, "hook-transcripts"); privateDirectory(dir);
    db = cursorDatabase(join(dir, `jcode-${session}.db`), String(stat.dev), String(stat.ino), stat.size); db.run("BEGIN IMMEDIATE");
    const cursor = db.query("SELECT * FROM cursor WHERE id=1").get() as Cursor;
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.size) || cursor.size < 0 || !timestamp(cursor.readAt)
      || ![0, 1].includes(cursor.skipping) || !/^(?:[a-f0-9]{64})?$/.test(cursor.title)) throw new Error("jcode journal cursor unavailable");
    // A new inode, or a file shorter than what was read, is a checkpoint replacement: start over; seen title/compactions suppress repeats.
    if (cursor.dev !== String(stat.dev) || cursor.ino !== String(stat.ino) || stat.size < cursor.size || stat.size < cursor.offset) { cursor.offset = 0; cursor.skipping = 0; }
    // #216 review (codex P2): read a bounded window FORWARD from the cursor. Jumping to the tail would discard earlier compactions that a
    // later summary superseded, so a backlog is worked off over successive turns (256 KiB each) and no complete record is dropped.
    const from = cursor.offset, partial = cursor.skipping === 1;
    let oversized = 0;
    const bytes = Buffer.alloc(Math.min(HOOK_TRANSCRIPT_BYTES, Math.max(0, stat.size - from)));
    const length = readSync(fd, bytes, 0, bytes.length, from);
    const after = fstatSync(fd), live = lstatSync(target.journal);
    if (length !== bytes.length || after.size < stat.size || live.dev !== stat.dev || live.ino !== stat.ino || realPath(target.journal) !== journal) return;
    const workStart = clock();
    const due = () => clock() >= options.deadline || options.workBudgetMs !== undefined && clock() - workStart >= options.workBudgetMs;
    let unpublished = false, start = 0, skipping = partial, stopReason: HookTranscriptProgress["stopReason"], newestLine: string | undefined;
    const compactions: { covers: unknown; text: string; at: string | undefined; subagent: boolean; dir: unknown }[] = [];
    // #216 review (codex P2): a row belongs to the project of its own line. A journal of a session that moved between projects carries other
    // `meta.working_dir` values; those rows are not staged under this hook's cwd. A missing working_dir keeps the hook's cwd (unchanged).
    const owned = new Map<string, boolean>();
    const ownsDir = (dir: unknown): boolean => {
      if (dir === undefined || dir === null) return true;
      if (typeof dir !== "string" || !dir) return false;
      let known = owned.get(dir);
      if (known === undefined) { try { known = realPath(dir) === cwd; } catch { known = false; } owned.set(dir, known); }
      return known;
    };
    const seen = (digest: string) => !!db!.query("SELECT 1 FROM fallback WHERE digest=?").get(digest);
    while (start < length && !due()) {
      const newline = bytes.indexOf(10, start);
      if (skipping) { start = newline < 0 ? length : newline + 1; if (newline >= 0) skipping = false; continue; }
      if (newline < 0) {
        // A line with no end inside a full window is bounded-skipped and counted; a short unfinished tail waits for the next turn.
        if (start === 0 && length >= HOOK_TRANSCRIPT_BYTES) { skipping = true; start = length; oversized++; }
        break;
      }
      let line: string;
      try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, newline)); } catch { start = newline + 1; continue; }
      start = newline + 1;
      if (!line.startsWith(META)) continue;
      const metaEnd = line.indexOf(BODIES, META.length), head = metaEnd >= 0 ? line.slice(0, metaEnd) : line;
      if (head.includes('"compaction":{')) {
        const meta = journalMeta(line), compaction = object(meta?.compaction);
        if (meta && compaction && typeof compaction.summary_text === "string" && compaction.summary_text.trim()) {
          compactions.push({ covers: compaction.covers_up_to_turn, text: compaction.summary_text, at: timestamp(meta.updated_at), subagent: typeof meta.parent_id === "string", dir: meta.working_dir });
        }
      }
      newestLine = line;   // every line repeats the current meta: only the newest one decides the title
    }
    if (!stopReason && start < length && due()) stopReason = "deadline";
    // The newest line's meta carries the current title.
    const newest = newestLine === undefined ? undefined : journalMeta(newestLine);
    const stage = async (event: "Title" | "Compact", text: string, at: string | undefined, subagent: boolean, identity: string) => {
      const publish = () => stageTranscriptCapture({ agent: "jcode", event, excerpt: text, at: at ?? cursor.readAt, session, ...(subagent ? { subagent: true } : {}) },
        { cwd, base, policy: options.policy, deferAtCapacity: true }, identity);
      await publish();
    };
    try {
      for (const compaction of compactions) {
        // #216 review (codex P1): the work budget covers publication too. Stop before the next publish; the cursor does not pass the
        // unpublished lines (see the offset below) and the seen digests make the next call publish only the rest, exactly once.
        if (!ownsDir(compaction.dir)) continue;
        const digest = hash(JSON.stringify(["jcode-compact", compaction.covers ?? null, compaction.text]));
        if (seen(digest)) continue;   // already published: costs a lookup, never budget, so a long journal cannot starve its own tail
        if (due()) { stopReason = "deadline"; unpublished = true; break; }
        await stage("Compact", compaction.text, compaction.at, compaction.subagent, `compact:${digest}`);
        // A refused row (secret, deny, policy) is final; a full spool throws before this point and is retried next turn.
        db.query("INSERT OR IGNORE INTO fallback VALUES (?,?)").run(digest, cursor.readAt);
      }
      const title = typeof newest?.title === "string" ? newest.title.trim() : "";
      // The newest line decides the title only once the scan has reached the end of the file; mid-backlog it would stage stale titles.
      const atEnd = from + start >= stat.size && !skipping;
      const titleDue = atEnd && !!title && ownsDir(newest?.working_dir) && Buffer.byteLength(title) <= TITLE_BYTES * 4 && hash(title) !== cursor.title;
      if (unpublished) { /* the title waits for the next call with the compactions */ }
      else if (titleDue && due()) { stopReason = "deadline"; unpublished = true; }   // keep the cursor behind the title line too
      else if (titleDue) {
        await stage("Title", title, timestamp(newest?.updated_at), typeof newest?.parent_id === "string", `title:${hash(title)}`);
        cursor.title = hash(title);
      }
    } catch (error) {
      if (!(error instanceof HookSpoolFull)) throw error;
      stopReason = "spool_full"; start = 0;   // nothing is acknowledged; the same window is read again next turn
    }
    if (oversized) appendMetrics(base, [{ at: new Date().toISOString(), kind: "hook", captureDrops: oversized, captureDropReason: "transcript_line_bound" }]);
    assertFormatFloor(base, "hook-spool");
    const offset = stopReason === "spool_full" || unpublished ? cursor.offset : from + start;
    db.query("UPDATE cursor SET offset=?,dev=?,ino=?,size=?,title=?,at=?,skipping=? WHERE id=1")
      .run(offset, String(stat.dev), String(stat.ino), stat.size, cursor.title, cursor.at, skipping ? 1 : 0);
    db.run("COMMIT");
    return { offset, ...(stopReason ? { stopReason } : {}) };
  } finally {
    if (db) try { db.run("ROLLBACK"); } catch { /* committed */ }
    db?.close();
    closeSync(fd);
  }
}
