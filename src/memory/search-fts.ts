import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CaptureRow } from "./capture.ts";

/**
 * #13 R5: full-text search over the curated tier with SQLite FTS5 and BM25, replacing substring matching where the
 * platform's sqlite has FTS5 (verified in bun:sqlite on Bun 1.4.2, macOS and Linux). The index lives in its own
 * `search.db` beside the memory logs: `index.db`'s table set is part of the shared-v1 golden contract and must not
 * gain tables, and the sync .gitignore already keeps every other file machine-local. `search.db` is derived only
 * from curated rows: every add is idempotent by entry id, and a store rebuild, a prune, a lock or any count drift
 * forces a full resync, so the incremental index equals a rebuild.
 *
 * The copy is a DERIVED cache: a locked or failing `search.db` never fails or stalls a curated write — the apply
 * path marks the copy stale and the next search resyncs it. Its busy timeout is zero: derived writes fail fast and
 * degrade, never queue behind another process's lock (R2's 150 ms hook budget includes the write path).
 */

/** Bumped when the docs table's shape changes: an older copy is dropped and rebuilt from the curated rows. */
const SEARCH_SCHEMA = "2";

let probe: boolean | undefined;
/** One runtime probe; the answer is cached for the process. */
export function fts5Available(): boolean {
  if (probe !== undefined) return probe;
  try {
    const db = new Database(":memory:");
    try {
      db.run("CREATE VIRTUAL TABLE probe USING fts5(body)");
      db.run("INSERT INTO probe (body) VALUES ('availability')");
      db.query("SELECT bm25(probe) AS rank FROM probe WHERE probe MATCH 'availability'").get();
      probe = true;
    } finally { db.close(); }
  } catch { probe = false; }
  return probe;
}

/** Tests force the fallback path; `undefined` restores the real probe. Not for host use. */
export function setFts5AvailableForTest(value: boolean | undefined): void {
  probe = value;
}

const KOREAN_PARTICLES = ["에는", "에서", "으로", "에게", "한테", "처럼", "보다", "까지", "부터", "마다", "조차", "마저", "이나", "이랑", "하고", "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "도", "만", "의", "랑", "나", "라"];

/** The original term plus a common-particle-stripped Korean alternative, so both 메모리 and 메모리는 match either form. */
function queryVariants(term: string): string[] {
  if (!/[가-힣]/u.test(term)) return [term];
  const particle = KOREAN_PARTICLES.find((p) => term.endsWith(p) && term.length - p.length >= 2);
  return particle ? [term, term.slice(0, -particle.length)] : [term];
}

/**
 * A free-text query as a safe FTS5 MATCH string: unicode61-ish terms (the index tokenizer's alphabet), each a
 * quoted PREFIX term (`"word" *` — inflections and Korean particles like 메모리/메모리를 match), quoted so query
 * punctuation can never become MATCH syntax, joined with OR so natural multi-word queries rank partial matches
 * instead of requiring every word like the substring filter did (the P0 recall gap).
 */
export function ftsTerms(q: string): string {
  const terms = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
  const variants = [...new Set(terms.flatMap(queryVariants))].slice(0, 64);
  return variants.map((t) => `"${t.replaceAll('"', '""')}" *`).join(" OR ");
}

export interface CuratedDoc { id: string; at: string; project: string; tier: string; scope: string; body: string }
export interface RankedRef { ref: string; project: string; tier: string; at: string; rank: number }

export class SearchIndex {
  readonly available: boolean;
  private readonly db?: Database;
  /** A write that failed (a locked or failing derived file): the next search resyncs, never the curated writer. */
  private stale = false;

  constructor(file: string) {
    if (!fts5Available()) { this.available = false; return; }
    try {
      const db = new Database(file, { create: true });
      db.run("PRAGMA busy_timeout = 0"); // derived: fail fast and mark stale; a curated write never waits on this file
      db.run("PRAGMA journal_mode = WAL");
      db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      if ((db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null)?.value !== SEARCH_SCHEMA) {
        db.run("DROP TABLE IF EXISTS docs");
        db.run("DROP TABLE IF EXISTS refs");
        db.run("DELETE FROM meta");
        db.query("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(SEARCH_SCHEMA);
      }
      db.run("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(body, ref UNINDEXED, project UNINDEXED, tier UNINDEXED, at UNINDEXED, scope UNINDEXED)");
      // FTS5 has no unique constraint: refs remembers what is indexed, so a repeated or rebuilt row is never doubled.
      db.run("CREATE TABLE IF NOT EXISTS refs (ref TEXT PRIMARY KEY)");
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
      this.db = db;
      this.available = true;
    } catch { this.available = false; }
  }

  private meta(key: string): string | undefined {
    return (this.db!.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  /** Called from the curated store's apply path, after the entry row committed. Idempotent by entry id. Never throws. */
  addCurated(doc: CuratedDoc): void {
    const db = this.db;
    if (!db) return;
    try {
      db.transaction(() => {
        // bun:sqlite's run().changes is not reliable for an ignored insert inside a transaction (the FTS triggers
        // confuse it), so idempotency is a plain lookup, never the statement's change count.
        if (db.query("SELECT 1 FROM refs WHERE ref = ?").get(doc.id)) return;
        db.query("INSERT INTO refs (ref) VALUES (?)").run(doc.id);
        db.query("INSERT INTO docs (body, ref, project, tier, at, scope) VALUES (?, ?, ?, ?, ?, ?)").run(doc.body, doc.id, doc.project, doc.tier, doc.at, doc.scope);
        db.query("INSERT INTO meta (key, value) VALUES ('curated', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
      }).immediate();
    } catch { this.markDirty(); } // the FTS copy degrades, the curated write stands
  }

  /** A curated prune removed rows the FTS copy cannot subtract incrementally: the next search resyncs instead. */
  markDirty(): void {
    this.stale = true;
    try { this.db?.query("INSERT INTO meta (key, value) VALUES ('dirty', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run(); } catch { /* the in-memory flag is enough for this process */ }
  }

  /** True when the FTS copy no longer mirrors the curated rows (a prune, a crashed apply, a lock or a rebuilt index). */
  needsResync(curatedCount: number): boolean {
    if (!this.db) return false;
    if (this.stale) return true;
    try { return this.meta("dirty") === "1" || Number(this.meta("curated") ?? "0") !== curatedCount; }
    catch { return true; }
  }

  /** Rebuild the FTS copy from the curated rows; the caller scans them. */
  resync(load: () => Iterable<CuratedDoc>): void {
    const db = this.db;
    if (!db) return;
    try {
      db.transaction(() => {
        db.run("DELETE FROM docs");
        db.run("DELETE FROM refs");
        let n = 0;
        for (const doc of load()) {
          db.query("INSERT INTO refs (ref) VALUES (?)").run(doc.id);
          db.query("INSERT INTO docs (body, ref, project, tier, at, scope) VALUES (?, ?, ?, ?, ?, ?)").run(doc.body, doc.id, doc.project, doc.tier, doc.at, doc.scope);
          n++;
        }
        db.query("INSERT INTO meta (key, value) VALUES ('curated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
        db.query("DELETE FROM meta WHERE key = 'dirty'").run();
      }).immediate();
      this.stale = false;
    } catch { this.stale = true; }
  }

  /** The store drops and re-reads every curated row: the FTS copy starts over and the apply path refills it. */
  reset(): void {
    const db = this.db;
    if (!db) return;
    try {
      db.transaction(() => {
        db.run("DELETE FROM docs");
        db.run("DELETE FROM refs");
        db.run("DELETE FROM meta WHERE key != 'schema'");
      }).immediate();
      this.stale = false;
    } catch { this.stale = true; }
  }

  /**
   * Best BM25 first (rank is negative: smaller wins). `project` filters inside the MATCH (its own rows plus shared
   * ones), so a busy sibling project can never starve a project's LIMIT. Visibility stays with the caller.
   */
  query(q: string, limit: number, project?: string): RankedRef[] {
    if (!this.db) return [];
    const match = ftsTerms(q);
    if (!match) return [];
    const where = project ? "docs MATCH ? AND (project = ? OR scope = 'shared')" : "docs MATCH ?";
    const bind = project ? [match, project] : [match];
    return this.db.query(`SELECT ref, project, tier, at, bm25(docs) AS rank FROM docs WHERE ${where} ORDER BY rank LIMIT ?`).all(...bind, limit) as RankedRef[];
  }

  close(): void { this.db?.close(); }
}

interface RawCaptureRow { id: number; at: string; project: string; agent: string; event: string; tool: string | null; paths: string; status: string | null; excerpt: string }

/**
 * The capture leg of #13 search: BM25 over the excerpts of one capture shard (`machine/<id>` of a project shard,
 * #15 T1). Empty when FTS5 or the shard is absent; a contended or corrupted shard degrades recall, never the search.
 */
export function captureSearch(dir: string, q: string, limit: number): { row: CaptureRow; rank: number }[] {
  const match = ftsTerms(q);
  if (!match || !fts5Available() || !existsSync(join(dir, "capture.db"))) return [];
  let db: Database | undefined;
  try {
    db = new Database(join(dir, "capture.db"), { readonly: true });
    db.run("PRAGMA busy_timeout = 3000");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'fts' AND type = 'table'").get()) return [];
    const rows = db.query(`SELECT r.*, bm25(fts) AS rank FROM fts JOIN rows r ON r.id = fts.rowid WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as (RawCaptureRow & { rank: number })[];
    return rows.map((r) => ({ row: { id: r.id, at: r.at, project: r.project, agent: r.agent, event: r.event, tool: r.tool, paths: JSON.parse(r.paths) as string[], status: r.status, excerpt: r.excerpt }, rank: r.rank }));
  } catch { return []; }
  finally { db?.close(); }
}
