import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksSecret } from "./screen.ts";
import { normalizeCaptureFields, type CaptureFields } from "./capture-input.ts";
export { CAPTURE_MAX_EXCERPT, CAPTURE_MAX_PATHS } from "./capture-input.ts";
import { memoryBase } from "./home.ts";
import { captureShardDir, ensureShardDescriptor, readShardDescriptor, resolveAlias, shardKeyHash } from "./shard.ts";
import { assertProjectActive } from "./lifecycle.ts";
import { machineId } from "./machine.ts";
import { loadAmemConfig, repoConfigRoot } from "./config.ts";
import { fold } from "./policy.ts";
import { readWindowSql, readRef, type ReadWindow, type ReadRef, ftsTerms, fts5Available } from "./search-fts.ts";

/**
 * #13 design A, tier 2, born sharded (#15 T1): machine-local capture, one shard per project key. A shard lives at
 * `projects/<key-hash>/machine/<machine-id>/` under the memory home (D1's shard root, the scope table's machine
 * level), has its own locks, so sessions in two projects never contend, and is never synced and never read as
 * curated evidence. Deterministic extraction only (R4: no model call, no network): an event, a tool, paths, an
 * exit status and a bounded, secret-screened excerpt per row. No code path here touches the curated logs, so
 * curated notes, goals and work lists are never evicted or rewritten by capture maintenance (AC5).
 *
 * R6 bounds: a soft size cap and a retention window (defaults 512 MB per shard, 90 days), resolved at every
 * invocation from `CaptureOptions`, then the shard's `config.json`, then the home default `capture-config.json`
 * the capacity advisor (R7) writes. The 2026-10-17 owner decision keeps the P1 cap per shard; the machine-wide
 * total is #15 T5. Eviction removes the oldest capture rows first, in bounded batches per invocation, so shrinking
 * a cap finishes over later invocations instead of breaking the hook budget (R2).
 * ponytail: the cap counts row payload bytes, not the sqlite file's page slack or WAL; a VACUUM blocks writers and
 * stays out of the hook path, so file size can exceed the cap until pages are reused.
 *
 * R2 contention: a writer that cannot take its shard's lock within `busyTimeoutMs` closes a private segment
 * before publishing it atomically in `spool/`. The next uncontended writer (or explicit `drain()`) replays it
 * under a unique claim name. Segments are immutable; a claim's byte offset advances only after the rows commit.
 * Replay is idempotent per spooled line, so a crash between insert and acknowledgement never doubles a row.
 *
 * Migration: the pre-T1 machine-wide `capture/` (this branch never shipped) is drained per project on open —
 * each project key's rows move into its shard with their original timestamps, and the legacy store is removed
 * once empty.
 */

export const CAPTURE_DEFAULT_CAP_MB = 512;
export const CAPTURE_DEFAULT_RETENTION_DAYS = 90;
/** Well under the 150 ms R2 wall budget even with process startup: contention spools instead of waiting. */
export const CAPTURE_BUSY_TIMEOUT_MS = 25;
/** Eviction and drain work per invocation, so a shrunk cap or a long outage is worked off over many hooks. */
export const CAPTURE_EVICT_BATCH_ROWS = 256;
export const CAPTURE_EVICT_MAX_BATCHES = 4;
/** Wall-time bound for one invocation's eviction: with the batch bound, an append stays inside R2 after a cap shrink. */
export const CAPTURE_EVICT_MAX_MS = 25;
export const CAPTURE_DRAIN_MAX_LINES = 1000;
const SPOOL = "spool.jsonl";
const DRAINING = "spool.jsonl.draining";
const SPOOL_DIR = "spool";
const SPOOL_MAX_FILES = 32;
const SPOOL_MAX_BYTES = 256 * 1024;
const SPOOL_MAX_MS = 25;
const segmentName = /^spool-[0-9a-f-]+\.jsonl(?:\.offset-(\d+)(-skip)?)?(?:\.draining-[0-9a-f]+)?$/;
let spoolSequence = 0;
const spoolToken = () => `${Date.now().toString(16).padStart(13, "0")}-${process.pid.toString(16).padStart(8, "0")}-${(spoolSequence++).toString(16).padStart(8, "0")}-${randomBytes(12).toString("hex")}`;

export interface CaptureInput extends CaptureFields { project: string }
export interface CaptureRow {
  id: number; at: string; project: string; agent: string; event: string;
  tool: string | null; paths: string[]; status: string | null; excerpt: string;
}
export interface CaptureConfig { capMb: number; retentionDays: number }
export interface CaptureOptions {
  memoryDir?: string;
  home?: string;
  /** The project key this shard belongs to; aliases resolve to the canonical key (#15 D2). */
  project: string;
  /** Defaults to this machine's `machine.json` identity, shared with the curated store. */
  machine?: string;
  now?: () => number;
  /** Host-supplied R6 values win over the shard and home config files. */
  capMb?: number; retentionDays?: number;
  busyTimeoutMs?: number;
  /** Host-only brief view: open existing capture only, without schema/index/replay writes. */
  readOnly?: boolean;
  /** Host-only row ceiling for the read-only snapshot; overflow is unavailable, never empty. */
  maxReadRows?: number;
  /** Host-only optional brief: retain the newest maxReadRows ids, with explicit partial coverage. */
  recentReadRows?: boolean;
  /** Excerpt screen; defaults to the built-in secret screen. A host passes its stricter policy. */
  screen?: (text: string) => boolean;
  /** Caps a caller may lower (F4); the built-in caps and the person's configured caps are the ceiling, so a larger value is ignored (a host can tighten, never loosen). */
  excerptBytes?: number; capturePaths?: number;
  /** The working directory the capture belongs to: its repository's `.amem/config` narrows the policy (deny paths, caps) for this store. Absent: the machine configuration only. */
  cwd?: string;
  /**
   * #15 T5: a writable open of an archived or forgotten project is refused (the person took it out of recall; `amem project unarchive` brings an archived one back).
   * `ignore` is for the maintenance that must still reach the shard (gc, export): it never appends.
   */
  lifecycle?: "enforce" | "ignore";
}
export interface CaptureAppendOptions {
  /** Opaque stable source receipt for deterministic transcript replay. Requires an explicit source timestamp. */
  receipt?: string;
}
export type CaptureAppend = { id: number; already?: true } | { spooled: true };

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

/**
 * The effective R6 settings for a shard directory: the shard's config over the home default (`capture-config.json`, which the capacity advisor writes)
 * over the person's machine configuration (`amem.config.json` `capture`, F4) over the built-in defaults. A malformed machine configuration throws.
 */
export function readCaptureConfig(dir: string, base?: string): CaptureConfig {
  const homeDefault = base === undefined ? {} : readCaptureConfigFile(join(base, "capture-config.json"));
  const shard = readCaptureConfigFile(join(dir, "config.json"));
  const machine = base === undefined ? {} : loadAmemConfig(base).config.capture;
  return {
    capMb: shard.capMb ?? homeDefault.capMb ?? machine.capMb ?? CAPTURE_DEFAULT_CAP_MB,
    retentionDays: shard.retentionDays ?? homeDefault.retentionDays ?? machine.retentionDays ?? CAPTURE_DEFAULT_RETENTION_DAYS,
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
  private readonly caps: import("./capture-input.ts").CaptureCaps;
  private readonly capMb: number;
  private readonly retentionDays: number;
  /** Set when the schema setup itself met the lock: appends spool without touching the database again. */
  private contended = false;
  private readonly readOnly: boolean;
  private recentReadIds?: number[];
  /** True when the optional recent snapshot excludes older capture rows. */
  readonly recentReadTruncated: boolean = false;

  constructor(opts: CaptureOptions) {
    if (typeof opts.project !== "string" || !opts.project.trim()) throw new Error("capture shards need a project key");
    if (opts.memoryDir !== undefined && opts.home !== undefined) throw new Error("choose a home or an exact memory directory");
    this.readOnly = opts.readOnly === true;
    if (opts.readOnly !== undefined && typeof opts.readOnly !== "boolean") throw new Error("invalid capture read-only option");
    if (opts.recentReadRows !== undefined && (typeof opts.recentReadRows !== "boolean" || !this.readOnly)) throw new Error("recent capture rows require a read-only store");
    const maxReadRows = opts.maxReadRows ?? 128;
    if (this.readOnly && (!Number.isSafeInteger(maxReadRows) || maxReadRows < 1 || maxReadRows >= Number.MAX_SAFE_INTEGER)) throw new Error("invalid capture read row bound");
    this.base = opts.memoryDir ?? memoryBase(opts.home);
    const machine = opts.machine ?? (this.readOnly ? this.existingMachine() : machineId(this.base).id);
    if (this.readOnly && !/^[a-f0-9]{16}$/.test(machine)) throw new Error("capture machine identity unavailable");
    this.requestedKey = opts.project;
    this.key = resolveAlias(this.base, opts.project);
    if (!this.readOnly && opts.lifecycle !== "ignore") assertProjectActive(this.base, this.key);
    if (this.readOnly) {
      const descriptor = lstatSync(join(this.base, "projects", shardKeyHash(this.key), "project.json"));
      if (!descriptor.isFile() || descriptor.isSymbolicLink() || descriptor.size > 4096
        || readShardDescriptor(this.base, shardKeyHash(this.key))?.key !== this.key) throw new Error("capture shard identity unavailable");
    } else ensureShardDescriptor(this.base, this.key);
    this.dir = captureShardDir(this.base, opts.project, machine);
    if (!this.readOnly) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700); // mkdir's mode applies only when it creates the directory
    }
    if (this.readOnly) for (const file of [join(this.dir, "config.json"), join(this.base, "capture-config.json")]) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)) throw new Error("capture configuration unavailable");
    }
    const config = readCaptureConfig(this.dir, this.base); // each invocation: a config change applies at the next hook
    this.capMb = opts.capMb ?? config.capMb;
    this.retentionDays = opts.retentionDays ?? config.retentionDays;
    this.now = opts.now ?? Date.now;
    const configured = loadAmemConfig(this.base, opts.cwd === undefined ? undefined : repoConfigRoot(opts.cwd)).config;
    // F4: the person's PII patterns screen every excerpt and their deny paths filter every path, whoever appends (hook, ingest or library). A host's own `screen` replaces only the secret part.
    const patterns = configured.piiPatterns.map(fold).filter(Boolean);
    const base = opts.screen ?? looksSecret;
    this.screen = patterns.length ? (text: string) => base(text) || patterns.some(pattern => fold(text).includes(pattern)) : base;
    const lowest = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.min(a, b);
    this.caps = { excerptBytes: lowest(opts.excerptBytes, configured.excerptBytes), paths: lowest(opts.capturePaths, configured.capturePaths),
      ...(configured.denyPaths.length ? { denyPaths: configured.denyPaths } : {}) };
    const file = join(this.dir, "capture.db");
    if (this.readOnly) {
      // Refuse absent/cold state without authoring machine, shard, schema, FTS or spool metadata.
      for (const directory of [this.base, join(this.base, "projects"), join(this.base, "projects", shardKeyHash(this.key)),
        join(this.base, "projects", shardKeyHash(this.key), "machine"), this.dir]) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("capture read path unavailable");
      }
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("capture database unavailable");
      const timeout = opts.busyTimeoutMs ?? 0;
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 3000) throw new Error("invalid capture busy timeout");
      const db = this.db = new Database(file, { readonly: true });
      try {
        db.run(`PRAGMA busy_timeout = ${timeout}`); db.run("PRAGMA cache_size = -2048"); db.run("PRAGMA mmap_size = 0");
        db.run("BEGIN");
        if (opts.recentReadRows) {
          // The existing rows_at index supplies the reverse time/id walk; retain ids only.
          // One sentinel records excluded history without counting or loading its bodies.
          const sql = "SELECT id FROM rows INDEXED BY rows_at ORDER BY at DESC, id DESC LIMIT ?";
          const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(maxReadRows + 1) as { detail: string }[];
          if (plan.some(row => row.detail.includes("TEMP B-TREE"))) throw new Error("capture recent index unavailable");
          const recent = db.query(sql).all(maxReadRows + 1) as { id: number }[];
          this.recentReadIds = recent.slice(0, maxReadRows).map(row => row.id);
          this.recentReadTruncated = recent.length > maxReadRows;
        } else {
          const count = (db.query("SELECT COUNT(*) AS n FROM (SELECT 1 FROM rows LIMIT ?)").get(maxReadRows + 1) as { n: number }).n;
          if (count > maxReadRows) throw new Error("capture brief row bound exceeded");
        }
        if (resolveAlias(this.base, this.requestedKey) !== this.key) throw new Error("capture alias binding changed");
      } catch (error) { db.close(); throw error; }
      this.migrated = 0;
      return;
    }
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
      if (!lockError(error)) { db.close(); throw error; }
      this.contended = true; // R2: the hook spools and exits instead of waiting out another writer
    }
    this.migrated = this.contended ? 0 : this.migrateLegacy();
  }

  private existingMachine(): string {
    const file = join(this.base, "machine.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("capture machine identity unavailable");
    const value = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown };
    if (typeof value?.id !== "string" || !/^[a-f0-9]{16}$/.test(value.id)) throw new Error("capture machine identity unavailable");
    return value.id;
  }
  private writable(): void {
    if (this.readOnly) throw new Error("capture store is read-only");
  }
  private checkReadBinding(): void {
    if (this.readOnly && resolveAlias(this.base, this.requestedKey) !== this.key) throw new Error("capture alias binding changed");
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
    const directory = join(this.dir, SPOOL_DIR), writing = join(directory, ".writing");
    mkdirSync(writing, { recursive: true, mode: 0o700 });
    const name = `spool-${spoolToken()}.jsonl`, temporary = join(writing, name);
    try {
      writeFileSync(temporary, line + "\n", { mode: 0o600, flag: "wx" }); // closes before readers can see it
      renameSync(temporary, join(directory, name));
    } finally { rmSync(temporary, { force: true }); }
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
    if (!had && (this.db.query("SELECT COUNT(*) AS n FROM rows").get() as { n: number }).n > 0) this.db.run("INSERT INTO fts (rowid, body) SELECT id, excerpt FROM rows");
  }

  private mcpReady = false;
  /** One-time MCP read cost only: hooks neither create this derived index nor scan history to fill it. */
  private ensureMcpFts(): boolean {
    if (this.readOnly) return !!this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'mcp_fts' AND type = 'table'").get();
    if (!fts5Available()) return false;
    if (this.mcpReady) return true;
    try {
      this.db.transaction(() => {
        const hadMcp = !!this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'mcp_fts' AND type = 'table'").get();
        const body = (row: string) => `${row}.excerpt || char(10) || COALESCE((SELECT group_concat(value, ' ') FROM json_each(${row}.paths)), '') || char(10) || ${row}.event`;
        this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS mcp_fts USING fts5(body)");
        this.db.run(`CREATE TRIGGER IF NOT EXISTS rows_mcp_ai AFTER INSERT ON rows BEGIN INSERT INTO mcp_fts(rowid, body) VALUES (new.id, ${body("new")}); END`);
        this.db.run("CREATE TRIGGER IF NOT EXISTS rows_mcp_ad AFTER DELETE ON rows BEGIN DELETE FROM mcp_fts WHERE rowid = old.id; END");
        this.db.run(`CREATE TRIGGER IF NOT EXISTS rows_mcp_au AFTER UPDATE ON rows BEGIN DELETE FROM mcp_fts WHERE rowid = old.id; INSERT INTO mcp_fts(rowid, body) VALUES (new.id, ${body("new")}); END`);
        if (!hadMcp) this.db.run(`INSERT INTO mcp_fts(rowid, body) SELECT rows.id, ${body("rows")} FROM rows`);
      }).immediate();
      this.mcpReady = true;
      return true;
    } catch {
      // Missing/unavailable derived search is not a capture read failure. Retry on the next independent read.
      return false;
    }
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
  append(input: CaptureInput, options: CaptureAppendOptions = {}): CaptureAppend {
    this.writable();
    const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    if (!str(input.project, 400) || !str(input.agent, 64) || !str(input.event, 64)) throw new Error("capture rows need a project, an agent and an event");
    if (input.at !== undefined && (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at)))) throw new Error("capture row time must be a parseable time string");
    const receipt = options.receipt;
    if (receipt !== undefined && (typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt) || input.at === undefined)) throw new Error("capture receipt needs a stable time and a 64-hex digest");
    const row = this.normalize(input);
    // Reuse the immutable spool format and its existing unique index: a crash between capture and cursor
    // advance replays exactly the same screened line, whether first written directly or under contention.
    const spoolId = receipt === undefined ? null : createHash("sha256").update(this.spoolLine(row, receipt)).digest("hex");
    if (this.contended) {
      this.spool(row, receipt);
      return { spooled: true };
    }
    try {
      this.drain(); // replay earlier spooled rows first, so row ids stay in hook order
      // The row and its running byte count commit or roll back together: a lock after the INSERT cannot spool a duplicate.
      const result = this.db.transaction((): CaptureAppend => {
        const id = this.insertRow(row, spoolId);
        if (id !== undefined) return { id };
        const prior = this.db.query("SELECT id FROM rows WHERE spool_id = ?").get(spoolId) as { id: number } | null;
        if (!prior) throw new Error("capture receipt lookup failed");
        return { id: prior.id, already: true };
      }).immediate();
      try { this.evict(); } catch (error) {
        if (!lockError(error)) throw error; // the row is already committed; a locked eviction simply resumes on a later append
      }
      return result;
    } catch (error) {
      if (!lockError(error)) throw error;
      this.spool(row, receipt);
      return { spooled: true };
    }
  }

  /** The one place input becomes a row: caps fields, deny-filters paths, screens the excerpt, counts its bytes. */
  private normalize(input: CaptureInput): NormalizedCapture {
    const { at, agent, event, tool, paths, status, excerpt, bytes } = normalizeCaptureFields(input, () => this.now(), text => this.screen(text), this.caps);
    return { at, project: input.project, agent, event, tool, paths, status, excerpt, bytes };
  }

  private spoolLine(row: NormalizedCapture, nonce = randomBytes(12).toString("hex")): string {
    return JSON.stringify({ ...row, nonce });
  }

  private spool(row: NormalizedCapture, nonce?: string): void {
    this.spoolRaw(this.spoolLine(row, nonce));
  }

  /**
   * Immutable segments with unique claims: a stale drainer can remove only its own old name. Recovery may
   * steal a live claim; both readers can replay it safely because row ids dedupe and neither mutates its inode.
   * Offset acknowledgement is another rename, after commit, so a crash always leaves replayable evidence.
   * ponytail: unpublished files left in .writing by a killed writer are not replayed (they may be partial).
   * Quiescent maintenance may remove them; durable recovery of an interrupted append needs a journal/fsync.
   * Legacy fixed names are accepted for upgrade, but old-version writers must stop before upgrading: their
   * already-open shared inode cannot be made immutable by a newer reader.
   */
  drain(): { drained: number; skipped: number } {
    this.writable();
    let budget = CAPTURE_DRAIN_MAX_LINES, byteBudget = SPOOL_MAX_BYTES, drained = 0, skipped = 0;
    if (this.contended) return { drained, skipped };
    const started = performance.now();
    const directory = join(this.dir, SPOOL_DIR);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const candidates: { file: string; name: string; offset: number; skip: boolean }[] = [];
    // Fixed-name imports are only compatibility inputs; all acknowledgements use unique names thereafter.
    for (const name of [DRAINING, SPOOL]) {
      if (existsSync(join(this.dir, name))) candidates.push({ file: join(this.dir, name), name: `spool-${spoolToken()}.jsonl`, offset: 0, skip: false });
    }
    const entries = opendirSync(directory);
    try {
      for (let scanned = 0; scanned < 256 && candidates.length < SPOOL_MAX_FILES; scanned++) {
        const entry = entries.readSync();
        if (!entry) break;
        const match = segmentName.exec(entry.name);
        if (entry.isFile() && match) candidates.push({ file: join(directory, entry.name), name: entry.name.split(".offset-")[0]!.split(".draining-")[0]!,
          offset: Number(match[1] ?? 0), skip: !!match[2] });
      }
    } finally { entries.closeSync(); }
    const validRow = (row: Partial<NormalizedCapture>): row is NormalizedCapture =>
      typeof row.at === "string" && row.at.length > 0 && typeof row.project === "string" && row.project.length > 0
      && typeof row.agent === "string" && row.agent.length > 0 && typeof row.event === "string" && row.event.length > 0
      && (row.tool === null || typeof row.tool === "string") && Array.isArray(row.paths) && row.paths.every((p) => typeof p === "string")
      && (row.status === null || typeof row.status === "string") && typeof row.excerpt === "string"
      && typeof row.bytes === "number" && Number.isFinite(row.bytes) && row.bytes >= 0;
    candidates.sort((a, b) => a.name.localeCompare(b.name));
    for (const source of candidates) {
      if (budget <= 0 || byteBudget <= 0 || performance.now() - started >= SPOOL_MAX_MS) break;
      const file = join(directory, `${source.name}.offset-${source.offset}${source.skip ? "-skip" : ""}.draining-${randomBytes(12).toString("hex")}`);
      try { renameSync(source.file, file); } catch { continue; } // another drainer claimed this exact name
      let bytes: Buffer, size: number;
      try {
        const fd = openSync(file, "r");
        try {
          size = statSync(file).size;
          bytes = Buffer.alloc(Math.min(byteBudget, Math.max(0, size - source.offset)));
          bytes = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, source.offset));
        } finally { closeSync(fd); }
      } catch { continue; } // a recovery reader may already have moved our unique claim
      byteBudget -= bytes.length;
      let consumed = 0, skipping = source.skip;
      const batch: string[] = [];
      while (consumed < bytes.length && batch.length < budget) {
        const newline = bytes.indexOf(10, consumed);
        if (newline < 0) {
          if (source.offset + bytes.length < size) {
            // A short window may only be the allowance left after another file, not an oversized row.
            if (consumed === 0 && bytes.length === SPOOL_MAX_BYTES) { consumed = bytes.length; skipping = true; }
            break;
          }
          if (!skipping) batch.push(bytes.subarray(consumed).toString("utf8"));
          else skipped++;
          consumed = bytes.length; skipping = false; break;
        }
        const line = bytes.subarray(consumed, newline).toString("utf8");
        consumed = newline + 1;
        if (skipping) { skipped++; skipping = false; }
        else if (line) batch.push(line);
      }
      try {
        this.db.transaction(() => {
          for (const line of batch) {
            let raw: Partial<NormalizedCapture> & { bytes?: number };
            try { raw = JSON.parse(line) as typeof raw; } catch { skipped++; continue; }
            let candidate: NormalizedCapture;
            try {
              // Spool lines written since the screened-spool rule are already bounded and screened; older lines
              // (this branch's pre-release format) pass through normalize once.
              candidate = typeof raw.bytes === "number" && typeof raw.excerpt === "string" ? raw as NormalizedCapture : this.normalize(raw as CaptureInput);
            } catch { skipped++; continue; }
            if (!validRow(candidate)) { skipped++; continue; }
            const added = this.insertRow(candidate, createHash("sha256").update(line).digest("hex")) !== undefined;
            if (added) drained++;
          }
        }).immediate();
      } catch (error) {
        if (!lockError(error)) throw error;
        break; // still contended: the spool stays for the next invocation
      }
      budget -= batch.length;
      const next = source.offset + consumed;
      if (next >= size) rmSync(file, { force: true });
      else {
        // Never rewrite a shared inode. Only the owner of this exact claim can acknowledge its prefix.
        try { renameSync(file, join(directory, `${source.name}.offset-${next}${skipping ? "-skip" : ""}`)); } catch { /* recovered elsewhere */ }
      }
    }
    return { drained, skipped };
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
    this.writable();
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
      const removedBytes = old.reduce((sum, r) => sum + r.bytes, 0);
      // Deleting rows and adjusting the running size is atomic too; a lock cannot leave a permanently stale counter.
      this.db.transaction(() => {
        for (const { id } of old) this.db.query("DELETE FROM rows WHERE id = ?").run(id);
        if (removedBytes) this.addBytes(-removedBytes);
      }).immediate();
      rows += old.length;
      bytes += removedBytes;
      if (old.length < CAPTURE_EVICT_BATCH_ROWS) break;
    }
    return { rows, bytes };
  }

  rows(f: { project?: string; sinceId?: number; limit?: number } = {}): CaptureRow[] {
    this.checkReadBinding();
    const where: string[] = [], bind: (string | number)[] = [];
    if (this.recentReadIds) { where.push("id IN (SELECT value FROM json_each(?))"); bind.push(JSON.stringify(this.recentReadIds)); }
    if (f.project) { where.push("project = ?"); bind.push(f.project); }
    if (f.sinceId !== undefined) { where.push("id > ?"); bind.push(f.sinceId); }
    const rows = this.db.query(`SELECT * FROM rows${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`).all(...bind, f.limit ?? 1000) as RawRow[];
    return rows.map(toRow);
  }

  /** Exact-project, bounded body pages; MCP screens before filling its public candidate window. */
  readPage(window: ReadWindow & { query?: string; match?: "substring" }): { rows: CaptureRow[]; next?: ReadRef; engine?: "fts5" | "substring" } {
    this.checkReadBinding();
    const { columns, where, bind } = readWindowSql(window, "id");
    if (this.recentReadIds) {
      if (window.query !== undefined) throw new Error("recent capture brief does not support query indexes");
      where.push("id IN (SELECT value FROM json_each(?))"); bind.push(JSON.stringify(this.recentReadIds));
    }
    const engine = window.query === undefined ? undefined : window.match !== "substring" && this.ensureMcpFts() ? "fts5" : "substring";
    if (window.query !== undefined && engine === "fts5") {
      const match = ftsTerms(window.query); if (!match) return { rows: [], engine };
      where.push("id IN (SELECT rowid FROM mcp_fts WHERE mcp_fts MATCH ?)"); bind.push(match);
    }
    const rows = this.db.query(`SELECT *, ${columns} FROM rows WHERE ${where.join(" AND ")} ORDER BY candidate_position, candidate_id LIMIT ?`)
      .all(...bind, window.limit) as (RawRow & { candidate_id: string; candidate_position: number })[];
    return { rows: rows.map(toRow), ...(engine ? { engine } : {}), ...(rows.length ? { next: readRef(rows[rows.length - 1]!) } : {}) };
  }

  stats(): { rows: number; bytes: number; capMb: number; retentionDays: number; fileBytes: number } {
    this.checkReadBinding();
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
