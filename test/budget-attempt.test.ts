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
const baseline = { cpuMs: 10, spawnMs: 10, ioMs: 10, factor: 2 };
type Probe = import("../scripts/runner-probe.ts").RunnerProbe;
const normal: Probe = { cpuMs: 10, spawnMs: 10, ioMs: 10, ioSamplesMs: [10, 10, 10], checksum }, slow = { ...normal, spawnMs: 21 };
const withIo = (probe: Probe, ioMs: number): Probe => ({ ...probe, ioMs, ioSamplesMs: [ioMs, ioMs, ioMs] });
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

test("40217188778 capture I/O spike permits one fresh remeasure despite a normal median", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  const { RUNNER_BASELINES, runnerIsSlow } = await import("../scripts/runner-probe.ts");
  // Exact before/after diagnostic values from the failed main Ubuntu run, not rounded issue values.
  const before: Probe = { cpuMs: 9.352681, spawnMs: 12.486705, ioMs: 2.6721919999999955, ioSamplesMs: [44.810738, 2.395752999999999, 2.6721919999999955], checksum };
  const after: Probe = { cpuMs: 9.419906000000992, spawnMs: 12.27413499999966, ioMs: 2.1628990000008343, ioSamplesMs: [2.6949640000002546, 2.1628990000008343, 2.141284999999698], checksum };
  const reference = RUNNER_BASELINES.linux!;
  expect(runnerIsSlow(before, after, reference)).toBe(true);
  let runs = 0, probes = 0;
  const result = await budgetGroup("capture-workloads", () => ({ wallMs: ++runs === 1 ? 310.52 : 63.3, rssMB: 75 }), judgeGroup,
    { baseline: reference, probe: () => ++probes === 1 ? before : after, record: () => {} });
  expect(runs).toBe(2); expect(probes).toBe(4);
  expect(result.attempts.map(row => [row.attempt, row.outcome, row.slow])).toEqual([[1, "wall-miss", true], [2, "pass", false]]);
  expect(result.attempts[0]!.result!.wallMs).toBe(310.52);
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

test("MCP single watchdog stall passes on its one retry even with normal probes", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  for (const reading of [normal, slow]) {
    let runs = 0, probes = 0;
    const receipts: import("../scripts/budget-attempt.ts").BudgetGroupAttempt<{ wallMs: number; rssMB: number }>[] = [];
    const result = await budgetGroup("mcp", () => {
      if (++runs === 1) throw new BudgetStall("watchdog", { limitMs: 30000, pending: "amem_search" });
      return { wallMs: 80, rssMB: 50 };
    }, judgeGroup, { baseline, retryPolicy: "stall", probe: () => { probes++; return reading; }, record: row => receipts.push(row) });
    expect(runs).toBe(2); expect(probes).toBe(4); expect(result.result.wallMs).toBe(80);
    expect(receipts.map(row => [row.attempt, row.outcome, row.retryPolicy])).toEqual([[1, "wall-miss", "stall"], [2, "pass", "stall"]]);
    expect(receipts[0]!.values).toEqual({ limitMs: 30000, pending: "amem_search" });
  }
});

test("MCP two watchdog stalls fail with two probe pairs and no nested retry", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  for (const reading of [normal, slow]) {
    let runs = 0, probes = 0; const receipts: unknown[] = [];
    await expect(budgetGroup("mcp", () => { runs++; throw new BudgetStall("watchdog", { limitMs: 30000 }); }, () => ({ wallPass: true, rssPass: true }),
      { baseline, retryPolicy: "stall", probe: () => { probes++; return reading; }, record: row => receipts.push(row) })).rejects.toThrow("watchdog");
    expect(runs).toBe(2); expect(probes).toBe(4); expect(receipts).toHaveLength(2);
  }
});

test("MCP slow probes alone never add a wall retry on top of the stall rule", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  let runs = 0;
  await expect(budgetGroup("mcp", () => { runs++; return { wallMs: 184, rssMB: 50 }; }, judgeGroup,
    { baseline, retryPolicy: "stall", probe: () => slow, record: () => {} })).rejects.toThrow("wall-miss");
  expect(runs).toBe(1);
});

test("correctness errors never remeasure even on a slow runner", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  let runs = 0;
  await expect(budgetGroup("injected", () => { runs++; throw Error("owned process survived"); }, () => ({ wallPass: true, rssPass: true }),
    { baseline, probe: () => slow, record: () => {} })).rejects.toThrow("owned process survived");
  expect(runs).toBe(1);
});

test("probe thresholds are strict, detect CPU, spawn or I/O slowdown and reject malformed evidence", async () => {
  const { runnerIsSlow } = await import("../scripts/runner-probe.ts");
  expect(runnerIsSlow(normal, { ...normal, cpuMs: 20, spawnMs: 20 }, baseline)).toBe(false);
  expect(runnerIsSlow({ ...normal, cpuMs: 21 }, normal, baseline)).toBe(true);
  expect(runnerIsSlow(normal, slow, baseline)).toBe(true);
  expect(runnerIsSlow(normal, withIo(normal, 21), baseline)).toBe(true);
  expect(runnerIsSlow(normal, { ...normal, ioSamplesMs: [20, 10, 10] }, baseline)).toBe(false);
  expect(runnerIsSlow(normal, { ...normal, ioSamplesMs: [20.01, 10, 10] }, baseline)).toBe(true);
  for (const reading of [{ ...normal, cpuMs: NaN }, { ...normal, spawnMs: 0 }, { ...normal, ioMs: NaN }, { ...normal, ioMs: 0 }, { ...normal, checksum: "bad" }]) expect(() => runnerIsSlow(reading, normal, baseline)).toThrow("invalid runner probe");
});

test("I/O-only slowdown remeasures the observed 40204205266 wall-miss values with normal CPU and spawn", async () => {
  const { budgetGroup } = await import("../scripts/budget-attempt.ts");
  const { runnerIsSlow } = await import("../scripts/runner-probe.ts");
  const reference = { cpuMs: 10.73, spawnMs: 17.17, ioMs: 10, factor: 2 };
  // The historical run did not record I/O. Only its CPU/spawn and wall values are historical;
  // Both the I/O baseline and the three I/O samples are injected, not claimed old readings.
  const reading = withIo({ ...normal, cpuMs: 9.63, spawnMs: 16.1 }, reference.ioMs * reference.factor + 0.01);
  expect(runnerIsSlow(withIo(reading, reference.ioMs), withIo(reading, reference.ioMs), reference)).toBe(false);
  for (const wallMs of [181.54, 206.15, 186.77]) {
    let runs = 0;
    const result = await budgetGroup("observed-wall-shape", () => ({ wallMs: ++runs === 1 ? wallMs : 80, rssMB: 75 }), judgeGroup,
      { baseline: reference, probe: () => reading, record: () => {} });
    expect(runs).toBe(2); expect(result.attempts[0]!.slow).toBe(true); expect(result.attempts[0]!.outcome).toBe("wall-miss");
  }
});

test("fixed real probe completes verified durable WAL writes and reports all three components", async () => {
  const { probeRunnerSpeed } = await import("../scripts/runner-probe.ts");
  const result = probeRunnerSpeed();
  expect(result.checksum).toBe(checksum);
  expect(result.ioSamplesMs).toHaveLength(3);
  expect(result.ioMs).toBe([...result.ioSamplesMs].sort((a, b) => a - b)[1]!);
  for (const ms of [result.cpuMs, result.spawnMs, result.ioMs]) { expect(Number.isFinite(ms)).toBe(true); expect(ms).toBeGreaterThan(0); }
});

test("three I/O samples retain a verified median receipt without concealing a peak from the classifier", async () => {
  const { median, runnerIsSlow } = await import("../scripts/runner-probe.ts");
  expect(median([3.43, 48.97, 4.04])).toBe(4.04);
  expect(median([48.97, 3.43, 4.04])).toBe(4.04);
  expect(median([4, 5, 6, 7])).toBe(5.5);
  const reading = { ...normal, ioMs: 4.04, ioSamplesMs: [3.43, 48.97, 4.04] as const };
  expect(runnerIsSlow(reading, reading, { ...baseline, ioMs: 25 })).toBe(false);
  expect(runnerIsSlow(reading, reading, baseline)).toBe(true);
  expect(() => runnerIsSlow({ ...reading, ioMs: 48.97 }, reading, baseline)).toThrow("invalid runner probe");
  for (const values of [[], [1, NaN, 2], [1, 0, 2], Array<number>(3)]) expect(() => median(values)).toThrow("invalid median samples");
});

test("recorded Ubuntu stalled-suite neighbors retain their slowdown evidence with the peak gate", async () => {
  const { runnerIsSlow, RUNNER_BASELINES } = await import("../scripts/runner-probe.ts");
  const reference = RUNNER_BASELINES.linux!;
  const pairs: [Probe, Probe][] = [
    [{ ...normal, "cpuMs": 9.707808000000002, "spawnMs": 12.979821000000001, "ioMs": 2.612885999999996, "ioSamplesMs": [4.5665540000000036, 2.612885999999996, 2.6064149999999984] }, { ...normal, "cpuMs": 9.775879, "spawnMs": 12.826019000000002, "ioMs": 29.95894099999998, "ioSamplesMs": [266.715968, 29.95894099999998, 25.053099999999972] }],
    [{ ...normal, "cpuMs": 9.847408000000001, "spawnMs": 14.387108000000001, "ioMs": 7.8769080000000145, "ioSamplesMs": [109.92653500000002, 3.625001999999995, 7.8769080000000145] }, { ...normal, "cpuMs": 10.491727999999998, "spawnMs": 13.130999000000003, "ioMs": 3.145179000000006, "ioSamplesMs": [4.117124000000004, 3.145179000000006, 2.8734290000000016] }],
  ];
  for (const [before, after] of pairs) {
    expect(runnerIsSlow(before, after, reference)).toBe(true);
    expect(runnerIsSlow(withIo(before, reference.ioMs), withIo(after, reference.ioMs), reference)).toBe(false);
    // The old single-write ceiling hid these medians; the raw peaks still exceed it.
    expect(runnerIsSlow(before, after, { ...reference, ioMs: 18.27 })).toBe(true);
  }
});

// Full-precision budget-group before/after readings, once per physical probe.
// Sources: https://github.com/STAIxBWLB/agent-mem/actions/runs/<run> below.
// Each green main suite passed its first attempt without stalls; older 40207268684 has no triples.
const healthyMainProbes: [number, "linux" | "darwin", string, number, number, number, readonly [number, number, number]][] = [
  [40216024240, "darwin", "hook-workloads/before", 8.092708000000002, 28.838290999999998, 8.832583, [19.48041699999999, 8.832583, 7.764291]],
  [40216024240, "darwin", "hook-workloads/after", 7.410792000000583, 13.57708300000013, 6.069499999999607, [6.069499999999607, 6.260000000000218, 5.7268330000006245]],
  [40216024240, "darwin", "capture-workloads/before", 7.664041000000001, 14.252375, 6.604917, [9.903708000000002, 6.604917, 5.077125000000002]],
  [40216024240, "darwin", "capture-workloads/after", 7.750250000000051, 14.225874999999178, 9.580791999999747, [9.580791999999747, 15.026375000000371, 5.714791000000332]],
  [40216024240, "darwin", "mcp-session/before", 7.562415999999999, 14.282416999999999, 5.102041, [7.443832999999998, 5.102041, 4.671082999999996]],
  [40216024240, "darwin", "mcp-session/after", 7.528791999999157, 12.986417000000074, 9.527708999999959, [9.527708999999959, 11.747207999998864, 5.38787499999853]],
  [40216024240, "linux", "hook-workloads/before", 10.685966, 16.345936000000002, 3.189563000000007, [7.896888000000004, 3.009363999999998, 3.189563000000007]],
  [40216024240, "linux", "hook-workloads/after", 10.741823000000295, 14.695818000000145, 2.8293740000008256, [3.5825349999995524, 2.8293740000008256, 2.6606659999997646]],
  [40216024240, "linux", "capture-workloads/before", 10.68208, 16.629025, 3.0928010000000015, [4.878965999999998, 2.7838689999999957, 3.0928010000000015]],
  [40216024240, "linux", "capture-workloads/after", 10.655018999999811, 15.243289000000004, 2.5437969999993584, [2.515593000000081, 3.3651049999998577, 2.5437969999993584]],
  [40216024240, "linux", "mcp-session/before", 10.715402999999998, 17.204707, 3.5951479999999947, [3.5951479999999947, 4.085502999999996, 3.3268830000000023]],
  [40216024240, "linux", "mcp-session/after", 10.651400999999169, 16.885990999999194, 3.0518840000004275, [3.1196860000018205, 2.6721069999985048, 3.0518840000004275]],
  [40218530218, "linux", "hook-workloads/before", 7.639350999999998, 10.685478999999997, 2.3026359999999997, [3.7644829999999985, 2.1721390000000014, 2.3026359999999997]],
  [40218530218, "linux", "hook-workloads/after", 7.6204420000003665, 9.951036000000386, 2.2457500000000437, [2.436678000000029, 2.2457500000000437, 2.08705000000009]],
  [40218530218, "linux", "capture-workloads/before", 7.671850000000001, 10.382092, 2.3546339999999972, [3.5330629999999985, 2.2777280000000033, 2.3546339999999972]],
  [40218530218, "linux", "capture-workloads/after", 7.757118999999875, 10.387244000000464, 2.221483000000262, [2.627462000000378, 2.1334900000001653, 2.221483000000262]],
  [40218530218, "linux", "mcp-session/before", 7.6367670000000025, 10.255239999999997, 2.509096999999997, [3.435876999999998, 2.3900579999999962, 2.509096999999997]],
  [40218530218, "linux", "mcp-session/after", 7.9168509999999515, 10.672059000000445, 2.3452500000003056, [2.8390849999996135, 2.3452500000003056, 2.2259800000010728]],
  [40218530218, "darwin", "hook-workloads/before", 8.047792000000001, 16.293833, 6.160999999999994, [13.330124999999995, 6.160999999999994, 4.586375000000004]],
  [40218530218, "darwin", "hook-workloads/after", 9.05987500000083, 12.904749999999694, 4.565791999999419, [4.656917000000249, 4.565791999999419, 3.5542500000010477]],
  [40218530218, "darwin", "capture-workloads/before", 7.751999999999999, 13.378667, 6.661375000000007, [6.829042000000001, 6.661375000000007, 3.6217499999999987]],
  [40218530218, "darwin", "capture-workloads/after", 7.0321670000003, 11.1127919999999, 6.778833000000304, [6.778833000000304, 14.727791999999681, 3.9875840000004246]],
  [40218530218, "darwin", "mcp-session/before", 6.959541999999999, 12.16225, 3.056207999999998, [5.2912919999999986, 3.056207999999998, 3.0097919999999974]],
  [40218530218, "darwin", "mcp-session/after", 8.276083000000654, 18.335708000000523, 8.0971669999999, [8.0971669999999, 20.349041999999827, 4.840208999999959]],
  [40219757226, "darwin", "hook-workloads/before", 7.805792000000004, 24.172541000000002, 8.77579200000001, [20.858458999999996, 8.77579200000001, 6.332207999999994]],
  [40219757226, "darwin", "hook-workloads/after", 7.667875000001004, 12.751416999999492, 4.2167499999995925, [4.2167499999995925, 5.175124999999753, 4.113874999999098]],
  [40219757226, "darwin", "capture-workloads/before", 8.988916999999999, 15.963249999999999, 6.4411249999999995, [9.754041999999998, 6.4411249999999995, 5.255541999999998]],
  [40219757226, "darwin", "capture-workloads/after", 9.084708000000319, 32.62537500000053, 9.506749999999556, [9.506749999999556, 11.570166999999856, 4.263792000000649]],
  [40219757226, "darwin", "mcp-session/before", 7.623583, 14.295582999999997, 3.870291999999999, [6.889917000000004, 3.827666999999998, 3.870291999999999]],
  [40219757226, "darwin", "mcp-session/after", 8.749165999999605, 19.04516700000022, 13.200417000000016, [13.76208299999962, 13.200417000000016, 4.802541999999448]],
  [40219757226, "linux", "hook-workloads/before", 10.696722000000001, 16.890083999999995, 2.5901209999999963, [4.810682999999997, 2.527042999999992, 2.5901209999999963]],
  [40219757226, "linux", "hook-workloads/after", 10.743150999998761, 16.190295000000333, 2.4682099999990896, [2.993967000000339, 2.4682099999990896, 2.417215000001306]],
  [40219757226, "linux", "capture-workloads/before", 10.682939000000001, 17.63778, 2.8715509999999966, [4.1806509999999975, 2.8715509999999966, 2.701535]],
  [40219757226, "linux", "capture-workloads/after", 10.746986999999535, 16.51679199999944, 2.4939239999994243, [2.8285789999999906, 2.4939239999994243, 2.421035000000302]],
  [40219757226, "linux", "mcp-session/before", 10.694988999999996, 16.102285000000002, 2.576234999999997, [3.6286050000000003, 2.3778950000000023, 2.576234999999997]],
  [40219757226, "linux", "mcp-session/after", 10.664597000002686, 15.98890499999834, 2.502481000003172, [3.0104900000005728, 2.502481000003172, 2.4973920000011276]],
  [40223666097, "darwin", "hook-workloads/before", 7.981749999999998, 14.11475, 5.235208, [12.082583, 5.235208, 3.7853330000000014]],
  [40223666097, "darwin", "hook-workloads/after", 8.628249999999753, 11.776334000000134, 4.313707999999679, [4.420458999999937, 4.313707999999679, 3.1397500000002765]],
  [40223666097, "darwin", "capture-workloads/before", 6.917875, 10.990874999999999, 4.492041999999998, [5.472125000000002, 4.492041999999998, 2.9640839999999997]],
  [40223666097, "darwin", "capture-workloads/after", 7.985708000000159, 12.714458000000377, 7.182083000000603, [7.182083000000603, 15.406541999999718, 3.390041999999994]],
  [40223666097, "darwin", "mcp-session/before", 7.599125000000001, 12.611832999999997, 3.771374999999999, [5.900458, 3.6486249999999956, 3.771374999999999]],
  [40223666097, "darwin", "mcp-session/after", 7.405749999999898, 12.40991700000086, 6.9027919999989535, [6.9027919999989535, 11.62395800000013, 3.4613749999989523]],
  [40223666097, "linux", "hook-workloads/before", 10.771888999999998, 18.479635000000002, 3.3514920000000004, [5.196583000000004, 3.3514920000000004, 3.336373999999992]],
  [40223666097, "linux", "hook-workloads/after", 10.975173000000723, 16.484065000000555, 3.2411229999997886, [3.5885159999997995, 3.2411229999997886, 2.6061529999988124]],
  [40223666097, "linux", "capture-workloads/before", 10.689437999999996, 17.447771000000003, 3.2826609999999974, [4.253991000000006, 2.6523499999999984, 3.2826609999999974]],
  [40223666097, "linux", "capture-workloads/after", 10.696909999999662, 15.806344000000536, 2.6475099999997838, [3.0019230000007155, 2.6475099999997838, 2.4537970000001224]],
  [40223666097, "linux", "mcp-session/before", 10.708540999999997, 18.139755, 3.1238519999999994, [4.196328999999999, 3.0016530000000046, 3.1238519999999994]],
  [40223666097, "linux", "mcp-session/after", 10.784786000000167, 17.65313199999946, 2.6183730000011565, [3.6052879999988363, 2.6183730000011565, 2.51255300000048]],
];

test("four green main runs pin the accepted false-slow counts for the median and max-sample rules", async () => {
  const { RUNNER_BASELINES, runnerIsSlow } = await import("../scripts/runner-probe.ts");
  for (const platform of ["linux", "darwin"] as const) {
    const readings = healthyMainProbes.filter(row => row[1] === platform);
    expect(readings).toHaveLength(24);
    const reference = RUNNER_BASELINES[platform]!;
    let medianSlow = 0, peakSlow = 0;
    for (const [, , , cpuMs, spawnMs, ioMs, ioSamplesMs] of readings) {
      const probe: Probe = { cpuMs, spawnMs, ioMs, ioSamplesMs, checksum };
      // Replay the previous policy too; false slow permits a retry, never a budget waiver.
      if (cpuMs > reference.cpuMs * reference.factor || spawnMs > reference.spawnMs * reference.factor || ioMs > reference.ioMs * reference.factor) medianSlow++;
      if (runnerIsSlow(probe, probe, reference)) peakSlow++;
    }
    expect({ medianSlow, peakSlow }).toEqual(platform === "linux" ? { medianSlow: 0, peakSlow: 1 } : { medianSlow: 15, peakSlow: 19 });
  }
});

test("40217188778 hook probes overlap healthy Linux I/O and cannot grant remeasurement", async () => {
  const { RUNNER_BASELINES, runnerIsSlow } = await import("../scripts/runner-probe.ts");
  const before: Probe = { cpuMs: 9.370922, spawnMs: 13.953046, ioMs: 3.1122390000000024, ioSamplesMs: [5.4217550000000045, 2.5107240000000033, 3.1122390000000024], checksum };
  const after: Probe = { cpuMs: 9.382031999999526, spawnMs: 12.274673000001712, ioMs: 2.370837999998912, ioSamplesMs: [2.79417999999896, 2.370837999998912, 2.2238200000010693], checksum };
  expect(runnerIsSlow(before, after, RUNNER_BASELINES.linux!)).toBe(false);
});
