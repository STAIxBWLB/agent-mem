import { reportBudgetAdvisory } from "./hook-timing-check.ts";
import { HOOK_RSS_COVERAGE, rssSourcesKnown, validRssSources } from "../src/hook-resources.ts";
import type { MetricSample } from "../src/memory/metrics.ts";

/** Linux wait4 can retain the launcher's pre-exec peak; it stays diagnostic, not a second RSS gate. */
export function measuredHookRss(metric: MetricSample, cliRawRssMB: number, platform = process.platform) {
  if (!Number.isFinite(cliRawRssMB) || cliRawRssMB <= 0 || !Number.isFinite(metric.rssMB) || metric.rssMB! <= 0
    || metric.rssScope !== "owned-images" || !validRssSources(metric.rssSources) || !rssSourcesKnown(metric.rssSources)) {
    throw new Error(`hook RSS provenance unknown: ${JSON.stringify({ cliRawRssMB, productionRssMB: metric.rssMB ?? null, scope: metric.rssScope ?? null, sources: metric.rssSources ?? null, rssCoverage: HOOK_RSS_COVERAGE })}`);
  }
  return {
    rssMB: platform === "linux" ? metric.rssMB! : Math.max(cliRawRssMB, metric.rssMB!),
    cliRssMB: cliRawRssMB, recordedRssMB: metric.rssMB!, rawRssMB: metric.rawRssMB ?? null,
    rssSource: platform === "linux" ? "production-owned-images" : "max-production-and-platform-rusage",
    rssSources: metric.rssSources, rssCoverage: HOOK_RSS_COVERAGE,
  };
}

export type BudgetHookRss = ReturnType<typeof measuredHookRss> & { rssProvenanceKnown: boolean; rssAdvisory: boolean };
/** Measurement-only #226 exception. These values remain an observed envelope, never a claim that missing worker peaks are known. */
export function measuredBudgetHookRss(metric: MetricSample, cliRawRssMB: number,
  evidence: { survivors: number; abandonedOwnedWorkers: number }, check: string,
  env: NodeJS.ProcessEnv = process.env, platform = process.platform): BudgetHookRss {
  try { return { ...measuredHookRss(metric, cliRawRssMB, platform), rssProvenanceKnown: true, rssAdvisory: false }; }
  catch (error) {
    const telemetryValid = Number.isFinite(cliRawRssMB) && cliRawRssMB > 0 && Number.isFinite(metric.rssMB) && metric.rssMB! > 0
      && Number.isFinite(metric.wallMs) && metric.wallMs! >= 0 && metric.rssScope === "owned-images" && validRssSources(metric.rssSources) && metric.rssSources.rawFallback === 0;
    if (!reportBudgetAdvisory("rss-unknown", check, { ...evidence, telemetryValid,
      unavailableRssSources: metric.rssSources?.unavailable }, env)) throw error;
    return {
      rssMB: platform === "linux" ? metric.rssMB! : Math.max(cliRawRssMB, metric.rssMB!),
      cliRssMB: cliRawRssMB, recordedRssMB: metric.rssMB!, rawRssMB: metric.rawRssMB ?? null,
      rssSource: "provenance-unknown-observed-envelope", rssSources: metric.rssSources!, rssCoverage: HOOK_RSS_COVERAGE,
      rssProvenanceKnown: false, rssAdvisory: true,
    };
  }
}
