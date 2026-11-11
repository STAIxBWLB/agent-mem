/** Measurement-only policy; never imported by the shipped hook or MCP path. */
import { cpus, totalmem } from "node:os";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probeRunnerSpeed, runnerIsSlow, RUNNER_BASELINES, type RunnerBaseline, type RunnerProbe } from "./runner-probe.ts";

/** #228 baseline reset (owner decision 2026-11-02, hub memory f154ff52). R2 has three independent gates:
 * - an absolute RSS ceiling of 150 MB on every single invocation, on every runner, failing closed on unknown telemetry;
 * - a regression gate: a group fails when its nearest-rank p95 exceeds its committed per-runner baseline by more than 10%
 *   (docs/bench/r2-baseline.json; enforced on hosted-linux, hosted-macos and dgx02, reported only on a local machine);
 * - a hard per-invocation wall maximum of 300 ms, stalled attempts included, beside the unchanged 140 ms handler and p95 < 150.
 * Origin: #13 set R2 as an absolute 100 MB peak; that is retired here in favour of ceiling plus regression. */
export const R2_RSS_CEILING_MB = 150, R2_WALL_MAX_MS = 300, R2_REGRESSION = 0.10;
/** #226 (task 107): the transcript scan runs in a killable child with a bounded parent wait after the kill, so the transcript
 * harness enforces the 300 ms per-invocation maximum like hooks and full-spool. */
export const TRANSCRIPT_WALL_MAX_ENFORCED = true;
export type RunnerKind = "hosted-linux" | "hosted-macos" | "dgx02" | "local";
const GATED: readonly RunnerKind[] = ["hosted-linux", "hosted-macos", "dgx02"];
/** Hosted runners are recognized by their exact GitHub markers. A dgx02 run sets AMEM_RUNNER=dgx02 explicitly (pass it through
 * remote_dev, e.g. `AMEM_RUNNER=dgx02 bun scripts/measure-hooks-budget.ts`); anything else is local. */
export function runnerKind(env: NodeJS.ProcessEnv = process.env): RunnerKind {
  if (env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "Linux") return "hosted-linux";
  if (env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "macOS") return "hosted-macos";
  return env.AMEM_RUNNER === "dgx02" ? "dgx02" : "local";
}
export type MacosHardwareClass = "apple-m1" | "apple-m2-pro" | "unknown";
/** Only evidenced CPU classes qualify; future models retain the strict runner baseline. */
export function macosHardwareClass(cpuModel: string): MacosHardwareClass {
  switch (cpuModel.trim()) {
    case "Apple M1": case "Apple M1 (Virtual)": return "apple-m1";
    case "Apple M2 Pro": case "Apple M2 Pro (Virtual)": return "apple-m2-pro";
    default: return "unknown";
  }
}
export interface R2Baseline {
  schema: "agent-mem.r2-baseline/v1";
  runners: Partial<Record<RunnerKind, Record<string, number>>>;
  hardwareClasses?: { "hosted-macos"?: { "apple-m2-pro"?: { "transcript:StopBurst"?: number } } };
}
export function loadR2Baseline(file = fileURLToPath(new URL("../docs/bench/r2-baseline.json", import.meta.url))): R2Baseline {
  const value = JSON.parse(readFileSync(file, "utf8")) as R2Baseline;
  if (value?.schema !== "agent-mem.r2-baseline/v1" || !value.runners || typeof value.runners !== "object") throw new Error(`${file} is not an R2 baseline file`);
  return value;
}
export interface R2Verdict {
  group: string; runner: RunnerKind; pass: boolean;
  ceiling: { pass: boolean; limitMB: number; peakMB: number; overCeiling: number };
  regression: { pass: boolean; enforced: boolean; p95MB: number; baselineMB: number | null; limitMB: number | null; message?: string; cpuModel?: string; hardwareClass?: MacosHardwareClass; baselineSource?: "hardware-class" | "runner" };
  wallMax: { pass: boolean; enforced: boolean; limitMs: number; maxMs: number; overMax: number };
}
/** The three R2 gates for one group. Every sample is the caller's to report; unknown telemetry fails closed. */
export function r2Verdict(group: string, samples: { rssMB: readonly number[]; wallMs: readonly number[] }, options: { env?: NodeJS.ProcessEnv; baseline?: R2Baseline; wallEnforced?: boolean; cpuModel?: string } = {}): R2Verdict {
  const runner = runnerKind(options.env), gated = GATED.includes(runner);
  const rss = rssVerdict(samples.rssMB, R2_RSS_CEILING_MB);
  const known = samples.rssMB.length > 0 && samples.rssMB.every(value => Number.isFinite(value) && value > 0);
  const ceiling = { pass: known && rss.peakMB < R2_RSS_CEILING_MB, limitMB: R2_RSS_CEILING_MB, peakMB: rss.peakMB, overCeiling: samples.rssMB.filter(value => !(value < R2_RSS_CEILING_MB)).length };
  const baseline = options.baseline ?? loadR2Baseline();
  let baselineMB = baseline.runners[runner]?.[group];
  let hardware: Pick<R2Verdict["regression"], "cpuModel" | "hardwareClass" | "baselineSource"> = {};
  // #365: only this evidenced group has a hardware-class baseline. Unknown CPUs keep the runner value.
  if (runner === "hosted-macos" && group === "transcript:StopBurst") {
    const cpuModel = (options.cpuModel ?? cpus()[0]?.model ?? "unknown").trim(), hardwareClass = macosHardwareClass(cpuModel);
    const override = hardwareClass === "apple-m2-pro" ? baseline.hardwareClasses?.["hosted-macos"]?.[hardwareClass]?.["transcript:StopBurst"] : undefined;
    if (override !== undefined) baselineMB = override;
    hardware = { cpuModel, hardwareClass, baselineSource: override === undefined ? "runner" : "hardware-class" };
  }
  let regression: R2Verdict["regression"];
  if (baselineMB === undefined || !Number.isFinite(baselineMB) || baselineMB <= 0) {
    const message = `no R2 baseline for ${runner} ${group}; record one: run the budget script on ${runner}, take the group's p95 from its log, and add it to docs/bench/r2-baseline.json in a PR that links that run`;
    regression = { pass: !gated, enforced: gated, p95MB: rss.valueMB, baselineMB: null, limitMB: null, message };
  } else {
    const limitMB = baselineMB * (1 + R2_REGRESSION), within = known && rss.valueMB <= limitMB;
    regression = { pass: gated ? within : true, enforced: gated, p95MB: rss.valueMB, baselineMB, limitMB, ...(within ? {} : { message: `${group} p95 ${rss.valueMB} MB exceeds its ${runner} baseline ${baselineMB} MB by more than 10%` }) };
  }
  regression = { ...regression, ...hardware };
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
/** #228 reset (ruling option 3): the 300 ms per-invocation maximum is judged on the handler's own metric wallMs, across every
 * attempt, stalled ones included. The sample's outer wallMs stays the completed attempt's for the p95 contract and is reported
 * only; attemptWallMaxMs carries the highest metric wall seen. A missing or non-finite metric wall on any attempt fails closed. */
export function keepAttemptWall<T extends { metricWallMs: number }>(completed: T, attempts: readonly BudgetAttempt<Partial<Record<"metricWallMs", unknown>>>[]): T & { attemptWallMaxMs: number } {
  const values = [completed.metricWallMs, ...attempts.filter(attempt => attempt.outcome === "stall").map(attempt => attempt.values?.metricWallMs)];
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return { ...completed, attemptWallMaxMs: Number.NaN };
  return { ...completed, attemptWallMaxMs: Math.max(...(values as number[])) };
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
  options: { probe?: () => RunnerProbe | Promise<RunnerProbe>; baseline?: RunnerBaseline; record?: (attempt: BudgetGroupAttempt<T>) => void; retryPolicy?: "slow-wall" | "stall"; env?: NodeJS.ProcessEnv } = {}): Promise<{ result: T; attempts: BudgetGroupAttempt<T>[] }> {
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
    // codex P2 on #231: under the R2 maximum (the default slow-wall policy of the hook budgets) a stall is retryable only when its
    // own handler wall is known and within 300 ms; a missing or larger one is a wall-max miss. The MCP stall policy has no hook wall.
    const metricWall = failure instanceof BudgetStall ? failure.values?.metricWallMs : undefined;
    const stallWithinMax = retryPolicy === "stall" || typeof metricWall === "number" && Number.isFinite(metricWall) && metricWall >= 0 && metricWall <= R2_WALL_MAX_MS;
    const outcome = failed ? failure instanceof BudgetStall ? stallWithinMax ? "wall-miss" : "wall-max-miss" : "fail" : verdict?.rssPass !== true ? "rss-miss" : verdict.wallMaxPass === false ? "wall-max-miss" : verdict.wallPass === true ? "pass" : "wall-miss";
    const receipt: BudgetGroupAttempt<T> = { diagnostic: "budget-group", check, attempt, outcome, before, after, baseline, slow, retryPolicy,
      ...(!failed ? { result } : { error: failure instanceof Error ? failure.message : String(failure), ...(failure instanceof BudgetStall ? { values: failure.values } : {}) }) };
    attempts.push(receipt); record(receipt);
    if (outcome === "pass") return { result: result!, attempts };
    // #302 (owner ruling C, 2026-11-08): on a GitHub-hosted runner a wall miss is re-measured once whatever the probe says, because the probe
    // (three small durable writes outside the group) did not flag several real storage stalls. The second attempt faces the same limits and
    // its result stands; there is no best-run selection. Local and dgx02 runs keep the probe-gated rule.
    const hosted = ["hosted-linux", "hosted-macos"].includes(runnerKind(options.env));
    if (outcome === "wall-miss" && attempt === 1 && (retryPolicy === "stall" ? failure instanceof BudgetStall : slow || hosted)) continue;
    if (failed) throw failure;
    throw Error(`${check}: ${outcome}`);
  }
  throw Error("unreachable budget group attempt");
}

export type HookWallKind348 = "wall-p95" | "wall-max" | "SessionStart deadline omitted fixture work";
export interface HookWallEvidence348 {
  telemetryValid: boolean; rssPass: boolean; survivors: number;
  wallP95Ms: number; wallMaxMs: number; rssP95MB: number; peakRssMB: number;
}
/** Measurement-only admission, not a verdict: RSS regression is checked on the complete group later. */
export function hookWallRunner348(group: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" && env.GITHUB_ACTIONS === "true" && (env.RUNNER_OS === "Linux" || env.RUNNER_OS === "macOS")
    && ["plain", "spoolAndExit", "drain", "sessionStart", "sessionStartRepoLog", "jcode", "jcodeJournal"].includes(group);
}
/** ponytail: temporary owner ruling #348; retire only after #348 is resolved and the person approves.
 * Upgrade to a strict wall gate after the attributed timing path is repaired; no automatic expiry. */
export function hookWallAdvisory348(group: string, kind: string, evidence: HookWallEvidence348, env: NodeJS.ProcessEnv = process.env): boolean {
  return hookWallRunner348(group, env) && evidence.telemetryValid === true && evidence.rssPass === true && evidence.survivors === 0
    && [evidence.wallP95Ms, evidence.wallMaxMs].every(value => Number.isFinite(value) && value >= 0)
    && [evidence.rssP95MB, evidence.peakRssMB].every(value => Number.isFinite(value) && value > 0 && value < R2_RSS_CEILING_MB)
    && (kind === "wall-p95" && evidence.wallP95Ms >= 150 || kind === "wall-max" && evidence.wallMaxMs > R2_WALL_MAX_MS
      || kind === "SessionStart deadline omitted fixture work" && ["sessionStart", "sessionStartRepoLog"].includes(group));
}
export function reportHookWallAdvisory348(group: string, kind: string, evidence: HookWallEvidence348, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hookWallAdvisory348(group, kind, evidence, env)) return false;
  const record = { diagnostic: "hosted-hook-wall-advisory-348", issue: 348, group, kind, status: "warning", ...evidence };
  console.log(JSON.stringify(record));
  if (!env.GITHUB_STEP_SUMMARY) throw Error("Hook #348 advisory step summary unavailable; set GITHUB_STEP_SUMMARY to retain timing evidence");
  appendFileSync(env.GITHUB_STEP_SUMMARY, `**Hook #348 advisory: ${group} (${kind})**\n\n\`${JSON.stringify(record)}\`\n\n`);
  console.warn(`::warning title=Hook wall advisory #348::${JSON.stringify(record)}`);
  return true;
}

/** Preserve the original verdict; widen timing only after validating all wall telemetry. */
export function hookWallPass348(verdict: { pass: boolean; peakPass: boolean; wallTimingPass: boolean; wallAdvisory: boolean; r2: { wallMax: { pass: boolean } } },
  wallP95Ms: number, wallSamplesMs: readonly number[], advisories: { p95: boolean; max: boolean }): boolean {
  const wallValid = Number.isFinite(wallP95Ms) && wallP95Ms >= 0 && wallSamplesMs.length > 0
    && wallSamplesMs.every(value => Number.isFinite(value) && value >= 0);
  if (!wallValid) return false;
  return verdict.pass || verdict.peakPass && (verdict.r2.wallMax.pass || advisories.max)
    && (verdict.wallTimingPass || advisories.p95 || verdict.wallAdvisory);
}
