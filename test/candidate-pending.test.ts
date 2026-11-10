import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../src/memory/candidates.ts";
import { markShown, pendingSummary } from "../src/memory/candidate-pending.ts";

const roots: string[] = [], DAY = 86400_000;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const home = () => { const root = mkdtempSync(join(tmpdir(), "amem-pending-day-")); roots.push(root); return root; };
function seed(base: string, project: string, at: number) {
  const store = new CandidateStore({ memoryDir: base, now: () => at });
  try { return store.put({ project, kind: "memory", text: `Public day-boundary fixture ${project}` }, "public"); }
  finally { store.close(); }
}
test("a scoped candidate day callback reaches the exact ceiling boundary hidden by the home summary", () => {
  const base = home(), now = Date.now();
  seed(base, "older", now - 40 * DAY); seed(base, "selected", now);
  const homeSummary = pendingSummary(base, undefined, now), bounds: number[] = [];
  expect(pendingSummary(base, ["selected"], now, true, at => bounds.push(at))?.oldestExpiresInDays).toBe(30);
  expect(bounds).toEqual([now + DAY]);
  expect(pendingSummary(base, ["selected"], now + DAY - 1).oldestExpiresInDays).toBe(30);
  expect(pendingSummary(base, ["selected"], now + DAY).oldestExpiresInDays).toBe(29);
  expect(pendingSummary(base, undefined, now + DAY)).toEqual(homeSummary);
});
test("an alias candidate bounds the same project's day ceiling", () => {
  const base = home(), now = Date.now(), bounds: number[] = [];
  seed(base, "alias", now - DAY / 2); seed(base, "selected", now);
  expect(pendingSummary(base, ["selected", "alias"], now, true, at => bounds.push(at))?.oldestExpiresInDays).toBe(30);
  expect(bounds).toEqual([now + DAY / 2]);
  expect(pendingSummary(base, ["selected", "alias"], bounds[0]!).oldestExpiresInDays).toBe(29);
});
test("day bounds preserve unshown protection and use the shown grace without stamping or pruning", () => {
  const base = home(), now = Date.now(), id = seed(base, "selected", now - 40 * DAY), bounds: number[] = [];
  expect(pendingSummary(base, ["selected"], now, true, at => bounds.push(at))?.oldestExpiresInDays).toBe(7);
  expect(bounds).toEqual([now + DAY]);
  expect(pendingSummary(base, ["selected"], now + DAY).oldestExpiresInDays).toBe(7);
  markShown(base, ["selected"], now, [id]); bounds.length = 0;
  expect(pendingSummary(base, ["selected"], now, true, at => bounds.push(at))?.oldestExpiresInDays).toBe(7);
  expect(bounds).toEqual([now + DAY]);
  expect(pendingSummary(base, ["selected"], now + DAY).oldestExpiresInDays).toBe(6);
  bounds.length = 0;
  expect(pendingSummary(base, ["selected"], now + 8 * DAY, true, at => bounds.push(at))?.oldestExpiresInDays).toBe(0);
  expect(bounds).toEqual([]);
});
test("empty and unavailable candidate sidecars publish no false day boundary", () => {
  const base = home(), bounds: number[] = [], now = Date.now();
  expect(pendingSummary(base, ["selected"], now, true, at => bounds.push(at))?.count).toBe(0);
  mkdirSync(join(base, "candidates.db"));
  expect(pendingSummary(base, ["selected"], now, true, at => bounds.push(at))).toBeNull();
  expect(bounds).toEqual([]);
});
