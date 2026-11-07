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

import { attributedWorkerRssObservation, measuredAttributedHookRss } from "../scripts/hook-rss-check.ts";
import { hookProcessDiagnostic } from "../scripts/hook-process-diagnostic.ts";
import type { HookLifecycleReceipt } from "./fakes/hooks-process-observer.ts";
function abandonedDiagnostic(workerPid: number, nativePid: number, unknown = 2) {
  const metric: MetricSample = { ...sample, wallMs: 100, abandonedChildren: 1,
    rssSources: { vmhwm: 0, vmpeakBound: 0, platformRusage: 2, rawFallback: 0, unavailable: unknown } };
  const life = (phase: HookLifecycleReceipt["phase"], childPid: number, kind: "worker" | "native", extra: Partial<HookLifecycleReceipt> = {}): HookLifecycleReceipt =>
    ({ phase, childPid, kind, parentPid: 1, atMs: 100, ...extra });
  const diagnostic = hookProcessDiagnostic({ event: "Stop", run: 1, logicalRun: 1, parentPid: 1, expectedOwnedChildren: 2, expectation: "fixture-contract", metric,
    workers: [{ pid: workerPid, kind: "worker", detached: true, argv: [] }, { pid: nativePid, kind: "native", detached: true, argv: [] }], evidence: [
      {phase:"preload",pid:1,loads:1},{phase:"precheck",pid:1,loads:1,host:0,remainingUs:100000},
      {phase:"attempt",pid:1,loads:1,exact:1,native:0},{phase:"returned",pid:1,loads:1,exact:1,native:0,childPid:workerPid},
      {phase:"attempt",pid:1,loads:1,exact:1,native:1},{phase:"returned",pid:1,loads:1,exact:1,native:1,childPid:nativePid},
    ], lifecycle: [
      life("spawn-attempt", 0, "worker"), life("spawn", workerPid, "worker"), life("kill-request", workerPid, "worker"),
      life("reap-start", workerPid, "worker"), life("reap-end", workerPid, "worker", { reaped: 0 }),
      life("rss-finish", workerPid, "worker", { vmhwm: 0, vmpeakBound: 0, platformRusage: 0, rawFallback: 0, unavailable: unknown, telemetryValid: 1 }),
      life("spawn-attempt", 0, "native"), life("spawn", nativePid, "native"), life("exit", nativePid, "native"),
      life("reap-end", nativePid, "native", { reaped: 1 }), life("rss-finish", nativePid, "native", { source: "platform-rusage", known: 1, observationFailed: 0, telemetryValid: 1 }),
    ] });
  return { metric, diagnostic };
}
test("#287 per-child attribution rejects mixed native unknowns and missing or invalid receipts", () => {
  for (const u of [1, 2]) expect(attributedWorkerRssObservation(abandonedDiagnostic(10, 20, u).diagnostic)).toEqual({ complete: true, explained: u });
  for (const mutate of [
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.observedOwnedChildren = 1; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.spawnAttempts = 3; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.truncated = true; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.expectedWorkerChildren = 2; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.admission = d.admission.filter(row=>row.phase!=="returned"); },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.admission.find(row=>row.phase==="attempt")!.exact=0; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.admission.find(row=>row.phase==="preload")!.loads=2; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.abandonedChildren = 2; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.children[0]!.rss = null; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.children[0]!.reaped = true; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.children[0]!.rss!.telemetryValid = 0; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.children[0]!.rss!.counters.rawFallback = 1; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.children[1]!.rss!.observationFailed = 1; },
    (d: ReturnType<typeof abandonedDiagnostic>["diagnostic"]) => { d.children[1]!.rss!.known = 0; },
  ]) { const { diagnostic } = abandonedDiagnostic(10, 20); mutate(diagnostic); expect(attributedWorkerRssObservation(diagnostic).complete).toBe(false); }
});
test("#287 warning keeps original unknown coverage and cannot admit an extra unknown or live PID", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-attributed-rss-")), summary = join(root, "summary.md");
  const flags = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", GITHUB_STEP_SUMMARY: summary };
  const dead = () => Bun.spawnSync(["/bin/true"]).pid;
  try {
    const { metric, diagnostic } = abandonedDiagnostic(dead(), dead());
    const result = await measuredAttributedHookRss(metric, 55, diagnostic, "attributed baseline", flags, "darwin");
    expect(result).toMatchObject({ rssProvenanceKnown: false, rssAdvisory: true, rssMB: 55 });
    expect(result.rssSources).toEqual(metric.rssSources!);
    expect(readFileSync(summary, "utf8")).toContain('"unavailableRssSources":2');
    expect(readFileSync(summary, "utf8")).toContain('"unexplainedRssSources":0');
    for (const bad of [ { ...metric, rssSources: { ...metric.rssSources!, unavailable: 3 } }, { ...metric, rssMB: Number.NaN },
      { ...metric, wallMs: Number.NaN }, { ...metric, rssScope: undefined }, { ...metric, rssSources: { ...metric.rssSources!, rawFallback: 1 } } ])
      await expect(measuredAttributedHookRss(bad, 55, diagnostic, "strict", flags, "darwin")).rejects.toThrow("provenance unknown");
    await expect(measuredAttributedHookRss(metric, 55, diagnostic, "Linux", { ...flags, RUNNER_OS: "Linux" }, "linux")).rejects.toThrow("provenance unknown");
    try { await measuredAttributedHookRss(metric, 55, diagnostic, "stage1-receipts", {}, "linux"); throw Error("expected strict refusal"); }
    catch (error) { expect(String(error)).toContain('"diagnostic":"hook-child-reap/v1"'); expect(String(error)).toContain('"event":"Stop"'); }
    const live = abandonedDiagnostic(process.pid, dead());
    await expect(measuredAttributedHookRss(live.metric, 55, live.diagnostic, "R1 live", flags, "darwin")).rejects.toThrow("provenance unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 5000);
