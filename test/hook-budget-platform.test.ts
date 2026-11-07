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

test("#293: only exact hosted Linux or macOS markers make the transcript stall clause advisory", async () => {
  const { stallAdvisory } = await import("../scripts/hook-timing-check.ts");
  for(const RUNNER_OS of ["Linux","macOS"])expect(stallAdvisory({CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS})).toBe(true);
  for (const env of [{}, { RUNNER_OS: "macOS" }, { CI: "true", RUNNER_OS: "macOS" }, { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
    { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" }, { CI: "true", GITHUB_ACTIONS: "true" }, { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "macos" }])
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


import { budgetFailureAdvisory, reportBudgetAdvisory } from "../scripts/hook-timing-check.ts";
const drainEvidence={telemetryValid:true,survivors:0,drainPass:4,expectedInvocations:55,databaseRows:40,hookPendingRows:11,capturePendingRows:4,
  accountingComplete:true,unreadableItems:0,duplicateItems:0,unaccountedItems:0,countedRetirements:0};
test("#293 liveness kinds warn only on exact hosted OS markers, without widening the macOS-only classes",()=>{
  for(const RUNNER_OS of ["Linux","macOS"]) {
    const env={CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS};
    expect(budgetFailureAdvisory("contended-drain",drainEvidence,env)).toBe(true);
    expect(budgetFailureAdvisory("transcript-stall",{telemetryValid:true,survivors:0,reasonOnlyStreak:3},env)).toBe(true);
    for(const kind of ["rss-unknown","owned-descendant-receipt","not-durable","transcript-wall-max"])
      expect(budgetFailureAdvisory(kind,{telemetryValid:true,survivors:0,abandonedOwnedWorkers:1,unavailableRssSources:2,receiptIncomplete:true,wallMs:301},env)).toBe(RUNNER_OS==="macOS");
  }
  for(const env of [{},{CI:"true"},{GITHUB_ACTIONS:"true"},{CI:"true",RUNNER_OS:"Linux"},{GITHUB_ACTIONS:"true",RUNNER_OS:"Linux"},
    {CI:"true",GITHUB_ACTIONS:"true"},{CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS:"linux"},{CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS:"Windows"}])
    for(const kind of ["contended-drain","transcript-stall"])expect(budgetFailureAdvisory(kind,{...drainEvidence,reasonOnlyStreak:3},env)).toBe(false);
});
test("#293 missing, unreadable, duplicated, retired or invalid accounting never receives the drain exception",()=>{
  for(const RUNNER_OS of ["Linux","macOS"])for(const patch of [{telemetryValid:false},{survivors:1},{accountingComplete:false},
    {unaccountedItems:1},{unreadableItems:1},{duplicateItems:1},{countedRetirements:1},{hookPendingRows:10},{capturePendingRows:5},
    {drainPass:undefined},{drainPass:3},{drainPass:5},{expectedInvocations:0},{expectedInvocations:Number.NaN},{databaseRows:55,hookPendingRows:0,capturePendingRows:0},
    {databaseRows:-1},{hookPendingRows:1.5},{countedRetirements:undefined}])
    expect(budgetFailureAdvisory("contended-drain",{...drainEvidence,...patch},{CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS})).toBe(false);
  for(const reasonOnlyStreak of [undefined,0,1,2,3.5,Number.NaN])
    expect(budgetFailureAdvisory("transcript-stall",{telemetryValid:true,survivors:0,reasonOnlyStreak},githubMac)).toBe(false);
});
test("#293 uses the existing record and summary with numeric evidence and preserves prior failures",()=>{
  const root=mkdtempSync(join(tmpdir(),"amem-liveness-advisory-"));
  try {
    for(const RUNNER_OS of ["Linux","macOS"]) {
      const summary=join(root,RUNNER_OS+".md"),env={CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS,GITHUB_STEP_SUMMARY:summary};
      expect(reportBudgetAdvisory("contended-drain","pass4 fixture",drainEvidence,env)).toBe(true);
      expect(reportBudgetAdvisory("transcript-stall","reason-only fixture",{telemetryValid:true,survivors:0,reasonOnlyStreak:3},env)).toBe(true);
      const body=readFileSync(summary,"utf8");expect(body).toContain('"diagnostic":"hosted-macos-budget-advisory"');
      expect(body).toContain('"expectedInvocations":55');expect(body).toContain('"databaseRows":40');expect(body).toContain('"reasonOnlyStreak":3');
    }
    const file=resolve(import.meta.dir,"../scripts/hook-timing-check.ts"),summary=join(root,"exit.md");
    const code=`import {reportBudgetAdvisory} from ${JSON.stringify(file)};process.exitCode=7;reportBudgetAdvisory('contended-drain','prior failure',${JSON.stringify(drainEvidence)},${JSON.stringify({CI:"true",GITHUB_ACTIONS:"true",RUNNER_OS:"Linux",GITHUB_STEP_SUMMARY:summary})});`;
    const result=Bun.spawnSync([process.execPath,"-e",code],{stdout:"pipe",stderr:"pipe",timeout:3000});
    expect(result.exitCode).toBe(7);expect(result.stderr.toString()).toContain("::warning");expect(result.stdout.toString()).toContain('"capturePendingRows":4');
  }finally{rmSync(root,{recursive:true,force:true});}
});
