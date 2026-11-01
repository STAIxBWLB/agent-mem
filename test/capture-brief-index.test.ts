import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as searchFts from "../src/memory/search-fts.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const f = hookFixture(); cleanup.push(f.close); return f; }
function legacy(f: ReturnType<typeof fixture>, rawRows: number, recap = true) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project }), file = join(store.dir, "capture.db"); store.close();
  const db = new Database(file), at = new Date().toISOString();
  try {
    db.run("DROP INDEX rows_brief_summaries_v1");
    const insert = db.query("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes) VALUES (?,?,'fixture',?,'[]',?,100)");
    db.transaction(() => { for (let i = 0; i < rawRows; i++) { insert.run(at, f.project, "PostToolUse", "legacy raw"); if (recap && i === Math.floor(rawRows / 2)) insert.run(at, f.project, "Recap", "legacy recap"); } }).immediate();
    db.run("INSERT OR REPLACE INTO meta(key,value) SELECT 'bytes', CAST(SUM(bytes) AS TEXT) FROM rows");
  } finally { db.close(); }
}

test("legacy summary history stays bounded and partial until off-hook index preparation", () => {
  const f = fixture(); legacy(f, 1000);
  const first = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { expect(first.readBriefSummaries()).toEqual({ rows: [], partial: true }); } finally { first.close(); }
  const next = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    next.readPage({ project: f.project, query: "legacy", limit: 1 });
    const summary = next.readBriefSummaries();
    expect(summary.partial).toBe(false); expect(summary.rows.map(row => row.excerpt)).toEqual(["legacy recap"]);
  } finally { next.close(); }
});

test("a small readonly legacy history is complete without creating derived tables", () => {
  const f = fixture(); legacy(f, 10, false);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  const file = join(store.dir, "capture.db");
  try { expect(store.readBriefSummaries()).toEqual({ rows: [], partial: false }); } finally { store.close(); }
  const db = new Database(file, { readonly: true });
  try { expect(db.query("SELECT name FROM sqlite_master WHERE name='rows_brief_summaries_v1'").all()).toEqual([]); } finally { db.close(); }
});

test("a published 0.18.0 writer is covered by ordinary SQLite partial-index maintenance", () => {
  const f = fixture(), initial = new CaptureStore({ memoryDir: f.base, project: f.project }); initial.close();
  const module = pathToFileURL(resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v018/src/memory/capture.ts")).href;
  const code = `const {CaptureStore}=await import(${JSON.stringify(module)});const s=new CaptureStore(${JSON.stringify({ memoryDir: f.base, project: f.project, cwd: f.cwd })});try{s.append({project:${JSON.stringify(f.project)},agent:'fixture',event:'Recap',excerpt:'from old writer'});}finally{s.close();}`;
  const result = Bun.spawnSync([process.execPath, "--smol", "-e", code], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  let file: string;
  try { file = join(store.dir, "capture.db"); expect(store.readBriefSummaries().rows.map(row => row.excerpt)).toEqual(["from old writer"]); } finally { store.close(); }
  const db = new Database(file!);
  try { db.run("DELETE FROM rows"); expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" }); } finally { db.close(); }
  const after = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  try { expect(after.readBriefSummaries().rows).toEqual([]); } finally { after.close(); }
});

test("off-hook summary completion remains available with the substring fallback", () => {
  const f = fixture(); legacy(f, 1000);
  const probe = spyOn(searchFts, "fts5Available").mockReturnValue(false);
  let store: CaptureStore | undefined;
  try {
    store = new CaptureStore({ memoryDir: f.base, project: f.project });
    expect(store.readBriefSummaries().partial).toBe(true);
    expect(store.readPage({ project: f.project, query: "legacy", match: "substring", limit: 1 }).rows.length).toBe(1);
    expect(store.readBriefSummaries().rows.map(row => row.excerpt)).toEqual(["legacy recap"]);
    expect(store.readBriefSummaries().partial).toBe(false);
  } finally { store?.close(); probe.mockRestore(); }
});

test("the small-store build decision cannot race a concurrent writer", () => {
  const f = fixture(); legacy(f, 10, false);
  const opened = new CaptureStore({ memoryDir: f.base, project: f.project }); const file = join(opened.dir, "capture.db"); opened.close();
  const other = new Database(file); other.run("DROP INDEX rows_brief_summaries_v1"); other.run("PRAGMA busy_timeout=0");
  const original = Database.prototype.query;
  let attempted = false, store: CaptureStore | undefined;
  const intercept = spyOn(Database.prototype, "query").mockImplementation((function(this: Database, sql: string) {
    const statement = original.call(this, sql);
    if (sql !== "SELECT COUNT(*) AS n FROM (SELECT 1 FROM rows LIMIT 129)") return statement;
    return { get: () => {
      const result = statement.get(); attempted = true;
      expect(() => other.run("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes) VALUES ('2026-11-01T00:00:00.000Z','fixture','fixture','PostToolUse','[]','raw',100)")).toThrow(/lock|busy/i);
      return result;
    } } as typeof statement;
  }) as typeof Database.prototype.query);
  try { store = new CaptureStore({ memoryDir: f.base, project: f.project, busyTimeoutMs: 0 }); expect(attempted).toBe(true); }
  finally { intercept.mockRestore(); store?.close(); other.close(); }
});

test("the actual indexed summary read uses rows_brief_summaries_v1 without a temporary sort", () => {
  const f = fixture(); legacy(f, 1000);
  const prepare = new CaptureStore({ memoryDir: f.base, project: f.project }), file = join(prepare.dir, "capture.db");
  try { prepare.readPage({ project: f.project, query: "legacy", limit: 1 }); }
  finally { prepare.close(); }
  const reader = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  const original = Database.prototype.query;
  let summarySql: string | undefined;
  const probe = spyOn(Database.prototype, "query").mockImplementation((function(this: Database, sql: string) {
    if (sql.startsWith("SELECT * FROM rows INDEXED BY rows_brief_summaries_v1")) summarySql = sql;
    return original.call(this, sql);
  }) as typeof Database.prototype.query);
  try { expect(reader.readBriefSummaries().rows.map(row => row.excerpt)).toEqual(["legacy recap"]); }
  finally { probe.mockRestore(); reader.close(); }
  expect(summarySql).toBeDefined();
  const db = new Database(file, { readonly: true });
  try {
    const plan = db.query(`EXPLAIN QUERY PLAN ${summarySql!}`).all(f.project, 33) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("USING INDEX rows_brief_summaries_v1"))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally { db.close(); }
});
