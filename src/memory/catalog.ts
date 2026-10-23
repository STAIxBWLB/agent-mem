import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { memoryBase } from "./home.ts";
import { effectiveAliases, readShardDescriptor, SHARDED_SCHEMA } from "./shard.ts";
import { readProfileJSON, validGeneration } from "./generation.ts";
import { captureShardStats, readCaptureConfig } from "./capture.ts";
import { openShardStore } from "./store.ts";
import { lifecycleResolver, type LifecycleState } from "./lifecycle.ts";

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
  curatedEntries: number | null; curatedLastAt: string | null; curatedAvailable: boolean;
  capMb: number; retentionDays: number;
  /** #15 T5: the person's lifecycle decision (`lifecycle.jsonl`); forgotten projects stay in the scan so the state is visible, and listings leave them out. */
  state: LifecycleState;
  /** Bytes the shard directory holds on disk (its logs, indexes, capture and work lists), counting files and never following a link. */
  diskBytes: number;
}

interface CatalogRow { hash: string; key: string; local: number; aliases: string; capture_rows: number; capture_bytes: number; capture_last_at: string | null; curated_entries: number | null; curated_last_at: string | null; cap_mb: number; retention_days: number; state: string; disk_bytes: number }

const fromRow = (r: CatalogRow): CatalogProject => ({ hash: r.hash, key: r.key, local: r.local === 1, aliases: JSON.parse(r.aliases) as string[],
  captureRows: r.capture_rows, captureBytes: r.capture_bytes, captureLastAt: r.capture_last_at, curatedEntries: r.curated_entries, curatedLastAt: r.curated_last_at, curatedAvailable: r.curated_entries !== null, capMb: r.cap_mb, retentionDays: r.retention_days, state: r.state === "archived" || r.state === "forgotten" ? r.state : "active", diskBytes: r.disk_bytes });

/** Interrupted splits expose capture facts, but cannot authorize any curated store open or initialization. */
function capturedSelection(base: string): boolean {
  const value = readProfileJSON(join(base, "shards.json")) as { schema?: unknown; generation?: unknown; phase?: unknown; selectorRevision?: unknown } | undefined;
  if (value === undefined) return false;
  if (!value || value.schema !== SHARDED_SCHEMA || !validGeneration(value.generation) || (value.phase !== "captured" && value.phase !== "active") || typeof value.selectorRevision !== "string") throw new Error("curated shard selection is unavailable or invalid");
  return value.phase === "captured";
}

/** Refresh the disposable curated index from its sealed logs before deriving an own-project receipt. */
function curatedStats(base: string, hash: string, key: string, captured: boolean): { entries: number | null; lastAt: string | null } {
  if (captured) return { entries: null, lastAt: null };
  const dir = join(base, "projects", hash);
  // A capture-only descriptor is not permission to initialize a curated store while listing the catalog.
  if (!existsSync(join(dir, "generation.json")) && !existsSync(join(dir, "generation-seal.json"))) return { entries: 0, lastAt: null };
  const store = openShardStore({ memoryDir: base, project: key, deferPromotions: true });
  try {
    const db = new Database(join(dir, "index.db"), { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 0");
      const row = db.query("SELECT COUNT(*) AS n, MAX(at) AS last FROM entries WHERE scope = 'project' AND project = ?").get(key) as { n: number; last: string | null };
      return { entries: row.n, lastAt: row.last };
    } finally { db.close(); }
  } finally { store.close(); }
}

/** Bytes of regular files under a shard directory. A link is not followed (counted as nothing), an unreadable entry as nothing: the figure is a lower bound, never a guess. */
export function directoryBytes(dir: string, depth = 0): number {
  if (depth > 12) return 0;
  let total = 0;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += directoryBytes(path, depth + 1);
      else if (entry.isFile()) total += lstatSync(path).size;
    } catch { /* vanished or unreadable: not counted */ }
  }
  return total;
}

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
  const captured = capturedSelection(base);
  // The latest op per alias (a removal included): an alias lists only under the key it currently points at, never under a past target or after `alias remove`.
  const latest = effectiveAliases(base);
  const stateOf = lifecycleResolver(base);
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
    const curated = curatedStats(base, shard.hash, shard.key, captured);
    out.push({ hash: shard.hash, key: shard.key, local: shard.local,
      aliases: [...latest.entries()].filter(([, key]) => key === shard.key).map(([alias]) => alias).sort(),
      captureRows: rows, captureBytes: bytes, captureLastAt: lastAt, curatedEntries: curated.entries, curatedLastAt: curated.lastAt, curatedAvailable: curated.entries !== null, capMb: config.capMb, retentionDays: config.retentionDays,
      state: stateOf(shard.key), diskBytes: directoryBytes(join(base, "projects", shard.hash)) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** A fresh scan of the shards for a read-only command (`amem usage`, `amem projects`): it writes nothing, `catalog.db` included. */
export function readCatalogFresh(base: string): CatalogProject[] {
  return scanCatalog(base);
}

/** Rewrite `catalog.db` from the shards in one transaction: the same shards always reproduce the same rows. */
export function rebuildCatalog(opts: { home?: string } = {}): CatalogProject[] {
  const base = memoryBase(opts.home);
  const projects = scanCatalog(base);
  const file = join(base, "catalog.db");
  const db = new Database(file, { create: true });
  try {
    db.run("PRAGMA busy_timeout = 3000");
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    db.transaction(() => {
      const columns = db.query("PRAGMA table_info(projects)").all() as { name: string; notnull: number }[];
      // This database is disposable. Rebuild older derived schemas instead of coercing unavailable into zero.
      if (columns.length && (!columns.some(column => column.name === "curated_entries" && column.notnull === 0) || !columns.some(column => column.name === "curated_last_at")
        || !columns.some(column => column.name === "state") || !columns.some(column => column.name === "disk_bytes"))) db.run("DROP TABLE projects");
      db.run(`CREATE TABLE IF NOT EXISTS projects (hash TEXT PRIMARY KEY, key TEXT NOT NULL, local INTEGER NOT NULL, aliases TEXT NOT NULL,
        capture_rows INTEGER NOT NULL, capture_bytes INTEGER NOT NULL, capture_last_at TEXT, curated_entries INTEGER, curated_last_at TEXT, cap_mb REAL NOT NULL, retention_days REAL NOT NULL, state TEXT NOT NULL DEFAULT 'active', disk_bytes INTEGER NOT NULL DEFAULT 0)`);
      db.run("DELETE FROM projects");
      for (const p of projects) db.query("INSERT INTO projects (hash, key, local, aliases, capture_rows, capture_bytes, capture_last_at, curated_entries, curated_last_at, cap_mb, retention_days, state, disk_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.hash, p.key, p.local ? 1 : 0, JSON.stringify(p.aliases), p.captureRows, p.captureBytes, p.captureLastAt, p.curatedEntries, p.curatedLastAt, p.capMb, p.retentionDays, p.state, p.diskBytes);
    }).immediate();
  } finally { db.close(); }
  return projects;
}

/** The stored catalog, rebuilt when absent. Listing may lag the shards; `rebuildCatalog` is the fresh read. */
export function readCatalog(opts: { home?: string } = {}): CatalogProject[] {
  const base = memoryBase(opts.home);
  const file = join(base, "catalog.db");
  if (!existsSync(file)) return rebuildCatalog(opts);
  const captured = capturedSelection(base);
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.run("PRAGMA busy_timeout = 3000");
    const columns = new Set((db.query("PRAGMA table_info(projects)").all() as { name: string }[]).map(column => column.name));
    if (!columns.has("curated_entries") || !columns.has("curated_last_at") || !columns.has("state") || !columns.has("disk_bytes")) throw new Error("catalog schema needs rebuild");
    return (db.query("SELECT * FROM projects ORDER BY key").all() as CatalogRow[]).map(fromRow)
      .map(project => captured ? { ...project, curatedEntries: null, curatedLastAt: null, curatedAvailable: false } : project);
  } catch { return rebuildCatalog(opts); }
  finally { db?.close(); }
}
