import { label, PLAIN, singleLine, type Style } from "./style.ts";
import type { MigrationResult } from "./migrate.ts";

/** #592: the human migrate report, kept out of migrate.ts so the write path never imports the output package. */
/** Render a migration result for a person; JSON output remains owned by the CLI. */
export function migrationText(result: MigrationResult, s: Style = PLAIN): string {
  const active = result.profile.kind === "generation";
  const needsResume = result.mode === "resume" && !active;
  const state = needsResume ? "attention" : result.mode === "dry-run" ? "preview" : "complete";
  const groups = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${singleLine(key)}=${count}`).join(", ");
  const countRows = result.counts ? [
    ["valid", result.counts.validRows], ["skipped", result.counts.skippedRows], ["tailBytes", result.counts.tailBytes],
    ["expired", result.counts.expiredRows], ["eligible", result.counts.eligibleRows],
  ].map(([key, value]) => `${label(s, "ok")} ${key} ${value}`) : [`${label(s, "skipped")} counts not returned for this mode`];
  const operationCounts = result.counts ? groups(result.counts.byOp) : "", tierCounts = result.counts ? groups(result.counts.byTier) : "";
  if (operationCounts) countRows.push(`${label(s, "ok")} operations ${operationCounts}`);
  if (tierCounts) countRows.push(`${label(s, "ok")} tiers ${tierCounts}`);
  let action = "none";
  if (result.mode === "dry-run" && !active) action = "apply migration: amem migrate --apply";
  else if (needsResume) action = "resume migration: amem migrate --resume";
  else if (result.mode === "deactivate" && active) action = "deactivate generation: amem migrate --deactivate";
  const lines = [
    `${s.bold("amem migrate:")} ${state}${result.alreadyActive ? " (already active)" : ""}`,
    `${label(s, "ok")} profile ${result.profile.kind}${result.profile.generation ? ` (generation ${result.profile.generation.slice(0, 8)})` : ""}`,
    `${label(s, "ok")} home ${singleLine(result.profile.home)}`,
    `${label(s, "ok")} current directory ${singleLine(result.profile.dir)}`,
    ...countRows,
    `${label(s, "ok")} effect ${singleLine(result.consequence)}`,
    `Next action: ${action}`,
  ];
  return lines.join("\n");
}
