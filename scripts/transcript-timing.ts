import type { MetricSample } from "../src/memory/metrics.ts";

/** Each timing mark is child-relative; the previous row prevents a stale metric being paired. */
export function transcriptTiming(metric: MetricSample | undefined, previous: MetricSample | undefined, outerWallMs: number) {
  const timing = metric?.transcriptTiming;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= outerWallMs;
  if (metric && previous && JSON.stringify(metric) === JSON.stringify(previous)) return { paired: false, reason: "unchanged-metric" as const };
  if (!timing || !Number.isFinite(outerWallMs) || !valid(timing.metricSampleAtMs)) return { paired: false, reason: "missing-or-outside-invocation" as const };
  const metricAt = timing.metricSampleAtMs;
  const reap = valid(timing.reapAtMs) && timing.reapAtMs <= metricAt ? timing.reapAtMs : undefined;
  const kill = valid(timing.killAtMs) && reap !== undefined && timing.killAtMs <= reap ? timing.killAtMs : undefined;
  return { paired: true, killToReapMs: kill === undefined || reap === undefined ? null : reap - kill,
    reapToMetricSampleMs: reap === undefined ? null : metricAt - reap,
    metricSampleToParentReturnUpperBoundMs: outerWallMs - metricAt,
    missing: [...(kill === undefined ? ["kill"] : []), ...(reap === undefined ? ["reap"] : [])] };
}
