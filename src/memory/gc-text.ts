import { Report } from "@staix/cli-output";
import { PLAIN, singleLine, type Style } from "./style.ts";
import type { GcResult } from "./gc.ts";

/** #592: the human gc output, kept out of gc.ts so the write path never imports the output package. */
/** The non-JSON rendering of `amem gc`. */
export function gcText(result: GcResult, render?: { columns?: number; style?: Style; next?: string }): string {
  if (render) {
    const s = render.style ?? PLAIN, out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
    out.header("amem", "Capture cleanup"); out.section(result.dryRun ? "Preview" : "Results");
    out.bullet(result.dryRun ? "pending" : "ok", result.dryRun ? "Review the cleanup before confirming." : "Cleanup completed.");
    if (result.shards.length) out.table(["PROJECT", "EXPIRED", "TRIMMED", "STATE"], result.shards.map(row => [row.key, String(row.expired), String(row.trimmed), row.remainingOverCap ? "over cap" : "within cap"]), 0);
    else out.note("No project shards.");
    for (const row of result.skipped) out.bullet("absent", `${row.key}: skipped (${row.reason})`);
    if (render.next && (result.dryRun ? result.shards.some(row => row.expired > 0 || row.remainingOverCap) : result.shards.some(row => row.remainingOverCap))) out.next(render.next);
    out.line(""); out.line(`Summary: ${result.shards.length} shards, ${result.skipped.length} skipped`);
    return out.render(s.color).join("\n");
  }
  const lines = result.shards.map(s => `${s.key}: ${result.dryRun ? `${s.expired} expired row(s) would go` : `${s.expired} expired, ${s.trimmed} trimmed`}${s.remainingOverCap ? "; still over its cap, run gc again" : ""}`);
  for (const s of result.skipped) lines.push(`${s.key}: skipped (${s.reason})`);
  return (lines.length ? lines : ["no project shards"]).join("\n");
}
