import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksSecret } from "./screen.ts";
import { isDenied } from "./platform.ts";
import { captureHome } from "./home.ts";
import { fts5Available, ftsTerms } from "./search-fts.ts";

/**
 * #13 design A, tier 2: machine-local capture. Deterministic extraction only (R4: no model call, no network): an
 * event, a tool, paths, an exit status and a bounded, secret-screened excerpt per row. The tier lives in its own
 * `capture.db` under `<memory home>/capture/`, never in a shared v1 segment (AC8): the sync .gitignore admits only
 * `log/*.jsonl`, and no code path here touches the curated logs, so curated notes, goals and work lists are never
 * evicted or rewritten by capture maintenance (AC5). Capture rows are recall candidates, never curated evidence.
 *
 * R6 bounds: a soft size cap (default 512 MB per machine) and a retention window (default 90 days), both read from
 * `config.json` at every invocation and overridable through the library options a host such as agent-hub passes in.
 * Eviction removes the oldest capture rows first, in bounded batches per invocation, so shrinking the cap finishes
 * over later invocations instead of breaking the hook budget (R2).
 * ponytail: the cap counts row payload bytes, not the sqlite file's page slack or WAL; a VACUUM blocks writers and
 * stays out of the hook path, so file size can exceed the cap until pages are reused.
 *
 * R2 contention: a writer that cannot take the database lock within `busyTimeoutMs` appends the row to the
 * append-only `spool.jsonl` and exits instead of blocking the agent. The next uncontended writer (or an explicit
 * `drain()`) replays the spool; replay is idempotent per spooled line, so a crash between insert and truncation
 * never doubles a row.
 */

export const CAPTURE_DEFAULT_CAP_MB = 512;
export const CAPTURE_DEFAULT_RETENTION_DAYS = 90;
/** Well under the 150 ms R2 wall budget even with process startup: contention spools instead of waiting. */
export const CAPTURE_BUSY_TIMEOUT_MS = 25;
export const CAPTURE_MAX_EXCERPT = 2000;
export const CAPTURE_MAX_PATHS = 32;
/** Eviction and drain work per invocation, so a shrunk cap or a long outage is worked off over many hooks. */
export const CAPTURE_EVICT_BATCH_ROWS = 256;
export const CAPTURE_EVICT_MAX_BATCHES = 4;
export const CAPTURE_DRAIN_MAX_LINES = 1000;
const ROW_OVERHEAD_BYTES = 96;
const SPOOL = "spool.jsonl";
const DRAINING = "spool.jsonl.draining";

export interface CaptureInput {
  project: string; agent: string; event: string;
  tool?: string; paths?: string[]; status?: string; excerpt?: string;
  /** Tests and the spool replay pin the time; hooks leave it to the store clock. */
  at?: string;
}
export interface CaptureRow {
  id: number; at: string; project: string; agent: string; event: string;
  tool: string | null; paths: string[]; status: string | null; excerpt: string;
}
export interface CaptureConfig { capMb: number; retentionDays: number }
export interface CaptureOptions {
  home?: string; now?: () => number;
  /** Host-supplied R6 values win over the machine-local config file. */
  capMb?: number; retentionDays?: number;
  busyTimeoutMs?: number;
  /** Excerpt screen; defaults to the built-in secret screen. A host passes its stricter policy. */
  screen?: (text: string) => boolean;
}
export type CaptureAppend = { id: number } | { spooled: true };

/** The machine-local R6 settings, read at every invocation so a change applies at the next hook or search. */
export function readCaptureConfig(dir: string): CaptureConfig {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>; } catch { /* absent or unreadable: defaults */ }
  const capMb = Number(parsed.cap_mb), retentionDays = Number(parsed.retention_days);
  return {
    capMb: Number.isFinite(capMb) && capMb > 0 ? capMb : CAPTURE_DEFAULT_CAP_MB,
    retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : CAPTURE_DEFAULT_RETENTION_DAYS,
  };
}

/** The person (or, through the library, an authorized host flow) adjusts the R6 bounds; agents never write this. */
export function writeCaptureConfig(dir: string, config: Partial<CaptureConfig>): CaptureConfig {
  const next = readCaptureConfig(dir);
  if (config.capMb !== undefined) {
    if (!Number.isFinite(config.capMb) || config.capMb <= 0) throw new Error("capture.cap_mb must be a positive number");
    next.capMb = config.capMb;
  }
  if (config.retentionDays !== undefined) {
    if (!Number.isFinite(config.retentionDays) || config.retentionDays <= 0) throw new Error("capture.retention_days must be a positive number");
    next.retentionDays = config.retentionDays;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ cap_mb: next.capMb, retention_days: next.retentionDays }) + "\n", { mode: 0o600 });
  return next;
}

const lockError = (error: unknown): boolean => /lock|busy/i.test((error as Error)?.message ?? "");

interface RawRow { id: number; at: string; project: string; agent: string; event: string; tool: string | null; paths: string; status: string | null; excerpt: string; bytes: number }
const toRow = (r: RawRow): CaptureRow => ({ id: r.id, at: r.at, project: r.project, agent: r.agent, event: r.event, tool: r.tool, paths: JSON.parse(r.paths) as string[], status: r.status, excerpt: r.excerpt });

export class CaptureStore {
  readonly dir: string;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly screen: (text: string) => boolean;
  private readonly capMb: number;
  private readonly retentionDays: number;
  /** Set when the schema setup itself met the lock: appends spool without touching the database again. */
  private contended = false;

  constructor(opts: CaptureOptions = {}) {
    this.dir = captureHome(opts.home);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700); // mkdir's mode applies only when it creates the directory
    const config = readCaptureConfig(this.dir); // each invocation: a config change applies at the next hook
    this.capMb = opts.capMb ?? config.capMb;
    this.retentionDays = opts.retentionDays ?? config.retentionDays;
    this.now = opts.now ?? Date.now;
    this.screen = opts.screen ?? looksSecret;
    const file = join(this.dir, "capture.db");
    const db = new Database(file, { create: true });
    this.db = db;
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    try {
      db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? CAPTURE_BUSY_TIMEOUT_MS}`);
      db.run("PRAGMA journal_mode = WAL");
      db.run(`CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL, event TEXT NOT NULL,
        tool TEXT, paths TEXT NOT NULL, status TEXT, excerpt TEXT NOT NULL, bytes INTEGER NOT NULL, spool_id TEXT)`);
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS rows_spool ON rows (spool_id) WHERE spool_id IS NOT NULL");
      db.run("CREATE INDEX IF NOT EXISTS rows_at ON rows (at)");
      db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.ensureFts();
    } catch (error) {
      if (!lockError(error)) throw error;
      this.contended = true; // R2: the hook spools and exits instead of waiting out another writer
    }
  }

  /** External-content FTS5 over the excerpts, kept in sync by triggers, so capture search needs no catch-up pass. */
  private ensureFts(): void {
    if (!fts5Available()) return; // the R5 fallback: capture rows are stored, search skips this tier
    const had = !!this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'fts' AND type = 'table'").get();
    this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(body, content='rows', content_rowid='id')");
    this.db.run("CREATE TRIGGER IF NOT EXISTS rows_ai AFTER INSERT ON rows BEGIN INSERT INTO fts (rowid, body) VALUES (new.id, new.excerpt); END");
    this.db.run("CREATE TRIGGER IF NOT EXISTS rows_ad AFTER DELETE ON rows BEGIN INSERT INTO fts (fts, rowid, body) VALUES ('delete', old.id, old.excerpt); END");
    this.db.run("CREATE TRIGGER IF NOT EXISTS rows_au AFTER UPDATE ON rows BEGIN INSERT INTO fts (fts, rowid, body) VALUES ('delete', old.id, old.excerpt); INSERT INTO fts (rowid, body) VALUES (new.id, new.excerpt); END");
    // Rows written before FTS existed (or before a platform gained it) are indexed once; triggers keep it level.
    if (!had && (this.db.query("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n > 0) this.db.run("INSERT INTO fts (fts) VALUES ('rebuild')");
  }

  private bytes(): number {
    return Number((this.db.query("SELECT value FROM meta WHERE key = 'bytes'").get() as { value: string } | null)?.value ?? "0");
  }
  private addBytes(delta: number): void {
    this.db.query("INSERT INTO meta (key, value) VALUES ('bytes', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?").run(String(Math.max(0, delta)), delta);
  }

  /**
   * One capture row. On lock contention the row goes to the spool and the caller exits fast (R2); the row is not
   * lost, and the next uncontended writer replays it with its original timestamp.
   */
  append(input: CaptureInput): CaptureAppend {
    const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    if (!str(input.project, 400) || !str(input.agent, 64) || !str(input.event, 64)) throw new Error("capture rows need a project, an agent and an event");
    const at = input.at ?? new Date(this.now()).toISOString();
    const tool = str(input.tool, 64) ? input.tool! : null;
    const status = str(input.status, 64) ? input.status! : null;
    const paths = (input.paths ?? []).map(String).filter((p) => p && !isDenied(p)).slice(0, CAPTURE_MAX_PATHS).map((p) => p.slice(0, 400));
    const pathsJson = JSON.stringify(paths);
    let excerpt = (input.excerpt ?? "").slice(0, CAPTURE_MAX_EXCERPT);
    if (excerpt && this.screen(excerpt)) excerpt = "[secret-screened]";
    const bytes = Buffer.byteLength(excerpt) + Buffer.byteLength(pathsJson) + ROW_OVERHEAD_BYTES;
    if (this.contended) {
      appendFileSync(join(this.dir, SPOOL), JSON.stringify({ ...input, at }) + "\n", { mode: 0o600 });
      return { spooled: true };
    }
    try {
      this.drain(); // replay earlier spooled rows first, so row ids stay in hook order
      const id = Number(this.db.query("INSERT INTO rows (at, project, agent, event, tool, paths, status, excerpt, bytes, spool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
        .run(at, input.project, input.agent, input.event, tool, pathsJson, status, excerpt, bytes).lastInsertRowid);
      this.addBytes(bytes);
      this.evict();
      return { id };
    } catch (error) {
      if (!lockError(error)) throw error;
      appendFileSync(join(this.dir, SPOOL), JSON.stringify({ ...input, at }) + "\n", { mode: 0o600 });
      return { spooled: true };
    }
  }

  /**
   * Replay the spool. The current file is renamed aside first, so rows spooled while draining are not lost, and a
   * leftover draining file from a crash is finished first. Idempotent per spooled line. Bounded per invocation.
   */
  drain(): { drained: number } {
    let budget = CAPTURE_DRAIN_MAX_LINES, drained = 0;
    if (this.contended) return { drained };
    for (const renameFirst of [false, true]) {
      const file = join(this.dir, DRAINING);
      if (renameFirst && existsSync(join(this.dir, SPOOL))) {
        if (budget <= 0) break;
        try { renameSync(join(this.dir, SPOOL), file); } catch { continue; }
      }
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (!lines.length) { rmSync(file, { force: true }); continue; }
      const batch = lines.slice(0, Math.max(0, budget));
      try {
        this.db.transaction(() => {
          for (const line of batch) {
            let input: CaptureInput;
            try { input = JSON.parse(line) as CaptureInput; } catch { continue; }
            if (typeof input.at !== "string") continue;
            const added = this.appendRow(input, createHash("sha256").update(line).digest("hex"));
            if (added) drained++;
          }
        }).immediate();
      } catch (error) {
        if (!lockError(error)) throw error;
        break; // still contended: the spool stays for the next invocation
      }
      budget -= batch.length;
      if (batch.length === lines.length) rmSync(file, { force: true });
      else { writeFileSync(file, lines.slice(batch.length).join("\n") + "\n", { mode: 0o600 }); break; }
    }
    return { drained };
  }

  /** The row insert shared by append and drain; with a spool id the insert is idempotent. */
  private appendRow(input: CaptureInput, spoolId: string): boolean {
    const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    if (!str(input.project, 400) || !str(input.agent, 64) || !str(input.event, 64)) return false;
    // bun:sqlite's run().changes is not reliable for an ignored insert inside a transaction (FTS triggers confuse
    // it), so the replay check is a plain indexed lookup, never the statement's change count.
    if (this.db.query("SELECT 1 FROM rows WHERE spool_id = ?").get(spoolId)) return false;
    const tool = str(input.tool, 64) ? input.tool! : null;
    const status = str(input.status, 64) ? input.status! : null;
    const paths = (input.paths ?? []).map(String).filter((p) => p && !isDenied(p)).slice(0, CAPTURE_MAX_PATHS).map((p) => p.slice(0, 400));
    const pathsJson = JSON.stringify(paths);
    let excerpt = (input.excerpt ?? "").slice(0, CAPTURE_MAX_EXCERPT);
    if (excerpt && this.screen(excerpt)) excerpt = "[secret-screened]";
    const bytes = Buffer.byteLength(excerpt) + Buffer.byteLength(pathsJson) + ROW_OVERHEAD_BYTES;
    try {
      this.db.query("INSERT INTO rows (at, project, agent, event, tool, paths, status, excerpt, bytes, spool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.at!, input.project, input.agent, input.event, tool, pathsJson, status, excerpt, bytes, spoolId);
    } catch (error) {
      if (String((error as Error)?.message ?? "").includes("UNIQUE")) return false; // a racing drain won this line
      throw error;
    }
    this.addBytes(bytes);
    return true;
  }

  /**
   * R6 eviction: expired rows first, then the oldest rows while over the cap, in bounded batches per invocation.
   * Only capture rows are ever deleted; the curated store is a different file this class never opens (AC5).
   */
  evict(): { expired: number; trimmed: number } {
    if (this.contended) return { expired: 0, trimmed: 0 };
    const expired = this.evictWhere("at < ?", [new Date(this.now() - this.retentionDays * 24 * 3600_000).toISOString()]);
    const capBytes = this.capMb * 1024 * 1024;
    let trimmed = 0;
    for (let batch = 0; batch < CAPTURE_EVICT_MAX_BATCHES && this.bytes() > capBytes; batch++) trimmed += this.evictWhere("1 = 1", []);
    return { expired, trimmed };
  }

  private evictWhere(where: string, bind: string[]): number {
    let removed = 0;
    for (let batch = 0; batch < CAPTURE_EVICT_MAX_BATCHES; batch++) {
      const old = this.db.query(`SELECT id FROM rows WHERE ${where} ORDER BY at, id LIMIT ?`).all(...bind, CAPTURE_EVICT_BATCH_ROWS) as { id: number }[];
      if (!old.length) break;
      this.db.transaction(() => { for (const { id } of old) this.db.query("DELETE FROM rows WHERE id = ?").run(id); }).immediate();
      removed += old.length;
      this.recountBytes();
      if (old.length < CAPTURE_EVICT_BATCH_ROWS) break;
    }
    return removed;
  }

  private recountBytes(): void {
    this.db.query("INSERT INTO meta (key, value) VALUES ('bytes', (SELECT COALESCE(SUM(bytes), 0) FROM rows)) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  }

  rows(f: { project?: string; sinceId?: number; limit?: number } = {}): CaptureRow[] {
    const where: string[] = [], bind: (string | number)[] = [];
    if (f.project) { where.push("project = ?"); bind.push(f.project); }
    if (f.sinceId !== undefined) { where.push("id > ?"); bind.push(f.sinceId); }
    const rows = this.db.query(`SELECT * FROM rows${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`).all(...bind, f.limit ?? 1000) as RawRow[];
    return rows.map(toRow);
  }

  stats(): { rows: number; bytes: number; capMb: number; retentionDays: number; fileBytes: number } {
    let fileBytes = 0;
    try { fileBytes = statSync(join(this.dir, "capture.db")).size; } catch { /* not created yet */ }
    return { rows: (this.db.query("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n, bytes: this.bytes(), capMb: this.capMb, retentionDays: this.retentionDays, fileBytes };
  }

  close(): void { this.db.close(); }
}

/** The capture leg of #13 search: BM25 over the excerpts of this machine's capture tier. Empty when FTS5 is absent. */
export function captureSearch(dir: string, q: string, limit: number): { row: CaptureRow; rank: number }[] {
  const match = ftsTerms(q);
  if (!match || !fts5Available() || !existsSync(join(dir, "capture.db"))) return [];
  let db: Database | undefined;
  try {
    db = new Database(join(dir, "capture.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 3000");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'fts' AND type = 'table'").get()) return [];
    const rows = db.query(`SELECT r.*, bm25(fts) AS rank FROM fts JOIN rows r ON r.id = fts.rowid WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as (RawRow & { rank: number })[];
    return rows.map((r) => ({ row: toRow(r), rank: r.rank }));
  } catch { return []; } // a contended or corrupted capture tier degrades recall, never the search itself
  finally { db?.close(); }
}
