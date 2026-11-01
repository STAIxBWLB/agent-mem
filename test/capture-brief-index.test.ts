import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const f = hookFixture(); cleanup.push(f.close); return f; }
function legacy(f: ReturnType<typeof fixture>, rawRows: number, recap = true) {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project }), file = join(store.dir, "capture.db"); store.close();
  const db = new Database(file), at = new Date().toISOString();
  try {
    for (const name of ["rows_brief_ai", "rows_brief_ad", "rows_brief_au"]) db.run(`DROP TRIGGER ${name}`);
    db.run("DROP TABLE brief_summaries_v1"); db.run("DELETE FROM meta WHERE key LIKE 'brief-v1-%'");
    const insert = db.query("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes) VALUES (?,?,'fixture',?,'[]',?,100)");
    db.transaction(() => { for (let i = 0; i < rawRows; i++) { insert.run(at, f.project, "PostToolUse", "legacy raw"); if (recap && i === Math.floor(rawRows / 2)) insert.run(at, f.project, "Recap", "legacy recap"); } }).immediate();
    db.run("INSERT OR REPLACE INTO meta(key,value) SELECT 'bytes', CAST(SUM(bytes) AS TEXT) FROM rows");
  } finally { db.close(); }
}

test("legacy summary history is explicitly partial until bounded backfill or off-hook indexing covers it", () => {
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
  try { expect(store.readBriefSummaries()).toEqual({ rows: [], partial: false }); } finally { store.close(); }
});

test("a published 0.18.0 writer maintains the new summary index through SQLite triggers", () => {
  const f = fixture(), initial = new CaptureStore({ memoryDir: f.base, project: f.project }); initial.close();
  const module = pathToFileURL(resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v018/src/memory/capture.ts")).href;
  const code = `const {CaptureStore}=await import(${JSON.stringify(module)});const s=new CaptureStore(${JSON.stringify({ memoryDir: f.base, project: f.project, cwd: f.cwd })});try{s.append({project:${JSON.stringify(f.project)},agent:'fixture',event:'Recap',excerpt:'from old writer'});}finally{s.close();}`;
  const result = Bun.spawnSync([process.execPath, "--smol", "-e", code], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  let file: string;
  try { file = join(store.dir, "capture.db"); expect(store.readBriefSummaries().rows.map(row => row.excerpt)).toEqual(["from old writer"]); } finally { store.close(); }
  const db = new Database(file!); try { db.run("DELETE FROM rows"); } finally { db.close(); }
  const after = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  try { expect(after.readBriefSummaries().rows).toEqual([]); } finally { after.close(); }
});
