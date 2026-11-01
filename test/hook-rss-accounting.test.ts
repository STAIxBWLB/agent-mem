import { expect, test } from "bun:test";
import { combineRssSources, rssSource, rssSourcesKnown, selectHookRss, validRssSources } from "../src/hook-resources.ts";

test("a missing or zero image peak never turns inherited raw RSS into known telemetry", () => {
  for (const peak of [undefined, 0, NaN, -1]) {
    const reading = selectHookRss("linux", peak, 128 * 1024);
    expect(reading).toMatchObject({ kb: 128 * 1024, source: "raw-fallback", known: false });
    expect(rssSourcesKnown(rssSource(reading))).toBe(false);
  }
  expect(selectHookRss("linux", undefined, 0)).toMatchObject({ source: "unavailable", known: false });
});

test("valid per-image peaks preserve real allocations while raw launch evidence stays separate", () => {
  expect(selectHookRss("linux", 2048, 128 * 1024)).toEqual({ kb: 2048, rawKB: 128 * 1024, source: "VmHWM", known: true });
  expect(selectHookRss("linux", 256 * 1024, 128 * 1024).kb).toBe(256 * 1024);
  expect(selectHookRss("darwin", undefined, 4096)).toMatchObject({ kb: 4096, source: "platform-rusage", known: true });
});

test("provenance keeps a single unknown component visible through aggregation", () => {
  const known = rssSource(selectHookRss("linux", 2048, 128 * 1024));
  const unknown = rssSource(selectHookRss("linux", undefined, 128 * 1024));
  expect(rssSourcesKnown(combineRssSources(known, known))).toBe(true);
  expect(rssSourcesKnown(combineRssSources(known, unknown))).toBe(false);
  expect(validRssSources({ ...known, vmhwm: -1 })).toBe(false);
  expect(validRssSources({ ...known, extra: 1 })).toBe(false);
  expect(validRssSources(known)).toBe(true);
});

test("peak virtual size provides an explicitly named conservative image bound when RSS telemetry is zero", () => {
  expect(selectHookRss("linux", 0, 128 * 1024, 2672)).toEqual({ kb: 2672, rawKB: 128 * 1024, source: "VmPeak-bound", known: true });
  expect(selectHookRss("linux", 0, 128 * 1024, 256 * 1024).kb).toBe(256 * 1024);
});
