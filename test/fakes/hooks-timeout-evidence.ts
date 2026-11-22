import type { FixtureChildEvidence, FixtureEntryEvidence, HookLifecycleReceipt, HookWorkerProcess } from "./hooks-process-observer.ts";

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

const rel = (at: number | null | undefined, origin: number | undefined) =>
  at === null || at === undefined || origin === undefined || !Number.isFinite(at) ? undefined : Math.round((at - origin) * 10) / 10;
const diff = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined ? undefined : Math.round((a - b) * 10) / 10;

/** #362: counts and hook-relative times for every timeout branch line. No pids, paths or environment values. */
export function timeoutBranchEvidence(input: { workers: readonly HookWorkerProcess[]; lifecycle: readonly HookLifecycleReceipt[];
  fixture: { rows: readonly FixtureChildEvidence[] }; entries: readonly FixtureEntryEvidence[] }) {
  const origin = input.lifecycle.find(row => row.phase === "origin")?.atMs;
  const count = (phase: HookLifecycleReceipt["phase"]) => input.lifecycle.filter(row => row.phase === phase).length;
  const owners = input.workers.slice(0, REFUSAL_EVIDENCE_LIMIT).map(owner => {
    const own = input.lifecycle.filter(row => row.childPid === owner.pid);
    const one = (phase: HookLifecycleReceipt["phase"]) => { const rows = own.filter(row => row.phase === phase); return rows.length === 1 ? rows[0] : undefined; };
    const spawn = one("spawn"), spawnAtMs = rel(spawn?.atMs, origin), killAtMs = rel(one("kill-request")?.atMs, origin);
    const exitAtMs = rel(one("exit")?.atMs, origin), reapAtMs = rel(one("reap-end")?.atMs, origin);
    const entryRows = input.entries.filter(row => row.ownerPid === owner.pid), child = input.fixture.rows.filter(row => row.ownerPid === owner.pid);
    const entryAtMs = entryRows.length === 1 ? rel(entryRows[0]!.entryMs, origin) : undefined;
    const beforeWriteAtMs = child.length === 1 ? rel(child[0]!.beforeMs, origin) : undefined;
    const afterWriteAtMs = child.length === 1 ? rel(child[0]!.afterMs, origin) : undefined;
    const remaining = spawn?.spawnRemainingMs;
    const fields = { kind: owner.kind, spawnAtMs, killAtMs, exitAtMs, reapAtMs,
      spawnRemainingMs: typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0 ? remaining : undefined,
      entryAtMs, beforeWriteAtMs, afterWriteAtMs,
      entryMinusKillMs: diff(entryAtMs, killAtMs), beforeMinusKillMs: diff(beforeWriteAtMs, killAtMs), afterMinusReapMs: diff(afterWriteAtMs, reapAtMs) };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  });
  return { spawnAttempts: count("spawn-attempt"), spawnFailed: count("spawn-failed"), owners };
}
