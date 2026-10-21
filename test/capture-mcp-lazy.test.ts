import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CAPTURE_MAX_EXCERPT, CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { fts5Available } from "../src/memory/search-fts.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = "lazy-capture-project";
const now = Date.now();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-capture-lazy-")); roots.push(root);
  const options = { home: root, project, now: () => now };
  const capture = new CaptureStore(options);
  return { root, options, capture, file: join(capture.dir, "capture.db") };
}
function append(capture: CaptureStore, excerpt: string, offset = 0, paths = ["public.ts"]) {
  const result = capture.append({ project, agent: "test", event: "PostToolUse", tool: "Read", paths, excerpt,
    at: new Date(now + offset).toISOString() });
  if (!("id" in result)) throw new Error("isolated fixture unexpectedly spooled");
  return result.id;
}
function removeMcpIndex(db: Database) {
  for (const trigger of ["rows_mcp_ai", "rows_mcp_ad", "rows_mcp_au"]) db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
  db.run("DROP TABLE IF EXISTS mcp_fts");
}
function mcpObjects(db: Database) {
  return db.query("SELECT name FROM sqlite_master WHERE name LIKE 'mcp_fts%' OR name LIKE 'rows_mcp_%' ORDER BY name").all();
}
const schemaVersion = (db: Database) => (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
const rowCount = (db: Database, table: "rows" | "mcp_fts") => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

// R2 records real SQL calls instead of using a load-sensitive wall-time threshold.
// schema_version also catches MCP schema that is created and then removed.
test("upgrade hook appends to 5001 full-size captures without MCP DDL or backfill; first read catches up", () => {
  const f = fixture();
  let oldest = 0;
  try {
    for (let i = 0; i < 5001; i++) {
      const prefix = i === 0 ? "beforeupgradeneedle " : `background ${i} `;
      const id = append(f.capture, prefix + "ordinary ".repeat(CAPTURE_MAX_EXCERPT).slice(0, CAPTURE_MAX_EXCERPT - prefix.length), -10000 + i);
      if (i === 0) oldest = id;
    }
  } finally { f.capture.close(); }
  const db = new Database(f.file);
  try {
    removeMcpIndex(db); // Existing pre-upgrade shard: excerpt FTS exists, MCP FTS does not.
    const schema = schemaVersion(db);
    const statements: string[] = [];
    const originalRun = Database.prototype.run, originalQuery = Database.prototype.query;
    let hook: CaptureStore | undefined;
    let justAppended: number;
    try {
      // Transparent call recorders preserve SQLite execution, bindings and return values.
      Database.prototype.run = new Proxy(originalRun, { apply(target, receiver, args) {
        if (typeof args[0] === "string") statements.push(args[0]);
        return Reflect.apply(target, receiver, args);
      } });
      Database.prototype.query = new Proxy(originalQuery, { apply(target, receiver, args) {
        if (typeof args[0] === "string") statements.push(args[0]);
        return Reflect.apply(target, receiver, args);
      } });
      hook = new CaptureStore(f.options);
      justAppended = append(hook, "duringupgradeneedle");
    } finally {
      Database.prototype.run = originalRun;
      Database.prototype.query = originalQuery;
      hook?.close();
    }
    // Restore recorders before inspection queries, which intentionally mention MCP schema.
    expect(statements.some(sql => /INSERT INTO rows/i.test(sql))).toBe(true);
    expect(statements.filter(sql => /mcp_fts|rows_mcp/i.test(sql))).toEqual([]);
    expect(rowCount(db, "rows")).toBe(5002);
    expect((db.query("SELECT length(excerpt) AS n FROM rows WHERE id = ?").get(oldest) as { n: number }).n).toBe(CAPTURE_MAX_EXCERPT);
    expect(mcpObjects(db)).toEqual([]);
    expect(schemaVersion(db)).toBe(schema);
    const reader = new CaptureStore(f.options);
    try {
      // An ordinary timeline read also has no reason to build a search index.
      expect(reader.readPage({ project, limit: 1 }).rows).toHaveLength(1);
      expect(mcpObjects(db)).toEqual([]);
      const initial = reader.readPage({ project, query: "beforeupgradeneedle", limit: 10 });
      expect((initial as { engine?: string }).engine).toBe(fts5Available() ? "fts5" : "substring");
      expect(initial.rows.map(row => row.id)).toEqual([oldest]);
      expect(reader.readPage({ project, query: "duringupgradeneedle", limit: 10 }).rows.map(row => row.id)).toEqual([justAppended]);
      if (fts5Available()) {
        expect(rowCount(db, "mcp_fts")).toBe(5002);
        const after = append(reader, "afterbackfillneedle", 1);
        expect(reader.readPage({ project, query: "afterbackfillneedle", limit: 10 }).rows.map(row => row.id)).toEqual([after]);
        expect(rowCount(db, "mcp_fts")).toBe(rowCount(db, "rows"));
        db.query("UPDATE rows SET excerpt = ? WHERE id = ?").run("updatedbackfillneedle", after);
        expect(reader.readPage({ project, query: "afterbackfillneedle", limit: 10 }).rows).toEqual([]);
        expect(reader.readPage({ project, query: "updatedbackfillneedle", limit: 10 }).rows.map(row => row.id)).toEqual([after]);
        db.query("DELETE FROM rows WHERE id = ?").run(after);
        expect(reader.readPage({ project, query: "updatedbackfillneedle", limit: 10 }).rows).toEqual([]);
        expect(rowCount(db, "mcp_fts")).toBe(rowCount(db, "rows"));
      }
    } finally { reader.close(); }
  } finally { db.close(); }
}, 20000);

test("first open under contention reads bounded fallback pages and retries lazy indexing on the same handle", () => {
  const f = fixture();
  const target = append(f.capture, "contendedneedle", -1000);
  for (let i = 0; i < 30; i++) append(f.capture, `ordinary ${i}`, -900 + i);
  f.capture.close();
  const lock = new Database(f.file);
  try {
    removeMcpIndex(lock);
    lock.run("BEGIN IMMEDIATE");
    const reader = new CaptureStore({ ...f.options, busyTimeoutMs: 1 });
    try {
      let after: { position: number; id: string } | undefined;
      const matches: number[] = [];
      for (let i = 0; i < 40; i++) {
        const page = reader.readPage({ project, query: "contendedneedle", limit: 7, after });
        expect((page as { engine?: string }).engine).toBe("substring");
        expect(page.rows.length).toBeLessThanOrEqual(7);
        matches.push(...page.rows.filter(row => row.excerpt.includes("contendedneedle")).map(row => row.id));
        if (!page.next) break;
        after = { position: page.next.position, id: page.next.id };
      }
      expect(matches).toEqual([target]);
      expect(mcpObjects(lock)).toEqual([]);
      lock.run("ROLLBACK");
      expect(reader.readPage({ project, query: "contendedneedle", limit: 7 }).rows.map(row => row.id)).toEqual([target]);
      if (fts5Available()) expect(rowCount(lock, "mcp_fts")).toBe(31);
    } finally { reader.close(); }
  } finally {
    if (lock.inTransaction) lock.run("ROLLBACK");
    lock.close();
  }
});

test("contended MCP search screens denied fallback rows before filling the public limit", async () => {
  const f = fixture();
  const target = append(f.capture, "fallbackneedle public", -1000);
  for (let i = 0; i < 300; i++) append(f.capture, "fallbackneedle private", -900 + i, ["hidden.ts"]);
  append(f.capture, "ordinary newer row", -1);
  f.capture.close();
  const lock = new Database(f.file);
  let mcp: ReturnType<typeof createMemoryMcp> | undefined;
  try {
    removeMcpIndex(lock);
    mcp = createMemoryMcp({ cwd: f.root, base: join(f.root, "memory"), project, policy: { denyPaths: ["hidden.ts"] } });
    lock.run("BEGIN IMMEDIATE");
    const found = await mcp.tools.amem_search({ query: "fallbackneedle", limit: 1 }) as { engine: string; hits: { source: string; evidence: boolean; capture: { id: number } }[] };
    expect(found.engine).toBe("substring");
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ source: "capture", evidence: false, capture: { id: target } });
    expect(mcpObjects(lock)).toEqual([]);
    lock.run("ROLLBACK");
    expect(await mcp.tools.amem_search({ query: "fallbackneedle", limit: 1 })).toMatchObject({ hits: [{ capture: { id: target } }] });
    if (fts5Available()) expect(rowCount(lock, "mcp_fts")).toBe(302);
  } finally {
    if (lock.inTransaction) lock.run("ROLLBACK");
    mcp?.close();
    lock.close();
  }
});


test("capture contention pins true substring matching for curated candidates and empty capture pages", async () => {
  const f = fixture(); f.capture.close();
  const store = new MemoryStore({ home: f.root, deferPromotions: true });
  const id = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "test", source: "person", text: "prefixcuratedsubstring", about: [] });
  store.close();
  const lock = new Database(f.file);
  let mcp: ReturnType<typeof createMemoryMcp> | undefined;
  try {
    mcp = createMemoryMcp({ cwd: f.root, base: join(f.root, "memory"), project });
    lock.run("BEGIN IMMEDIATE");
    // FTS prefix token matching cannot find this infix; the fallback must not retain its raw FTS predicate.
    expect(await mcp.tools.amem_search({ query: "curatedsubstring" })).toMatchObject({ engine: "substring", hits: [{ view: { id } }] });
    expect(mcpObjects(lock)).toEqual([]);
    expect(await mcp.tools.amem_search({ query: "prefixcuratedsubstring", includeCapture: false })).toMatchObject({ hits: [{ view: { id } }] });
    expect(mcpObjects(lock)).toEqual([]);
    lock.run("ROLLBACK");
    expect(await mcp.tools.amem_search({ query: "prefixcuratedsubstring" })).toMatchObject({ hits: [{ view: { id } }] });
    if (fts5Available()) expect(rowCount(lock, "mcp_fts")).toBe(0);
  } finally {
    if (lock.inTransaction) lock.run("ROLLBACK");
    mcp?.close(); lock.close();
  }
});
