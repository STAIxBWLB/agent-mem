/** Nonshipping task127 stable-identity sampling. No wait loop, new deadline, RSS upgrade or lock operation.
 * The caller merges these PIDs into its original R1 loop and owns that loop's original absolute end.
 */
import type { ProcessObservation } from "./task-127-lock-probe.ts";

export interface ExpectedProcessIdentity { pid: number; available: boolean; startIdentity?: string }
export interface ProcessPresence { state: "present" | "absent" | "unknown"; code?: string }
export interface StableOwnedObservation {
  pid: number; expected: ExpectedProcessIdentity; actual?: ProcessObservation; presence?: ProcessPresence;
  classification: "same-start" | "reused" | "gone" | "unknown";
  state?: string; reason: string;
}
export interface StableOwnedSample {
  observations: StableOwnedObservation[];
  /** Same-start process-table entries, including Z; not a claim of user-code execution. */
  stableAlivePids: number[];
  identityUncertainPids: number[];
}
export interface StableOwnedPorts {
  processIdentity(pid: number): ProcessObservation;
  getPresence(pid: number): ProcessPresence;
}
const errorCode = (error: unknown): string => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "observer-error";
function validPid(pid: number): boolean { return Number.isSafeInteger(pid) && pid > 0; }
function validBirth(value: ExpectedProcessIdentity): boolean {
  return value.available === true && typeof value.startIdentity === "string" && new RegExp(`^${value.pid}:\\d+(?::\\d+)?$`).test(value.startIdentity);
}
/** Signal0 does not send a signal. Presence alone never establishes ownership or accepted final RSS. */
export function processPresence(pid: number): ProcessPresence {
  if (!validPid(pid)) return { state: "unknown", code: "invalid-pid" };
  try { process.kill(pid, 0); return { state: "present" }; }
  catch (error) { const code = errorCode(error); return { state: code === "ESRCH" ? "absent" : "unknown", code }; }
}
/** Pure sampling orchestration through ports; keeps R/D/Z raw states distinct, including owned zombies.
 * ponytail: at most64 expected records per sample. Upgrade this bound only with a reviewed owned-process allowance;
 * never replace a missing birth identity with command text or follow a reused PID.
 */
export function sampleStableOwned(expected: readonly ExpectedProcessIdentity[], ports: StableOwnedPorts): StableOwnedSample {
  if (expected.length > 64 || expected.some(value => !validPid(value.pid))) throw new Error("task127 expected PID bound or identity invalid");
  const byPid = new Map<number, ExpectedProcessIdentity[]>();
  for (const value of expected) byPid.set(value.pid, [...(byPid.get(value.pid) ?? []), value]);
  const observations: StableOwnedObservation[] = [];
  for (const [pid, births] of byPid) {
    const first = births[0]!;
    if (births.some(value => value.available !== first.available || value.startIdentity !== first.startIdentity)) {
      observations.push({ pid, expected: first, classification: "unknown", reason: "conflicting-expected-births" }); continue;
    }
    let actual: ProcessObservation | undefined;
    try { actual = ports.processIdentity(pid); } catch { /* The presence port distinguishes disappearance from unavailable telemetry. */ }
    const knownExpected = validBirth(first), knownActual = !!actual && actual.pid === pid && validBirth(actual);
    if (knownExpected && knownActual) {
      const same = actual!.startIdentity === first.startIdentity;
      observations.push({ pid, expected: first, actual, classification: same ? "same-start" : "reused", state: actual!.state,
        reason: same ? "expected-birth-still-observed" : "different-birth-do-not-follow" });
      continue;
    }
    let presence: ProcessPresence;
    try { presence = ports.getPresence(pid); } catch { presence = { state: "unknown", code: "presence-port-unavailable" }; }
    if (presence.state === "absent") {
      observations.push({ pid, expected: first, actual, presence, classification: "gone", state: actual?.state,
        reason: "original-pid-no-longer-present" });
    } else {
      observations.push({ pid, expected: first, actual, presence, classification: "unknown", state: actual?.state,
        reason: !knownExpected ? "expected-birth-unavailable" : actual?.pid !== undefined && actual.pid !== pid ? "identity-pid-mismatch" : "current-birth-unavailable" });
    }
  }
  return { observations,
    stableAlivePids: observations.filter(value => value.classification === "same-start").map(value => value.pid),
    identityUncertainPids: observations.filter(value => value.classification === "unknown").map(value => value.pid) };
}

/** A command-string match cannot resurrect an original PID after verified reuse/disappearance. */
export function mergeCommandMatches(commandPids: readonly number[], sample: StableOwnedSample): number[] {
  const noLongerOriginal = new Set(sample.observations.filter(row => row.classification === "reused" || row.classification === "gone").map(row => row.pid));
  return [...new Set([...commandPids.filter(pid => !noLongerOriginal.has(pid)), ...sample.stableAlivePids, ...sample.identityUncertainPids])];
}
