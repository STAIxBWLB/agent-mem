import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CaptureRow } from "./capture.ts";

/**
 * #13 R5: full-text search over the curated tier with SQLite FTS5 and BM25, replacing substring matching where the
 * platform's sqlite has FTS5 (verified in bun:sqlite on Bun 1.4.2, macOS and Linux). The index lives in its own
 * `search.db` beside the memory logs: `index.db`'s table set is part of the shared-v1 golden contract and must not
 * gain tables, and the sync .gitignore already keeps every other file machine-local. `search.db` is derived only
 * from curated rows: every add is idempotent by entry id, and a store rebuild, a prune or any count drift forces a
 * full resync, so the incremental index equals a rebuild.
 */

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

/**
 * A free-text query as a safe FTS5 MATCH string: unicode61-ish terms (the index tokenizer's alphabet), each quoted
 * so query punctuation can never become MATCH syntax, joined with OR so natural multi-word queries rank partial
 * matches instead of requiring every word like the substring filter did (the P0 recall gap).
 */
export function ftsTerms(q: string): string {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(terms)].slice(0, 32).map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

export interface CuratedDoc { id: string; at: string; project: string; tier: string; body: string }
export interface RankedRef { ref: string; project: string; tier: string; at: string; rank: number }

export class SearchIndex {
  readonly available: boolean;
  private readonly db?: Database;

  constructor(file: string) {
    if (!fts5Available()) { this.available = false; return; }
    try {
      const db = new Database(file, { create: true });
      db.run("PRAGMA busy_timeout = 3000");
      db.run("PRAGMA journal_mode = WAL");
      db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.run("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(body, ref UNINDEXED, project UNINDEXED, tier UNINDEXED, at UNINDEXED)");
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

  /** Called from the curated store's apply path, after the entry row committed. Idempotent by entry id. */
  addCurated(doc: CuratedDoc): void {
    const db = this.db;
    if (!db) return;
    db.transaction(() => {
      // bun:sqlite's run().changes is not reliable for an ignored insert inside a transaction (the FTS triggers
      // confuse it), so idempotency is a plain lookup, never the statement's change count.
      if (db.query("SELECT 1 FROM refs WHERE ref = ?").get(doc.id)) return;
      db.query("INSERT INTO refs (ref) VALUES (?)").run(doc.id);
      db.query("INSERT INTO docs (body, ref, project, tier, at) VALUES (?, ?, ?, ?, ?)").run(doc.body, doc.id, doc.project, doc.tier, doc.at);
      db.query("INSERT INTO meta (key, value) VALUES ('curated', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
    }).immediate();
  }

  /** A curated prune removed rows the FTS copy cannot subtract incrementally: the next search resyncs instead. */
  markDirty(): void {
    this.db?.query("INSERT INTO meta (key, value) VALUES ('dirty', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  }

  /** True when the FTS copy no longer mirrors the curated rows (a prune, a crashed apply or a rebuilt index). */
  needsResync(curatedCount: number): boolean {
    if (!this.db) return false;
    return this.meta("dirty") === "1" || Number(this.meta("curated") ?? "0") !== curatedCount;
  }

  /** Rebuild the FTS copy from the curated rows; the caller scans them. */
  resync(load: () => Iterable<CuratedDoc>): void {
    const db = this.db;
    if (!db) return;
    db.transaction(() => {
      db.run("DELETE FROM docs");
      db.run("DELETE FROM refs");
      let n = 0;
      for (const doc of load()) {
        db.query("INSERT INTO refs (ref) VALUES (?)").run(doc.id);
        db.query("INSERT INTO docs (body, ref, project, tier, at) VALUES (?, ?, ?, ?, ?)").run(doc.body, doc.id, doc.project, doc.tier, doc.at);
        n++;
      }
      db.query("INSERT INTO meta (key, value) VALUES ('curated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
      db.query("DELETE FROM meta WHERE key = 'dirty'").run();
    }).immediate();
  }

  /** The store drops and re-reads every curated row: the FTS copy starts over and the apply path refills it. */
  reset(): void {
    const db = this.db;
    if (!db) return;
    db.transaction(() => {
      db.run("DELETE FROM docs");
      db.run("DELETE FROM refs");
      db.run("DELETE FROM meta");
    }).immediate();
  }

  /** Best BM25 first (rank is negative: smaller wins). Visibility and project filtering stay with the caller. */
  query(q: string, limit: number): RankedRef[] {
    if (!this.db) return [];
    const match = ftsTerms(q);
    if (!match) return [];
    return this.db.query("SELECT ref, project, tier, at, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?").all(match, limit) as RankedRef[];
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
