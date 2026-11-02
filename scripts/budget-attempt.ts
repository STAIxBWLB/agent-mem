/** Measurement-only policy; never imported by the shipped hook or MCP path. */
import { cpus, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probeRunnerSpeed, runnerIsSlow, RUNNER_BASELINES, type RunnerBaseline, type RunnerProbe } from "./runner-probe.ts";

/** #228 baseline reset (owner decision 2026-11-02, hub memory f154ff52). R2 has three independent gates:
 * - an absolute RSS ceiling of 150 MB on every single invocation, on every runner, failing closed on unknown telemetry;
 * - a regression gate: a group fails when its nearest-rank p95 exceeds its committed per-runner baseline by more than 10%
 *   (docs/bench/r2-baseline.json; enforced on hosted-linux, hosted-macos and dgx02, reported only on a local machine);
 * - a hard per-invocation wall maximum of 300 ms, stalled attempts included, beside the unchanged 140 ms handler and p95 < 150.
 * Origin: #13 set R2 as an absolute 100 MB peak; that is retired here in favour of ceiling plus regression. */
export const R2_RSS_CEILING_MB = 150, R2_WALL_MAX_MS = 300, R2_REGRESSION = 0.10;
/** ponytail: transcript 300 ms max: pending #226 (task 103). The transcript harness logs the maximum per sample but does not
 * enforce it; main d927292 on hosted ubuntu peaked at 330/312 ms through the worker's unbounded staging (the #226 finding).
 * Ceiling: that harness only; hooks and full-spool enforce it now. Upgrade path: task 103 (#226 killable scan child, with a
 * bounded parent wait after the kill) switches this to true. */
export const TRANSCRIPT_WALL_MAX_ENFORCED = false;
export type RunnerKind = "hosted-linux" | "hosted-macos" | "dgx02" | "local";
const GATED: readonly RunnerKind[] = ["hosted-linux", "hosted-macos", "dgx02"];
/** Hosted runners are recognized by their exact GitHub markers. A dgx02 run sets AMEM_RUNNER=dgx02 explicitly (pass it through
 * remote_dev, e.g. `AMEM_RUNNER=dgx02 bun scripts/measure-hooks-budget.ts`); anything else is local. */
export function runnerKind(env: NodeJS.ProcessEnv = process.env): RunnerKind {
  if (env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "Linux") return "hosted-linux";
  if (env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "macOS") return "hosted-macos";
  return env.AMEM_RUNNER === "dgx02" ? "dgx02" : "local";
}
export interface R2Baseline { schema: "agent-mem.r2-baseline/v1"; runners: Partial<Record<RunnerKind, Record<string, number>>> }
export function loadR2Baseline(file = fileURLToPath(new URL("../docs/bench/r2-baseline.json", import.meta.url))): R2Baseline {
  const value = JSON.parse(readFileSync(file, "utf8")) as R2Baseline;
  if (value?.schema !== "agent-mem.r2-baseline/v1" || !value.runners || typeof value.runners !== "object") throw new Error(`${file} is not an R2 baseline file`);
  return value;
}
export interface R2Verdict {
  group: string; runner: RunnerKind; pass: boolean;
  ceiling: { pass: boolean; limitMB: number; peakMB: number; overCeiling: number };
  regression: { pass: boolean; enforced: boolean; p95MB: number; baselineMB: number | null; limitMB: number | null; message?: string };
  wallMax: { pass: boolean; enforced: boolean; limitMs: number; maxMs: number; overMax: number };
}
/** The three R2 gates for one group. Every sample is the caller's to report; unknown telemetry fails closed. */
export function r2Verdict(group: string, samples: { rssMB: readonly number[]; wallMs: readonly number[] }, options: { env?: NodeJS.ProcessEnv; baseline?: R2Baseline; wallEnforced?: boolean } = {}): R2Verdict {
  const runner = runnerKind(options.env), gated = GATED.includes(runner);
  const rss = rssVerdict(samples.rssMB, R2_RSS_CEILING_MB);
  const known = samples.rssMB.length > 0 && samples.rssMB.every(value => Number.isFinite(value) && value > 0);
  const ceiling = { pass: known && rss.peakMB < R2_RSS_CEILING_MB, limitMB: R2_RSS_CEILING_MB, peakMB: rss.peakMB, overCeiling: samples.rssMB.filter(value => !(value < R2_RSS_CEILING_MB)).length };
  const baselineMB = (options.baseline ?? loadR2Baseline()).runners[runner]?.[group];
  let regression: R2Verdict["regression"];
  if (baselineMB === undefined || !Number.isFinite(baselineMB) || baselineMB <= 0) {
    const message = `no R2 baseline for ${runner} ${group}; record one: run the budget script on ${runner}, take the group's p95 from its log, and add it to docs/bench/r2-baseline.json in a PR that links that run`;
    regression = { pass: !gated, enforced: gated, p95MB: rss.valueMB, baselineMB: null, limitMB: null, message };
  } else {
    const limitMB = baselineMB * (1 + R2_REGRESSION), within = known && rss.valueMB <= limitMB;
    regression = { pass: gated ? within : true, enforced: gated, p95MB: rss.valueMB, baselineMB, limitMB, ...(within ? {} : { message: `${group} p95 ${rss.valueMB} MB exceeds its ${runner} baseline ${baselineMB} MB by more than 10%` }) };
  }
  const wallKnown = samples.wallMs.length > 0 && samples.wallMs.every(value => Number.isFinite(value) && value >= 0);
  const maxMs = wallKnown ? Math.max(...samples.wallMs) : Number.NaN, wallEnforced = options.wallEnforced ?? true;
  const wallMax = { pass: !wallEnforced || wallKnown && maxMs <= R2_WALL_MAX_MS, enforced: wallEnforced, limitMs: R2_WALL_MAX_MS, maxMs, overMax: samples.wallMs.filter(value => !(value <= R2_WALL_MAX_MS)).length };
  return { group, runner, pass: ceiling.pass && regression.pass && wallMax.pass, ceiling, regression, wallMax };
}
export interface RssVerdict { pass: boolean; statistic: "p95"; valueMB: number; peakMB: number; count: number; overLimit: number; limitMB: number }
/** #228: the gate is the nearest-rank p95 over a fixed sample count, not the single maximum. Every sample is still
 * reported by the caller; a non-finite or non-positive sample (unknown telemetry) fails the whole group closed. */
export function rssVerdict(samplesMB: readonly number[], limitMB: number): RssVerdict {
  const count = samplesMB.length, known = count > 0 && samplesMB.every(value => Number.isFinite(value) && value > 0);
  const sorted = [...samplesMB].sort((a, b) => a - b), valueMB = known ? sorted[Math.ceil(count * 0.95) - 1]! : NaN, peakMB = known ? sorted[count - 1]! : NaN;
  return { pass: known && Number.isFinite(limitMB) && valueMB < limitMB, statistic: "p95", valueMB, peakMB, count, overLimit: samplesMB.filter(value => !(value < limitMB)).length, limitMB };
}
/** Once per measurement run, beside the samples, so an RSS shift can be correlated with the runner (#228). */
export function runnerFingerprint(): { diagnostic: "runner-fingerprint"; platform: string; arch: string; nproc: number; totalMemMB: number; cpuModel: string; runnerImage: string | null } {
  const value = { diagnostic: "runner-fingerprint" as const, platform: process.platform, arch: process.arch, nproc: cpus().length, totalMemMB: Math.round(totalmem() / 1048576),
    cpuModel: cpus()[0]?.model.trim() ?? "unknown", runnerImage: process.env.ImageOS && process.env.ImageVersion ? `${process.env.ImageOS} ${process.env.ImageVersion}` : null };
  console.log(JSON.stringify(value));
  return value;
}
/** #228 (review P2): a logical sample whose first attempt stalled keeps the highest RSS seen across all its attempts,
 * so a retry can never hide a high-RSS attempt from the p95 distribution. Wall stays the completed attempt's (the
 * existing stall contract: a stall is a wall/deadline event, re-measured once). A stalled attempt without a finite
 * positive RSS is unknown telemetry and fails the group closed. */
/** #228 reset: the 300 ms per-invocation maximum counts every attempt, stalled ones included. The sample's own wallMs stays the
 * completed attempt's for the p95 contract; attemptWallMaxMs carries the highest wall seen across its attempts. */
export function keepAttemptWall<T extends { wallMs: number }>(completed: T, attempts: readonly BudgetAttempt<T>[]): T & { attemptWallMaxMs: number } {
  const stalled = attempts.filter(attempt => attempt.outcome === "stall").map(attempt => attempt.values?.wallMs);
  if (stalled.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return { ...completed, attemptWallMaxMs: Number.NaN };
  return { ...completed, attemptWallMaxMs: Math.max(completed.wallMs, ...(stalled as number[])) };
}
export function keepAttemptRss<T extends { rssMB: number }>(completed: T, stalled: readonly BudgetAttempt<T>[]): T {
  const stalledRss = stalled.filter(attempt => attempt.outcome === "stall").map(attempt => attempt.values?.rssMB);
  if (stalledRss.some(value => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return { ...completed, rssMB: Number.NaN };
  return { ...completed, rssMB: Math.max(completed.rssMB, ...(stalledRss as number[])) };
}
export class BudgetStall extends Error {
  constructor(message: string, readonly values: Record<string, number | string | boolean | null> = {}) { super(message); this.name = "BudgetStall"; }
}
export interface BudgetAttempt<T> {
  diagnostic: "budget-attempt"; check: string; attempt: 1 | 2; outcome: "pass" | "stall" | "fail";
  result?: T; error?: string; values?: Record<string, number | string | boolean | null>;
}
/** Retry exactly one explicit stall, retaining the same run callback/limits and every attempt receipt. */
export async function budgetSample<T>(check: string, run: () => T | Promise<T>, record: (attempt: BudgetAttempt<T>) => void = attempt => console.log(JSON.stringify(attempt))): Promise<T> {
  for (const attempt of [1, 2] as const) {
    let result: T;
    try { result = await run(); }
    catch (error) {
      const stalled = error instanceof BudgetStall;
      record({ diagnostic: "budget-attempt", check, attempt, outcome: stalled ? "stall" : "fail", error: error instanceof Error ? error.message : String(error), ...(stalled ? { values: error.values } : {}) });
      if (stalled && attempt === 1) continue;
      throw error;
    }
    record({ diagnostic: "budget-attempt", check, attempt, outcome: "pass", result }); return result;
  }
  throw new Error("unreachable budget attempt");
}

/** Keep stalled physical attempts visible beside workload p95, which uses completed samples. */
export function budgetGroupRecorder<T>(group: string, counts: Map<string, number>, write: (attempt: BudgetAttempt<T>) => void = attempt => console.log(JSON.stringify(attempt))): (attempt: BudgetAttempt<T>) => void {
  if (!counts.has(group)) counts.set(group, 0);
  return attempt => { if (attempt.outcome === "stall") counts.set(group, counts.get(group)! + 1); write(attempt); };
}

export interface BudgetGroupAttempt<T> {
  diagnostic: "budget-group"; check: string; attempt: 1 | 2; outcome: "pass" | "wall-miss" | "wall-max-miss" | "rss-miss" | "fail";
  before: RunnerProbe; after: RunnerProbe; baseline: RunnerBaseline; slow: boolean; retryPolicy: "slow-wall" | "stall"; result?: T; error?: string; values?: BudgetStall["values"];
}
/** One re-measure: slow-runner wall misses by default, or the existing MCP single-stall rule. */
export async function budgetGroup<T>(check: string, run: () => T | Promise<T>, judge: (result: T) => { wallPass: boolean; rssPass: boolean; wallMaxPass?: boolean },
  options: { probe?: () => RunnerProbe | Promise<RunnerProbe>; baseline?: RunnerBaseline; record?: (attempt: BudgetGroupAttempt<T>) => void; retryPolicy?: "slow-wall" | "stall" } = {}): Promise<{ result: T; attempts: BudgetGroupAttempt<T>[] }> {
  const probe = options.probe ?? probeRunnerSpeed, baseline = options.baseline ?? RUNNER_BASELINES[process.platform];
  if (!baseline) throw Error("runner baseline unavailable for this platform");
  const record = options.record ?? (attempt => console.log(JSON.stringify(attempt))), attempts: BudgetGroupAttempt<T>[] = [], retryPolicy = options.retryPolicy ?? "slow-wall";
  for (const attempt of [1, 2] as const) {
    const before = await probe(); let result: T | undefined, failure: unknown, failed = false;
    let verdict: { wallPass: boolean; rssPass: boolean; wallMaxPass?: boolean } | undefined;
    try { result = await run(); verdict = judge(result); }
    catch (error) { failure = error; failed = true; }
    const after = await probe(), slow = runnerIsSlow(before, after, baseline);
    // #228 reset: a hard per-invocation 300 ms miss is its own outcome and is never re-measured away by the slow-runner retry.
    const outcome = failed ? failure instanceof BudgetStall ? "wall-miss" : "fail" : verdict?.rssPass !== true ? "rss-miss" : verdict.wallMaxPass === false ? "wall-max-miss" : verdict.wallPass === true ? "pass" : "wall-miss";
    const receipt: BudgetGroupAttempt<T> = { diagnostic: "budget-group", check, attempt, outcome, before, after, baseline, slow, retryPolicy,
      ...(!failed ? { result } : { error: failure instanceof Error ? failure.message : String(failure), ...(failure instanceof BudgetStall ? { values: failure.values } : {}) }) };
    attempts.push(receipt); record(receipt);
    if (outcome === "pass") return { result: result!, attempts };
    if (outcome === "wall-miss" && attempt === 1 && (retryPolicy === "stall" ? failure instanceof BudgetStall : slow)) continue;
    if (failed) throw failure;
    throw Error(`${check}: ${outcome}`);
  }
  throw Error("unreachable budget group attempt");
}
