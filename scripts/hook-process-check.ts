import type { HookWorkerProcess, HookProcessEvidence } from "../test/fakes/hooks-process-observer.ts";

/** R1 observation contract. A deferred optional worker needs positive branch and durable-intake evidence. */
export function verifyHookProcessObservation(event: "PostToolUse" | "SessionStart", workers: readonly HookWorkerProcess[], evidence: readonly HookProcessEvidence[], pending: boolean): { deferred: boolean } {
  const buns = workers.filter(row => row.kind === "worker"), native = workers.filter(row => row.kind === "native");
  const attempts = evidence.filter(row => row.phase === "attempt"), returned = evidence.filter(row => row.phase === "returned");
  const checks = evidence.filter(row => row.phase === "precheck"), skipped = evidence.filter(row => row.phase === "deadline_skip");
  const why = () => JSON.stringify({ buns: buns.length, native: native.length, attempts: attempts.length, returned: returned.length, checks: checks.length, skipped: skipped.length, pending: Number(pending), preloadMax: Math.max(0, ...evidence.map(row => row.loads)), remainingUs: skipped[0]?.remainingUs ?? null });
  const fail = (): never => { throw new Error(`owned-process observation did not match the executable event: ${why()}`); };
  if (!evidence.some(row => row.phase === "preload") || evidence.some(row => row.loads !== 1)) fail();
  if (new Set(workers.map(row => row.pid)).size !== workers.length) fail();
  if (attempts.some(row => row.exact !== 1) || returned.length !== attempts.length || workers.length !== returned.length) fail();
  if (returned.some(row => !workers.some(worker => worker.pid === row.childPid && Number(worker.kind === "native") === row.native))) fail();
  if (event === "SessionStart") {
    if (buns.length !== 0 || native.length < 1 || native.length > 65 || skipped.length) fail();
    return { deferred: false };
  }
  if (native.length || buns.length > 1 || checks.length !== 1) fail();
  if (buns.length === 1) {
    if (skipped.length || checks[0]!.host !== 0 || !Number.isSafeInteger(checks[0]!.remainingUs) || checks[0]!.remainingUs! < 5000) fail();
    return { deferred: false };
  }
  if (attempts.length || skipped.length !== 1 || !pending || checks[0]!.host !== 0 || skipped[0]!.host !== 0 || skipped[0]!.remainingUs !== checks[0]!.remainingUs || !Number.isSafeInteger(checks[0]!.remainingUs) || checks[0]!.remainingUs! >= 5000) fail();
  return { deferred: true };
}

/** Cold/pressured startup cannot turn most ordinary samples into worker-free measurements. */
export function verifyPlainHookDeferrals(count: number, samples: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(samples) || samples <= 0 || count > Math.floor(samples / 4)) throw new Error("plain optional-worker deferral exceeded 25 percent");
}
