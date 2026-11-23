import { Report } from "@staix/cli-output";
import { facts, humanBytes, label, PLAIN, singleLine, type Style } from "./style.ts";
import type { CapacityReport } from "./capacity.ts";
import type { CaptureConfig } from "./capture.ts";

const MB = 1048576;

/** #592: the human capacity output, kept out of capacity.ts so the write path never imports the output package. */
interface CapacityRender { columns?: number; style?: Style; next?: string }
/** The non-JSON rendering of `amem capacity`. */
export function capacityText(report: CapacityReport, render?: CapacityRender): string {
  if (render) {
    const s = render.style ?? PLAIN, out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
    out.header("amem", "Capacity"); out.section("Capture");
    out.kv([["Rows", String(report.capture.rows)], ["Size", humanBytes(report.capture.bytes)], ["Shards", String(report.capture.shards)], ["Growth", `${report.capture.rowsPerDay.toFixed(1)} rows/day, ${humanBytes(report.capture.bytesPerDay)}/day`]]);
    out.section("Resources"); out.kv([["Disk", `${humanBytes(report.disk.freeBytes)} free of ${humanBytes(report.disk.totalBytes)}`], ["Memory", `${humanBytes(report.memory.totalBytes)} total${report.memory.pressure ? `, pressure ${report.memory.pressure}` : ""}`], ["Samples", String(report.metrics.samples)], ["Hook p95", report.metrics.hookP95Ms === null ? "?" : `${report.metrics.hookP95Ms.toFixed(1)} ms`], ["Search peak", report.metrics.searchRssMB === null ? "?" : `${report.metrics.searchRssMB.toFixed(1)} MiB`], ...(report.metrics.mcpPhasePeak ? [["MCP phase peak", `${report.metrics.mcpPhasePeak.phase}: ${report.metrics.mcpPhasePeak.rssMB.toFixed(1)} MiB (${report.metrics.mcpPhasePeak.shared ? "shared peak" : report.metrics.mcpPhasePeak.peakRaised ? "peak raised" : "not attributed"})`] as [string, string]] : [])]);
    out.section("Proposal"); out.kv([["Projected", `${humanBytes(report.projected.bytes)} in ${report.projected.days} days`], ["Current", `${report.current.capMb} MiB, ${report.current.retentionDays} days`], ["Proposed", `${report.proposal.capMb} MiB, ${report.proposal.retentionDays} days`], ["Reason", report.proposal.reason]]);
    if (report.splitRefused) out.bullet("warn", `Split unavailable: ${report.splitRefused}`);
    if (report.split.length) { out.section("Shard proposals", String(report.split.length)); out.table(["PROJECT", "CAP", "RETENTION", "REASON"], report.split.map(row => [row.key, `${row.capMb} MiB`, `${row.retentionDays} days`, row.reason]), 3); out.next("amem capacity apply --split"); }
    out.line(""); out.line(`Summary: 1 capacity proposal, ${report.split.length} shard proposals`);
    return out.render(s.color).join("\n");
  }
  const mb = (n: number): string => `${(n / MB).toFixed(1)} MB`;
  return [
    `capture: ${report.capture.rows} rows, ${mb(report.capture.bytes)} in ${report.capture.shards} shard(s), +${report.capture.rowsPerDay.toFixed(1)} rows/day, +${mb(report.capture.bytesPerDay)}/day`,
    `disk: ${mb(report.disk.freeBytes)} free of ${mb(report.disk.totalBytes)}; memory: ${mb(report.memory.totalBytes)} total${report.memory.pressure ? `, pressure ${report.memory.pressure}` : ""}`,
    `metrics: ${report.metrics.samples} samples (hook p95 ${report.metrics.hookP95Ms?.toFixed(1) ?? "?"} ms, search peak ${report.metrics.searchRssMB?.toFixed(1) ?? "?"} MB)`,
    ...(report.metrics.mcpPhasePeak ? [`MCP phase peak: ${report.metrics.mcpPhasePeak.phase} ${report.metrics.mcpPhasePeak.rssMB.toFixed(1)} MB (${report.metrics.mcpPhasePeak.shared ? "shared peak" : report.metrics.mcpPhasePeak.peakRaised ? "peak raised" : "not attributed"})`] : []),
    `projected capture in ${report.projected.days} days: ${mb(report.projected.bytes)}`,
    `current: cap ${report.current.capMb} MB, retention ${report.current.retentionDays} days`,
    `proposal: cap ${report.proposal.capMb} MB, retention ${report.proposal.retentionDays} days (${report.proposal.reason})`,
    ...(report.splitRefused ? [`split: none proposed (${report.splitRefused})`] : []),
    ...(report.split.length ? ["split of the global budget per shard (a proposal: amem capacity apply --split):", ...report.split.map(row => `  ${row.key}: cap ${row.capMb} MB, retention ${row.retentionDays} days (${row.reason})`)] : []),
  ].join("\n");
}

/** Human-readable `capacity apply` result. JSON output remains the caller's responsibility. */
export function capacityApplyText(result: {
  preview: { file: string; current: Partial<CaptureConfig>; target: CaptureConfig; reason: string };
  confirm?: string;
  written?: { cap_mb?: number; retention_days?: number };
}, s: Style = PLAIN, render?: CapacityRender): string {
  const applied = result.written !== undefined;
  if (render) {
    const out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
    out.header("amem", "Capacity apply"); out.section(applied ? "Applied" : "Preview");
    out.bullet(applied ? "ok" : "pending", applied ? "Capacity settings written." : "Capacity settings are ready for review.");
    out.kv([["File", result.preview.file], ["Current", result.preview.current.capMb === undefined && result.preview.current.retentionDays === undefined ? "defaults" : `${result.preview.current.capMb ?? "?"} MiB, ${result.preview.current.retentionDays ?? "?"} days`], ["Proposed", `${result.preview.target.capMb} MiB, ${result.preview.target.retentionDays} days`], ["Reason", result.preview.reason], ...(result.written ? [["Written", `${result.written.cap_mb ?? "?"} MiB, ${result.written.retention_days ?? "?"} days`] as [string, string]] : [])]);
    if (!applied && render.next) out.next(render.next);
    return out.render(s.color).join("\n");
  }
  return [
    `amem capacity apply: ${applied ? s.ok("complete") : s.attention("preview")}`,
    `${label(s, applied ? "ok" : "attention")} target: ${singleLine(result.preview.file)}`,
    `${label(s, "ok")} current: ${facts({ cap_mb: result.preview.current.capMb, retention_days: result.preview.current.retentionDays }) || "defaults"}`,
    `${label(s, "attention")} proposed: ${facts({ cap_mb: result.preview.target.capMb, retention_days: result.preview.target.retentionDays })}`,
    `${label(s, "ok")} reason: ${singleLine(result.preview.reason)}`,
    ...(applied ? [`${label(s, "ok")} written: ${facts(result.written!) || "no settings reported"}`] : []),
    `Next action: ${applied ? "none" : "re-run the same capacity apply command with --confirm, keeping all other arguments"}`,
  ].join("\n");
}

/** Human-readable `capacity apply --split` result, retaining skipped shard identities. */
export function capacitySplitText(result:
  | { at: number; split: { key: string; dir: string; current: Partial<CaptureConfig>; target: CaptureConfig; reason: string }[]; skipped: string[]; confirm: string }
  | { split: { key: string; dir: string; current: Partial<CaptureConfig>; target: CaptureConfig; reason: string }[]; written: { key: string; cap_mb: number; retention_days: number }[] },
  s: Style = PLAIN, render?: CapacityRender,
): string {
  const applied = "written" in result;
  if (render) {
    const out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
    out.header("amem", "Capacity split"); out.section(applied ? "Applied" : "Preview");
    out.bullet(applied ? "ok" : "pending", applied ? "Shard settings written." : "Shard settings are ready for review.");
    if (!result.split.length) out.note("No shard settings to change.");
    for (const row of result.split) {
      const written = "written" in result ? result.written.find(item => item.key === row.key) : undefined;
      out.section("Shard");
      out.kv([["Project", row.key], ["File", row.dir], ["Current", row.current.capMb === undefined && row.current.retentionDays === undefined ? "defaults" : `${row.current.capMb ?? "?"} MiB, ${row.current.retentionDays ?? "?"} days`], ["Proposed", `${row.target.capMb} MiB, ${row.target.retentionDays} days`], ["Reason", row.reason], ...(written ? [["Written", `${written.cap_mb ?? "?"} MiB, ${written.retention_days ?? "?"} days`] as [string, string]] : [])]);
    }
    if ("skipped" in result) for (const key of result.skipped) out.bullet("absent", `${key}: no local shard config to write`);
    if (!applied && result.split.length && render.next) out.next(render.next);
    return out.render(s.color).join("\n");
  }
  const rows = result.split.map(row => [
    `${label(s, applied ? "ok" : "attention")} shard: ${singleLine(row.key)}`,
    `${label(s, applied ? "ok" : "attention")} target: ${singleLine(row.dir)}`,
    `${label(s, "ok")} current: ${facts({ cap_mb: row.current.capMb, retention_days: row.current.retentionDays }) || "defaults"}`,
    `${label(s, applied ? "ok" : "attention")} proposed: ${facts({ cap_mb: row.target.capMb, retention_days: row.target.retentionDays })}`,
    `${label(s, "ok")} reason: ${singleLine(row.reason)}`,
  ].join("\n"));
  const skipped = "skipped" in result ? result.skipped : [];
  return [
    `amem capacity apply --split: ${applied ? s.ok("complete") : s.attention("preview")}`,
    ...(result.split.length ? [] : [`${label(s, "skipped")} targets: none`]),
    ...rows,
    ...skipped.map(key => `${label(s, "skipped")} skipped shard: ${singleLine(key)} (no local shard config to write)`),
    ...(applied ? result.written.map(row => `${label(s, "ok")} written ${singleLine(row.key)}: ${facts({ cap_mb: row.cap_mb, retention_days: row.retention_days })}`) : []),
    `Next action: ${applied || !result.split.length ? "none" : "re-run the same capacity apply --split command with --confirm, keeping all other arguments"}`,
  ].join("\n");
}
