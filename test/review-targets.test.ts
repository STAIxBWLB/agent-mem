import { expect, test } from "bun:test";
import { noRecentReview, reviewTargets } from "../src/memory/review-targets.ts";
import type { View } from "../src/memory/store.ts";
import { summarizeMemoryUse } from "../src/memory/use-telemetry.ts";
import type { Counter } from "../src/memory/candidates.ts";

test("review target selection is deterministic and orders stale, rendered, then volatile", () => {
  const view = (id: string, kind: string): View => ({ id, kind, at: "2026-01-01T00:00:00.000Z", supersededBy: null } as View);
  const views = [view("a", "decision"), view("b", "finding"), view("c", "contract")];
  const options = {
    now: Date.parse("2026-02-10T00:00:00.000Z"), recheckDays: 30, limit: 10,
    stale: (row: View) => row.id === "b",
    use: (row: View) => ({ state: "known" as const, records: 1, rendered: row.id === "a" ? 4 : 0, delivered: 1, cited: 0 }),
    eligibleForRecheck: () => true,
  };
  const first = reviewTargets(views, options);
  expect(first.map(row => [row.id, row.reason])).toEqual([["b", "stale"], ["a", "rendered"], ["c", "volatile"]]);
  expect(JSON.stringify(reviewTargets(views, options))).toBe(JSON.stringify(first));
});

test("a missing metric remains unknown when delivery observations are combined", () => {
  const row = (delivered: number | null, cited: number | null): Counter => ({ id: "fixture", key: { entryId: "a".repeat(32), project: "p", deliveryId: "d" }, createdAt: "2026-01-01T00:00:00.000Z", rendered: 20, delivered, cited });
  expect(summarizeMemoryUse([row(null, 0)]).delivered).toBeNull();
  expect(summarizeMemoryUse([row(1, null)]).cited).toBeNull();
  expect(summarizeMemoryUse([row(1, 0), row(1, 0)]).cited).toBe(0);
});

test("review recency uses retained decided candidate creation time", () => {
  const snapshot = { counters: [], decided: [{ at: 100, targets: ["a", "b"] }, { at: 200, targets: ["c"] }] };
  expect(noRecentReview(snapshot, "a", 100)).toBe(false);
  expect(noRecentReview(snapshot, "a", 101)).toBe(true);
  expect(noRecentReview(snapshot, "missing", 0)).toBe(true);
});
