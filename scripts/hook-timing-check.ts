import { appendFileSync } from "node:fs";
import { r2Verdict, type R2Baseline } from "./budget-attempt.ts";

/** Only shared GitHub macOS wall-time p95 variance is advisory; malformed samples and the R2 verdict (150 MB ceiling, baseline
 * regression, 300 ms per-invocation maximum; #228 reset) always fail. `group` keys the committed baseline. */
export function workloadBudget(check: string, values: { group: string; wallP95Ms: number; rssSamplesMB: readonly number[]; wallSamplesMs: readonly number[]; wallLimitMs: number; wallMaxEnforced?: boolean; baseline?: R2Baseline }, env: NodeJS.ProcessEnv = process.env) {
  const wallAdvisory = hostedTimingRunner(env) === "macOS";
  const validWall = Number.isFinite(values.wallP95Ms) && values.wallP95Ms >= 0;
  const wallTimingPass = validWall && values.wallP95Ms < values.wallLimitMs;
  const r2 = r2Verdict(values.group, { rssMB: values.rssSamplesMB, wallMs: values.wallSamplesMs }, { env, ...(values.baseline ? { baseline: values.baseline } : {}), wallEnforced: values.wallMaxEnforced ?? true });
  const peakPass = r2.ceiling.pass && r2.regression.pass;
  const pass = r2.pass && validWall && (wallTimingPass || wallAdvisory);
  const status = !pass ? "fail" : wallTimingPass ? "pass" : "warning";
  const result = { wallTimingPass, peakPass, wallAdvisory, pass };
  const shown = { group: values.group, runner: r2.runner, wallP95Ms: values.wallP95Ms, wallLimitMs: values.wallLimitMs, rssStatistic: "p95", rssP95MB: r2.regression.p95MB, peakRssMB: r2.ceiling.peakMB,
    rssCount: values.rssSamplesMB.length, ceilingMB: r2.ceiling.limitMB, overCeiling: r2.ceiling.overCeiling, baselineMB: r2.regression.baselineMB, regressionLimitMB: r2.regression.limitMB,
    regressionEnforced: r2.regression.enforced, regressionPass: r2.regression.pass, ...(r2.regression.message ? { regressionMessage: r2.regression.message } : {}),
    wallMaxMs: r2.wallMax.maxMs, wallMaxLimitMs: r2.wallMax.limitMs, wallMaxEnforced: r2.wallMax.enforced, overWallMax: r2.wallMax.overMax };
  console.log(JSON.stringify({ diagnostic: "workload-R2", check, status, ...shown, ...result }));
  if (wallAdvisory && !env.GITHUB_STEP_SUMMARY) throw new Error(`GitHub ${env.RUNNER_OS} budget step summary is unavailable; set GITHUB_STEP_SUMMARY to retain warning receipts`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `**${check}: ${status}**\n\n\`${JSON.stringify({ ...shown, ...result })}\`\n\n`);
  if (!wallTimingPass && validWall && wallAdvisory) console.warn(`::warning title=Hook macOS runner p95::${check}: ${JSON.stringify(shown)}`);
  // A local (non-CI) regression is reported in the workload-R2 line above; GitHub annotations are for hosted runs only.
  if (r2.regression.message && !r2.regression.enforced && env.GITHUB_ACTIONS === "true") console.warn(`::warning title=R2 regression (reported, not enforced on ${r2.runner})::${r2.regression.message}`);
  if (r2.wallMax.overMax && !r2.wallMax.enforced) console.warn(`::warning title=R2 300 ms maximum (reported, not enforced here yet)::${check}: ${r2.wallMax.overMax} invocation(s), max ${r2.wallMax.maxMs} ms`);
  return { ...result, r2 };
}

/** One exact marker classifier; per-kind exceptions decide which hosted OS is allowed. */
function hostedTimingRunner(env: NodeJS.ProcessEnv): "Linux" | "macOS" | undefined {
  if (env.CI === "true" && env.GITHUB_ACTIONS === "true" && (env.RUNNER_OS === "Linux" || env.RUNNER_OS === "macOS")) return env.RUNNER_OS;
}
/** #293 person ruling: only reason-only stalls and accounted drain liveness use both hosted OSes. */
export function stallAdvisory(env: NodeJS.ProcessEnv = process.env): boolean {
  return hostedTimingRunner(env) !== undefined;
}

/** Gate diagnostics only. This module is never imported by the shipped hook path. */
export function singleAttemptTiming(check: string, passed: boolean, values: Record<string, number | boolean | null>, env: NodeJS.ProcessEnv = process.env): void {
  const advisory = env.CI === "true" && env.GITHUB_ACTIONS === "true";
  const status = passed ? "pass" : advisory ? "warning" : "fail";
  const record = { diagnostic: "single-attempt-timing", check, status, ...values };
  console.log(JSON.stringify(record));
  if (advisory && !env.GITHUB_STEP_SUMMARY) throw new Error("GitHub timing step summary is unavailable");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `**${check}: ${status}**\n\n\`${JSON.stringify(values)}\`\n\n`);
  if (!passed) {
    const message = `${check}: ${JSON.stringify(values)}`;
    if (advisory) console.warn(`::warning title=Hook single-attempt timing::${message}`);
    else throw new Error(message);
  }
}


export interface BudgetFailureEvidence {
  telemetryValid: boolean; survivors: number; abandonedOwnedWorkers?: number;
  unavailableRssSources?: number; receiptIncomplete?: boolean; wallMs?: number;
  reasonOnlyStreak?: number; drainPass?: number; expectedInvocations?: number; databaseRows?: number; hookPendingRows?: number; capturePendingRows?: number;
  accountedInvocations?: number; acknowledgedPendingRows?: number; pendingAliases?: number; accountingComplete?: boolean; unreadableItems?: number; duplicateItems?: number; unaccountedItems?: number; countedRetirements?: number;
  transcriptEvent?: string; logicalRunTelemetryValid?: boolean; spoolFullStops?: number; cursorSource?: string; cursorOffset?: number; summaryPrefixEnd?: number;
  scannedSummaries?: number; durableScannedSummaries?: number;
}
/** ponytail: #226's original abandonment/timing classes default to hosted macOS. #293 adds only reason-only
 * transcript stalls and exactly-accounted contended drains on exact hosted Linux/macOS markers.
 * #357 adds only the evidenced StopBurst unfinished-prefix/backpressure case on hosted Linux.
 * Every other verdict stays strict. Read the main red rate after one week; retire #293's exception after
 * a liveness redesign passes 20 strict runs on each affected hosted OS and the person approves retirement.
 * Retirement: remove this exception only when a #226 redesign passes 20 strict uninstrumented hosted-macOS
 * runs and the owner decides to retire it. */
export function budgetFailureAdvisory(kind: string, evidence: BudgetFailureEvidence, env: NodeJS.ProcessEnv = process.env): boolean {
  const runner = hostedTimingRunner(env), both = kind === "transcript-stall" || kind === "contended-drain" || kind === "not-durable";
  if (!(both ? runner !== undefined : runner === "macOS") || evidence.telemetryValid !== true
    || !Number.isSafeInteger(evidence.survivors) || evidence.survivors !== 0) return false;
  for (const count of [evidence.abandonedOwnedWorkers, evidence.unavailableRssSources])
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) return false;
  if (evidence.receiptIncomplete !== undefined && typeof evidence.receiptIncomplete !== "boolean") return false;
  if (evidence.wallMs !== undefined && (!Number.isFinite(evidence.wallMs) || evidence.wallMs < 0)) return false;
  if (kind === "transcript-stall") return Number.isSafeInteger(evidence.reasonOnlyStreak) && evidence.reasonOnlyStreak! >= 3;
  if (kind === "contended-drain") {
    const counts = [evidence.expectedInvocations, evidence.databaseRows, evidence.hookPendingRows, evidence.capturePendingRows,
      evidence.unreadableItems, evidence.duplicateItems, evidence.unaccountedItems, evidence.countedRetirements, evidence.accountedInvocations, evidence.acknowledgedPendingRows, evidence.pendingAliases];
    return evidence.drainPass === 4 && evidence.accountingComplete === true && counts.every(value => Number.isSafeInteger(value) && value! >= 0)
      && evidence.expectedInvocations! > 0 && evidence.databaseRows! < evidence.expectedInvocations!
      && evidence.accountedInvocations === evidence.expectedInvocations
      && evidence.acknowledgedPendingRows! <= Math.min(evidence.databaseRows!,evidence.hookPendingRows!+evidence.capturePendingRows!)
      && evidence.expectedInvocations === evidence.databaseRows! + evidence.hookPendingRows! + evidence.capturePendingRows! - evidence.acknowledgedPendingRows!
      && evidence.unreadableItems === 0 && evidence.duplicateItems === 0 && evidence.unaccountedItems === 0 && evidence.countedRetirements === 0;
  }
  if (kind === "not-durable") {
    if (runner === "macOS") return true;
    // ponytail: #357 permits only StopBurst's unfinished-prefix/backpressure ceiling after 64 follow-ups on hosted Linux.
    // Retire after a product fix gives 10 consecutive strict-green hosted Ubuntu runs, or a later person ruling.
    return evidence.transcriptEvent === "StopBurst" && evidence.logicalRunTelemetryValid === true && evidence.cursorSource === "cursor"
      && Number.isSafeInteger(evidence.spoolFullStops) && evidence.spoolFullStops! > 0
      && Number.isSafeInteger(evidence.cursorOffset) && evidence.cursorOffset! > 0
      && Number.isSafeInteger(evidence.summaryPrefixEnd) && evidence.summaryPrefixEnd! > evidence.cursorOffset!
      && Number.isSafeInteger(evidence.scannedSummaries) && evidence.scannedSummaries! > 0
      && Number.isSafeInteger(evidence.durableScannedSummaries) && evidence.durableScannedSummaries === evidence.scannedSummaries;
  }
  if (kind === "transcript-wall-max") return evidence.wallMs !== undefined && evidence.wallMs > 300;
  if (kind !== "rss-unknown" && kind !== "owned-descendant-receipt") return false;
  const abandoned = Number.isSafeInteger(evidence.abandonedOwnedWorkers) && evidence.abandonedOwnedWorkers! > 0;
  return abandoned && (kind === "owned-descendant-receipt" ? evidence.receiptIncomplete === true
    : Number.isSafeInteger(evidence.unavailableRssSources) && evidence.unavailableRssSources! > 0);
}

/** Report an already classified exception without altering process.exitCode or any hard verdict. */
export function reportBudgetAdvisory(kind: string, check: string, evidence: BudgetFailureEvidence, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!budgetFailureAdvisory(kind, evidence, env)) return false;
  const record = { diagnostic: "hosted-macos-budget-advisory", kind, check, status: "warning", ...evidence };
  console.log(JSON.stringify(record));
  if (!env.GITHUB_STEP_SUMMARY) throw new Error(`GitHub ${env.RUNNER_OS} budget step summary is unavailable; set GITHUB_STEP_SUMMARY to retain warning receipts`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `**${check}: warning (${kind})**\n\n\`${JSON.stringify(record)}\`\n\n`);
  console.warn(`::warning title=Hook ${env.RUNNER_OS} runner budget::${check}: ${JSON.stringify(record)}`);
  return true;
}

export interface AttributedWorkerRssEvidence extends BudgetFailureEvidence {
  rawFallbackRssSources: number; unexplainedRssSources: number;
  ownedChildObservationComplete: boolean; r1Passed: boolean;
}
/** #287 uses the existing marker predicate/record, but never the broader #226 attribution shortcut.
 * ponytail: at most two unknown counters per abandoned capture-only worker (own RSS and invalidation).
 * Retire with a lifecycle/reap redesign proved by strict hosted-macOS runs and an owner decision. */
export function attributedWorkerRssAdvisory(evidence: AttributedWorkerRssEvidence, env: NodeJS.ProcessEnv = process.env): boolean {
  return budgetFailureAdvisory("rss-unknown", evidence, env)
    && evidence.rawFallbackRssSources === 0 && evidence.unexplainedRssSources === 0
    && evidence.ownedChildObservationComplete === true && evidence.r1Passed === true
    && evidence.unavailableRssSources! <= 2 * evidence.abandonedOwnedWorkers!;
}
export function reportAttributedWorkerRssAdvisory(check: string, evidence: AttributedWorkerRssEvidence, env: NodeJS.ProcessEnv = process.env): boolean {
  return attributedWorkerRssAdvisory(evidence, env) && reportBudgetAdvisory("rss-unknown", check, evidence, env);
}
