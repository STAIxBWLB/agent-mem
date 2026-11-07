import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function probe(flags: NodeJS.ProcessEnv, wallP95Ms = 195.3, peakRssMB = 75, priorExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "amem-budget-platform-")), summary = join(root, "summary.md");
  try {
    const file = resolve(import.meta.dir, "../scripts/hook-timing-check.ts");
    // #228: a uniform group of 40 samples, so its p95 is exactly `peakRssMB` (a NaN sample is unknown telemetry).
    // #228 reset: an inline baseline of 75 MB for hooks:plain on every runner, so 100 and 105 MB regress by more than 10%.
    const baseline = { schema: "agent-mem.r2-baseline/v1", runners: { "hosted-macos": { "hooks:plain": 75 }, "hosted-linux": { "hooks:plain": 75 }, dgx02: { "hooks:plain": 75 }, local: { "hooks:plain": 75 } } };
    const values = { group: "hooks:plain", wallP95Ms, rssSamplesMB: Array.from({ length: 40 }, () => peakRssMB), wallSamplesMs: Array.from({ length: 40 }, () => Number.isFinite(wallP95Ms) ? Math.min(wallP95Ms, 299) : wallP95Ms), wallLimitMs: 150, baseline };
    const script = `import {workloadBudget} from ${JSON.stringify(file)};process.exitCode=${priorExit};const result=workloadBudget('plain',${JSON.stringify(values)},${JSON.stringify({ ...flags, GITHUB_STEP_SUMMARY: summary })});if(!result.pass)process.exitCode=1;`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), summary: readFileSync(summary, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const githubMac = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" };

test("only the GitHub macOS runner warns on p95 and records the original numbers", () => {
  const result = probe(githubMac);
  expect(result.code).toBe(0); expect(result.out).toContain('"status":"warning"');
  expect(result.out).toContain('"wallTimingPass":false'); expect(result.out).toContain('"wallAdvisory":true');
  expect(result.err).toContain("::warning title=Hook macOS runner p95::");
  expect(result.summary).toContain("plain: warning");
  expect(result.summary).toContain('"wallP95Ms":195.3'); expect(result.summary).toContain('"wallLimitMs":150');
});

test("the same p95 miss fails Ubuntu, non-CI and every incomplete or incorrect runner marker", () => {
  for (const flags of [{}, { RUNNER_OS: "macOS" }, { CI: "true", RUNNER_OS: "macOS" }, { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
    { CI: "true", GITHUB_ACTIONS: "true" }, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" },
    { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" }, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macos" }]) {
    const result = probe(flags);
    expect(result.code).not.toBe(0); expect(result.out).toContain('"status":"fail"');
    expect(result.out).toContain('"wallAdvisory":false'); expect(result.err).not.toContain("::warning");
    expect(result.summary).toContain('"wallP95Ms":195.3');
  }
});

test("an RSS regression over the baseline remains hard even with a GitHub macOS p95 warning (#228 reset)", () => {
  for (const wall of [55, 195.3]) for (const rss of [100, 105]) {
    const result = probe(githubMac, wall, rss);
    expect(result.code).not.toBe(0); expect(result.out).toContain('"peakPass":false');
    expect(result.out).toContain('"status":"fail"'); expect(result.summary).toContain("plain: fail");
  }
});

test("a p95 warning cannot erase an existing hard R1 or functional exit, and invalid samples fail", () => {
  expect(probe(githubMac, 195.3, 75, 7).code).toBe(7);
  expect(probe(githubMac, Number.NaN).code).not.toBe(0);
  expect(probe(githubMac, 55, Number.NaN).code).not.toBe(0);
});

test("within-budget workloads pass on either runner and locally without a warning", () => {
  for (const flags of [{}, githubMac, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" }]) {
    const result = probe(flags, 75, 80);
    expect(result.code).toBe(0); expect(result.out).toContain('"status":"pass"'); expect(result.err).not.toContain("::warning");
  }
});

test("#226: only the exact hosted GitHub macOS runner makes the transcript stall clause advisory", async () => {
  const { stallAdvisory } = await import("../scripts/hook-timing-check.ts");
  expect(stallAdvisory({ CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" })).toBe(true);
  for (const env of [{}, { RUNNER_OS: "macOS" }, { CI: "true", RUNNER_OS: "macOS" }, { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
    { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" }, { CI: "true", GITHUB_ACTIONS: "true" }, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macos" }])
    expect(stallAdvisory(env), JSON.stringify(env)).toBe(false);
});

import { attributedWorkerRssAdvisory } from "../scripts/hook-timing-check.ts";
const attributed = { telemetryValid: true, survivors: 0, abandonedOwnedWorkers: 1, unavailableRssSources: 2,
  rawFallbackRssSources: 0, unexplainedRssSources: 0, ownedChildObservationComplete: true, r1Passed: true };
test("#287 attribution requires the existing exact hosted-macOS markers", () => {
  for (const unavailableRssSources of [1, 2]) expect(attributedWorkerRssAdvisory({ ...attributed, unavailableRssSources }, githubMac)).toBe(true);
  for (const env of [{}, { RUNNER_OS: "macOS" }, { ...githubMac, CI: "false" }, { ...githubMac, GITHUB_ACTIONS: "false" },
    { ...githubMac, RUNNER_OS: "Linux" }, { ...githubMac, RUNNER_OS: "Windows" }, { ...githubMac, RUNNER_OS: "macos" }])
    expect(attributedWorkerRssAdvisory(attributed, env)).toBe(false);
});
test("#287 every unattributed, invalid or R1/observation-failed combination stays strict", () => {
  for (const patch of [ { telemetryValid: false }, { survivors: 1 }, { survivors: Number.NaN }, { abandonedOwnedWorkers: 0 },
    { abandonedOwnedWorkers: undefined }, { abandonedOwnedWorkers: -1 }, { unavailableRssSources: 0 }, { unavailableRssSources: 3 },
    { unavailableRssSources: Number.NaN }, { unavailableRssSources: 1.5 }, { rawFallbackRssSources: 1 }, { rawFallbackRssSources: Number.NaN },
    { unexplainedRssSources: 1 }, { unexplainedRssSources: -1 }, { ownedChildObservationComplete: false }, { r1Passed: false }])
    expect(attributedWorkerRssAdvisory({ ...attributed, ...patch }, githubMac), JSON.stringify(patch)).toBe(false);
});
