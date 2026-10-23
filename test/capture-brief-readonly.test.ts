import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendAlias } from "../src/memory/shard.ts";

const project = "brief-project";
const input = (n: number) => ({ project, agent: "claude", event: "PostToolUse", excerpt: `public capture ${n}` });
function fixture(rows = 2) {
  const base = mkdtempSync(join(tmpdir(), "amem-capture-brief-"));
  const writer = new CaptureStore({ memoryDir: base, project });
  for (let n = 0; n < rows; n++) writer.append(input(n));
  const dir = writer.dir, expected = writer.rows(), page = writer.readPage({ project, limit: 32 }).rows; writer.close();
  return { base, dir, expected, page, close: () => rmSync(base, { recursive: true, force: true }) };
}
/** SQLite itself may create empty WAL/SHM bookkeeping on the first read-only open.
 * Establish that neutral reader before comparing CaptureStore's authored files. */
function keeper(dir: string): Database {
  const db = new Database(join(dir, "capture.db"), { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0"); db.run("BEGIN");
    db.query("SELECT COUNT(*) FROM rows").get();
    return db;
  } catch (error) { db.close(); throw error; }
}

function files(base: string): Record<string, { bytes: string; mode: number }> {
  const found: Record<string, { bytes: string; mode: number }> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(join(base, relative))) {
      const entry = join(relative, name), stat = statSync(join(base, entry));
      if (stat.isDirectory()) walk(entry);
      // SQLite read-only WAL readers update shared-memory lock/read marks, not authored data.
      else found[entry] = { bytes: entry.endsWith(".db-shm") ? "sqlite read marks" : createHash("sha256").update(readFileSync(join(base, entry))).digest("hex"), mode: stat.mode };
    }
  };
  walk(""); return found;
}

test("read-only capture brief matches bounded native rows without creating FTS or authoring metadata", () => {
  const f = fixture(); let reader: CaptureStore | undefined, neutral: Database | undefined;
  try {
    const db = new Database(join(f.dir, "capture.db"));
    try {
      for (const trigger of ["rows_ai", "rows_ad", "rows_au"]) db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      db.run("DROP TABLE IF EXISTS fts");
    } finally { db.close(); }
    neutral = keeper(f.dir);
    const before = files(f.base);
    reader = new CaptureStore({ memoryDir: f.base, project, readOnly: true, maxReadRows: 128 });
    expect(reader.migrated).toBe(0);
    expect(reader.readPage({ project, limit: 32 }).rows).toEqual(f.page);
    expect(reader.rows()).toEqual(f.expected);
    // Query reads may use an existing index, but must never create/rebuild it.
    reader.readPage({ project, limit: 32, query: "public" });
    expect(() => reader!.append(input(3))).toThrow("read-only");
    expect(() => reader!.drain()).toThrow("read-only");
    expect(() => reader!.evict()).toThrow("read-only");
    reader.close(); reader = undefined;
    expect(files(f.base)).toEqual(before);
    const check = new Database(join(f.dir, "capture.db"), { readonly: true });
    try { expect(check.query("SELECT name FROM sqlite_master WHERE name IN ('fts','mcp_fts','rows_ai','rows_ad','rows_au')").all()).toEqual([]); }
    finally { check.close(); }
  } finally { reader?.close(); neutral?.close(); f.close(); }
});

test("a missing capture store is unavailable without creating machine, shard, database or spool", () => {
  const base = mkdtempSync(join(tmpdir(), "amem-capture-missing-"));
  try {
    expect(() => new CaptureStore({ memoryDir: base, project, readOnly: true, maxReadRows: 128 })).toThrow();
    expect(readdirSync(base)).toEqual([]);
    const writer = new CaptureStore({ memoryDir: base, project }); const dir = writer.dir; writer.close();
    rmSync(join(dir, "capture.db"));
    const before = files(base);
    expect(() => new CaptureStore({ memoryDir: base, project, readOnly: true })).toThrow();
    expect(files(base)).toEqual(before);
    expect(existsSync(join(dir, "spool"))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("129 capture rows refuse a 128-row brief ceiling instead of returning an empty or truncated view", () => {
  const f = fixture(129); let neutral: Database | undefined;
  try {
    neutral = keeper(f.dir);
    const before = files(f.base);
    expect(() => new CaptureStore({ memoryDir: f.base, project, readOnly: true, maxReadRows: 128 })).toThrow("row bound exceeded");
    expect(files(f.base)).toEqual(before);
    neutral.close(); neutral = undefined;
    const full = new CaptureStore({ memoryDir: f.base, project });
    try { expect(full.rows()).toHaveLength(129); } finally { full.close(); }
  } finally { neutral?.close(); f.close(); }
});

test("read-only capture admission is zero-wait under an exclusive lock", () => {
  const f = fixture(), lock = new Database(join(f.dir, "capture.db"));
  try {
    lock.run("PRAGMA journal_mode = DELETE"); lock.run("BEGIN EXCLUSIVE");
    const started = performance.now();
    expect(() => new CaptureStore({ memoryDir: f.base, project, readOnly: true, maxReadRows: 128 })).toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
    lock.run("ROLLBACK");
    const reader = new CaptureStore({ memoryDir: f.base, project, readOnly: true });
    try { expect(reader.rows()).toEqual(f.expected); } finally { reader.close(); }
  } finally { try { lock.run("ROLLBACK"); } catch {} lock.close(); f.close(); }
});

test("read-only capture cannot continue across an alias rebind", () => {
  const f = fixture(); const reader = new CaptureStore({ memoryDir: f.base, project, readOnly: true });
  try {
    appendAlias(f.base, { alias: project, key: "another-project", actor: "person", machine: "1".repeat(16) });
    expect(() => reader.readPage({ project, limit: 32 })).toThrow("alias binding changed");
  } finally { reader.close(); f.close(); }
});


test("read-only capture sees committed uncheckpointed WAL rows without authoring or immutable reads", () => {
  const base = mkdtempSync(join(tmpdir(), "amem-capture-visible-wal-"));
  const writer = new CaptureStore({ memoryDir: base, project });
  const file = join(writer.dir, "capture.db"), db = new Database(file);
  let reader: CaptureStore | undefined;
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  try {
    writer.append(input(0));
    db.run("PRAGMA wal_autocheckpoint = 0"); db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const checkpointHash = hash();
    writer.append(input(1));
    expect(hash()).toBe(checkpointHash);
    expect(statSync(file + "-wal").size).toBeGreaterThan(32);
    const expected = writer.rows(), page = writer.readPage({ project, limit: 32 }).rows;
    expect(expected.map(row => row.excerpt)).toEqual(["public capture 0", "public capture 1"]);
    const before = files(base);
    reader = new CaptureStore({ memoryDir: base, project, readOnly: true, maxReadRows: 128 });
    expect(reader.rows()).toEqual(expected);
    expect(reader.readPage({ project, limit: 32 }).rows).toEqual(page);
    reader.close(); reader = undefined;
    expect(hash()).toBe(checkpointHash);
    expect(files(base)).toEqual(before);
  } finally { reader?.close(); db.close(); writer.close(); rmSync(base, { recursive: true, force: true }); }
});
