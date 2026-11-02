import { appendFileSync } from "node:fs";
import { rssVerdict } from "./budget-attempt.ts";

/** Only shared GitHub macOS wall-time variance is advisory; malformed samples and the RSS verdict always fail.
 * #228: RSS gates on the nearest-rank p95 of the group's fixed samples (`rssSamplesMB`), not the single maximum. */
export function workloadBudget(check: string, values: { wallP95Ms: number; rssSamplesMB: readonly number[]; wallLimitMs: number; rssLimitMB: number }, env: NodeJS.ProcessEnv = process.env) {
  const wallAdvisory = env.CI === "true" && env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "macOS";
  const validWall = Number.isFinite(values.wallP95Ms) && values.wallP95Ms >= 0;
  const wallTimingPass = validWall && values.wallP95Ms < values.wallLimitMs;
  const rss = rssVerdict(values.rssSamplesMB, values.rssLimitMB), peakPass = rss.pass;
  const pass = peakPass && validWall && (wallTimingPass || wallAdvisory);
  const status = !pass ? "fail" : wallTimingPass ? "pass" : "warning";
  const result = { wallTimingPass, peakPass, wallAdvisory, pass };
  const shown = { wallP95Ms: values.wallP95Ms, wallLimitMs: values.wallLimitMs, rssLimitMB: values.rssLimitMB, rssStatistic: rss.statistic, rssP95MB: rss.valueMB, peakRssMB: rss.peakMB, rssCount: rss.count, rssOverLimit: rss.overLimit };
  console.log(JSON.stringify({ diagnostic: "workload-R2", check, status, ...shown, ...result }));
  if (wallAdvisory && !env.GITHUB_STEP_SUMMARY) throw new Error("GitHub macOS budget step summary is unavailable");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `**${check}: ${status}**\n\n\`${JSON.stringify({ ...shown, ...result })}\`\n\n`);
  if (!wallTimingPass && validWall && wallAdvisory) console.warn(`::warning title=Hook macOS runner p95::${check}: ${JSON.stringify(shown)}`);
  return { ...result, rss };
}

/** #226 owner decision 2026-11-02: only the transcript reason-only stall clause, and only on hosted GitHub macOS, is
 * advisory. All three markers must match exactly, as for the macOS wall advisory. */
export function stallAdvisory(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" && env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "macOS";
}

/** Gate diagnostics only. This module is never imported by the shipped hook path. */
export function singleAttemptTiming(check: string, passed: boolean, values: Record<string, number | boolean | null>, env: NodeJS.ProcessEnv = process.env): void {
  const advisory = env.CI === "true" && env.GITHUB_ACTIONS === "true";
  const status = passed ? "pass" : advisory ? "warning" : "fail";
  const record = { diagnostic: "single-attempt-timing", check, status, ...values };
  console.log(JSON.stringify(record));
  if (advisory && !env.GITHUB_STEP_SUMMARY) throw new Error("GitHub timing step summary is unavailable");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `**${check}: ${status}**\n\n\`${JSON.stringify(values)}\`\n\n`);
  if (!passed) {
    const message = `${check}: ${JSON.stringify(values)}`;
    if (advisory) console.warn(`::warning title=Hook single-attempt timing::${message}`);
    else throw new Error(message);
  }
}
