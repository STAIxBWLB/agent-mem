import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_EVICT_BATCH_ROWS, CAPTURE_EVICT_MAX_BATCHES, CaptureStore, captureShardStats, writeCaptureConfig } from "../src/memory/capture.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";
import { readCatalog, rebuildCatalog, scanCatalog } from "../src/memory/catalog.ts";
import { shardDir, shardMachineDir } from "../src/memory/shard.ts";
import { machineId } from "../src/memory/store.ts";
import { planGc, runGc } from "../src/memory/gc.ts";
import { usageReport, usageText } from "../src/memory/usage.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";

// #15 T5 / D3: `amem usage` and `amem gc`. gc applies each shard's own retention and cap through the capture store's bounded evict(); it never opens a
// curated store or a work list, so those can neither be evicted nor rewritten (AC5 of #13, D7 of #15).
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const DAY = 24 * 3600_000, NOW = Date.parse("2026-10-23T00:00:00.000Z");
function home(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "amem-gc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, base: join(dir, "memory") };
}
function fill(dir: string, project: string, rows: { daysAgo: number; excerpt?: string }[], config?: { capMb?: number; retentionDays?: number }): void {
  const store = new CaptureStore({ home: dir, project, now: () => NOW, retentionDays: 100_000, capMb: 100_000 });
  for (const [i, r] of rows.entries()) store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: r.excerpt ?? `row ${i} ${"x".repeat(200)}`, at: new Date(NOW - r.daysAgo * DAY).toISOString() });
  const machineDir = store.dir; store.close();
  if (config) writeCaptureConfig(machineDir, config);
}
const machineDirOf = (base: string, key: string) => shardMachineDir(base, key, machineId(base).id);
const rowsOf = (base: string, key: string) => captureShardStats(machineDirOf(base, key)).rows;

test("planGc reports each shard's expired rows and over-cap bytes without writing anything", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 1 }, { daysAgo: 5 }, { daysAgo: 40 }, { daysAgo: 60 }], { retentionDays: 30 });
  fill(dir, "github.com/o/b", [{ daysAgo: 1 }, { daysAgo: 2 }], { retentionDays: 30 });
  const before = rowsOf(base, "github.com/o/a");
  const plan = planGc(base, { now: () => NOW });
  expect(plan.map(p => [p.key, p.expiredRows, p.overCap])).toEqual([["github.com/o/a", 2, false], ["github.com/o/b", 0, false]]);
  expect(rowsOf(base, "github.com/o/a")).toBe(before);
});

test("runGc evicts expired rows in every shard by that shard's own retention, and a shard with nothing to do is left alone", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 1 }, { daysAgo: 40 }, { daysAgo: 60 }], { retentionDays: 30 });
  fill(dir, "github.com/o/b", [{ daysAgo: 40 }, { daysAgo: 60 }], { retentionDays: 90 });   // its own, longer window
  const result = runGc(base, { now: () => NOW });
  expect(rowsOf(base, "github.com/o/a")).toBe(1);
  expect(rowsOf(base, "github.com/o/b")).toBe(2);
  expect(result.shards.find(s => s.key === "github.com/o/a")).toMatchObject({ expired: 2, trimmed: 0, remainingOverCap: false });
  expect(result.shards.find(s => s.key === "github.com/o/b")).toMatchObject({ expired: 0 });
});

test("a cap shrink trims oldest rows first, in bounded batches, and the report says when a shard is still over its cap", () => {
  const { dir, base } = home();
  // 6000 rows of about 1.5 KB (9 MB), ordered oldest first, against a 1 MB cap: more than one evict() window (4 batches of 256 rows) must remove.
  const rows = Array.from({ length: 6000 }, (_, i) => ({ daysAgo: 6000 - i, excerpt: `row ${i} ${"y".repeat(1500)}` }));
  fill(dir, "github.com/o/big", rows, { capMb: 1 });
  expect(captureShardStats(machineDirOf(base, "github.com/o/big")).bytes).toBeGreaterThan(8_000_000);
  const first = runGc(base, { now: () => NOW, maxBatchesPerShard: 1 });
  const row = first.shards[0]!;
  expect(row.batches).toBe(1);
  // One evict() call is bounded by CAPTURE_EVICT_MAX_MS of wall time (its trim loop repeats 4-batch windows while time remains), so the row count per call
  // depends on machine speed: the bound that holds everywhere is whole batches, and never the whole shard in one pass.
  expect(row.trimmed % CAPTURE_EVICT_BATCH_ROWS).toBe(0);
  expect(row.trimmed).toBeGreaterThanOrEqual(CAPTURE_EVICT_BATCH_ROWS);
  expect(row.trimmed).toBeLessThan(6000);
  expect(row.trimmed).toBeGreaterThan(0);
  expect(row.remainingOverCap).toBe(true);
  // the oldest went first: the newest row is still there
  const store = new CaptureStore({ home: dir, project: "github.com/o/big", lifecycle: "ignore" });
  cleanup.push(() => store.close());
  expect(store.rows({ limit: 9000 }).at(-1)!.excerpt.startsWith("row 5999 ")).toBe(true);
  expect(store.rows({ limit: 9000 })[0]!.excerpt.startsWith("row 0 ")).toBe(false);
  // repeated runs converge under the cap, and the last one reports it. Each evict() window is also bounded by 25 ms of wall time, so a loaded machine trims
  // fewer rows per call: the loop is bounded by progress (rows left), never by a fixed number of calls that speed could exhaust.
  let last = row, guard = 0, rowsLeft = rowsOf(base, "github.com/o/big");
  while (last.remainingOverCap && guard++ < 2000) {
    last = runGc(base, { now: () => NOW, maxBatchesPerShard: 1 }).shards[0]!;
    const now = rowsOf(base, "github.com/o/big");
    if (last.remainingOverCap) expect(now).toBeLessThan(rowsLeft);        // every call that leaves the shard over its cap still removed something
    rowsLeft = now;
  }
  expect(last.remainingOverCap).toBe(false);
  expect(captureShardStats(machineDirOf(base, "github.com/o/big")).bytes).toBeLessThanOrEqual(1024 * 1024);
});

test("gc never touches curated logs or work lists: their files are byte-identical before and after", async () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 400 }, { daysAgo: 300 }, { daysAgo: 1 }], { retentionDays: 30 });
  const work = new WorkListStore({ base, project: "github.com/o/a", policy: () => true, now: () => NOW });
  await work.write("checklist", { title: "keep me", state: "open" }); work.close();
  // a curated-looking file in the shard, as a split home would have
  const logDir = join(shardDir(base, "github.com/o/a"), "log"); mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "m1.jsonl"), '{"schema":"agent-hub.memory/v1","kind":"decision","text":"keep"}\n');
  const snapshot = () => Object.fromEntries([...walk(join(shardDir(base, "github.com/o/a")))].filter(([p]) => !p.includes("/machine/")));
  const before = snapshot();
  runGc(base, { now: () => NOW });
  expect(snapshot()).toEqual(before);
  expect(Object.keys(before).some(p => p.includes("/work/"))).toBe(true);
  expect(Object.keys(before).some(p => p.endsWith("/log/m1.jsonl"))).toBe(true);
});
function* walk(root: string): Generator<[string, string]> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield [path, `${statSync(path).size}:${readFileSync(path).toString("base64")}`];
  }
}

test("gc leaves other shards' rows and bytes alone when only one is over its bound, and it reaches an archived shard (cold shards shrink too)", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 100 }, { daysAgo: 1 }], { retentionDays: 30 });
  fill(dir, "github.com/o/b", [{ daysAgo: 100 }, { daysAgo: 1 }], { retentionDays: 365 });
  appendLifecycle(base, { op: "archive", key: "github.com/o/a", actor: "person", machine: "m1" });
  const result = runGc(base, { now: () => NOW });
  expect(rowsOf(base, "github.com/o/a")).toBe(1);   // archived but still bounded by its retention
  expect(rowsOf(base, "github.com/o/b")).toBe(2);
  expect(result.shards.map(s => s.key)).toEqual(["github.com/o/a", "github.com/o/b"]);
});

test("a forgotten project is skipped by gc and listed as skipped, never opened", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 100 }], { retentionDays: 30 });
  appendLifecycle(base, { op: "forget", key: "github.com/o/a", actor: "person", machine: "m1" });
  const result = runGc(base, { now: () => NOW });
  expect(result.shards).toEqual([]);
  expect(result.skipped).toEqual([{ key: "github.com/o/a", reason: "forgotten" }]);
  expect(rowsOf(base, "github.com/o/a")).toBe(1);
});

test("--dry-run style: runGc with dryRun writes nothing and returns the plan's numbers", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 100 }, { daysAgo: 1 }], { retentionDays: 30 });
  const result = runGc(base, { now: () => NOW, dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(result.shards[0]).toMatchObject({ expired: 1, trimmed: 0 });
  expect(rowsOf(base, "github.com/o/a")).toBe(2);
});

test("an unreadable or locked shard is reported as skipped and never stops the other shards", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 100 }], { retentionDays: 30 });
  fill(dir, "github.com/o/b", [{ daysAgo: 100 }], { retentionDays: 30 });
  writeFileSync(join(machineDirOf(base, "github.com/o/a"), "capture.db"), "not a database");
  const result = runGc(base, { now: () => NOW });
  expect(result.skipped.map(s => s.key)).toEqual(["github.com/o/a"]);
  expect(result.skipped[0]!.reason).toMatch(/unreadable|locked/);
  expect(rowsOf(base, "github.com/o/b")).toBe(0);
});

test("usageReport totals the shards, ranks the largest, and is honest about an unavailable curated count", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/small", [{ daysAgo: 1 }]);
  fill(dir, "github.com/o/large", Array.from({ length: 50 }, (_, i) => ({ daysAgo: i })));
  fill(dir, "github.com/o/medium", Array.from({ length: 10 }, (_, i) => ({ daysAgo: i })));
  const report = usageReport(base, { limit: 2 });
  expect(report.totals).toMatchObject({ shards: 3, captureRows: 61 });
  expect(report.totals.captureBytes).toBeGreaterThan(0);
  expect(report.totals.diskBytes).toBeGreaterThanOrEqual(report.totals.captureBytes);
  expect(report.largest.map(p => p.key)).toEqual(["github.com/o/large", "github.com/o/medium"]);
  expect(report.projects).toHaveLength(3);
  expect(report.curatedSplit).toBe(false);
  expect(report.totals.curatedEntries).toBeNull();            // an unsplit home has no per-project curated count: unavailable, never 0
  expect(usageText(report)).toContain("home not split into shards");
});

test("the catalog carries each project's state, lists archived ones, and leaves forgotten ones out of the default listing and usage totals", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 1 }]); fill(dir, "github.com/o/b", [{ daysAgo: 1 }]); fill(dir, "github.com/o/c", [{ daysAgo: 1 }]);
  appendLifecycle(base, { op: "archive", key: "github.com/o/b", actor: "person", machine: "m1" });
  appendLifecycle(base, { op: "forget", key: "github.com/o/c", actor: "person", machine: "m1" });
  const all = scanCatalog(base);
  expect(all.map(p => [p.key, p.state])).toEqual([["github.com/o/a", "active"], ["github.com/o/b", "archived"], ["github.com/o/c", "forgotten"]]);
  expect(usageReport(base).projects.map(p => p.key)).toEqual(["github.com/o/a", "github.com/o/b"]);
  expect(usageReport(base, { includeForgotten: true }).projects.map(p => p.key)).toEqual(["github.com/o/a", "github.com/o/b", "github.com/o/c"]);
  // catalog.db stays derived: deleting it and rebuilding reproduces the same rows, state included (#15 AC5)
  const built = rebuildCatalog({ home: dir });
  expect(readCatalog({ home: dir })).toEqual(built);
  rmSync(join(base, "catalog.db"));
  expect(rebuildCatalog({ home: dir })).toEqual(built);
  expect(existsSync(join(base, "catalog.db"))).toBe(true);
});

test("a catalog.db from before the state column is rebuilt, never read as all-active", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 1 }]);
  appendLifecycle(base, { op: "archive", key: "github.com/o/a", actor: "person", machine: "m1" });
  rebuildCatalog({ home: dir });
  const { Database } = require("bun:sqlite");
  const db = new Database(join(base, "catalog.db")); db.run("ALTER TABLE projects DROP COLUMN state"); db.close();
  expect(readCatalog({ home: dir }).map(p => p.state)).toEqual(["archived"]);
});

test("readCatalog reports the live lifecycle state: an op after the catalog was built shows without a rebuild", () => {
  const { dir, base } = home();
  fill(dir, "github.com/o/a", [{ daysAgo: 1 }]);
  rebuildCatalog({ home: dir });
  expect(readCatalog({ home: dir }).find(p => p.key === "github.com/o/a")!.state).toBe("active");
  appendLifecycle(base, { op: "archive", key: "github.com/o/a", actor: "person", machine: "m1" });
  expect(readCatalog({ home: dir }).find(p => p.key === "github.com/o/a")!.state).toBe("archived");   // the cached row said active
  appendLifecycle(base, { op: "forget", key: "github.com/o/a", actor: "person", machine: "m1" });
  expect(readCatalog({ home: dir }).find(p => p.key === "github.com/o/a")!.state).toBe("forgotten");
});
