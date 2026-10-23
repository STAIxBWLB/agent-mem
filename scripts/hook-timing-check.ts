import { appendFileSync } from "node:fs";

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
