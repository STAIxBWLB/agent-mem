/** Measurement-only policy; never imported by the shipped hook or MCP path. */
import { probeRunnerSpeed, runnerIsSlow, RUNNER_BASELINES, type RunnerBaseline, type RunnerProbe } from "./runner-probe.ts";
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
  before: RunnerProbe; after: RunnerProbe; baseline: RunnerBaseline; slow: boolean; result?: T; error?: string; values?: BudgetStall["values"];
}
/** Re-measure only an evidenced slow-runner wall miss, at most once, retaining all measurements. */
export async function budgetGroup<T>(check: string, run: () => T | Promise<T>, judge: (result: T) => { wallPass: boolean; rssPass: boolean },
  options: { probe?: () => RunnerProbe | Promise<RunnerProbe>; baseline?: RunnerBaseline; record?: (attempt: BudgetGroupAttempt<T>) => void } = {}): Promise<{ result: T; attempts: BudgetGroupAttempt<T>[] }> {
  const probe = options.probe ?? probeRunnerSpeed, baseline = options.baseline ?? RUNNER_BASELINES[process.platform];
  if (!baseline) throw Error("runner baseline unavailable for this platform");
  const record = options.record ?? (attempt => console.log(JSON.stringify(attempt))), attempts: BudgetGroupAttempt<T>[] = [];
  for (const attempt of [1, 2] as const) {
    const before = await probe(); let result: T | undefined, failure: unknown, failed = false;
    let verdict: { wallPass: boolean; rssPass: boolean } | undefined;
    try { result = await run(); verdict = judge(result); }
    catch (error) { failure = error; failed = true; }
    const after = await probe(), slow = runnerIsSlow(before, after, baseline);
    const outcome = failed ? failure instanceof BudgetStall ? "wall-miss" : "fail" : verdict?.rssPass !== true ? "rss-miss" : verdict.wallPass === true ? "pass" : "wall-miss";
    const receipt: BudgetGroupAttempt<T> = { diagnostic: "budget-group", check, attempt, outcome, before, after, baseline, slow,
      ...(!failed ? { result } : { error: failure instanceof Error ? failure.message : String(failure), ...(failure instanceof BudgetStall ? { values: failure.values } : {}) }) };
    attempts.push(receipt); record(receipt);
    if (outcome === "pass") return { result: result!, attempts };
    if (outcome === "wall-miss" && slow && attempt === 1) continue;
    if (failed) throw failure;
    throw Error(`${check}: ${outcome}`);
  }
  throw Error("unreachable budget group attempt");
}
