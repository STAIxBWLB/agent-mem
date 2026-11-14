import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetFailureAdvisory, reportBudgetAdvisory, notDurableFailureReceipt, type BudgetFailureEvidence } from "../scripts/hook-timing-check.ts";

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

test("#412 fatal measurement branch emits one bounded receipt naming false conjuncts before throwing", () => {
  const source = readFileSync(resolve(import.meta.dir, "../scripts/measure-transcript-budget.ts"), "utf8");
  const start = source.indexOf("      if (!complete) {"), end = source.indexOf("      await verifyReplay", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const branch = source.slice(start, end);
  const module = resolve(import.meta.dir, "../scripts/hook-timing-check.ts");
  const run = (complete: boolean) => Bun.spawnSync([process.execPath, "-e", `
    import { reportBudgetAdvisory, notDurableFailureReceipt } from ${JSON.stringify(module)};
    const event = 'StopBurst', logicalRun = 1, MAX_FOLLOW_UPS = 64, complete = ${complete};
    const samples = [{ event, logicalRun, wallMs: 1, rssMB: 20, offsetSource: 'cursor', offset: 10, stopReason: 'deadline' }];
    const summaryEnds = new Map([['scanned', 5], ['pending', 20]]), previousAvailable = new Set(['scanned']), incompleteRuns = {};
    for (let once = 0; once < 1; once++) { ${branch} }
  `], { env: { ...process.env, ...hostedLinux }, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  const failed = run(false), output = failed.stdout.toString().trim().split("\n");
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr.toString()).toContain("transcript summaries not durable within 64 follow-up invocations");
  expect(output).toHaveLength(1);
  expect(Buffer.byteLength(output[0]!)).toBeLessThan(2500);
  const receipt = JSON.parse(output[0]!);
  expect(receipt.diagnostic).toBe("transcript-not-durable-receipt");
  expect(receipt.event).toBe("StopBurst"); expect(receipt.logicalRun).toBe(1);
  expect(receipt.evidence.spoolFullStops).toBe(0);
  expect(Object.entries(receipt.failedConjuncts).filter(([, failed]) => failed).map(([key]) => key)).toEqual(["spoolFullStopsPositive"]);
  const allowed = new Set(["transcript-not-durable-receipt", "StopBurst", "Linux", "cursor"]);
  const safe = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value)
    : typeof value === "boolean" || typeof value === "string" && allowed.has(value)
      || value !== null && typeof value === "object" && Object.values(value).every(safe);
  expect(safe(receipt)).toBe(true);
  const passing = run(true);
  expect(passing.exitCode).toBe(0); expect(passing.stdout.length).toBe(0);
});


test("#412 failure bitmap agrees with unchanged advisory across scopes and invalid evidence", () => {
  const patches: Partial<BudgetFailureEvidence>[] = [{}, { telemetryValid: false }, { survivors: 1 }, { survivors: Number.NaN },
    { abandonedOwnedWorkers: -1 }, { unavailableRssSources: 0.5 }, { receiptIncomplete: "private-path" as unknown as boolean }, { wallMs: -1 },
    { transcriptEvent: "private-excerpt" }, { logicalRunTelemetryValid: false }, { cursorSource: "private-path" }, { spoolFullStops: 0 },
    { cursorOffset: Number.NaN }, { summaryPrefixEnd: Number.POSITIVE_INFINITY }, { scannedSummaries: 0 }, { durableScannedSummaries: 89 }];
  for (const env of [hostedLinux, { ...hostedLinux, RUNNER_OS: "macOS" }, {}]) {
    for (const patch of patches) {
      const value = { ...evidence, ...patch }, receipt = notDurableFailureReceipt("StopBurst", 1, value, env);
      expect(Object.values(receipt.failedConjuncts).some(Boolean)).toBe(!budgetFailureAdvisory("not-durable", value, env));
      const line = JSON.stringify(receipt);
      expect(Buffer.byteLength(line)).toBeLessThan(2500);
      expect(line).not.toContain("private-");
      expect(line).not.toContain("null");
    }
  }
});
