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

// Injected readings keep runner-speed cases independent of the machine running the tests.
const checksum = "55c7e25571a69216de25162f191bb2847201a09ee7efe46b5bada034acc695d5";
const baseline = { cpuMs: 10, spawnMs: 10, factor: 2 };
const normal = { cpuMs: 10, spawnMs: 10, checksum }, slow = { ...normal, spawnMs: 21 };
const judgeGroup = (result: { wallMs: number; rssMB: number }) => ({ wallPass: result.wallMs < 150, rssPass: result.rssMB > 0 && result.rssMB < 100 });

test("a slow-probed group remeasures a single wall miss once and retains every result and probe", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  const receipts: import("../scripts/budget-attempt.ts").BudgetGroupAttempt<{ wallMs: number; rssMB: number }>[] = [];
  let runs = 0, probes = 0;
  const result = await budgetGroup("injected", () => ({ wallMs: ++runs === 1 ? 184 : 81, rssMB: 50 }), judgeGroup,
    { baseline, probe: () => { probes++; return probes === 2 ? slow : normal; }, record: row => receipts.push(row) });
  expect(runs).toBe(2); expect(probes).toBe(4); expect(result.result.wallMs).toBe(81);
  expect(result.attempts).toEqual(receipts);
  expect(receipts.map(row => [row.attempt, row.outcome, row.slow])).toEqual([[1, "wall-miss", true], [2, "pass", false]]);
  expect(receipts[0]!.result!.wallMs).toBe(184); expect(receipts[0]!.before).toEqual(normal); expect(receipts[0]!.after).toEqual(slow);
});

test("two slow-probed group misses fail with two complete attempts and no third run", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  const receipts: unknown[] = []; let runs = 0, probes = 0;
  await expect(budgetGroup("injected", () => { runs++; return { wallMs: 184, rssMB: 50 }; }, judgeGroup,
    { baseline, probe: () => { probes++; return slow; }, record: row => receipts.push(row) })).rejects.toThrow("wall-miss");
  expect(runs).toBe(2); expect(probes).toBe(4); expect(receipts).toHaveLength(2);
});

test("a normal-speed group wall miss fails immediately without remeasurement", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  let runs = 0, probes = 0; const receipts: unknown[] = [];
  await expect(budgetGroup("injected", () => { runs++; return { wallMs: 150, rssMB: 50 }; }, judgeGroup,
    { baseline, probe: () => { probes++; return normal; }, record: row => receipts.push(row) })).rejects.toThrow("wall-miss");
  expect(runs).toBe(1); expect(probes).toBe(2); expect(receipts).toHaveLength(1);
});

test("an RSS miss never remeasures, including a simultaneous wall miss on a slow runner", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  for (const wallMs of [80, 184]) {
    let runs = 0; const receipts: import("../scripts/budget-attempt.ts").BudgetGroupAttempt<{ wallMs: number; rssMB: number }>[] = [];
    await expect(budgetGroup("injected", () => { runs++; return { wallMs, rssMB: 100 }; }, judgeGroup,
      { baseline, probe: () => slow, record: row => receipts.push(row) })).rejects.toThrow("rss-miss");
    expect(runs).toBe(1); expect(receipts.map(row => row.outcome)).toEqual(["rss-miss"]);
  }
});

test("MCP watchdog stalls use only the probe-gated group retry and retain stall diagnostics", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  for (const reading of [normal, slow]) {
    let runs = 0; const receipts: import("../scripts/budget-attempt.ts").BudgetGroupAttempt<never>[] = [];
    await expect(budgetGroup("mcp", () => { runs++; throw new BudgetStall("watchdog", { limitMs: 30000, pending: "amem_search" }); }, () => ({ wallPass: true, rssPass: true }),
      { baseline, probe: () => reading, record: row => receipts.push(row) })).rejects.toThrow("watchdog");
    expect(runs).toBe(reading === normal ? 1 : 2); expect(receipts.every(row => row.values?.limitMs === 30000 && row.values.pending === "amem_search")).toBe(true);
  }
});

test("correctness errors never remeasure even on a slow runner", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  let runs = 0;
  await expect(budgetGroup("injected", () => { runs++; throw Error("owned process survived"); }, () => ({ wallPass: true, rssPass: true }),
    { baseline, probe: () => slow, record: () => {} })).rejects.toThrow("owned process survived");
  expect(runs).toBe(1);
});

test("probe thresholds are strict, detect CPU or spawn slowdown and reject malformed evidence", async () => {
  const { runnerIsSlow } = await import("../scripts/runner-probe.ts");
  expect(runnerIsSlow(normal, { ...normal, cpuMs: 20, spawnMs: 20 }, baseline)).toBe(false);
  expect(runnerIsSlow({ ...normal, cpuMs: 21 }, normal, baseline)).toBe(true);
  expect(runnerIsSlow(normal, slow, baseline)).toBe(true);
  for (const reading of [{ ...normal, cpuMs: NaN }, { ...normal, spawnMs: 0 }, { ...normal, checksum: "bad" }]) expect(() => runnerIsSlow(reading, normal, baseline)).toThrow("invalid runner probe");
});
