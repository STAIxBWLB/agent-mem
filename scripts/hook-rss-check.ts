import { reportAttributedWorkerRssAdvisory, reportBudgetAdvisory } from "./hook-timing-check.ts";
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

type ProcessDiagnostic = ReturnType<typeof import("./hook-process-diagnostic.ts").hookProcessDiagnostic>;
/** Both new #287 callers already have the lifecycle observer. Match every unknown to an unreaped worker,
 * then observe PID AND detached group disappearance; a leader exit alone is never R1 proof. */
export async function measuredAttributedHookRss(metric: MetricSample, cliRawRssMB: number, diagnostic: ProcessDiagnostic,
  check: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<BudgetHookRss> {
  try { return { ...measuredHookRss(metric, cliRawRssMB, platform), rssProvenanceKnown: true, rssAdvisory: false }; }
  catch {
    const { processGroupLiveness, processLiveness } = await import("../src/memory/platform.ts");
    const observation = attributedWorkerRssObservation(diagnostic);
    // The existing R1 post-exit window is observational only; no signals, no late RSS recollection.
    const end = performance.now() + 2000;
    const survivors = () => diagnostic.children.filter(child => processLiveness(child.pid) !== "gone" || processGroupLiveness(child.pid) !== "gone").length;
    let remaining = observation.complete ? survivors() : diagnostic.children.length;
    while (observation.complete && remaining && performance.now() < end) { await Bun.sleep(10); remaining = survivors(); }
    const sources = metric.rssSources;
    const telemetryValid = metric.kind === "hook" && metric.abandonedChildren === diagnostic.abandonedChildren && Number.isFinite(cliRawRssMB) && cliRawRssMB > 0
      && Number.isFinite(metric.rssMB) && metric.rssMB! > 0 && Number.isFinite(metric.wallMs) && metric.wallMs! >= 0
      && metric.rssScope === "owned-images" && validRssSources(sources) && sources.vmhwm + sources.vmpeakBound + sources.platformRusage > 0;
    const evidence = { telemetryValid, survivors: remaining,
      abandonedOwnedWorkers: metric.abandonedChildren, unavailableRssSources: sources?.unavailable,
      rawFallbackRssSources: sources?.rawFallback ?? -1, unexplainedRssSources: (sources?.unavailable ?? -1) - observation.explained,
      wallMs: metric.wallMs, ownedChildObservationComplete: observation.complete, r1Passed: observation.complete && remaining === 0 };
    if (!reportAttributedWorkerRssAdvisory(check, evidence, env))
      throw new Error("hook RSS provenance unknown (unattributed, invalid telemetry or failed R1); inspect owned-child receipts: "
        + JSON.stringify({ check, ...evidence, process: diagnostic }));
    return { rssMB: platform === "linux" ? metric.rssMB! : Math.max(cliRawRssMB, metric.rssMB!),
      cliRssMB: cliRawRssMB, recordedRssMB: metric.rssMB!, rawRssMB: metric.rawRssMB ?? null,
      rssSource: "provenance-unknown-observed-envelope", rssSources: sources!, rssCoverage: HOOK_RSS_COVERAGE,
      rssProvenanceKnown: false, rssAdvisory: true };
  }
}

/** Pure receipt accounting. Missing or inconsistent receipts cannot explain an unknown source. */
export function attributedWorkerRssObservation(diagnostic: ProcessDiagnostic): { complete: boolean; explained: number } {
  const children = diagnostic.children, abandoned = diagnostic.abandonedChildren;
  let explained = 0, abandonedWorkers = 0;
  let complete = !diagnostic.truncated && diagnostic.metricPresent && diagnostic.lifecyclePresent
    && diagnostic.expectedOwnedChildren !== null && diagnostic.expectedOwnedChildren > 0
    && diagnostic.expectedOwnedChildren === diagnostic.observedOwnedChildren
    && diagnostic.observedOwnedChildren === diagnostic.lifecycleChildren && children.length === diagnostic.lifecycleChildren
    && diagnostic.spawnAttempts === children.length && diagnostic.spawnFailures === 0
    && (diagnostic.expectedWorkerChildren === null || diagnostic.expectedWorkerChildren === children.filter(child => child.kind === "worker").length);
  for (const child of children) {
    complete &&= child.detached === true && child.spawnMs !== null && child.rss !== null && child.rss.telemetryValid === 1;
    if (child.kind === "worker" && child.reaped === false) {
      abandonedWorkers++;
      const counters = child.rss?.counters;
      const count = counters?.unavailable;
      complete &&= child.killRequestMs !== null && child.reapStartMs !== null && child.reapEndMs !== null
        && !!counters && validRssSources(counters) && counters.rawFallback === 0
        && count !== null && count !== undefined && count >= 1 && count <= 2;
      if (typeof count === "number") explained += count;
    } else if (child.kind === "native") {
      complete &&= child.receiptComplete && child.reaped === true && child.rss?.known === 1
        && child.rss.observationFailed === 0 && ["VmHWM", "vmpeak-bound", "platform-rusage"].includes(child.rss.source ?? "");
    } else if (child.kind === "worker") {
      complete &&= child.receiptComplete && child.reaped === true && validRssSources(child.rss?.counters)
        && rssSourcesKnown(child.rss!.counters as import("../src/hook-resources.ts").HookRssSources);
    } else complete = false;
  }
  return { complete: complete && abandonedWorkers === abandoned && abandonedWorkers > 0, explained };
}
