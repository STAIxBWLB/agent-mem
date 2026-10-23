import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { SplitBudgetError, capacityReport, capacitySplit, type SplitInput } from "../src/memory/capacity.ts";
import { appendLifecycle } from "../src/memory/lifecycle.ts";

// #15 D7 / #13 R7: the advisor proposes a per-shard split of the global capture budget from use and growth. Recently used projects keep more capture, cold
// ones shrink first, the split never exceeds the budget, and it only ever proposes capture bounds: curated notes, goals and work lists are not an input.
const MB = 1048576, DAY = 24 * 3600_000, NOW = Date.parse("2026-10-23T00:00:00.000Z");
const shard = (key: string, useMb: number, growthMbPerDay: number, lastDaysAgo: number | null): SplitInput["shards"][number] =>
  ({ key, useBytes: useMb * MB, growthBytesPerDay: growthMbPerDay * MB, lastAt: lastDaysAgo === null ? null : new Date(NOW - lastDaysAgo * DAY).toISOString() });
const split = (shards: SplitInput["shards"], budgetMb: number) => capacitySplit({ budgetBytes: budgetMb * MB, shards, now: NOW });
const sum = (rows: { capMb: number }[]) => rows.reduce((total, row) => total + row.capMb, 0);

test("the split never exceeds the global budget, however many shards and whatever their use", () => {
  for (const budget of [5, 100, 1000, 20_000]) {
    const rows = split([shard("a", 50, 5, 0), shard("b", 300, 1, 3), shard("c", 10, 0, 90), shard("d", 0, 0, null), shard("e", 700, 20, 1)], budget);
    expect(sum(rows)).toBeLessThanOrEqual(budget);
    expect(rows.every(row => row.capMb >= 1 && Number.isInteger(row.capMb))).toBe(true);
  }
});

test("a recently active, growing project keeps more capture than a cold one of the same size", () => {
  const rows = split([shard("active", 100, 8, 0), shard("cold", 100, 0, 120)], 400);
  const byKey = Object.fromEntries(rows.map(row => [row.key, row]));
  expect(byKey.active!.capMb).toBeGreaterThan(byKey.cold!.capMb);
});

test("cold shards shrink first: when the budget falls, a cold shard loses before an active one does", () => {
  const shards = [shard("active", 120, 6, 0), shard("warm", 120, 1, 14), shard("cold", 120, 0, 150)];
  const wide = Object.fromEntries(split(shards, 900).map(row => [row.key, row.capMb]));
  const tight = Object.fromEntries(split(shards, 300).map(row => [row.key, row.capMb]));
  const lost = (key: string) => wide[key]! - tight[key]!;
  expect(lost("cold") / wide.cold!).toBeGreaterThanOrEqual(lost("active") / wide.active!);
  expect(tight.cold!).toBeLessThanOrEqual(tight.warm!);
  expect(tight.warm!).toBeLessThanOrEqual(tight.active!);
});

test("a shard is never proposed below what it holds right now unless the budget forces it, and a forced shrink names the reason", () => {
  const rows = split([shard("a", 40, 1, 0), shard("b", 40, 1, 1)], 500);
  for (const row of rows) { expect(row.capMb).toBeGreaterThanOrEqual(40); expect(row.reason).not.toMatch(/forced/); }
  const forced = split([shard("a", 400, 1, 0), shard("b", 400, 1, 100)], 300);
  expect(sum(forced)).toBeLessThanOrEqual(300);
  expect(forced.find(row => row.key === "b")!.reason).toMatch(/budget|shrink/);
});

test("when total use fits but total need does not, no shard goes below what it holds (hot A 10 MB, cold B 50 MB, budget 100 MB)", () => {
  const rows = split([shard("a", 10, 5, 0), shard("b", 50, 0, 120)], 100);
  const a = rows.find(row => row.key === "a")!, b = rows.find(row => row.key === "b")!;
  expect(b.capMb).toBeGreaterThanOrEqual(50);                                    // the review's example: B used to get 1 MB
  expect(a.capMb).toBeGreaterThanOrEqual(10);
  expect(sum(rows)).toBeLessThanOrEqual(100);
  expect(b.reason).not.toMatch(/smaller than what the shards hold|forces shrink/);
  expect(a.capMb - 10).toBeGreaterThan(b.capMb - 50);                             // the headroom goes to the hot shard first
});

test("property: whenever the total use fits the budget, every cap is at least its shard's use, and the sum stays within the budget", () => {
  let seed = 20261023;
  const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let middle = 0;
  for (let round = 0; round < 400; round++) {
    const count = 1 + Math.floor(next() * 6);
    const shards = Array.from({ length: count }, (_, i) => shard(`p${i}`, Math.floor(next() * 200 * next()), next() * 8 * Math.round(next()), next() < 0.1 ? null : Math.floor(next() * 400)));
    const use = shards.reduce((total, row) => total + Math.max(1, Math.ceil(row.useBytes / MB)), 0);
    const budget = Math.max(count, Math.floor(use * (0.9 + next() * 1.5)));
    const rows = split(shards, budget);
    expect(sum(rows)).toBeLessThanOrEqual(Math.max(budget, count));
    if (use <= budget) {
      middle++;
      for (const row of rows) expect(row.capMb).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(shards.find(s => s.key === row.key)!.useBytes / MB)));
    }
  }
  expect(middle).toBeGreaterThan(100);                                            // the property really exercised the fits-by-use region
});

test("retention never drops below a shard's idle time plus a month: a shard idle for a year keeps its rows, with no project emptied by gc", () => {
  for (const idle of [0, 10, 31, 60, 120, 200, 365, 500]) {
    const row = split([shard("quiet", 20, 0, idle), shard("busy", 20, 1, 0)], 1000).find(r => r.key === "quiet")!;
    expect(row.retentionDays).toBeGreaterThanOrEqual(idle + 30);                  // every row it holds is younger than its retention
  }
  expect(split([shard("never", 20, 0, null)], 1000)[0]!.retentionDays).toBeGreaterThanOrEqual(30);
});

test("with room to spare the split gives every shard at least what it uses and grows the growing ones, bounded by the budget", () => {
  const rows = split([shard("a", 20, 4, 0), shard("b", 20, 0, 60)], 10_000);
  expect(sum(rows)).toBeLessThanOrEqual(10_000);
  expect(rows.find(row => row.key === "a")!.capMb).toBeGreaterThan(rows.find(row => row.key === "b")!.capMb);
});

test("retention follows activity: a cold shard keeps a shorter window, an active one a longer one, within bounds", () => {
  const rows = split([shard("active", 50, 3, 0), shard("cold", 50, 0, 200)], 1000);
  const active = rows.find(row => row.key === "active")!, cold = rows.find(row => row.key === "cold")!;
  expect(active.retentionDays).toBeGreaterThan(cold.retentionDays);
  for (const row of rows) { expect(row.retentionDays).toBeGreaterThanOrEqual(30); expect(row.retentionDays).toBeLessThanOrEqual(365); }
});

test("the split is deterministic and independent of input order, and an empty or all-zero input is well defined", () => {
  const shards = [shard("a", 10, 1, 0), shard("b", 30, 2, 5), shard("c", 5, 0, 70)];
  expect(split([...shards].reverse(), 500)).toEqual(split(shards, 500));
  expect(split([], 500)).toEqual([]);
  const zero = split([shard("x", 0, 0, null), shard("y", 0, 0, null)], 100);
  expect(sum(zero)).toBeLessThanOrEqual(100); expect(zero.every(row => row.capMb >= 1)).toBe(true);
});

test("invalid input is refused: a negative or non-finite budget, use or growth never produces a proposal", () => {
  expect(() => split([shard("a", 1, 1, 0)], -1)).toThrow(/budget/);
  expect(() => capacitySplit({ budgetBytes: Number.NaN, shards: [], now: NOW })).toThrow(/budget/);
  expect(() => split([{ key: "a", useBytes: -1, growthBytesPerDay: 0, lastAt: null }], 10)).toThrow(/use/);
  expect(() => split([{ key: "a", useBytes: 1, growthBytesPerDay: Number.POSITIVE_INFINITY, lastAt: null }], 10)).toThrow(/growth/);
});

// ---- the report carries the split, and the split sees only capture ----
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home(): string { const dir = mkdtempSync(join(tmpdir(), "amem-split-")); dirs.push(dir); return dir; }
function seed(dir: string, project: string, rows: number, at: string): void {
  const store = new CaptureStore({ home: dir, project, retentionDays: 100_000, capMb: 100_000, now: () => NOW });
  for (let i = 0; i < rows; i++) store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: `row ${i} ${"z".repeat(400)}`, at });
  store.close();
}
const readings = { inject: { disk: { freeBytes: 500 * 1024 * MB, totalBytes: 1024 * 1024 * MB }, memoryPressure: null, metrics: [] } };

test("capacityReport carries a per-shard split of the global budget, drawn from each shard's own use and growth", () => {
  const dir = home();
  seed(dir, "github.com/o/busy", 40, new Date(NOW - DAY).toISOString());
  seed(dir, "github.com/o/quiet", 5, new Date(NOW - 100 * DAY).toISOString());
  const report = capacityReport({ home: dir, now: () => NOW, ...readings });
  expect(report.split.map(row => row.key)).toEqual(["github.com/o/busy", "github.com/o/quiet"]);
  expect(sum(report.split)).toBeLessThanOrEqual(Math.floor(report.diskShare * report.disk.freeBytes / MB));
  const [busy, quiet] = [report.split[0]!, report.split[1]!];
  expect(busy.capMb).toBeGreaterThanOrEqual(quiet.capMb);
  // the existing single proposal is unchanged for a caller that reads it
  expect(report.proposal.capMb).toBeGreaterThan(0);
});

test("archived shards are part of the split and shrink first; forgotten ones are not in it", () => {
  const dir = home(), base = join(dir, "memory");
  seed(dir, "github.com/o/a", 20, new Date(NOW - DAY).toISOString());
  seed(dir, "github.com/o/b", 20, new Date(NOW - DAY).toISOString());
  seed(dir, "github.com/o/c", 20, new Date(NOW - DAY).toISOString());
  appendLifecycle(base, { op: "archive", key: "github.com/o/b", actor: "person", machine: "m1" });
  appendLifecycle(base, { op: "forget", key: "github.com/o/c", actor: "person", machine: "m1" });
  const report = capacityReport({ home: dir, now: () => NOW, ...readings });
  expect(report.split.map(row => row.key)).toEqual(["github.com/o/a", "github.com/o/b"]);
  expect(report.split.find(row => row.key === "github.com/o/b")!.capMb).toBeLessThanOrEqual(report.split.find(row => row.key === "github.com/o/a")!.capMb);
});

test("the split reads capture only: it names no curated, goal or work-list quantity anywhere in its rows", () => {
  const dir = home();
  seed(dir, "github.com/o/a", 5, new Date(NOW - DAY).toISOString());
  const report = capacityReport({ home: dir, now: () => NOW, ...readings });
  for (const row of report.split) expect(Object.keys(row).sort()).toEqual(["capMb", "key", "reason", "retentionDays"]);
});

// ---- the activity weight itself, pinned (a rule that only shows in the tight and the surplus case) ----
test("with equal use and no growth, a surplus goes to the recently active shard in proportion to its activity weight, not equally", () => {
  const rows = split([shard("active", 50, 0, 0), shard("cold", 50, 0, 140)], 1000);
  const byKey = Object.fromEntries(rows.map(row => [row.key, row.capMb]));
  expect(byKey.active! + byKey.cold!).toBeGreaterThan(900);                     // the surplus is handed out, not left on the table
  expect(byKey.active!).toBeGreaterThan(byKey.cold! * 5);                        // a 140-day-cold shard (weight 0.02) against a fresh one (1.02): about fifty to one
  expect(byKey.cold!).toBeGreaterThanOrEqual(50);                               // and never below what it holds
});

test("with equal use and no growth under a tight budget, the cold shard is the one pushed down, and the reason says the budget did it", () => {
  const rows = split([shard("active", 200, 0, 0), shard("cold", 200, 0, 140)], 250);
  const active = rows.find(row => row.key === "active")!, cold = rows.find(row => row.key === "cold")!;
  expect(active.capMb).toBeGreaterThan(cold.capMb);
  expect(cold.capMb).toBeLessThan(200); expect(cold.reason).toMatch(/budget forces shrink/);
  expect(active.capMb + cold.capMb).toBeLessThanOrEqual(250);
});

test("a shard whose last capture time is unknown counts as cold (a year), never as active", () => {
  const rows = split([shard("known", 50, 0, 1), { key: "unknown", useBytes: 50 * MB, growthBytesPerDay: 0, lastAt: null }, { key: "garbled", useBytes: 50 * MB, growthBytesPerDay: 0, lastAt: "not a date" }], 600);
  const cap = (key: string) => rows.find(row => row.key === key)!.capMb;
  expect(cap("known")).toBeGreaterThan(cap("unknown")); expect(cap("known")).toBeGreaterThan(cap("garbled"));
  expect(cap("unknown")).toBe(cap("garbled"));
});

// #15 T5 review (codex-connector P2): a positive per-shard floor and the global bound cannot both hold when the budget has fewer whole MB than shards.
test("a budget with fewer whole MB than shards is refused, never answered with an over-budget proposal", () => {
  expect(() => split([shard("a", 1, 0, 0), shard("b", 1, 0, 1)], 1)).toThrow(SplitBudgetError);
  expect(() => split([shard("a", 0, 0, 0), shard("b", 0, 0, 1), shard("c", 0, 0, 2)], 2)).toThrow(/fewer than the 3 shards/);
  expect(() => capacitySplit({ budgetBytes: 1.9 * MB, shards: [shard("a", 0, 0, 0), shard("b", 0, 0, 1)], now: NOW })).toThrow(SplitBudgetError);   // 1.9 MB is 1 whole MB
  for (const budget of [2, 3, 7]) expect(sum(split([shard("a", 0, 0, 0), shard("b", 0, 0, 1)], budget))).toBeLessThanOrEqual(budget);   // exactly enough still splits
  expect(split([], 0)).toEqual([]);                                              // no shards need no budget
});

test("property: whenever a split is returned its sum is within the budget, with no exception for small budgets", () => {
  let seed = 7331;
  const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let refused = 0, made = 0;
  for (let round = 0; round < 300; round++) {
    const count = 1 + Math.floor(next() * 6), budget = Math.floor(next() * 12);
    const shards = Array.from({ length: count }, (_, i) => shard(`p${i}`, Math.floor(next() * 5), next() * 2, Math.floor(next() * 300)));
    try { expect(sum(split(shards, budget))).toBeLessThanOrEqual(budget); made++; } catch (error) { if (!(error instanceof SplitBudgetError)) throw error; expect(budget).toBeLessThan(count); refused++; }
  }
  expect(refused).toBeGreaterThan(20); expect(made).toBeGreaterThan(20);
});

test("capacityReport names the refusal instead of a split, and a tiny disk share does not crash the advisor", () => {
  const dir = home();
  seed(dir, "github.com/o/a", 2, "2026-10-20T00:00:00.000Z"); seed(dir, "github.com/o/b", 2, "2026-10-21T00:00:00.000Z");
  const report = capacityReport({ memoryDir: join(dir, "memory"), diskShare: 0.000001, now: () => NOW, inject: { disk: { freeBytes: 500 * 1024 * MB, totalBytes: 1024 * 1024 * MB }, memoryPressure: null, metrics: [] } });
  expect(report.split).toEqual([]); expect(report.splitRefused).toMatch(/fewer than the 2 shards/);
});
