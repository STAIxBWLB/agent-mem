/** Measurement-only policy; never imported by the shipped hook or MCP path. */
import { cpus, totalmem } from "node:os";
import { probeRunnerSpeed, runnerIsSlow, RUNNER_BASELINES, type RunnerBaseline, type RunnerProbe } from "./runner-probe.ts";

/** R2 hook RSS limit, MB. Every group and OS uses it unless named below (#228). */
export const R2_RSS_LIMIT_MB = 100;
/** ponytail: hosted ubuntu transcript StopBurst gates at p95 < 110 MB (owner decision 2026-11-02, #228). From main 9986fe6
 * its whole distribution moved up about 7 MB on unchanged hook code and the same runner image; the cause is unknown.
 * Ceiling: 110 MB on that one group and OS. Upgrade path: explain the shift (the runner fingerprint is logged beside
 * every measurement run), then delete this entry so the group returns to R2_RSS_LIMIT_MB. */
export const R2_RSS_LIMIT_OVERRIDES_MB: Readonly<Record<string, number>> = { "hosted-linux:transcript:StopBurst": 110 };
/** The override applies only on a hosted GitHub Linux runner; local and dgx02 runs keep R2_RSS_LIMIT_MB. */
export function r2RssLimitMB(group: string, env: NodeJS.ProcessEnv = process.env): number {
  const runner = env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "Linux" ? "hosted-linux" : env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "macOS" ? "hosted-macos" : "local";
  return R2_RSS_LIMIT_OVERRIDES_MB[`${runner}:${group}`] ?? R2_RSS_LIMIT_MB;
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
  diagnostic: "budget-group"; check: string; attempt: 1 | 2; outcome: "pass" | "wall-miss" | "rss-miss" | "fail";
  before: RunnerProbe; after: RunnerProbe; baseline: RunnerBaseline; slow: boolean; retryPolicy: "slow-wall" | "stall"; result?: T; error?: string; values?: BudgetStall["values"];
}
/** One re-measure: slow-runner wall misses by default, or the existing MCP single-stall rule. */
export async function budgetGroup<T>(check: string, run: () => T | Promise<T>, judge: (result: T) => { wallPass: boolean; rssPass: boolean },
  options: { probe?: () => RunnerProbe | Promise<RunnerProbe>; baseline?: RunnerBaseline; record?: (attempt: BudgetGroupAttempt<T>) => void; retryPolicy?: "slow-wall" | "stall" } = {}): Promise<{ result: T; attempts: BudgetGroupAttempt<T>[] }> {
  const probe = options.probe ?? probeRunnerSpeed, baseline = options.baseline ?? RUNNER_BASELINES[process.platform];
  if (!baseline) throw Error("runner baseline unavailable for this platform");
  const record = options.record ?? (attempt => console.log(JSON.stringify(attempt))), attempts: BudgetGroupAttempt<T>[] = [], retryPolicy = options.retryPolicy ?? "slow-wall";
  for (const attempt of [1, 2] as const) {
    const before = await probe(); let result: T | undefined, failure: unknown, failed = false;
    let verdict: { wallPass: boolean; rssPass: boolean } | undefined;
    try { result = await run(); verdict = judge(result); }
    catch (error) { failure = error; failed = true; }
    const after = await probe(), slow = runnerIsSlow(before, after, baseline);
    const outcome = failed ? failure instanceof BudgetStall ? "wall-miss" : "fail" : verdict?.rssPass !== true ? "rss-miss" : verdict.wallPass === true ? "pass" : "wall-miss";
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
