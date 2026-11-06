/** Nonshipping numeric phase analysis. No I/O, product imports, or timing-budget decisions. */
export interface PhaseDurationRow { id: number; seq: number; atMs: number }
export type PhaseDurationInterval =
  | { kind: "completed"; durationMs: number }
  | { kind: "censored"; lowerMs: number }
  | { kind: "unknown"; reason: "next-start" | "stop-or-throw" | "transition" | "incomplete-trace" | "no-kill-bound" };
interface PhaseDurationMetric { intervals: PhaseDurationInterval[]; orphanReturns: number }
export interface PhaseDurationAccumulator {
  workerInputs: number; inputRows: number; malformedWorkers: number; overBoundWorkers: number;
  truncatedWorkers: number; anchorRefusedWorkers: number;
  close: PhaseDurationMetric; write: PhaseDurationMetric;
}
interface Quantiles { p50: number; p95: number; p99: number; max: number }
interface QuantileBound { lowerMs: number; upperMs: number | null; upperUnbounded: boolean }
export interface PhaseDurationSummary {
  started: number; completed: number; censored: number; unknown: number; orphanReturns: number;
  unknownReasons: Partial<Record<Extract<PhaseDurationInterval, { kind: "unknown" }>["reason"], number>>;
  completedMs: (Quantiles & { over10: number }) | null;
  allStarted: { bounds: Record<keyof Quantiles, QuantileBound> | null; over10Minimum: number; over10Maximum: number };
}
const IDS = new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,30,31]);
const RANKS = { p50: .5, p95: .95, p99: .99, max: 1 } as const;
export function emptyPhaseDurations(): PhaseDurationAccumulator {
  return { workerInputs: 0, inputRows: 0, malformedWorkers: 0, overBoundWorkers: 0, truncatedWorkers: 0, anchorRefusedWorkers: 0,
    close: { intervals: [], orphanReturns: 0 }, write: { intervals: [], orphanReturns: 0 } };
}

/** Max 512 rows per worker. Rejected inputs remain explicit, never silently trimmed or counted as complete. */
export function addWorkerPhaseDurations(acc: PhaseDurationAccumulator, rows: readonly PhaseDurationRow[], firstKillMs: number | null): void {
  acc.workerInputs++; acc.inputRows += rows.length;
  if (rows.length > 512) { acc.overBoundWorkers++; return; }
  if ((firstKillMs !== null && (!Number.isFinite(firstKillMs) || firstKillMs < 0)) || rows.some((row, index) =>
    !row || !IDS.has(row.id) || !Number.isSafeInteger(row.seq) || row.seq !== index + 1 || !Number.isFinite(row.atMs) || row.atMs < 0
      || (index > 0 && row.atMs < rows[index - 1]!.atMs))) { acc.malformedWorkers++; return; }
  const truncated = rows.some(row => row.id === 30), refused = rows.some(row => row.id === 31);
  if (truncated) acc.truncatedWorkers++;
  if (refused) acc.anchorRefusedWorkers++;
  for (const [metric, start, end] of [[acc.close, 11, 12], [acc.write, 9, 10]] as const) {
    let active: { atMs: number; invalidated?: Extract<PhaseDurationInterval, { kind: "unknown" }>["reason"] } | undefined;
    const unknown = (reason: Extract<PhaseDurationInterval, { kind: "unknown" }>["reason"]) => metric.intervals.push({ kind: "unknown", reason });
    for (const row of rows) {
      if (row.id === start) {
        if (active) unknown(active.invalidated ?? "next-start");
        active = { atMs: row.atMs };
      } else if (row.id === end) {
        if (!active) metric.orphanReturns++;
        else {
          // Even an intervening exception may recover inside append(). A matching observed return is completion.
          metric.intervals.push({ kind: "completed", durationMs: row.atMs - active.atMs }); active = undefined;
        }
      } else if (active) {
        if (row.id === 15 || row.id === 19) active.invalidated ??= "stop-or-throw";
        else if (row.id === 30 || row.id === 31) active.invalidated ??= "incomplete-trace";
        else if (start === 9 && [5,6,7,8,11,12,13,14].includes(row.id)) active.invalidated ??= "transition";
        else if (start === 11 && [5,6,7,8,9,10,13,14].includes(row.id)) active.invalidated ??= "transition";
      }
    }
    if (active) {
      if (active.invalidated) unknown(active.invalidated);
      else if (truncated || refused) unknown("incomplete-trace");
      else if (firstKillMs !== null && firstKillMs >= active.atMs) metric.intervals.push({ kind: "censored", lowerMs: firstKillMs - active.atMs });
      else unknown("no-kill-bound");
    }
  }
}
function summarizeMetric(metric: PhaseDurationMetric): PhaseDurationSummary {
  const completed = metric.intervals.flatMap(row => row.kind === "completed" ? [row.durationMs] : []).sort((a,b) => a-b);
  const lower = metric.intervals.map(row => row.kind === "completed" ? row.durationMs : row.kind === "censored" ? row.lowerMs : 0).sort((a,b) => a-b);
  const upper = metric.intervals.map(row => row.kind === "completed" ? row.durationMs : Infinity).sort((a,b) => a-b);
  const rank = (values: readonly number[], q: number) => values[Math.ceil(q * values.length) - 1]!;
  const completedMs = completed.length ? { p50: rank(completed,.5), p95: rank(completed,.95), p99: rank(completed,.99), max: completed[completed.length - 1]!, over10: completed.filter(value => value > 10).length } : null;
  const bounds = lower.length ? Object.fromEntries(Object.entries(RANKS).map(([name,q]) => {
    const hi = rank(upper,q); return [name, { lowerMs: rank(lower,q), upperMs: Number.isFinite(hi) ? hi : null, upperUnbounded: !Number.isFinite(hi) }];
  })) as Record<keyof Quantiles, QuantileBound> : null;
  const unknownReasons: PhaseDurationSummary["unknownReasons"] = {};
  for (const row of metric.intervals) if (row.kind === "unknown") unknownReasons[row.reason] = (unknownReasons[row.reason] ?? 0) + 1;
  return { started: metric.intervals.length, completed: completed.length,
    censored: metric.intervals.filter(row => row.kind === "censored").length,
    unknown: metric.intervals.filter(row => row.kind === "unknown").length, orphanReturns: metric.orphanReturns, unknownReasons, completedMs,
    allStarted: { bounds, over10Minimum: lower.filter(value => value > 10).length,
      over10Maximum: completed.filter(value => value > 10).length + metric.intervals.length - completed.length } };
}
export function summarizePhaseDurations(acc: PhaseDurationAccumulator) {
  const close = summarizeMetric(acc.close), write = summarizeMetric(acc.write);
  return { workerInputs: acc.workerInputs, inputRows: acc.inputRows,
    incomplete: !!(acc.malformedWorkers || acc.overBoundWorkers || acc.truncatedWorkers || acc.anchorRefusedWorkers || close.orphanReturns || write.orphanReturns || close.unknown || write.unknown),
    validation: { malformedWorkers: acc.malformedWorkers, overBoundWorkers: acc.overBoundWorkers, truncatedWorkers: acc.truncatedWorkers, anchorRefusedWorkers: acc.anchorRefusedWorkers }, close, write };
}
