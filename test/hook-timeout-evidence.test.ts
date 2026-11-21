import { expect, test } from "bun:test";
import { timeoutReceiptEvidence } from "./fakes/hooks-timeout-evidence.ts";
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
