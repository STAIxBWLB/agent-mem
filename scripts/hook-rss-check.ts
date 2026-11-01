import { rssSourcesKnown, validRssSources } from "../src/hook-resources.ts";
import type { MetricSample } from "../src/memory/metrics.ts";

/** Linux wait4 can retain the launcher's pre-exec peak; it stays diagnostic, not a second RSS gate. */
export function measuredHookRss(metric: MetricSample, cliRawRssMB: number, platform = process.platform) {
  if (!Number.isFinite(cliRawRssMB) || cliRawRssMB <= 0 || !Number.isFinite(metric.rssMB) || metric.rssMB! <= 0
    || metric.rssScope !== "owned-images" || !validRssSources(metric.rssSources) || !rssSourcesKnown(metric.rssSources)) {
    throw new Error(`hook RSS provenance unknown: ${JSON.stringify({ cliRawRssMB, productionRssMB: metric.rssMB ?? null, scope: metric.rssScope ?? null, sources: metric.rssSources ?? null })}`);
  }
  return {
    rssMB: platform === "linux" ? metric.rssMB! : Math.max(cliRawRssMB, metric.rssMB!),
    cliRssMB: cliRawRssMB, recordedRssMB: metric.rssMB!, rawRssMB: metric.rawRssMB ?? null,
    rssSource: platform === "linux" ? "production-owned-images" : "max-production-and-platform-rusage",
    rssSources: metric.rssSources,
  };
}
