import type { FixtureChildEvidence, HookLifecycleReceipt, HookWorkerProcess } from "./hooks-process-observer.ts";

/** Wall-clock comparisons across processes and filesystem clocks are approximate. */
export const RECEIPT_CLOCK_TOLERANCE_MS = 5, REFUSAL_EVIDENCE_LIMIT = 512;
export function timeoutReceiptEvidence(input: { workers: readonly HookWorkerProcess[]; receiptPids: readonly number[];
  lifecycle: readonly HookLifecycleReceipt[]; fixture: { rows: readonly FixtureChildEvidence[]; truncated: boolean; invalid: boolean } }) {
  const owners = input.workers.slice(0, REFUSAL_EVIDENCE_LIMIT);
  const children = input.fixture.rows.slice(0, REFUSAL_EVIDENCE_LIMIT - owners.length);
  const truncated = input.fixture.truncated || input.workers.length + input.fixture.rows.length > REFUSAL_EVIDENCE_LIMIT || input.lifecycle.some(row => row.phase === "truncated");
  const duplicate = new Set(children.map(row => row.pid)).size !== children.length || new Set(owners.map(row => row.pid)).size !== owners.length;
  const invalid = input.fixture.invalid || duplicate || children.some(row => !owners.some(owner => owner.pid === row.ownerPid));
  const trusted = !truncated && !invalid;
  const lifecycle = owners.map(owner => {
    const own = input.lifecycle.filter(row => row.childPid === owner.pid);
    const one = (phase: HookLifecycleReceipt["phase"]) => {
      const values = own.filter(row => row.phase === phase);
      return values.length === 1 && Number.isFinite(values[0]!.atMs) ? values[0]!.atMs : null;
    };
    return { pid: owner.pid, kind: owner.kind, spawnAtMs: one("spawn"), killAtMs: one("kill-request"),
      exitAtMs: one("exit"), reapStartAtMs: one("reap-start"), reapAtMs: one("reap-end") };
  });
  const evidence = children.map(child => {
    const owner = lifecycle.find(row => row.pid === child.ownerPid);
    const kill = owner?.killAtMs ?? null, reap = owner?.reapAtMs ?? null, before = child.beforeMs, after = child.afterMs ?? null;
    const good = trusted && Number.isFinite(before) && after !== null && Number.isFinite(after) && after >= before && kill !== null && reap !== null && reap >= kill;
    const relation = !good ? "ambiguous" : after! < kill! - RECEIPT_CLOCK_TOLERANCE_MS ? "before-kill"
      : before > kill! + RECEIPT_CLOCK_TOLERANCE_MS && after! < reap! - RECEIPT_CLOCK_TOLERANCE_MS ? "between-kill-and-reap"
      : before > reap! + RECEIPT_CLOCK_TOLERANCE_MS ? "after-reap" : "ambiguous";
    // The entry marker is also the pre-write bound; these two labels refer to the same filesystem observation.
    return { pid: child.pid, ownerPid: child.ownerPid, fixtureEntryMarkerAtMs: before, receiptBeforeMs: before, receiptAfterMs: after,
      beforeMinusKillMs: kill === null ? null : before - kill, afterMinusKillMs: after === null || kill === null ? null : after - kill,
      beforeMinusReapMs: reap === null ? null : before - reap, afterMinusReapMs: after === null || reap === null ? null : after - reap, relation };
  });
  return { maxRecords: REFUSAL_EVIDENCE_LIMIT, toleranceMs: RECEIPT_CLOCK_TOLERANCE_MS, clock: "approximate-wall-clock" as const,
    truncated, invalid, missingPids: trusted ? children.filter(row => !input.receiptPids.includes(row.pid)).map(row => row.pid) : null,
    unidentifiedOwners: trusted ? owners.filter(row => !children.some(child => child.ownerPid === row.pid)).map(row => row.pid) : owners.map(row => row.pid),
    owners: lifecycle, children: evidence };
}
