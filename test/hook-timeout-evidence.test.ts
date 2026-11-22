import { expect, test } from "bun:test";
import { timeoutBranchEvidence, timeoutReceiptEvidence } from "./fakes/hooks-timeout-evidence.ts";
import { supervisorRemainingMs } from "./fakes/hooks-process-lifecycle.ts";
import { timeoutDescendantReceipt, timeoutDescendantRefusal } from "./fakes/hooks-timeout-probe.ts";
import type { HookLifecycleReceipt, HookWorkerProcess } from "./fakes/hooks-process-observer.ts";

const workers: HookWorkerProcess[] = [{ pid: 10, kind: "native", detached: true, argv: [] }, { pid: 20, kind: "worker", detached: true, argv: [] }];
const life = (pid: number, phase: HookLifecycleReceipt["phase"], atMs: number): HookLifecycleReceipt =>
  ({ parentPid: 1, childPid: pid, kind: pid === 10 ? "native" : "worker", phase, atMs });
const lifecycle = [life(10,"spawn",100), life(10,"kill-request",200), life(10,"reap-end",250), life(20,"spawn",110), life(20,"kill-request",210), life(20,"reap-end",260)];
const rows = [{ pid: 101, ownerPid: 10, beforeMs: 150, afterMs: 160 }, { pid: 202, ownerPid: 20, beforeMs: 220, afterMs: 240 }];

test("incomplete refusal names missing sleeper and brackets each owner's lifecycle", () => {
  const receipt = timeoutDescendantReceipt("101\n", 2);
  const evidence = timeoutReceiptEvidence({ workers, receiptPids: receipt.pids, lifecycle, fixture: { rows, invalid: false, truncated: false } });
  expect(evidence.missingPids).toEqual([202]);
  expect(evidence.children.map(row => row.relation)).toEqual(["before-kill", "between-kill-and-reap"]);
  expect(evidence.children[1]!.beforeMinusKillMs).toBe(10);
  const record = timeoutDescendantRefusal({ event: "PreToolUse", predicate: "advisory-refused", branch: "admitted-blocked", control: false,
    expected: 2, workers: 2, receipt, metric: {}, advisoryEligible: true, evidence });
  expect(record.childEvidence?.missingPids).toEqual([202]);
  expect(JSON.stringify(record)).not.toContain("argv");
});

test("missing, duplicate and truncated evidence stays explicit and ambiguous", () => {
  const missing = timeoutReceiptEvidence({ workers, receiptPids: [101], lifecycle, fixture: { rows: [rows[0]!], invalid: false, truncated: false } });
  expect(missing.unidentifiedOwners).toEqual([20]); expect(missing.missingPids).toEqual([]);
  const interrupted = timeoutReceiptEvidence({ workers, receiptPids: [101], lifecycle, fixture: { rows: [{ pid: 202, ownerPid: 20, beforeMs: 208 }], invalid: false, truncated: false } });
  expect(interrupted.missingPids).toEqual([202]); expect(interrupted.children[0]!.relation).toBe("ambiguous");
  const duplicate = timeoutReceiptEvidence({ workers, receiptPids: [101], lifecycle, fixture: { rows: [rows[0]!, rows[0]!], invalid: false, truncated: false } });
  expect(duplicate.invalid).toBe(true); expect(duplicate.missingPids).toBeNull();
  const truncated = timeoutReceiptEvidence({ workers, receiptPids: [101], lifecycle, fixture: { rows, invalid: false, truncated: true } });
  expect(truncated.truncated).toBe(true); expect(truncated.missingPids).toBeNull();
  const near = timeoutReceiptEvidence({ workers, receiptPids: [], lifecycle, fixture: { rows: [{ pid: 101, ownerPid: 10, beforeMs: 196, afterMs: 198 }], invalid: false, truncated: false } });
  expect(near.children[0]!.relation).toBe("ambiguous");
  const after = timeoutReceiptEvidence({ workers, receiptPids: [], lifecycle, fixture: { rows: [{ pid: 101, ownerPid: 10, beforeMs: 270, afterMs: 280 }], invalid: false, truncated: false } });
  expect(after.children[0]!.relation).toBe("after-reap");
  const many = Array.from({ length: 511 }, (_, index) => ({ pid: 1000 + index, ownerPid: 10, beforeMs: 150, afterMs: 160 }));
  const bounded = timeoutReceiptEvidence({ workers, receiptPids: [], lifecycle, fixture: { rows: many, invalid: false, truncated: false } });
  expect(bounded.truncated).toBe(true); expect(bounded.owners.length + bounded.children.length).toBe(512); expect(bounded.missingPids).toBeNull();
});

test("#362 branch evidence is counts and hook-relative times only, with no pid fields", () => {
  const life = (phase: HookLifecycleReceipt["phase"], childPid: number, kind: "worker" | "native", atMs: number, extra = {}): HookLifecycleReceipt => ({ phase, parentPid: 10, childPid, kind, atMs, ...extra });
  const workers: HookWorkerProcess[] = [{ pid: 20, kind: "worker", detached: true, argv: [] }, { pid: 30, kind: "native", detached: true, argv: [] }];
  const out = timeoutBranchEvidence({ workers, entries: [{ ownerPid: 30, entryMs: 1105 }],
    fixture: { rows: [{ pid: 31, ownerPid: 30, beforeMs: 1410 }] },
    lifecycle: [life("origin", 0, "worker", 1000), life("spawn-attempt", 0, "worker", 1010), life("spawn", 20, "worker", 1012, { spawnRemainingMs: 480.5 }),
      life("spawn-attempt", 0, "native", 1100), life("spawn", 30, "native", 1102), life("kill-request", 30, "native", 1400), life("reap-end", 30, "native", 1420),
      life("spawn-attempt", 0, "native", 1450), life("spawn-failed", 0, "native", 1451)] });
  expect(out.spawnAttempts).toBe(3);
  expect(out.spawnFailed).toBe(1);
  expect(out.owners).toEqual([{ kind: "worker", spawnAtMs: 12, spawnRemainingMs: 480.5 },
    { kind: "native", spawnAtMs: 102, killAtMs: 400, reapAtMs: 420, entryAtMs: 105, beforeWriteAtMs: 410, entryMinusKillMs: -295, beforeMinusKillMs: 10 }]);
  expect(JSON.stringify(out)).not.toMatch(/pid/i);
});

test("#362 spawn-site deadline is read only from the expected supervisor shape", () => {
  const shape = ["/bin/sh", "-c", "marker=$1; seconds=$2; shift 2; leader=$$; rest", "amem-hook-native", "AMEM_META_x", "0.4875", "cmd"];
  expect(supervisorRemainingMs(shape)).toBe(487.5);
  expect(supervisorRemainingMs([...shape.slice(0, 5), "-1"])).toBeUndefined();
  expect(supervisorRemainingMs([...shape.slice(0, 5), "NaN"])).toBeUndefined();
  expect(supervisorRemainingMs(["/bin/sh", "-c", "other", "amem-hook-native", "m", "0.4"])).toBeUndefined();
  expect(supervisorRemainingMs(["/usr/bin/env", "-c", shape[2], "amem-hook-native", "m", "0.4"])).toBeUndefined();
  const missing = timeoutBranchEvidence({ workers: [{ pid: 30, kind: "native", detached: true, argv: [] }], entries: [], fixture: { rows: [] },
    lifecycle: [{ phase: "origin", parentPid: 10, childPid: 0, kind: "worker", atMs: 0 }, { phase: "spawn", parentPid: 10, childPid: 30, kind: "native", atMs: 5 }] });
  expect(missing.owners[0]).not.toHaveProperty("spawnRemainingMs");
});
