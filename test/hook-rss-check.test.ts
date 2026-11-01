import { expect, test } from "bun:test";
import { measuredHookRss } from "../scripts/hook-rss-check.ts";
import type { MetricSample } from "../src/memory/metrics.ts";

const sample: MetricSample = { at: new Date().toISOString(), kind: "hook", rssMB: 40, rawRssMB: 180, rssScope: "owned-images", rssSources: { vmhwm: 1, vmpeakBound: 2, platformRusage: 0, rawFallback: 0, unavailable: 0 } };
test("Linux launcher's raw high-water cannot displace known process-image accounting", () => {
  expect(measuredHookRss(sample, 160, "linux")).toMatchObject({ rssMB: 40, cliRssMB: 160, rssSource: "production-owned-images" });
  expect(measuredHookRss({ ...sample, rssMB: 150 }, 160, "linux").rssMB).toBe(150);
});
test("a plausible small numeric RSS does not pass with missing or unknown provenance", () => {
  expect(() => measuredHookRss({ ...sample, rssSources: undefined }, 40, "linux")).toThrow("provenance unknown");
  expect(() => measuredHookRss({ ...sample, rssSources: { ...sample.rssSources!, rawFallback: 1 } }, 40, "linux")).toThrow("provenance unknown");
});

test("each platform profile declares counted images and unmeasured descendants", () => {
  for (const platform of ["linux", "darwin"] as const) {
    expect(measuredHookRss(sample, 40, platform).rssCoverage).toBe("images: bun+supervisor; descendants: not measured");
  }
});

test("coverage never certifies a missing scope or an unavailable source", () => {
  for (const metric of [{ ...sample, rssScope: undefined }, { ...sample, rssSources: { ...sample.rssSources!, unavailable: 1 } }]) {
    expect(() => measuredHookRss(metric, 40, "linux")).toThrow("provenance unknown");
    expect(() => measuredHookRss(metric, 40, "linux")).toThrow("descendants: not measured");
  }
});
