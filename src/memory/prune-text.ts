import { label, PLAIN, singleLine, type Style } from "./style.ts";
import type { PrunePlan } from "./prune.ts";

/** #592: the human prune report, kept out of prune.ts so the write path never imports the output package. */
/** Human-readable preview or apply result. A preview is descriptive output, not a serialized sealed plan. */
export function pruneText(result: PrunePlan | { completed: string[] }, s: Style = PLAIN): string {
  if ("completed" in result) {
    return [
      `amem prune: ${s.ok("complete")}`,
      `${label(s, result.completed.length ? "ok" : "skipped")} completed prune rows: ${result.completed.length}`,
      ...result.completed.map(id => `  ${label(s, "ok")} ${id}`),
      "Next action: none",
    ].join("\n");
  }
  const targetIds = result.rows.flatMap(row => row.payload.targets.map(target => target.id));
  const next = targetIds.length
    ? "save this preview with --json, then amem prune --apply --plan <file>; keep --user if used in the preview"
    : "none; the sealed plan contains no prune rows";
  return [
    `amem prune: ${s.attention("preview")}`,
    `${label(s, "ok")} project: ${singleLine(result.project)}`,
    ...(result.rows.length ? [`${label(s, "ok")} cutoff: ${result.rows[0]!.payload.cutoff}`] : []),
    `${label(s, targetIds.length ? "attention" : "skipped")} selection: eligible ${result.counts.eligible}, selected ${result.counts.selected}, local ${result.counts.local}, synced ${result.counts.synced}`,
    ...(result.hasMore ? ["more eligible entries remain beyond this plan"] : []),
    ...result.rows.flatMap(row => row.payload.targets.map(target => `  ${label(s, "attention")} ${row.placement}: ${target.id} (expired ${target.expiredAt})`)),
    `Next action: ${next}`,
    ...(targetIds.length ? ["The readable preview is not a sealed JSON plan."] : []),
  ].join("\n");
}
