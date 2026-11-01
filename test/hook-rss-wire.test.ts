import { expect, test } from "bun:test";
import { HookWorkerRss } from "../src/hook-rss-wire.ts";
import { rssSourcesKnown } from "../src/hook-resources.ts";

const self = (t: HookWorkerRss, kb = 35 * 1024) => t.frame([3, kb, 128 * 1024, 0]);
function start(t: HookWorkerRss, id: number, pid: number) { t.frame([1, id, 0]); t.frame([1, id, pid]); }

test("worker and overlapping native images preserve their source and conservative sum", () => {
  const t = new HookWorkerRss(100); t.frame([0]); start(t, 1, 101); start(t, 2, 102);
  t.frame([2, 1, 2048, 35 * 1024, 0, 0]); t.frame([2, 2, 2672, 35 * 1024, 1, 0]); self(t);
  const value = t.finish(128 * 1024, "linux");
  expect(value.rssKB).toBe(35 * 1024 + 2048 + 2672);
  expect(value.rawRssKB).toBe(128 * 1024); expect(rssSourcesKnown(value.rssSources)).toBe(true);
  expect(value.rssSources).toMatchObject({ vmhwm: 2, vmpeakBound: 1, rawFallback: 0, unavailable: 0 });
});

test("sequential native peaks do not become a fictitious concurrent sum", () => {
  const t = new HookWorkerRss(100); t.frame([0]); start(t, 1, 101); t.frame([2, 1, 8000, 35000, 0, 0]);
  start(t, 2, 102); t.frame([2, 2, 5000, 35000, 0, 0]); self(t);
  expect(t.finish(128 * 1024, "linux").rssKB).toBe(35 * 1024 + 8000);
});

test("timeout uses live owned images while an unobserved native intent stays unknown", () => {
  const live = new HookWorkerRss(100); live.frame([0]); start(live, 1, 101);
  live.captureLive(pid => pid === 100 ? { hwmKB: 35000 } : { virtualKB: 2672 });
  const value = live.finish(128 * 1024, "linux");
  expect(value.rssKB).toBe(37672); expect(rssSourcesKnown(value.rssSources)).toBe(true);
  const missing = new HookWorkerRss(100); missing.frame([0]); missing.frame([1, 1, 0]); self(missing);
  expect(rssSourcesKnown(missing.finish(128 * 1024, "linux").rssSources)).toBe(false);
});

test("real large worker allocations and malformed telemetry cannot yield a budget pass", () => {
  const large = new HookWorkerRss(100); large.frame([0]); self(large, 150 * 1024);
  expect(large.finish(160 * 1024, "linux").rssKB).toBeGreaterThan(100 * 1024);
  const invalid = new HookWorkerRss(100); invalid.frame([0]); self(invalid); invalid.frame([1, 65, 101]);
  expect(rssSourcesKnown(invalid.finish(128 * 1024, "linux").rssSources)).toBe(false);
});

test("a worker's unknown native source is not promoted into known platform rusage", () => {
  const t = new HookWorkerRss(100); t.frame([0]); start(t, 1, 101);
  t.frame([2, 1, 35000, 35000, 3, 0]); self(t);
  expect(rssSourcesKnown(t.finish(128 * 1024, "darwin").rssSources)).toBe(false);
});

test("a second teardown read after exit cannot erase an earlier valid live snapshot", () => {
  const t = new HookWorkerRss(100); t.frame([0]); start(t, 1, 101);
  t.captureLive(pid => pid === 100 ? { hwmKB: 35000 } : { virtualKB: 2672 });
  t.captureLive(() => ({}));
  const value = t.finish(128 * 1024, "linux");
  expect(value.rssKB).toBe(37672); expect(rssSourcesKnown(value.rssSources)).toBe(true);
});

test("platform worker rusage remains a floor for the combined report rather than being added twice", () => {
  const t = new HookWorkerRss(100); t.frame([0]); start(t, 1, 101);
  t.frame([2, 1, 5000, 5000, 2, 0]); t.frame([3, 35000, 35000, 2]);
  expect(t.finish(40000, "darwin").rssKB).toBe(40000);
  expect(t.finish(45000, "darwin").rssKB).toBe(45000);
});
