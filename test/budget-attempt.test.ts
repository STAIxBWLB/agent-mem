import { expect, test } from "bun:test";
import { budgetSample, BudgetStall, budgetGroupRecorder, type BudgetAttempt } from "../scripts/budget-attempt.ts";
for (const check of ["hook-SessionStart", "mcp-session"] as const) {
  test(`${check}: one injected stall retries under the same limit and records both attempts`, async () => {
    const attempts: BudgetAttempt<{ wallMs: number }>[] = [], limitMs = check === "mcp-session" ? 30000 : 150; let calls = 0;
    const result = await budgetSample(check, () => { if (++calls === 1) throw new BudgetStall("injected stall", { wallMs: limitMs, limitMs }); return { wallMs: limitMs - 1 }; }, row => attempts.push(row));
    expect(result).toEqual({ wallMs: limitMs - 1 }); expect(calls).toBe(2);
    expect(attempts.map(row => [row.attempt, row.outcome])).toEqual([[1, "stall"], [2, "pass"]]); expect(attempts[0]!.values).toEqual({ wallMs: limitMs, limitMs }); expect(attempts[1]!.result).toEqual(result);
  });
  test(`${check}: two consecutive injected stalls fail with no third attempt and preserve both receipts`, async () => {
    let calls = 0; const attempts: BudgetAttempt<never>[] = [];
    await expect(budgetSample(check, () => { calls++; throw new BudgetStall("injected stall", { call: calls }); }, row => attempts.push(row))).rejects.toThrow("injected stall");
    expect(calls).toBe(2); expect(attempts.map(row => [row.attempt, row.outcome])).toEqual([[1, "stall"], [2, "stall"]]); expect(attempts.map(row => row.values?.call)).toEqual([1, 2]);
  });
  test(`${check}: correctness, RSS and process failures never retry`, async () => {
    for (const reason of ["RSS exceeded", "owned process survived", "invalid protocol result"]) {
      let calls = 0; const attempts: BudgetAttempt<never>[] = [];
      await expect(budgetSample(check, () => { calls++; throw Error(reason); }, row => attempts.push(row))).rejects.toThrow(reason);
      expect(calls).toBe(1); expect(attempts).toHaveLength(1); expect(attempts[0]!.outcome).toBe("fail");
    }
  });
}

test("retry policy leaves workload p95 and RSS verdicts strict under the unchanged limits", async () => {
  const { workloadBudget } = await import("../scripts/hook-timing-check.ts");
  const values = { wallP95Ms: 150, peakRssMB: 80, wallLimitMs: 150, rssLimitMB: 100 };
  expect(workloadBudget("injected p95 miss", values, {}).pass).toBe(false);
  expect(workloadBudget("injected RSS miss", { ...values, wallP95Ms: 100, peakRssMB: 100 }, {}).pass).toBe(false);
  expect(workloadBudget("under both limits", { ...values, wallP95Ms: 149, peakRssMB: 99 }, {}).pass).toBe(true);
});

test("group summaries count stalled physical attempts independently and retain every receipt", async () => {
  const counts = new Map<string, number>(), receipts: BudgetAttempt<number>[] = []; let calls = 0;
  const write = (attempt: BudgetAttempt<number>) => receipts.push(attempt);
  expect(await budgetSample("plain-1", () => { if (++calls === 1) throw new BudgetStall("stall"); return 7; }, budgetGroupRecorder<number>("plain", counts, write))).toBe(7);
  await budgetSample("plain-2", () => 8, budgetGroupRecorder<number>("plain", counts, write));
  await budgetSample("session-1", () => 9, budgetGroupRecorder<number>("sessionStart", counts, write));
  expect(Object.fromEntries(counts)).toEqual({ plain: 1, sessionStart: 0 });
  expect(receipts.map(row => row.outcome)).toEqual(["stall", "pass", "pass", "pass"]);
});
test("a failed second stall is counted in the group without a third attempt", async () => {
  const counts = new Map<string, number>(), receipts: BudgetAttempt<never>[] = [];
  await expect(budgetSample("drain-1", () => { throw new BudgetStall("stall"); }, budgetGroupRecorder<never>("drain", counts, row => receipts.push(row)))).rejects.toThrow("stall");
  expect(counts.get("drain")).toBe(2); expect(receipts).toHaveLength(2);
});
