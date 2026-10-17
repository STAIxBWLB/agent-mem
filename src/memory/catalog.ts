import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { memoryBase } from "./home.ts";
import { listAliases, readShardDescriptor } from "./shard.ts";
import { captureShardStats, readCaptureConfig } from "./capture.ts";

/**
 * #15 D3 (storage part only): the user-level catalog of project shards. `catalog.db` in the memory home is derived
 * only from the shards (`projects/* /project.json`, their `machine/<id>` capture stores and configs) and the
 * append-only `aliases.jsonl`; it carries no truth of its own, so deleting it and rebuilding from the shards always
 * reproduces the same rows. The D3 management commands (`amem projects/usage/gc/export/archive/forget`) are #15 T5
 * and are deliberately not built here.
 */

export interface CatalogProject {
  hash: string; key: string; local: boolean; aliases: string[];
  captureRows: number; captureBytes: number; captureLastAt: string | null;
  capMb: number; retentionDays: number;
}

interface CatalogRow { hash: string; key: string; local: number; aliases: string; capture_rows: number; capture_bytes: number; capture_last_at: string | null; cap_mb: number; retention_days: number }

const fromRow = (r: CatalogRow): CatalogProject => ({ hash: r.hash, key: r.key, local: r.local === 1, aliases: JSON.parse(r.aliases) as string[],
  captureRows: r.capture_rows, captureBytes: r.capture_bytes, captureLastAt: r.capture_last_at, capMb: r.cap_mb, retentionDays: r.retention_days });

/** Every readable shard with its machine-scope directories; the walk behind the catalog and the capacity advisor. */
export function walkShards(base: string): { hash: string; key: string; local: boolean; machineDirs: string[] }[] {
  const projectsDir = join(base, "projects");
  let hashes: string[] = [];
  try { hashes = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{16}$/.test(e.name)).map((e) => e.name).sort(); } catch { /* no shards yet */ }
  const out: { hash: string; key: string; local: boolean; machineDirs: string[] }[] = [];
  for (const hash of hashes) {
    const descriptor = readShardDescriptor(base, hash);
    if (!descriptor) continue; // a half-created or corrupt shard is skipped, never fatal
    const machineDirs: string[] = [];
    try {
      for (const entry of readdirSync(join(projectsDir, hash, "machine"), { withFileTypes: true })) if (entry.isDirectory()) machineDirs.push(join(projectsDir, hash, "machine", entry.name));
    } catch { /* no machine scope yet */ }
    out.push({ hash, key: descriptor.key, local: descriptor.local, machineDirs: machineDirs.sort() });
  }
  return out;
}

/** What the shards and the alias log say, before anything is persisted. */
export function scanCatalog(base: string): CatalogProject[] {
  const aliases = listAliases(base);
  const out: CatalogProject[] = [];
  for (const shard of walkShards(base)) {
    let rows = 0, bytes = 0, lastAt: string | null = null;
    for (const dir of shard.machineDirs) {
      const stats = captureShardStats(dir);
      rows += stats.rows;
      bytes += stats.bytes;
      if (stats.lastAt && (lastAt === null || stats.lastAt > lastAt)) lastAt = stats.lastAt;
    }
    const config = readCaptureConfig(shard.machineDirs[shard.machineDirs.length - 1] ?? join(base, "projects", shard.hash, "machine", "_"), base);
    out.push({ hash: shard.hash, key: shard.key, local: shard.local,
      aliases: [...new Set(aliases.filter((op) => op.key === shard.key).map((op) => op.alias))].sort(),
      captureRows: rows, captureBytes: bytes, captureLastAt: lastAt, capMb: config.capMb, retentionDays: config.retentionDays });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Rewrite `catalog.db` from the shards in one transaction: the same shards always reproduce the same rows. */
export function rebuildCatalog(opts: { home?: string } = {}): CatalogProject[] {
  const base = memoryBase(opts.home);
  const projects = scanCatalog(base);
  const file = join(base, "catalog.db");
  const db = new Database(file, { create: true });
  try {
    db.run("PRAGMA busy_timeout = 3000");
    db.run(`CREATE TABLE IF NOT EXISTS projects (hash TEXT PRIMARY KEY, key TEXT NOT NULL, local INTEGER NOT NULL, aliases TEXT NOT NULL,
      capture_rows INTEGER NOT NULL, capture_bytes INTEGER NOT NULL, capture_last_at TEXT, cap_mb REAL NOT NULL, retention_days REAL NOT NULL)`);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    db.transaction(() => {
      db.run("DELETE FROM projects");
      for (const p of projects) db.query("INSERT INTO projects (hash, key, local, aliases, capture_rows, capture_bytes, capture_last_at, cap_mb, retention_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.hash, p.key, p.local ? 1 : 0, JSON.stringify(p.aliases), p.captureRows, p.captureBytes, p.captureLastAt, p.capMb, p.retentionDays);
    }).immediate();
  } finally { db.close(); }
  return projects;
}

/** The stored catalog, rebuilt when absent. Listing may lag the shards; `rebuildCatalog` is the fresh read. */
export function readCatalog(opts: { home?: string } = {}): CatalogProject[] {
  const base = memoryBase(opts.home);
  const file = join(base, "catalog.db");
  if (!existsSync(file)) return rebuildCatalog(opts);
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.run("PRAGMA busy_timeout = 3000");
    return (db.query("SELECT * FROM projects ORDER BY key").all() as CatalogRow[]).map(fromRow);
  } catch { return rebuildCatalog(opts); }
  finally { db?.close(); }
}
