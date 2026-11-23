import { label, PLAIN, singleLine, type Style } from "./style.ts";
import type { ShardMigrationResult } from "./shard-migration.ts";

/** #592: the human shard-migration report, kept out of shard-migration.ts so the write path never imports the output package. */
/** Render a shard migration result for a person; JSON output remains owned by the CLI. */
export function shardMigrationText(result: ShardMigrationResult, s: Style = PLAIN): string {
  const counts = result.counts;
  const groupRows = (name: string, value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${label(s, "ok")} ${name} ${singleLine(key)} ${count}`);
  const countRows = [
    ["rows", counts.rows], ["skipped", counts.skippedRows], ["userRows", counts.userRows], ["tailBytes", counts.tailBytes],
    ["legacyRows", counts.legacyRows], ["generationRows", counts.generationRows], ["generationLocalRows", counts.generationLocalRows],
    ["legacyLocalRows", counts.legacyLocalRows], ["legacyMainRows", counts.legacyMainRows], ["pruneRows", counts.pruneRows],
    ["translatedPruneRows", counts.translatedPruneRows], ["refusedRows", counts.refusedRows],
    ["sharedSupersededByPrivate", counts.sharedSupersededByPrivate], ["crossPrivateReplacement", counts.crossPrivateReplacement],
    ["danglingRows", counts.danglingRows],
  ].map(([key, value]) => {
    const flagged = key === "refusedRows" && counts.refusedRows > 0 || key === "sharedSupersededByPrivate" && counts.sharedSupersededByPrivate > 0
      || key === "crossPrivateReplacement" && counts.crossPrivateReplacement > 0 || key === "danglingRows" && counts.danglingRows > 0;
    return `${label(s, flagged ? "attention" : "ok")} ${key} ${value}`;
  });
  const warnings = result.refusals ?? [];
  const attention = warnings.length > 0 || counts.refusedRows > 0 || counts.danglingRows > 0 || (!result.active && result.mode === "resume");
  const state = attention ? "attention" : result.mode === "dry-run" ? "preview" : result.active ? "complete" : "attention";
  const action = warnings.length || counts.refusedRows > 0 || counts.danglingRows > 0 ? "resolve the listed refusals or flagged rows before retrying"
    : result.mode === "dry-run" && (!result.active || counts.rows > 0) ? "apply shard migration: amem migrate --shards --apply"
    : result.mode === "resume" && !result.active ? "resume shard migration: amem migrate --shards --resume"
      : "none";
  return [
    `${s.bold("amem migrate --shards:")} ${state}${result.alreadyActive ? " (already active)" : ""}`,
    `${label(s, "ok")} generation ${result.generation.slice(0, 8)}`,
    ...countRows,
    ...groupRows("shard rows", counts.byShard),
    ...groupRows("project rows", counts.byProject),
    ...(result.deadLeasesRemoved?.length ? [`${label(s, "ok")} dead reader leases removed ${result.deadLeasesRemoved.length}`] : []),
    ...(warnings.length ? ["Refusals:", ...warnings.map(reason => `  ${label(s, "attention")} ${singleLine(reason)}`)] : []),
    `${label(s, "ok")} effect ${singleLine(result.consequence)}`,
    `Next action: ${action}`,
  ].join("\n");
}
