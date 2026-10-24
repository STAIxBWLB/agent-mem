/** Measurement-only policy; never imported by the shipped hook or MCP path. */
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
