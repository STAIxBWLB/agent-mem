import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetFailureAdvisory, reportBudgetAdvisory, type BudgetFailureEvidence } from "../scripts/hook-timing-check.ts";

const hostedLinux = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" };
const evidence: BudgetFailureEvidence = { telemetryValid: true, logicalRunTelemetryValid: true, survivors: 0,
  transcriptEvent: "StopBurst", spoolFullStops: 15, cursorSource: "cursor", cursorOffset: 5907, summaryPrefixEnd: 6900,
  scannedSummaries: 90, durableScannedSummaries: 90 };

test("#357 hosted Linux accepts the evidenced incomplete StopBurst prefix, including earlier spool_full stops", () => {
  expect(budgetFailureAdvisory("not-durable", evidence, hostedLinux)).toBe(true);
  expect(budgetFailureAdvisory("not-durable", { ...evidence, spoolFullStops: 1 }, hostedLinux)).toBe(true);
});

test("#357 every missing condition, invalid count, survivor or lost scanned summary stays strict", () => {
  for (const field of Object.keys(evidence) as (keyof BudgetFailureEvidence)[]) {
    const incomplete = { ...evidence }; delete incomplete[field];
    expect(budgetFailureAdvisory("not-durable", incomplete, hostedLinux), `missing ${field}`).toBe(false);
  }
  const patches: Partial<BudgetFailureEvidence>[] = [
    { transcriptEvent: "Stop" }, { transcriptEvent: "SessionEnd" }, { transcriptEvent: "stopburst" },
    { telemetryValid: false }, { logicalRunTelemetryValid: false }, { survivors: 1 }, { survivors: Number.NaN },
    { spoolFullStops: 0 }, { spoolFullStops: -1 }, { spoolFullStops: 1.5 }, { spoolFullStops: Number.NaN },
    { cursorSource: "uncreated" }, { cursorSource: "rollback_pending" },
    { cursorOffset: 0 }, { cursorOffset: -1 }, { cursorOffset: 1.5 }, { cursorOffset: Number.NaN }, { cursorOffset: 6900 }, { cursorOffset: 6901 },
    { summaryPrefixEnd: 0 }, { summaryPrefixEnd: 5907 }, { summaryPrefixEnd: Number.POSITIVE_INFINITY },
    { scannedSummaries: 0, durableScannedSummaries: 0 }, { scannedSummaries: -1 }, { scannedSummaries: 1.5 }, { scannedSummaries: Number.NaN },
    { durableScannedSummaries: 89 }, { durableScannedSummaries: 91 }, { durableScannedSummaries: Number.NaN },
  ];
  for (const patch of patches)
    expect(budgetFailureAdvisory("not-durable", { ...evidence, ...patch }, hostedLinux), JSON.stringify(patch)).toBe(false);
});

test("#357 local, remote and incomplete hosted markers stay strict and macOS keeps its existing policy", () => {
  for (const env of [{}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { RUNNER_OS: "Linux" },
    { CI: "true", RUNNER_OS: "Linux" }, { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" },
    { ...hostedLinux, CI: "1" }, { ...hostedLinux, GITHUB_ACTIONS: "TRUE" },
    { ...hostedLinux, RUNNER_OS: "linux" }, { ...hostedLinux, RUNNER_OS: "Windows" }])
    expect(budgetFailureAdvisory("not-durable", evidence, env), JSON.stringify(env)).toBe(false);
  const hostedMac = { ...hostedLinux, RUNNER_OS: "macOS" };
  for (const transcriptEvent of ["Stop", "SessionEnd", "StopBurst"])
    expect(budgetFailureAdvisory("not-durable", { telemetryValid: true, survivors: 0, transcriptEvent }, hostedMac)).toBe(true);
  for (const kind of ["rss-unknown", "owned-descendant-receipt", "transcript-wall-max", "ceiling", "regression", "wall-max", "scan-progress", "no-loss"])
    expect(budgetFailureAdvisory(kind, { ...evidence, wallMs: 301, abandonedOwnedWorkers: 1, unavailableRssSources: 1, receiptIncomplete: true }, hostedLinux)).toBe(false);
});

test("#357 emits the existing receipt and annotation, requires a summary and never clears a prior hard failure", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-not-durable-advisory-")), summary = join(root, "summary.md");
  try {
    const env = { ...hostedLinux, GITHUB_STEP_SUMMARY: summary };
    expect(reportBudgetAdvisory("not-durable", "StopBurst:1", { ...evidence, scannedSummaries: 91 }, env)).toBe(false);
    expect(existsSync(summary)).toBe(false);
    const file = resolve(import.meta.dir, "../scripts/hook-timing-check.ts");
    const code = `import {reportBudgetAdvisory} from ${JSON.stringify(file)};process.exitCode=7;reportBudgetAdvisory('not-durable','StopBurst:1',${JSON.stringify(evidence)},${JSON.stringify(env)});`;
    const result = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString()).toContain('"diagnostic":"hosted-macos-budget-advisory"');
    expect(result.stderr.toString()).toContain("::warning title=Hook Linux runner budget::");
    const body = readFileSync(summary, "utf8");
    expect(body).toContain("StopBurst:1: warning (not-durable)");
    expect(body).toContain('"spoolFullStops":15');
    expect(body).toContain('"cursorOffset":5907');
    expect(body).toContain('"scannedSummaries":90');
    expect(body).toContain('"durableScannedSummaries":90');
    expect(() => reportBudgetAdvisory("not-durable", "StopBurst:1", evidence, hostedLinux)).toThrow("step summary is unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
