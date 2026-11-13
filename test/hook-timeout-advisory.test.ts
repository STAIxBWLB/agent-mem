import { expect, test } from "bun:test";
import { timeoutDescendantReceipt, timeoutOwnedGroupsGone, timeoutOwnedGroupBarrier, timeoutProbeBranch } from "./fakes/hooks-timeout-probe.ts";

test("timeout descendant receipts distinguish complete, incomplete and empty positive-PID lists", () => {
  expect(timeoutDescendantReceipt("12\n34\n", 2)).toEqual({ pids: [12, 34], valid: true, complete: true, incomplete: false });
  expect(timeoutDescendantReceipt("12\n", 2)).toEqual({ pids: [12], valid: true, complete: false, incomplete: true });
  expect(timeoutDescendantReceipt(" \n", 2)).toEqual({ pids: [], valid: true, complete: false, incomplete: true });
  expect(timeoutDescendantReceipt("12 34 56", 2).incomplete).toBe(false);
});

test("malformed timeout PID tokens never qualify as incomplete or reach alive/cleanup probes", () => {
  for (const token of ["0", "-12", "+12", "1.2", "1e2", "Infinity", "NaN", "9007199254740992", "12x"]) {
    const result = timeoutDescendantReceipt(`34 ${token}`, 3);
    expect(result.valid).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.pids).toEqual([34]);
  }
});

test("fresh group census detects an orphan even after its leader and receipted child exit", () => {
  expect(timeoutOwnedGroupsGone(" 1 1\n 99 42\n", [42])).toBe(false);
  expect(timeoutOwnedGroupsGone(" 0 0\n 1 1\n 99 43\n", [42])).toBe(true);
});

test("unknown or malformed process census stays strict", () => {
  for (const table of ["", " \n", "1", "1 2 extra", "-1 2", "1 -1", "9007199254740992 1", "1 9007199254740992"])
    expect(() => timeoutOwnedGroupsGone(table, [42])).toThrow("R1 process table unavailable");
});


test("invalid owned group identities cannot prove an incomplete receipt safe", () => {
  for (const groups of [[], [0], [-1], [Number.NaN], [1, 1]])
    expect(() => timeoutOwnedGroupsGone("2 2\n", groups)).toThrow("R1 owned group identity unavailable");
});

test("an unreceipted orphan is judged at the existing exit barrier, even after every receipted PID has gone", async () => {
  let left = 400, scans = 0;
  const gone = await timeoutOwnedGroupBarrier([42], () => left,
    () => ++scans === 1 ? "1 1\n99 42\n" : "1 1\n", async () => { left -= 10; });
  expect(gone).toBe(true);
  expect(scans).toBe(2);
  expect(left).toBe(390);
});

test("a persistent unreceipted group member fails without renewing the exit barrier", async () => {
  let left = 20, pauses = 0, scans = 0;
  const gone = await timeoutOwnedGroupBarrier([42], () => left,
    () => { scans++; return "1 1\n99 42\n"; }, async () => { pauses++; left -= 10; });
  expect(gone).toBe(false);
  expect(scans).toBe(3);
  expect(pauses).toBe(2);
  expect(left).toBe(0);
  await expect(timeoutOwnedGroupBarrier([42], () => 0, () => "malformed", async () => {})).rejects.toThrow("R1 process table unavailable");
});


function timeoutObservation() {
  const evidence = [
    { phase: "preload" as const, pid: 10, loads: 1 },
    { phase: "precheck" as const, pid: 10, loads: 1, remainingUs: 1812, host: 0 },
    { phase: "deadline_skip" as const, pid: 10, loads: 1, remainingUs: 1812, host: 0 },
  ];
  return { control: false, expected: 2, parentPid: 10, workers: [] as import("./fakes/hooks-process-observer.ts").HookWorkerProcess[], evidence,
    lifecycle: [] as import("./fakes/hooks-process-observer.ts").HookLifecycleReceipt[], entered: false,
    receipt: timeoutDescendantReceipt("", 2), survivors: 0 };
}
function spawnedTimeoutObservation() {
  const input = timeoutObservation();
  input.workers.push({ pid: 20, detached: true, kind: "native", argv: [] });
  const evidence: import("./fakes/hooks-process-observer.ts").HookProcessEvidence[] = [input.evidence[0]!,
    { phase: "attempt", pid: 10, loads: 1, exact: 1, native: 1 },
    { phase: "returned", pid: 10, loads: 1, exact: 1, native: 1, childPid: 20 }];
  for (const phase of ["spawn-attempt", "spawn", "kill-request", "exit", "reap-end"] as const)
    input.lifecycle.push({ phase, parentPid: 10, childPid: phase === "spawn-attempt" ? 0 : 20, kind: "native", atMs: 1, ...(phase === "reap-end" ? { reaped: 1 } : {}) });
  return { ...input, evidence };
}
test("pre-admission requires this invocation's positive guard evidence, zero attempts and children", () => {
  const input = timeoutObservation();
  expect(timeoutProbeBranch(input)).toBe("pre-admission");
  for (const evidence of [input.evidence.slice(0, 1), input.evidence.map(row => ({ ...row, remainingUs: 5000 })),
    input.evidence.map(row => ({ ...row, pid: 11 })), input.evidence.map(row => ({ ...row, loads: 2 }))])
    expect(() => timeoutProbeBranch({ ...input, evidence })).toThrow();
  expect(timeoutProbeBranch({ ...input, evidence: [input.evidence[0]!, { phase: "session-native-deadline-skip", pid: 10, loads: 1, remainingUs: -100 }] })).toBe("pre-admission");
  expect(() => timeoutProbeBranch({ ...input, lifecycle: [{ phase: "spawn-attempt", parentPid: 10, childPid: 0, kind: "native", atMs: 1 }] })).toThrow();
});
test("spawned-not-entered requires complete lifecycle and zero survivors even without a PID witness", () => {
  const input = spawnedTimeoutObservation();
  expect(timeoutProbeBranch(input)).toBe("spawned-not-entered");
  expect(() => timeoutProbeBranch({ ...input, survivors: 1 })).toThrow();
  for (const phase of ["spawn", "exit", "reap-end"] as const)
    expect(() => timeoutProbeBranch({ ...input, lifecycle: input.lifecycle.filter(row => row.phase !== phase) })).toThrow();
  expect(() => timeoutProbeBranch({ ...input, receipt: timeoutDescendantReceipt("bad", 2) })).toThrow();
});
test("cleanup controls cannot substitute a deadline refusal, missing child or missing entry receipt", () => {
  expect(() => timeoutProbeBranch({ ...timeoutObservation(), control: true })).toThrow();
  const input = spawnedTimeoutObservation();
  expect(() => timeoutProbeBranch({ ...input, control: true })).toThrow();
  expect(() => timeoutProbeBranch({ ...input, control: true, entered: true, receipt: timeoutDescendantReceipt("30", 2) })).toThrow();
  const complete = { ...input, control: true, expected: 1, entered: true, receipt: timeoutDescendantReceipt("30", 1) };
  expect(timeoutProbeBranch(complete)).toBe("admitted-blocked");
  expect(() => timeoutProbeBranch({ ...complete, entered: false })).toThrow();
  expect(() => timeoutProbeBranch({ ...complete, survivors: 1 })).toThrow();
  expect(() => timeoutProbeBranch({ ...complete, receipt: timeoutDescendantReceipt("30 30", 2) })).toThrow();
});


test("a census cannot accept disappearance observed after the same exit deadline", async () => {
  let left = 1;
  expect(await timeoutOwnedGroupBarrier([42], () => left, () => { left -= 20; return "1 1\n"; }, async () => {})).toBe(false);
  let scans = 0;
  expect(await timeoutOwnedGroupBarrier([42], () => -1, () => { scans++; return "1 1\n"; }, async () => {})).toBe(false);
  expect(scans).toBe(0);
});
test("an entered witness with an empty PID receipt is contradictory evidence", () => {
  expect(() => timeoutProbeBranch({ ...spawnedTimeoutObservation(), entered: true })).toThrow("entered witness has no descendant PID receipt");
});

// #362 (task 237 attribution): recorded receipt shapes from hosted runs.
test("#362 run 42957548722: a precheck then a negative late_check with no spawn is the pre-admission zero-child branch", async () => {
  const { timeoutProbeBranch } = await import("./fakes/hooks-timeout-probe.ts");
  const recorded = { ...timeoutObservation(), evidence: [
    { phase: "preload" as const, pid: 10, loads: 1 },
    { phase: "precheck" as const, pid: 10, loads: 1, remainingUs: 7462, host: 0 },
    { phase: "late_check" as const, pid: 10, loads: 1, remainingUs: -2063, host: 0 }] };
  expect(timeoutProbeBranch(recorded)).toBe("pre-admission");
  const late = recorded.evidence[2]!, precheck = recorded.evidence[1]!, preload = recorded.evidence[0]!;
  // A non-negative remainder, a missing or later precheck, a duplicate late guard, a spawn attempt, an entry or a control all stay refused.
  for (const evidence of [[preload, precheck, { ...late, remainingUs: 0 }], [preload, late], [preload, late, precheck], [preload, precheck, late, late],
    [preload, precheck, { ...late, pid: 11 }]])
    expect(() => timeoutProbeBranch({ ...recorded, evidence })).toThrow();
  expect(() => timeoutProbeBranch({ ...recorded, entered: true })).toThrow();
  expect(() => timeoutProbeBranch({ ...recorded, control: true })).toThrow();
  expect(() => timeoutProbeBranch({ ...recorded, lifecycle: [{ phase: "spawn-attempt", parentPid: 10, childPid: 0, kind: "native", atMs: 1 }] })).toThrow();
});

test("#362 runs 42934443076 and 43173840052 a2: the timeout wall stall carries the measured handler wall, never the outer wall", async () => {
  const { timeoutWallStallValues } = await import("./fakes/hooks-timeout-probe.ts");
  const { budgetGroup, BudgetStall } = await import("../scripts/budget-attempt.ts");
  const sources = { vmhwm: 0, vmpeakBound: 0, platformRusage: 2, rawFallback: 0, unavailable: 0 };
  // 43173840052 a2: outer 192.831 ms; handler wall from its metric row.
  const measured = timeoutWallStallValues("SessionStart", { wallMs: 192.831, metricWallMs: 118.4, rssMB: 42.7, rssSource: "max-production-and-platform-rusage", rssSources: sources }, 150);
  expect(measured.message).toBe("actual SessionStart timeout wall below 150 ms");
  expect(measured.values).toMatchObject({ wallMs: 192.831, metricWallMs: 118.4, limitMs: 150 });
  // No metric row: the field stays absent (never 0, never the outer wall), so the group helper still fails closed.
  for (const metricWallMs of [undefined, Number.NaN, -1]) expect("metricWallMs" in timeoutWallStallValues("SessionStart", { wallMs: 154.25, metricWallMs, rssMB: 42.7, rssSources: sources }, 150).values).toBe(false);
  const baseline = { cpuMs: 10, spawnMs: 10, ioMs: 10, factor: 2 };
  const normal = { cpuMs: 10, spawnMs: 10, ioMs: 10, ioSamplesMs: [10, 10, 10] as const, checksum: "55c7e25571a69216de25162f191bb2847201a09ee7efe46b5bada034acc695d5" };
  const outcome = async (values: Record<string, string | number | boolean | null>) => {
    const seen: string[] = [];
    await budgetGroup("hook-workloads", () => { throw new BudgetStall("actual SessionStart timeout wall below 150 ms", values); }, () => ({ wallPass: true, rssPass: true }),
      { env: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" }, baseline, probe: () => normal, record: attempt => { seen.push(attempt.outcome); } }).catch(() => {});
    return seen[0];
  };
  expect(await outcome(measured.values)).toBe("wall-miss");
  expect(await outcome(timeoutWallStallValues("SessionStart", { wallMs: 154.25, rssMB: 42.7, rssSources: sources }, 150).values)).toBe("wall-max-miss");
  expect(await outcome(timeoutWallStallValues("SessionStart", { wallMs: 400, metricWallMs: 320, rssMB: 42.7, rssSources: sources }, 150).values)).toBe("wall-max-miss");
});

test("#362 run 42996734319: an invalid owned descendant receipt names its failed predicate with bounded numeric fields", async () => {
  const { timeoutDescendantPrerequisite, timeoutDescendantRefusal, timeoutDescendantReceipt } = await import("./fakes/hooks-timeout-probe.ts");
  const sources = { vmhwm: 0, vmpeakBound: 0, platformRusage: 2, rawFallback: 0, unavailable: 0 };
  const receipt = timeoutDescendantReceipt("", 3), metric = { wallMs: 131.2, rssScope: "owned-images", rssSources: sources, abandonedChildren: 3 };
  expect(timeoutDescendantPrerequisite({ control: false, receipt, metric })).toBeUndefined();
  expect(timeoutDescendantPrerequisite({ control: true, receipt, metric })).toBe("control-run");
  expect(timeoutDescendantPrerequisite({ control: false, receipt: timeoutDescendantReceipt("1 2 3", 3), metric })).toBe("receipt-not-incomplete");
  expect(timeoutDescendantPrerequisite({ control: false, receipt, metric: { ...metric, wallMs: Number.NaN } })).toBe("metric-wall-invalid");
  expect(timeoutDescendantPrerequisite({ control: false, receipt, metric: { ...metric, rssScope: "process" } })).toBe("rss-scope-not-owned-images");
  expect(timeoutDescendantPrerequisite({ control: false, receipt, metric: { ...metric, rssSources: { vmhwm: "x" } } })).toBe("rss-sources-invalid");
  const record = timeoutDescendantRefusal({ event: "SessionStart", predicate: "advisory-refused", branch: "admitted-blocked", control: false, expected: 3, workers: 3,
    receipt, metric: { ...metric, rssScope: "/private/path", rssSources: { ...sources, extra: "text" } }, advisoryEligible: true });
  expect(record).toEqual({ diagnostic: "timeout-descendant-refusal/v1", event: "SessionStart", predicate: "advisory-refused", branch: "admitted-blocked", control: false,
    expectedOwnedChildren: 3, observedOwnedChildren: 3, receipt: { pids: 0, valid: true, incomplete: true, complete: false },
    metricWallMs: 131.2, rssScope: "other", rssSources: sources, abandonedChildren: 3, advisoryEligible: true });
  expect(JSON.stringify(record)).not.toContain("private");
});

test("#367 option A: a deferred plain call logs one bounded numeric guard record", async () => {
  const { plainDeferralRecord, verifyHookProcessObservation } = await import("../scripts/hook-process-check.ts");
  // Recorded shapes: a post-metadata late guard under 5 ms (the #221 second pre-spawn exit) and a precheck deadline skip.
  const late = [{ phase: "preload" as const, pid: 10, loads: 1 }, { phase: "precheck" as const, pid: 10, loads: 1, remainingUs: 7462, host: 0 },
    { phase: "late_check" as const, pid: 10, loads: 1, remainingUs: 2063, host: 0 }];
  const skip = [{ phase: "preload" as const, pid: 10, loads: 1 }, { phase: "precheck" as const, pid: 10, loads: 1, remainingUs: 1812, host: 0 },
    { phase: "deadline_skip" as const, pid: 10, loads: 1, remainingUs: 1812, host: 0 }];
  expect(verifyHookProcessObservation("PostToolUse", [], late, true)).toEqual({ deferred: true });
  expect(verifyHookProcessObservation("PostToolUse", [], skip, true)).toEqual({ deferred: true });
  const record = plainDeferralRecord({ event: "PostToolUse", invocation: 11, evidence: late, wallMs: 153.4812345, metricWallMs: 129.12834375, slow: true });
  expect(record).toEqual({ diagnostic: "plain-deferral/v1", event: "PostToolUse", invocation: 11, guard: "late_check", remainingUs: 2063, precheckRemainingUs: 7462,
    wallMs: 153.481, metricWallMs: 129.128, slow: true });
  expect(plainDeferralRecord({ event: "PostToolUse", invocation: 3, evidence: skip, wallMs: 140, metricWallMs: undefined, slow: null }))
    .toMatchObject({ guard: "deadline_skip", remainingUs: 1812, precheckRemainingUs: 1812, metricWallMs: null, slow: null });
  // Only numbers, booleans, null and fixed enums: an unexpected event string or a non-finite value never reaches the log.
  const odd = plainDeferralRecord({ event: "/private/path", invocation: Number.NaN, evidence: [], wallMs: Number.POSITIVE_INFINITY, metricWallMs: Number.NaN, slow: false });
  expect(odd).toEqual({ diagnostic: "plain-deferral/v1", event: "other", invocation: null, guard: null, remainingUs: null, precheckRemainingUs: null, wallMs: null, metricWallMs: null, slow: false });
  expect(JSON.stringify(odd)).not.toContain("private");
});
