import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksSecret } from "./screen.ts";
import { isDenied } from "./platform.ts";
import { memoryBase } from "./home.ts";
import { captureShardDir, ensureShardDescriptor, resolveAlias } from "./shard.ts";
import { machineId } from "./store.ts";
import { fts5Available } from "./search-fts.ts";

/**
 * #13 design A, tier 2, born sharded (#15 T1): machine-local capture, one shard per project key. A shard lives at
 * `projects/<key-hash>/machine/<machine-id>/` under the memory home (D1's shard root, the scope table's machine
 * level), has its own locks, so sessions in two projects never contend, and is never synced and never read as
 * curated evidence. Deterministic extraction only (R4: no model call, no network): an event, a tool, paths, an
 * exit status and a bounded, secret-screened excerpt per row. No code path here touches the curated logs, so
 * curated notes, goals and work lists are never evicted or rewritten by capture maintenance (AC5).
 *
 * R6 bounds: a soft size cap and a retention window (defaults 512 MB per machine, 90 days), resolved at every
 * invocation from `CaptureOptions`, then the shard's `config.json`, then the home default `capture-config.json`
 * the capacity advisor (R7) writes. Eviction removes the oldest capture rows first, in bounded batches per
 * invocation, so shrinking a cap finishes over later invocations instead of breaking the hook budget (R2).
 * ponytail: the cap counts row payload bytes, not the sqlite file's page slack or WAL; a VACUUM blocks writers and
 * stays out of the hook path, so file size can exceed the cap until pages are reused.
 *
 * R2 contention: a writer that cannot take its shard's lock within `busyTimeoutMs` appends the row to the
 * append-only `spool.jsonl` and exits instead of blocking the agent. The next uncontended writer (or an explicit
 * `drain()`) replays the spool; replay is idempotent per spooled line, so a crash between insert and truncation
 * never doubles a row.
 *
 * Migration: the pre-T1 machine-wide `capture/` (this branch never shipped) is drained per project on open —
 * each project key's rows move into its shard with their original timestamps, and the legacy store is removed
 * once empty.
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
/** Wall-time bound for one invocation's eviction: with the batch bound, an append stays inside R2 after a cap shrink. */
export const CAPTURE_EVICT_MAX_MS = 25;
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
  home?: string;
  /** The project key this shard belongs to; aliases resolve to the canonical key (#15 D2). */
  project: string;
  /** Defaults to this machine's `machine.json` identity, shared with the curated store. */
  machine?: string;
  now?: () => number;
  /** Host-supplied R6 values win over the shard and home config files. */
  capMb?: number; retentionDays?: number;
  busyTimeoutMs?: number;
  /** Excerpt screen; defaults to the built-in secret screen. A host passes its stricter policy. */
  screen?: (text: string) => boolean;
}
export type CaptureAppend = { id: number } | { spooled: true };

/** One row after validation, deny-filtering, bounding and screening: what both the insert and the spool carry. */
interface NormalizedCapture {
  at: string; project: string; agent: string; event: string;
  tool: string | null; paths: string[]; status: string | null; excerpt: string; bytes: number;
  /** Entropy per spooled line, so two byte-identical hook events are two rows; a replayed line still dedupes. */
  nonce?: string;
}

const configValues = (parsed: Record<string, unknown>): Partial<CaptureConfig> => {
  const capMb = Number(parsed.cap_mb), retentionDays = Number(parsed.retention_days);
  return {
    ...(Number.isFinite(capMb) && capMb > 0 ? { capMb } : {}),
    ...(Number.isFinite(retentionDays) && retentionDays > 0 ? { retentionDays } : {}),
  };
};

/** The R6 settings one config file holds; absent or invalid keys are simply not set. */
export function readCaptureConfigFile(path: string): Partial<CaptureConfig> {
  try { return configValues(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>); } catch { return {}; }
}

/** Merge `config` into one config file; only given keys change. The person (or R7's apply) writes these, never an agent. */
export function writeCaptureConfigFile(path: string, config: Partial<CaptureConfig>): Partial<CaptureConfig> {
  const next = { ...readCaptureConfigFile(path) };
  if (config.capMb !== undefined) {
    if (!Number.isFinite(config.capMb) || config.capMb <= 0) throw new Error("capture.cap_mb must be a positive number");
    next.capMb = config.capMb;
  }
  if (config.retentionDays !== undefined) {
    if (!Number.isFinite(config.retentionDays) || config.retentionDays <= 0) throw new Error("capture.retention_days must be a positive number");
    next.retentionDays = config.retentionDays;
  }
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ cap_mb: next.capMb ?? CAPTURE_DEFAULT_CAP_MB, retention_days: next.retentionDays ?? CAPTURE_DEFAULT_RETENTION_DAYS }) + "\n", { mode: 0o600 });
  return next;
}

/** The effective R6 settings for a shard directory: shard config over the home default over the built-in defaults. */
export function readCaptureConfig(dir: string, base?: string): CaptureConfig {
  const homeDefault = base === undefined ? {} : readCaptureConfigFile(join(base, "capture-config.json"));
  const shard = readCaptureConfigFile(join(dir, "config.json"));
  return {
    capMb: shard.capMb ?? homeDefault.capMb ?? CAPTURE_DEFAULT_CAP_MB,
    retentionDays: shard.retentionDays ?? homeDefault.retentionDays ?? CAPTURE_DEFAULT_RETENTION_DAYS,
  };
}

/** Adjust a shard's own R6 bounds (an override of the home default); merged over that shard's current file. */
export function writeCaptureConfig(dir: string, config: Partial<CaptureConfig>): CaptureConfig {
  const next = writeCaptureConfigFile(join(dir, "config.json"), config);
  return { capMb: next.capMb ?? CAPTURE_DEFAULT_CAP_MB, retentionDays: next.retentionDays ?? CAPTURE_DEFAULT_RETENTION_DAYS };
}

const lockError = (error: unknown): boolean => /lock|busy/i.test((error as Error)?.message ?? "");

interface RawRow { id: number; at: string; project: string; agent: string; event: string; tool: string | null; paths: string; status: string | null; excerpt: string; bytes: number }
const toRow = (r: RawRow): CaptureRow => ({ id: r.id, at: r.at, project: r.project, agent: r.agent, event: r.event, tool: r.tool, paths: JSON.parse(r.paths) as string[], status: r.status, excerpt: r.excerpt });

export class CaptureStore {
  readonly dir: string;
  /** The canonical project key of this shard (aliases resolved). */
  readonly key: string;
  /** Rows the pre-T1 machine-wide capture store handed this shard on open. */
  readonly migrated: number;
  private readonly base: string;
  private readonly requestedKey: string;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly screen: (text: string) => boolean;
  private readonly capMb: number;
  private readonly retentionDays: number;
  /** Set when the schema setup itself met the lock: appends spool without touching the database again. */
  private contended = false;

  constructor(opts: CaptureOptions) {
    if (typeof opts.project !== "string" || !opts.project.trim()) throw new Error("capture shards need a project key");
    this.base = memoryBase(opts.home);
    const machine = opts.machine ?? machineId(this.base).id;
    this.requestedKey = opts.project;
    this.key = resolveAlias(this.base, opts.project);
    ensureShardDescriptor(this.base, this.key);
    this.dir = captureShardDir(this.base, opts.project, machine);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700); // mkdir's mode applies only when it creates the directory
    const config = readCaptureConfig(this.dir, this.base); // each invocation: a config change applies at the next hook
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
    this.migrated = this.contended ? 0 : this.migrateLegacy();
  }

  /** The pre-T1 machine-wide store hands this project key's rows AND spool lines to the shard, once; an emptied legacy store goes away. */
  private migrateLegacy(): number {
    const legacyDir = join(this.base, "capture"); // the pre-T1 machine-wide location (this branch never shipped)
    const file = join(legacyDir, "capture.db");
    if (!existsSync(file)) return 0;
    const homeDefault = join(this.base, "capture-config.json");
    if (existsSync(join(legacyDir, "config.json")) && !existsSync(homeDefault)) renameSync(join(legacyDir, "config.json"), homeDefault);
    let legacy: Database | undefined;
    let moved = 0;
    try {
      legacy = new Database(file);
      legacy.run(`PRAGMA busy_timeout = ${CAPTURE_BUSY_TIMEOUT_MS}`); // never stall a hook on another project's migration
      const rows = legacy.query("SELECT * FROM rows WHERE project = ? OR project = ? ORDER BY id").all(this.key, this.requestedKey) as RawRow[];
      // `legacy:<id>` spool ids make the move idempotent: a crash between the two writes replays nothing.
      this.db.transaction(() => {
        for (const r of rows) {
          const row: NormalizedCapture = { at: r.at, project: this.key, agent: r.agent, event: r.event, tool: r.tool, status: r.status,
            paths: JSON.parse(r.paths) as string[], excerpt: r.excerpt, bytes: r.bytes };
          if (this.insertRow(row, `legacy:${r.id}`) !== undefined) moved++;
        }
      }).immediate();
      legacy.transaction(() => { for (const r of rows) legacy!.query("DELETE FROM rows WHERE id = ?").run(r.id); }).immediate();
      // Legacy spool lines for this key move to the shard spool (they drain on the next append); other keys' lines stay.
      let spoolLeft = 0;
      for (const name of ["spool.jsonl", "spool.jsonl.draining"]) {
        const legacySpool = join(legacyDir, name);
        if (!existsSync(legacySpool)) continue;
        const lines = readFileSync(legacySpool, "utf8").split("\n").filter(Boolean);
        const keep: string[] = [];
        for (const line of lines) {
          let project = "";
          try { project = String((JSON.parse(line) as { project?: unknown }).project ?? ""); } catch { /* unparseable: keep */ }
          if (project === this.key || project === this.requestedKey) this.spoolRaw(line);
          else keep.push(line);
        }
        if (keep.length) { writeFileSync(legacySpool, keep.join("\n") + "\n", { mode: 0o600 }); spoolLeft += keep.length; }
        else rmSync(legacySpool, { force: true });
      }
      if ((legacy.query("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n === 0 && spoolLeft === 0) {
        legacy.close();
        legacy = undefined;
        for (const name of ["capture.db", "capture.db-wal", "capture.db-shm"]) rmSync(join(legacyDir, name), { force: true });
        try { rmSync(legacyDir, { recursive: true }); } catch { /* a leftover file keeps the directory */ }
      }
    } catch { return moved; } // locked or unreadable: the next open of this project retries
    finally { legacy?.close(); }
    return moved;
  }

  /** A line moved from the legacy spool, byte for byte: the shard's drain normalizes whatever format it holds. */
  private spoolRaw(line: string): void {
    appendFileSync(join(this.dir, SPOOL), line + "\n", { mode: 0o600 });
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
   * One capture row. Validation, deny-filtering, bounding and screening happen once, BEFORE anything is written:
   * the spool holds only the screened row (never raw input, so no secret or PII excerpt ever reaches spool.jsonl),
   * and a later drainer — under any screen — inserts exactly that row. On lock contention the row goes to the spool
   * and the caller exits fast (R2); the next uncontended writer replays it with its original timestamp.
   */
  append(input: CaptureInput): CaptureAppend {
    const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    if (!str(input.project, 400) || !str(input.agent, 64) || !str(input.event, 64)) throw new Error("capture rows need a project, an agent and an event");
    const row = this.normalize(input);
    if (this.contended) {
      this.spool(row);
      return { spooled: true };
    }
    try {
      this.drain(); // replay earlier spooled rows first, so row ids stay in hook order
      const id = this.insertRow(row, null);
      this.evict();
      return { id: id! };
    } catch (error) {
      if (!lockError(error)) throw error;
      this.spool(row);
      return { spooled: true };
    }
  }

  /** The one place input becomes a row: caps fields, deny-filters paths, screens the excerpt, counts its bytes. */
  private normalize(input: CaptureInput): NormalizedCapture {
    const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    const at = input.at ?? new Date(this.now()).toISOString();
    const tool = str(input.tool, 64) ? input.tool! : null;
    const status = str(input.status, 64) ? input.status! : null;
    const paths = (input.paths ?? []).map(String).filter((p) => p && !isDenied(p)).slice(0, CAPTURE_MAX_PATHS).map((p) => p.slice(0, 400));
    let excerpt = (input.excerpt ?? "").slice(0, CAPTURE_MAX_EXCERPT);
    if (excerpt && this.screen(excerpt)) excerpt = "[secret-screened]";
    return { at, project: input.project, agent: input.agent, event: input.event, tool, paths, status, excerpt,
      bytes: Buffer.byteLength(excerpt) + Buffer.byteLength(JSON.stringify(paths)) + ROW_OVERHEAD_BYTES };
  }

  private spool(row: NormalizedCapture): void {
    appendFileSync(join(this.dir, SPOOL), JSON.stringify({ ...row, nonce: randomBytes(4).toString("hex") }) + "\n", { mode: 0o600 });
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
        // link+remove, not rename: a draining file another process owns is never clobbered.
        try { linkSync(join(this.dir, SPOOL), file); rmSync(join(this.dir, SPOOL)); } catch { continue; }
      }
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (!lines.length) { rmSync(file, { force: true }); continue; }
      const batch = lines.slice(0, Math.max(0, budget));
      try {
        this.db.transaction(() => {
          for (const line of batch) {
            let raw: Partial<NormalizedCapture> & { bytes?: number };
            try { raw = JSON.parse(line) as typeof raw; } catch { continue; }
            // Spool lines written since the screened-spool rule are already bounded and screened; older lines
            // (this branch's pre-release format) pass through normalize once.
            const row = typeof raw.bytes === "number" && typeof raw.excerpt === "string" ? raw as NormalizedCapture : this.normalize(raw as CaptureInput);
            if (!row || typeof row.at !== "string") continue;
            const added = this.insertRow(row, createHash("sha256").update(line).digest("hex")) !== undefined;
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

  /** The row insert shared by append, drain and the legacy migration; with a spool id the insert is idempotent. */
  private insertRow(row: NormalizedCapture, spoolId: string | null): number | undefined {
    // bun:sqlite's run().changes is not reliable for an ignored insert inside a transaction (FTS triggers confuse
    // it), so the replay check is a plain indexed lookup, never the statement's change count.
    if (spoolId !== null && this.db.query("SELECT 1 FROM rows WHERE spool_id = ?").get(spoolId)) return undefined;
    try {
      const id = Number(this.db.query("INSERT INTO rows (at, project, agent, event, tool, paths, status, excerpt, bytes, spool_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.at, row.project, row.agent, row.event, row.tool, JSON.stringify(row.paths), row.status, row.excerpt, row.bytes, spoolId).lastInsertRowid);
      this.addBytes(row.bytes);
      return id;
    } catch (error) {
      if (String((error as Error)?.message ?? "").includes("UNIQUE")) return undefined; // a racing drain won this line
      throw error;
    }
  }

  /**
   * R6 eviction: expired rows first, then the oldest rows while over the cap, bounded per invocation by batches AND
   * by wall time, so even a big cap shrink finishes over later appends and one hook stays inside R2. The running
   * size in `meta.bytes` is adjusted by the removed rows' own bytes; no SUM rescan. Only capture rows are ever
   * deleted; the curated store is a different file this class never opens (AC5).
   */
  evict(): { expired: number; trimmed: number } {
    if (this.contended) return { expired: 0, trimmed: 0 };
    const start = performance.now();
    const expired = this.evictWhere("at < ?", [new Date(this.now() - this.retentionDays * 24 * 3600_000).toISOString()], start);
    const capBytes = this.capMb * 1024 * 1024;
    let trimmed = 0;
    while (this.bytes() > capBytes && performance.now() - start < CAPTURE_EVICT_MAX_MS) {
      const removed = this.evictWhere("1 = 1", [], start);
      if (!removed.rows) break;
      trimmed += removed.rows;
    }
    return { expired: expired.rows, trimmed };
  }

  private evictWhere(where: string, bind: string[], start: number): { rows: number; bytes: number } {
    let rows = 0, bytes = 0;
    for (let batch = 0; batch < CAPTURE_EVICT_MAX_BATCHES && performance.now() - start < CAPTURE_EVICT_MAX_MS; batch++) {
      const old = this.db.query(`SELECT id, bytes FROM rows WHERE ${where} ORDER BY at, id LIMIT ?`).all(...bind, CAPTURE_EVICT_BATCH_ROWS) as { id: number; bytes: number }[];
      if (!old.length) break;
      this.db.transaction(() => { for (const { id } of old) this.db.query("DELETE FROM rows WHERE id = ?").run(id); }).immediate();
      rows += old.length;
      bytes += old.reduce((sum, r) => sum + r.bytes, 0);
      if (old.length < CAPTURE_EVICT_BATCH_ROWS) break;
    }
    if (bytes) this.addBytes(-bytes);
    return { rows, bytes };
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

/** One shard's capture totals for the catalog and the capacity advisor, without opening a writer. */
export function captureShardStats(dir: string): { rows: number; bytes: number; lastAt: string | null } {
  if (!existsSync(join(dir, "capture.db"))) return { rows: 0, bytes: 0, lastAt: null };
  let db: Database | undefined;
  try {
    db = new Database(join(dir, "capture.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 3000");
    const row = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b, MAX(at) AS last FROM rows").get() as { n: number; b: number; last: string | null };
    return { rows: row.n, bytes: row.b, lastAt: row.last };
  } catch { return { rows: 0, bytes: 0, lastAt: null }; }
  finally { db?.close(); }
}

/** One shard's capture added since an ISO time: the growth input of the R7 capacity advisor. */
export function captureShardGrowth(dir: string, since: string): { rows: number; bytes: number } {
  if (!existsSync(join(dir, "capture.db"))) return { rows: 0, bytes: 0 };
  let db: Database | undefined;
  try {
    db = new Database(join(dir, "capture.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 3000");
    const row = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM rows WHERE at >= ?").get(since) as { n: number; b: number };
    return { rows: row.n, bytes: row.b };
  } catch { return { rows: 0, bytes: 0 }; }
  finally { db?.close(); }
}
