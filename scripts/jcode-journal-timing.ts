import type { JcodeJournalTiming, MetricSample } from "../src/memory/metrics.ts";

/** Journal spans are nested and all marks use the child process's performance clock. */
export function jcodeJournalSampleFields(group: string, metric: MetricSample, outerWallMs: number) {
  if (group !== "jcodeJournal") return {};
  const timing = metric.jcodeJournalTiming;
  const fields: (keyof JcodeJournalTiming)[] = ["scanStartMs", "scanEndMs", "workStartMs", "publishStartMs", "publishEndMs", "publishTotalMs", "workerSpawnStartMs", "workerSpawnEndMs", "cursorCloseStartMs", "cursorCloseEndMs", "metricSampleAtMs"];
  const valid: JcodeJournalTiming = {};
  if (timing && typeof timing === "object") for (const name of fields) {
    const value = timing[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) valid[name] = value;
  }
  for (const [start, end] of [["scanStartMs", "scanEndMs"], ["publishStartMs", "publishEndMs"], ["workerSpawnStartMs", "workerSpawnEndMs"], ["cursorCloseStartMs", "cursorCloseEndMs"]] as const) {
    if (valid[end] !== undefined && (valid[start] === undefined || valid[end]! < valid[start]!)) delete valid[end];
  }
  if (valid.publishEndMs === undefined) delete valid.publishTotalMs;
  const sample = valid.metricSampleAtMs;
  return { ...(metric.drainStartMs === undefined ? {} : { drainStartMs: metric.drainStartMs }),
    ...(metric.drained === undefined ? {} : { drained: metric.drained }),
    ...(metric.transcriptOffset === undefined ? {} : { transcriptOffset: metric.transcriptOffset }),
    ...(metric.transcriptStopReason === undefined ? {} : { transcriptStopReason: metric.transcriptStopReason }),
    ...(timing ? { jcodeJournalTiming: valid } : {}),
    metricSampleToParentReturnUpperBoundMs: typeof sample === "number" && Number.isFinite(outerWallMs) && sample <= outerWallMs ? outerWallMs - sample : null };
}
