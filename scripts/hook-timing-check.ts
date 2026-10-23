import { appendFileSync } from "node:fs";

/** Only shared GitHub macOS wall-time variance is advisory; malformed samples and peak RSS always fail. */
export function workloadBudget(check: string, values: { wallP95Ms: number; peakRssMB: number; wallLimitMs: number; rssLimitMB: number }, env: NodeJS.ProcessEnv = process.env) {
  const wallAdvisory = env.CI === "true" && env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "macOS";
  const validWall = Number.isFinite(values.wallP95Ms) && values.wallP95Ms >= 0;
  const wallTimingPass = validWall && values.wallP95Ms < values.wallLimitMs;
  const peakPass = Number.isFinite(values.peakRssMB) && values.peakRssMB > 0 && values.peakRssMB < values.rssLimitMB;
  const pass = peakPass && validWall && (wallTimingPass || wallAdvisory);
  const status = !pass ? "fail" : wallTimingPass ? "pass" : "warning";
  const result = { wallTimingPass, peakPass, wallAdvisory, pass };
  console.log(JSON.stringify({ diagnostic: "workload-R2", check, status, ...values, ...result }));
  if (wallAdvisory && !env.GITHUB_STEP_SUMMARY) throw new Error("GitHub macOS budget step summary is unavailable");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `**${check}: ${status}**\n\n\`${JSON.stringify({ ...values, ...result })}\`\n\n`);
  if (!wallTimingPass && validWall && wallAdvisory) console.warn(`::warning title=Hook macOS runner p95::${check}: ${JSON.stringify(values)}`);
  return result;
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
