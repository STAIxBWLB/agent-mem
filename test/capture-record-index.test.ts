import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(rawRows: number, indexed: boolean) {
  const f = hookFixture(); cleanup.push(f.close);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  const file = join(store.dir, "capture.db"); store.close();
  const db = new Database(file), at = Date.now() - 60_000;
  try {
    const insert = db.query("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes,subagent) VALUES (?,?,'claude',?,'[\"src/a.ts\"]',?,100,?)");
    db.transaction(() => {
      insert.run(new Date(at).toISOString(), f.project, "Record", "amem: finding | src/a.ts | older record", null);
      insert.run(new Date(at + 1).toISOString(), f.project, "Record", "amem: finding | src/a.ts | hidden subagent", 1);
      for (let n = 0; n < rawRows; n++) insert.run(new Date(at + 100 + n).toISOString(), f.project, "PostToolUse", `raw ${n}`, null);
    }).immediate();
    if (!indexed) db.run("DROP INDEX rows_brief_records_v1");
  } finally { db.close(); }
  return { ...f, file };
}

test("Record partial index finds older main-session records beyond the native raw window", () => {
  const f = fixture(1000, true);
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true, maxReadRows: 128 });
  try {
    expect(capture.recentReadTruncated).toBe(true);
    expect(capture.readBriefRecords()).toMatchObject({ partial: false, rows: [{ excerpt: "amem: finding | src/a.ts | older record" }] });
  } finally { capture.close(); }
  const db = new Database(f.file, { readonly: true });
  try {
    const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM rows INDEXED BY rows_brief_records_v1 WHERE project=? AND event='Record' AND (subagent IS NULL OR subagent != 1) ORDER BY at DESC,id DESC LIMIT 33").all(f.project) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("rows_brief_records_v1"))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally { db.close(); }
});

test("large legacy Record history stays bounded and partial until off-hook preparation", () => {
  const f = fixture(1000, false);
  const first = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { expect(first.readBriefRecords()).toEqual({ rows: [], partial: true }); } finally { first.close(); }
  const db = new Database(f.file, { readonly: true });
  try { expect(db.query("SELECT name FROM sqlite_master WHERE name='rows_brief_records_v1'").get()).toBeNull(); } finally { db.close(); }
  const search = new CaptureStore({ memoryDir: f.base, project: f.project });
  try {
    search.readPage({ project: f.project, query: "record", limit: 1 });
    expect(search.readBriefRecords()).toMatchObject({ partial: false, rows: [{ excerpt: "amem: finding | src/a.ts | older record" }] });
  } finally { search.close(); }
});

test("small legacy hook opens prepare the Record index only at or below 128 rows", () => {
  for (const rows of [128, 129]) {
    const f = fixture(rows - 2, false), capture = new CaptureStore({ memoryDir: f.base, project: f.project }); capture.close();
    const db = new Database(f.file, { readonly: true });
    try { expect(!!db.query("SELECT name FROM sqlite_master WHERE name='rows_brief_records_v1'").get()).toBe(rows === 128); } finally { db.close(); }
  }
});

test("Record readers are bounded and do not prepare an index on a readonly legacy store", () => {
  const f = fixture(3, false);
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true });
  try {
    expect(capture.readBriefRecords(1).rows).toHaveLength(1);
    for (const limit of [0, 33, 1.5, NaN]) expect(() => capture.readBriefRecords(limit)).toThrow("use an integer from 1 to 32");
  } finally { capture.close(); }
  const db = new Database(f.file, { readonly: true });
  try { expect(db.query("SELECT name FROM sqlite_master WHERE name='rows_brief_records_v1'").get()).toBeNull(); } finally { db.close(); }
});
