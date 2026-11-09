import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { outsideCountPlanIsBounded } from "../src/memory/capture-plan.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** A shard whose Records are older than a wall of tool rows, written past the store so the derived index exists. */
function fixture(spec: { records: number; tools: number; indexed?: boolean }) {
  const f = hookFixture(); cleanup.push(f.close);
  const store = new CaptureStore({ memoryDir: f.base, project: f.project });
  const file = join(store.dir, "capture.db"); store.close();
  const db = new Database(file), at = Date.now() - 6_000_000;
  try {
    const insert = db.query("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes,subagent) VALUES (?,?,'claude',?,'[\"src/a.ts\"]',?,100,?)");
    db.transaction(() => {
      for (let n = 0; n < spec.records; n++) insert.run(new Date(at + n).toISOString(), f.project, "Record", `amem: finding ${n}`, null);
      for (let n = 0; n < spec.tools; n++) insert.run(new Date(at + 100_000 + n).toISOString(), f.project, "PostToolUse", `raw ${n}`, null);
    }).immediate();
    if (spec.indexed === false) db.run("DROP INDEX rows_brief_records_v1");
  } finally { db.close(); }
  return { ...f, file, at };
}

const reader = (f: { base: string; project: string }, maxReadRows = 128) => {
  const store = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true, recentReadRows: true, maxReadRows });
  cleanup.push(() => store.close());
  return store;
};

test("Records behind a wall of tool rows are counted outside the window", () => {
  const f = fixture({ records: 5, tools: 400 }), capture = reader(f);
  expect(capture.recentReadTruncated).toBe(true);
  expect(capture.rows()).toHaveLength(128);
  expect(capture.rows().some(row => row.event === "Record")).toBe(false);
  expect(capture.countOutsideRecent({ event: "Record" })).toEqual({ rows: 5, capped: false, available: true });
});

test("the count stops at the window bound and reports capped", () => {
  const f = fixture({ records: 300, tools: 400 });
  expect(reader(f).countOutsideRecent({ event: "Record" })).toEqual({ rows: 128, capped: true, available: true });
  // Exactly the bound is not capped: the window bound doubles as the count's cost bound.
  expect(reader(f, 300).countOutsideRecent({ event: "Record" })).toEqual({ rows: 300, capped: false, available: true });
});

test("the since lower bound is the host's, and older Records fall outside it", () => {
  const f = fixture({ records: 4, tools: 400 });
  const cutoff = new Date(f.at + 2).toISOString();
  expect(reader(f).countOutsideRecent({ event: "Record", since: cutoff })).toEqual({ rows: 2, capped: false, available: true });
});

test("subagent and foreign-project Records are not in the cohort", () => {
  const f = fixture({ records: 3, tools: 400 });
  const db = new Database(f.file);
  try {
    const insert = db.query("INSERT INTO rows(at,project,agent,event,paths,excerpt,bytes,subagent) VALUES (?,?,'claude','Record','[\"src/a.ts\"]',?,100,?)");
    db.transaction(() => {
      insert.run(new Date(Date.now() - 6_000_000 - 9000).toISOString(), f.project, "amem: subagent finding", 1);
      insert.run(new Date(Date.now() - 6_000_000 - 9000).toISOString(), "other-project", "amem: foreign finding", null);
    }).immediate();
  } finally { db.close(); }
  expect(reader(f).countOutsideRecent({ event: "Record" })).toEqual({ rows: 3, capped: false, available: true });
});

test("the answering plan is a bounded seek on the derived index, never a table scan", () => {
  const f = fixture({ records: 5, tools: 400 }), capture = reader(f);
  capture.countOutsideRecent({ event: "Record" });
  const db = new Database(f.file, { readonly: true });
  try {
    const boundary = db.query("SELECT at, id FROM rows ORDER BY at DESC, id DESC LIMIT 1 OFFSET 127").get() as { at: string; id: number };
    for (const sql of [
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM rows INDEXED BY rows_brief_records_v1 WHERE project=? AND event='Record' AND (subagent IS NULL OR subagent != 1) AND (at,id) < (?,?) LIMIT ?)",
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM rows INDEXED BY rows_brief_records_v1 WHERE project=? AND event='Record' AND (subagent IS NULL OR subagent != 1) AND (at,id) < (?,?) AND at >= ? LIMIT ?)",
    ]) {
      const bind = sql.includes("at >= ?") ? [f.project, boundary.at, boundary.id, "1970-01-01T00:00:00.000Z", 129] : [f.project, boundary.at, boundary.id, 129];
      const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...bind) as { detail: string }[];
      expect(plan.some(row => /^SEARCH rows USING INDEX rows_brief_records_v1 \(project=\?[^)]*at<\?/.test(row.detail))).toBe(true);
      expect(plan.some(row => /^SCAN rows\b/.test(row.detail) || row.detail.includes("TEMP B-TREE"))).toBe(false);
    }
  } finally { db.close(); }
});

test("a store without the derived index reports unavailable instead of counting or scanning", () => {
  const f = fixture({ records: 5, tools: 400, indexed: false }), capture = reader(f);
  expect(capture.countOutsideRecent({ event: "Record" })).toEqual({ rows: 0, capped: false, available: false });
  const db = new Database(f.file, { readonly: true });
  try { expect(db.query("SELECT name FROM sqlite_master WHERE name='rows_brief_records_v1'").get()).toBeNull(); } finally { db.close(); }
});

test("an event without a derived index is unavailable, not a quiet fallback", () => {
  const f = fixture({ records: 5, tools: 400 });
  expect(reader(f).countOutsideRecent({ event: "PostToolUse" })).toEqual({ rows: 0, capped: false, available: false });
});

test("outside counts need a read-only store opened with the recent window", () => {
  const f = fixture({ records: 1, tools: 3 });
  const writable = new CaptureStore({ memoryDir: f.base, project: f.project }); cleanup.push(() => writable.close());
  expect(() => writable.countOutsideRecent({ event: "Record" })).toThrow("require a read-only recent window");
  const bounded = new CaptureStore({ memoryDir: f.base, project: f.project, readOnly: true }); cleanup.push(() => bounded.close());
  expect(() => bounded.countOutsideRecent({ event: "Record" })).toThrow("require a read-only recent window");
  const capture = reader(f);
  for (const event of ["", " ", "x".repeat(65)]) expect(() => capture.countOutsideRecent({ event })).toThrow("invalid capture event filter");
  for (const since of ["", "x".repeat(65)]) expect(() => capture.countOutsideRecent({ event: "Record", since })).toThrow("invalid capture since bound");
});

test("a plan that is not the bounded seek answers unavailable, without throwing", () => {
  const f = fixture({ records: 5, tools: 400 });
  // The derived index's name, the wrong shape: the planner can only seek the project, so the walk is unbounded.
  const db = new Database(f.file);
  try {
    db.run("DROP INDEX rows_brief_records_v1");
    db.run("CREATE INDEX rows_brief_records_v1 ON rows(project)");
  } finally { db.close(); }
  const capture = reader(f);
  expect(() => capture.countOutsideRecent({ event: "Record" })).not.toThrow();
  expect(capture.countOutsideRecent({ event: "Record" })).toEqual({ rows: 0, capped: false, available: false });
});

test("the plan guard reads the bounded seek and refuses a scan, a temp sort or a project-only walk", () => {
  const open = { detail: "CO-ROUTINE (subquery-1)" }, read = { detail: "SCAN (subquery-1)" };
  expect(outsideCountPlanIsBounded([open, { detail: "SEARCH rows USING INDEX rows_brief_records_v1 (project=? AND at<?)" }, read])).toBe(true);
  expect(outsideCountPlanIsBounded([open, { detail: "SEARCH rows USING INDEX rows_brief_records_v1 (project=? AND at>? AND at<?)" }, read])).toBe(true);
  expect(outsideCountPlanIsBounded([open, { detail: "SEARCH rows USING INDEX rows_brief_records_v1 (project=?)" }, read])).toBe(false);
  expect(outsideCountPlanIsBounded([open, { detail: "SCAN rows USING INDEX rows_brief_records_v1" }, read])).toBe(false);
  expect(outsideCountPlanIsBounded([open, { detail: "SCAN rows" }, read])).toBe(false);
  expect(outsideCountPlanIsBounded([open, { detail: "SEARCH rows USING INDEX rows_brief_records_v1 (project=? AND at<?)" }, { detail: "USE TEMP B-TREE FOR ORDER BY" }])).toBe(false);
  expect(outsideCountPlanIsBounded([])).toBe(false);
});
