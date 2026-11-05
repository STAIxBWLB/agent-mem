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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measuredBudgetHookRss } from "../scripts/hook-rss-check.ts";
import { r2Verdict } from "../scripts/budget-attempt.ts";

test("only abandoned hosted-macOS unknown sources retain a visibly incomplete observed RSS envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-rss-advisory-"));
  const metric: MetricSample = { ...sample, wallMs: 80, abandonedChildren: 1, rssSources: { ...sample.rssSources!, unavailable: 1 } };
  const env = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", GITHUB_STEP_SUMMARY: join(root, "summary.md") };
  try {
    const value = measuredBudgetHookRss(metric, 55, { survivors: 0, abandonedOwnedWorkers: 1 }, "rss fixture", env, "darwin");
    expect(value).toMatchObject({ rssMB: 55, recordedRssMB: 40, rssProvenanceKnown: false, rssAdvisory: true, rssSource: "provenance-unknown-observed-envelope" });
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("rss-unknown");
    for (const strictEnv of [{}, { ...env, RUNNER_OS: "Linux" }, { ...env, CI: "false" }])
      expect(() => measuredBudgetHookRss(metric, 55, { survivors: 0, abandonedOwnedWorkers: 1 }, "strict", strictEnv, "darwin")).toThrow("provenance unknown");
    for (const evidence of [{ survivors: 1, abandonedOwnedWorkers: 1 }, { survivors: 0, abandonedOwnedWorkers: 0 }])
      expect(() => measuredBudgetHookRss(metric, 55, evidence, "strict", env, "darwin")).toThrow("provenance unknown");
    for (const bad of [{ ...metric, rssMB: Number.NaN }, { ...metric, wallMs: Number.NaN }, { ...metric, rssScope: undefined }, { ...metric, rssSources: undefined },
      { ...metric, rssSources: { ...metric.rssSources!, rawFallback: 1 } }])
      expect(() => measuredBudgetHookRss(bad, 55, { survivors: 0, abandonedOwnedWorkers: 1 }, "strict", env, "darwin")).toThrow("provenance unknown");
    const over = measuredBudgetHookRss({ ...metric, rssMB: 151 }, 55, { survivors: 0, abandonedOwnedWorkers: 1 }, "over", env, "darwin");
    const gate = r2Verdict("hooks:plain", { rssMB: Array.from({ length: 40 }, () => over.rssMB), wallMs: Array.from({ length: 40 }, () => 80) }, { env });
    expect(gate.ceiling.pass).toBe(false);
    expect(measuredBudgetHookRss({ ...sample, wallMs: 80 }, 55, { survivors: 0, abandonedOwnedWorkers: 0 }, "known", {}, "darwin").rssProvenanceKnown).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
