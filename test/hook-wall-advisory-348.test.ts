import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookWallAdvisory348, reportHookWallAdvisory348, type HookWallEvidence348 } from "../scripts/budget-attempt.ts";
const evidence: HookWallEvidence348 = { telemetryValid: true, rssPass: true, survivors: 0, wallP95Ms: 180, wallMaxMs: 350, rssP95MB: 80, peakRssMB: 90 };
const hosted = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" };
test("#348 exact hosted markers and seven groups only", () => {
  for (const os of ["Linux", "macOS"]) for (const group of ["plain", "spoolAndExit", "drain", "sessionStart", "sessionStartRepoLog", "jcode", "jcodeJournal"]) {
    for (const kind of ["wall-p95", "wall-max"]) expect(hookWallAdvisory348(group, kind, evidence, { ...hosted, RUNNER_OS: os })).toBe(true);
  }
  for (const env of [{}, { AMEM_RUNNER: "dgx02" }, { ...hosted, CI: undefined }, { ...hosted, GITHUB_ACTIONS: undefined }, { ...hosted, RUNNER_OS: undefined }, { ...hosted, CI: "1" }, { ...hosted, RUNNER_OS: "Windows" }]) expect(hookWallAdvisory348("plain", "wall-p95", evidence, env)).toBe(false);
  for (const group of ["hooks:plain", "transcript", "full-spool", "hook-workloads", "sessionStart-1"]) expect(hookWallAdvisory348(group, "wall-max", evidence, hosted)).toBe(false);
});
test("#348 RSS regression, ceiling, unknown telemetry, R1 and non-timing errors stay strict", () => {
  for (const patch of [{ rssPass: false }, { telemetryValid: false }, { survivors: 1 }, { survivors: NaN }, { peakRssMB: 150 }, { rssP95MB: 0 }, { wallMaxMs: NaN }, { wallP95Ms: Infinity }]) expect(hookWallAdvisory348("plain", "wall-max", { ...evidence, ...patch }, hosted)).toBe(false);
  for (const kind of ["loss", "duplication", "rss-miss", "transcript-stall", "SessionStart deadline produced empty context"]) expect(hookWallAdvisory348("sessionStart", kind, evidence, hosted)).toBe(false);
  expect(hookWallAdvisory348("sessionStart", "SessionStart deadline omitted fixture work", evidence, hosted)).toBe(true);
  expect(hookWallAdvisory348("plain", "SessionStart deadline omitted fixture work", evidence, hosted)).toBe(false);
  expect(hookWallAdvisory348("plain", "wall-p95", { ...evidence, wallP95Ms: 149 }, hosted)).toBe(false);
  expect(hookWallAdvisory348("plain", "wall-max", { ...evidence, wallMaxMs: 300 }, hosted)).toBe(false);
});
test("#348 numeric evidence is retained under its own step-summary record", () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-advisory-"));
  try {
    const summary = join(dir, "summary");
    expect(reportHookWallAdvisory348("plain", "wall-max", evidence, { ...hosted, GITHUB_STEP_SUMMARY: summary })).toBe(true);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("hosted-hook-wall-advisory-348"); expect(text).toContain('"wallMaxMs":350'); expect(text).toContain('"rssP95MB":80');
    expect(reportHookWallAdvisory348("plain", "wall-max", { ...evidence, rssPass: false }, hosted)).toBe(false);
    expect(() => reportHookWallAdvisory348("plain", "wall-max", evidence, hosted)).toThrow("set GITHUB_STEP_SUMMARY");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
