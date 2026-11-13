import type { HookWorkerProcess, HookProcessEvidence } from "../test/fakes/hooks-process-observer.ts";

/** The caller's durable-intake gate (#221): only an absent Bun worker makes a capture eligible for the pending check.
 * Native metadata supervisors are observed as workers too, and a late deferral has them. */
export function deferralPendingEligible(workers: readonly HookWorkerProcess[]): boolean {
  return !workers.some(row => row.kind === "worker");
}

/** R1 observation contract. A deferred optional worker needs positive branch and durable-intake evidence. */
export function verifyHookProcessObservation(event: "PostToolUse" | "SessionStart" | "Stop" | "SessionEnd", workers: readonly HookWorkerProcess[], evidence: readonly HookProcessEvidence[], pending: boolean): { deferred: boolean } {
  const buns = workers.filter(row => row.kind === "worker"), native = workers.filter(row => row.kind === "native");
  const attempts = evidence.filter(row => row.phase === "attempt"), returned = evidence.filter(row => row.phase === "returned");
  const checks = evidence.filter(row => row.phase === "precheck"), skipped = evidence.filter(row => row.phase === "deadline_skip");
  const why = () => JSON.stringify({ buns: buns.length, native: native.length, attempts: attempts.length, returned: returned.length, checks: checks.length, skipped: skipped.length, pending: Number(pending), preloadMax: Math.max(0, ...evidence.map(row => row.loads)), remainingUs: skipped[0]?.remainingUs ?? null });
  const fail = (): never => { throw new Error(`owned-process observation did not match the executable event: ${why()}`); };
  if (!evidence.some(row => row.phase === "preload") || evidence.some(row => row.loads !== 1)) fail();
  if (new Set(workers.map(row => row.pid)).size !== workers.length) fail();
  if (attempts.some(row => row.exact !== 1) || returned.length !== attempts.length || workers.length !== returned.length) fail();
  if (returned.some(row => row.exact !== 1 || !workers.some(worker => worker.pid === row.childPid && Number(worker.kind === "native") === row.native))) fail();
  const spawns = evidence.filter(row => row.phase === "attempt" || row.phase === "returned");
  const seen = new Set<number>();
  for (let index = 0; index < spawns.length; index += 2) {
    const attempt = spawns[index]!, result = spawns[index + 1];
    if (attempt.phase !== "attempt" || result?.phase !== "returned" || attempt.native !== result.native
      || result.childPid === undefined || seen.has(result.childPid)) fail();
    seen.add(result!.childPid!);
  }
  const sessionSkipped = evidence.filter(row => row.phase === "session-native-deadline-skip");
  if (sessionSkipped.length && (event !== "SessionStart" || sessionSkipped.length !== 1
    || !Number.isSafeInteger(sessionSkipped[0]!.remainingUs) || sessionSkipped[0]!.remainingUs! > 1000)) fail();
  if (event === "SessionStart") {
    if (buns.length !== 0 || native.length > 65 || skipped.length) fail();
    if (native.length === 0) {
      if (workers.length || attempts.length || returned.length || checks.length || evidence.some(row => row.phase === "late_check")
        || sessionSkipped.length !== 1 || pending !== true) fail();
      return { deferred: true };
    }
    return { deferred: false };
  }
  if (native.length > 64 || buns.length > 1 || checks.length !== 1) fail();
  const late = evidence.filter(row => row.phase === "late_check");
  if (late.length > 1 || late.length === 1 && skipped.length) fail();
  if (event === "Stop" || event === "SessionEnd") {
    // Transcript final hooks admit their only worker first, before any native metadata.
    // Their late_check follows all those spawns and cannot govern the earlier admission.
    if (buns.length !== 1 || skipped.length || checks[0]!.host !== 0
      || !Number.isSafeInteger(checks[0]!.remainingUs) || checks[0]!.remainingUs! < 5000
      || attempts[0]?.native !== 0 || late.length !== 1 || !Number.isSafeInteger(late[0]!.remainingUs)
      || evidence.indexOf(checks[0]!) >= evidence.indexOf(attempts[0]!)
      || evidence.indexOf(late[0]!) <= evidence.indexOf(returned.at(-1)!)) fail();
    return { deferred: false };
  }
  if (buns.length === 1) {
    // Ordinary workers start only after metadata and its positive late admission check.
    if (skipped.length || checks[0]!.host !== 0 || !Number.isSafeInteger(checks[0]!.remainingUs) || checks[0]!.remainingUs! < 5000
      || late.length !== 1 || !Number.isSafeInteger(late[0]!.remainingUs) || late[0]!.remainingUs! < 5000
      || attempts.at(-1)?.native !== 0 || evidence.indexOf(checks[0]!) >= evidence.indexOf(attempts[0]!)
      || evidence.indexOf(late[0]!) >= evidence.indexOf(attempts.at(-1)!)
      || returned.filter(row => row.native === 1).some(row => evidence.indexOf(row) >= evidence.indexOf(late[0]!))) fail();
    return { deferred: false };
  }
  // #221: the second pre-spawn exit, after native metadata. Accepted only with positive evidence measured at that guard:
  // the first check passed, the late check saw under 5 ms left, and the capture stayed durably pending.
  if (late.length === 1) {
    if (attempts.length > 64 || !pending || checks[0]!.host !== 0 || !Number.isSafeInteger(checks[0]!.remainingUs) || checks[0]!.remainingUs! < 5000
      || !Number.isSafeInteger(late[0]!.remainingUs) || late[0]!.remainingUs! >= 5000) fail();
    return { deferred: true };
  }
  if (attempts.length || skipped.length !== 1 || !pending || checks[0]!.host !== 0 || skipped[0]!.host !== 0 || skipped[0]!.remainingUs !== checks[0]!.remainingUs || !Number.isSafeInteger(checks[0]!.remainingUs) || checks[0]!.remainingUs! >= 5000) fail();
  return { deferred: true };
}

/** #367 option A: one bounded numeric record per deferred plain hook call, so a recurrence separates the precheck
 * `deadline_skip` exit from the post-metadata `late_check` exit. Numbers and fixed enums only; no paths or row text. */
export function plainDeferralRecord(input: { event: string; invocation: number; evidence: readonly HookProcessEvidence[]; wallMs: number;
  metricWallMs: number | undefined; slow: boolean | null }) {
  const late = input.evidence.find(row => row.phase === "late_check"), skipped = input.evidence.find(row => row.phase === "deadline_skip");
  const precheck = input.evidence.find(row => row.phase === "precheck");
  const guard = late ? "late_check" : skipped ? "deadline_skip" : precheck ? "precheck" : null;
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  return { diagnostic: "plain-deferral/v1" as const, event: input.event === "PostToolUse" ? "PostToolUse" : "other", invocation: Number.isSafeInteger(input.invocation) ? input.invocation : null,
    guard, remainingUs: numeric((late ?? skipped ?? precheck)?.remainingUs), precheckRemainingUs: numeric(precheck?.remainingUs),
    wallMs: numeric(input.wallMs), metricWallMs: numeric(input.metricWallMs), slow: input.slow };
}

/** Cold/pressured startup cannot turn most ordinary samples into worker-free measurements. */
export function verifyPlainHookDeferrals(count: number, samples: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(samples) || samples <= 0 || count > Math.floor(samples / 4)) throw new Error("plain optional-worker deferral exceeded 25 percent");
}
