import { expect, test } from "bun:test";
import type { ProcessObservation } from "../scripts/task-127-lock-probe.ts";
import { mergeCommandMatches, processPresence, sampleStableOwned, type ProcessPresence } from "../scripts/task-127-r1.ts";

const birth = { pid: 42, available: true, startIdentity: "42:100" };
const observed = (state: string, startIdentity = birth.startIdentity): ProcessObservation => ({ ...birth, startIdentity, state, source: "proc-stat", startPrecision: "kernel-clock-ticks" });
const unavailable = (error: string): ProcessObservation => ({ pid: 42, available: false, source: "proc-stat", error });
const mustNotProbePresence = (): ProcessPresence => { throw new Error("known birth does not need a presence-only substitute"); };

test("task127 stable sampling retains separate R/D/Z states even when the caller's command match is empty", () => {
  for (const state of ["R", "D", "Z"]) {
    const sample = sampleStableOwned([birth], { processIdentity: () => observed(state), getPresence: mustNotProbePresence });
    expect(sample.stableAlivePids).toEqual([42]); expect(sample.identityUncertainPids).toEqual([]);
    expect(sample.observations[0]).toMatchObject({ classification: "same-start", state, reason: "expected-birth-still-observed" });
  }
});

test("task127 stable sampling never follows a reused PID or upgrades it into the old owner's lifetime", () => {
  const sample = sampleStableOwned([birth], { processIdentity: () => observed("R", "42:101"), getPresence: mustNotProbePresence });
  expect(sample.stableAlivePids).toEqual([]); expect(sample.identityUncertainPids).toEqual([]);
  expect(sample.observations[0]?.classification).toBe("reused");
  expect(mergeCommandMatches([42, 77], sample)).toEqual([77]);
});

test("task127 stable sampling is merged into the existing command observation without hiding unknown ownership", () => {
  const same = sampleStableOwned([birth], { processIdentity: () => observed("Z"), getPresence: mustNotProbePresence });
  expect(mergeCommandMatches([], same)).toEqual([42]);
  const unknown = sampleStableOwned([birth], { processIdentity: () => unavailable("EPERM"), getPresence: () => ({ state: "unknown", code: "EPERM" }) });
  expect(mergeCommandMatches([], unknown)).toEqual([42]);
  const gone = sampleStableOwned([birth], { processIdentity: () => unavailable("ENOENT"), getPresence: () => ({ state: "absent", code: "ESRCH" }) });
  expect(mergeCommandMatches([42], gone)).toEqual([]);
});

test("task127 missing identity requires presence evidence and permissions remain unknown", () => {
  const cases: [ProcessObservation, ProcessPresence, string][] = [
    [unavailable("ENOENT"), { state: "absent", code: "ESRCH" }, "gone"],
    [unavailable("EACCES"), { state: "unknown", code: "EPERM" }, "unknown"],
    [unavailable("proc-pidinfo-unavailable-or-layout"), { state: "absent", code: "ESRCH" }, "gone"],
    [unavailable("ENOENT"), { state: "present" }, "unknown"],
  ];
  for (const [actual, presence, classification] of cases) {
    const sample = sampleStableOwned([birth], { processIdentity: () => actual, getPresence: () => presence });
    expect(sample.observations[0]?.classification).toBe(classification);
    expect(sample.stableAlivePids).toEqual([]);
    expect(sample.identityUncertainPids).toEqual(classification === "unknown" ? [42] : []);
  }
});

test("task127 unknown expected birth and conflicting expected records cannot become owned by PID alone", () => {
  const sample = sampleStableOwned([{ pid: 42, available: false }], { processIdentity: () => observed("R"), getPresence: () => ({ state: "present" }) });
  expect(sample.stableAlivePids).toEqual([]); expect(sample.identityUncertainPids).toEqual([42]);
  let calls = 0;
  const conflict = sampleStableOwned([birth, { ...birth, startIdentity: "42:101" }], { processIdentity: () => { calls++; return observed("R"); }, getPresence: mustNotProbePresence });
  expect(calls).toBe(0); expect(conflict.identityUncertainPids).toEqual([42]);
  const duplicate = sampleStableOwned([birth, birth], { processIdentity: () => observed("D"), getPresence: mustNotProbePresence });
  expect(duplicate.stableAlivePids).toEqual([42]);
});

test("task127 observation port failures and malformed identities fail closed", () => {
  const failure = sampleStableOwned([birth], { processIdentity: () => { throw Error("unavailable"); }, getPresence: () => { throw Error("unavailable"); } });
  expect(failure.identityUncertainPids).toEqual([42]);
  const wrongPid = sampleStableOwned([birth], { processIdentity: () => ({ ...observed("R"), pid: 43 }), getPresence: () => ({ state: "present" }) });
  expect(wrongPid.observations[0]?.reason).toBe("identity-pid-mismatch");
  const malformed = sampleStableOwned([birth], { processIdentity: () => observed("R", "not-a-start-identity"), getPresence: () => ({ state: "present" }) });
  expect(malformed.identityUncertainPids).toEqual([42]);
  expect(() => sampleStableOwned([{ ...birth, pid: -1 }], { processIdentity: () => observed("R"), getPresence: mustNotProbePresence })).toThrow("PID bound");
});

test("task127 signal0 presence observation is readonly and rejects invalid PIDs", () => {
  expect(processPresence(process.pid)).toEqual({ state: "present" });
  expect(processPresence(-1)).toEqual({ state: "unknown", code: "invalid-pid" });
});
