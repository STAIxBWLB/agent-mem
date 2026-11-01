import { expect, test } from "bun:test";
import { combineRssSources, countedRssSources, rssSource, rssSourcesKnown, selectHookRss, validRssSources } from "../src/hook-resources.ts";

test("a missing or zero image peak never turns inherited raw RSS into known telemetry", () => {
  for (const peak of [undefined, 0, NaN, -1]) {
    const reading = selectHookRss("linux", peak, 128 * 1024);
    expect(reading).toMatchObject({ kb: 128 * 1024, source: "raw-fallback", known: false });
    expect(rssSourcesKnown(rssSource(reading))).toBe(false);
  }
  expect(selectHookRss("linux", undefined, 0)).toMatchObject({ source: "unavailable", known: false });
});

test("VmHWM present selects its image peak before a larger VmPeak bound", () => {
  expect(selectHookRss("linux", 2048, 128 * 1024, 256 * 1024)).toEqual({ kb: 2048, rawKB: 128 * 1024, source: "VmHWM", known: true });
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

test("VmHWM zero selects an explicitly named vmpeak-bound reading", () => {
  expect(selectHookRss("linux", 0, 128 * 1024, 2672)).toEqual({ kb: 2672, rawKB: 128 * 1024, source: "vmpeak-bound", known: true });
  expect(selectHookRss("linux", 0, 128 * 1024, 256 * 1024).kb).toBe(256 * 1024);
});

test("a known parent cannot hide a counted child with missing source metadata", () => {
  const parent = rssSource(selectHookRss("linux", 35000, 128000));
  expect(rssSourcesKnown(combineRssSources(parent, countedRssSources(2048)))).toBe(false);
  expect(rssSourcesKnown(combineRssSources(parent, countedRssSources(0)))).toBe(true);
});

test("missing VmHWM and VmPeak cannot certify an image", () => {
  const fallback = selectHookRss("linux", undefined, 128 * 1024, undefined);
  expect(fallback).toEqual({ kb: 128 * 1024, rawKB: 128 * 1024, source: "raw-fallback", known: false });
  expect(rssSourcesKnown(rssSource(fallback))).toBe(false);
  expect(selectHookRss("linux", undefined, 0, undefined)).toEqual({ kb: 0, rawKB: 0, source: "unavailable", known: false });
});
