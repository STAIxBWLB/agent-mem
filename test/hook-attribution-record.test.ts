import { expect, test } from "bun:test";
import { attributedWorkerMisses } from "../scripts/run-hook-worker-attribution.ts";
import { HookWorkerPhase } from "./fakes/hooks-worker-phases.ts";

const child = { pid: 22, kind: "worker", reaped: false, phaseInstrumentation: true, phaseTracePartial: false, phaseTraceTruncated: false,
  phaseTraceMissing: false, bootReceiptPresent: true, workerPhases: [], killRequestMs: 90, lastWorkerPhaseBeforeKill: { id: HookWorkerPhase.StoreClose, phase: "PRIVATE_CANARY" },
  parentTimerAtReapEnd: { lagMs: 2.6, windowChildPid: 22 } };
const record = { diagnostic: "hook-child-reap/v1", phaseInstrumentation: true, variant: "baseline", parentPid: 11, event: "Stop", children: [child] };
test("attribution counts unique real worker misses and projects only a fixed phase label", () => {
  const rows = attributedWorkerMisses([record, record]); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ parentPid: 11, childPid: 22, phase: "StoreClose", timerLagMs: 2.6 });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_CANARY");
});
test("unknown RSS, timeout fakes, partial traces and missing timer identity do not fill the attribution target", () => {
  for (const row of [{ ...record, variant: "timeout-native" }, { ...record, phaseInstrumentation: false },
    ...[{ reaped: true }, { phaseTracePartial: true }, { phaseTraceTruncated: true }, { parentTimerAtReapEnd: null }].map(change => ({ ...record, children: [{ ...child, ...change }] }))])
    expect(attributedWorkerMisses([row])).toEqual([]);
});
test("a complete empty trace is labelled unobserved preload entry rather than an invented worker phase", () => {
  expect(attributedWorkerMisses([{ ...record, children: [{ ...child, phaseTraceMissing: true, bootReceiptPresent: false, lastWorkerPhaseBeforeKill: null }] }])[0]?.phase).toBe("preload-entry-not-observed");
});
