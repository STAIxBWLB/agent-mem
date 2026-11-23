import { Report } from "@staix/cli-output";
import type { CatalogProject } from "./catalog.ts";
import type { DecayPlan } from "./decay-review.ts";
import type { MigrationResult } from "./migrate.ts";
import type { PrunePlan } from "./prune.ts";
import type { ShardMigrationResult } from "./shard-migration.ts";
import type { View } from "./store.ts";
import type { SyncResult } from "./sync.ts";
import { renderSyncProgress, type SyncStatusReport } from "./sync-progress.ts";
import type { UsageReport } from "./usage.ts";
import { humanBytes, PLAIN, relativeTime, singleLine, wordedKey, type Style } from "./style.ts";

/**
 * CLI-only #590 renderers for the report families outside status, doctor, setup and the memory reads (task 429).
 * Never re-exported from `src/index.ts`: the exported renderers they replace on the CLI (migrationText, pruneText, usageText,
 * vaultCandidatesText, renderSyncStatus, ...) stay byte-identical for hosts. Every `→` line is a complete amem command.
 */
export interface RenderOptions { columns?: number; now?: number }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const frame = (s: Style, name: string, state: string, opts: RenderOptions): Report =>
  new Report(opts.columns ?? 80, s.ascii, { sanitize: singleLine }).header("amem", name, state);
const done = (report: Report, s: Style) => report.render(s.color).join("\n");
const shortId = (id: string) => id.slice(0, 8);

/** `amem migrate` (generation profile). */
export function migrateReportText(result: MigrationResult, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const active = result.profile.kind === "generation", needsResume = result.mode === "resume" && !active;
  const state = needsResume ? "needs resume" : result.mode === "dry-run" ? "preview, nothing written" : result.alreadyActive ? "already active" : "done";
  const report = frame(s, "Migration", state, opts);
  report.section("Profile").kv([["Kind", result.profile.kind], ["Generation", result.profile.generation ? shortId(result.profile.generation) : ""],
    ["Home", result.profile.home], ["Directory", result.profile.dir]], 2, { omitEmpty: true });
  if (result.counts) {
    const c = result.counts, groups = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(", ");
    report.section("Rows").kv([["Valid", c.validRows], ["Skipped", c.skippedRows], ["Expired", c.expiredRows], ["Eligible", c.eligibleRows],
      ["Tail bytes", c.tailBytes ? humanBytes(c.tailBytes) : ""], ["Operations", groups(c.byOp)], ["Tiers", groups(c.byTier)]], 2, { omitEmpty: true });
  }
  report.section("Effect").note(result.consequence, "value");
  const next = result.mode === "dry-run" && !active ? "amem migrate --apply" : needsResume ? "amem migrate --resume" : result.mode === "deactivate" && active ? "amem migrate --deactivate" : undefined;
  if (next) { report.section("Next"); report.next(next); }
  return done(report, s);
}

/** `amem migrate --shards`. */
export function shardMigrateReportText(result: ShardMigrationResult, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const c = result.counts, refusals = result.refusals ?? [];
  const flagged = refusals.length > 0 || c.refusedRows > 0 || c.danglingRows > 0;
  const state = flagged ? "needs attention" : result.mode === "dry-run" ? "preview, nothing written" : result.active ? result.alreadyActive ? "already active" : "done" : "needs resume";
  const report = frame(s, "Shard migration", state, opts);
  report.note(`generation ${shortId(result.generation)}`);
  const findings: { text: string; next?: string }[] = [
    ...refusals.map(reason => ({ text: reason })),
    ...(c.refusedRows ? [{ text: `${plural(c.refusedRows, "row")} refused` }] : []),
    ...(c.danglingRows ? [{ text: `${plural(c.danglingRows, "dangling row")}` }] : []),
    ...(c.sharedSupersededByPrivate ? [{ text: `${plural(c.sharedSupersededByPrivate, "shared row")} superseded by a private one` }] : []),
    ...(c.crossPrivateReplacement ? [{ text: `${plural(c.crossPrivateReplacement, "cross-project private replacement")}` }] : []),
  ];
  if (findings.length) { report.section("Attention", String(findings.length)); for (const f of findings) report.bullet("warn", f.text); }
  report.section("Rows").kv(([["Rows", c.rows], ["Skipped", c.skippedRows], ["User", c.userRows], ["Legacy", c.legacyRows], ["Legacy local", c.legacyLocalRows],
    ["Legacy main", c.legacyMainRows], ["Generation", c.generationRows], ["Generation local", c.generationLocalRows], ["Prune", c.pruneRows],
    ["Translated prune", c.translatedPruneRows], ["Tail bytes", c.tailBytes ? humanBytes(c.tailBytes) : ""],
    ["Shards", Object.keys(c.byShard).length], ["Projects", Object.keys(c.byProject).length],
    ["Dead leases removed", result.deadLeasesRemoved?.length ?? 0]] as [string, string | number][]).filter(([, v]) => v !== 0), 2, { omitEmpty: true });
  report.section("Effect").note(result.consequence, "value");
  const next = flagged ? undefined : result.mode === "dry-run" && (!result.active || c.rows > 0) ? "amem migrate --shards --apply"
    : result.mode === "resume" && !result.active ? "amem migrate --shards --resume" : undefined;
  if (next) { report.section("Next"); report.next(next); }
  return done(report, s);
}

/** `amem prune`: the readable preview (never the sealed plan) or the applied rows. */
export function pruneReportText(result: PrunePlan | { completed: string[] }, s: Style = PLAIN, opts: RenderOptions = {}): string {
  if ("completed" in result) {
    const report = frame(s, "Prune", result.completed.length ? "done" : "nothing to apply", opts);
    if (result.completed.length) { report.section("Completed", String(result.completed.length)); for (const id of result.completed) report.bullet("ok", id); }
    return done(report, s);
  }
  const targets = result.rows.flatMap(row => row.payload.targets.map(target => ({ placement: row.placement, ...target })));
  const report = frame(s, "Prune", targets.length ? "preview, nothing written" : "nothing eligible", opts);
  const now = opts.now ?? Date.now();
  report.note(`project ${result.project}${result.rows.length ? `, cutoff ${relativeTime(result.rows[0]!.payload.cutoff, now)}` : ""}`);
  report.section("Selection").kv([["Eligible", result.counts.eligible], ["Selected", result.counts.selected], ["Local", result.counts.local], ["Synced", result.counts.synced]]);
  if (result.hasMore) report.note("More eligible entries remain beyond this plan.");
  if (targets.length) {
    report.section("Targets", String(targets.length));
    report.table(["Placement", "Entry", "Expired"], targets.map(t => [t.placement, t.id, relativeTime(t.expiredAt, now)]), 1);
    report.section("Next");
    report.note("This preview is not the sealed plan. Save the plan with --json, then apply it (keep --user if you used it):");
    report.next("amem prune --apply --plan <file>");
  }
  return done(report, s);
}

/** `amem decay`: preview, nothing eligible, or the applied revision. */
export function decayReportText(input: { kind: "preview"; plan: DecayPlan; action: "demote" | "FORGET" } | { kind: "empty" } | { kind: "applied"; action: string; ids: readonly string[]; expiresAt?: string },
  s: Style = PLAIN, opts: RenderOptions = {}): string {
  if (input.kind === "empty") return done(frame(s, "Decay", "nothing eligible to apply", opts), s);
  if (input.kind === "applied") {
    const report = frame(s, "Decay", `${input.action === "forget" ? "forgotten" : "demoted"} ${plural(input.ids.length, "note")}`, opts);
    if (input.expiresAt) report.section("Details").kv([["Expires", relativeTime(input.expiresAt, opts.now ?? Date.now())]]);
    return done(report, s);
  }
  const { plan, action } = input, verb = action === "FORGET" ? "forget" : "demote";
  const report = frame(s, "Decay", `preview, nothing written`, opts);
  report.note(`${plural(plan.entries.length, "note")} older than ${plural(plan.days, "day")} would ${verb === "forget" ? "be forgotten" : "be demoted"}`);
  report.section("Selection").kv([["Notes", plan.entries.length], ["Withheld", plan.withheld], ["Cited, kept", plan.citedExemptions ?? "unknown"],
    ["Citation history", "unknown"], ...(plan.truncated ? [["Truncated", "yes"] as const] : [])]);
  if (plan.entries.length) {
    report.section("Notes", String(plan.entries.length));
    report.table(["ID", "Revision", "Kind", "Title"], plan.entries.map(e => [shortId(e.target.id), String(e.target.revision), e.view.kind, singleLine(e.view.title ?? e.view.text)]), 3);
    report.section("Next");
    report.next(`amem decay --days ${plan.days} --apply --confirm${action === "FORGET" ? " --forget" : ""}`);
  }
  return done(report, s);
}

interface ReplayPlan { records: { cwd: string; project: string | null; class: string }[]; counts: Record<string, number>; digest: string; needsConfirmation: { cwd: string; project: string; count: number }[] }
/** `amem spool replay` preview: counts and cwd mappings only, never a record body. */
export function spoolReplayReportText(plan: ReplayPlan, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const report = frame(s, "Spool replay", "preview, nothing written", opts);
  report.note(`plan ${plan.digest.slice(0, 12)}; no record bodies shown`);
  const counts = Object.entries(plan.counts).filter(([, n]) => n > 0);
  if (counts.length) report.section("Records").kv(counts.map(([cls, n]) => [wordedKey(cls).replace(/^./, c => c.toUpperCase()), n]));
  const byCwd = new Map<string, { project: string | null; classes: Map<string, number> }>();
  for (const record of plan.records) {
    const row = byCwd.get(record.cwd) ?? { project: record.project, classes: new Map() };
    row.classes.set(record.class, (row.classes.get(record.class) ?? 0) + 1); byCwd.set(record.cwd, row);
  }
  if (byCwd.size) {
    report.section("Mappings", String(byCwd.size));
    report.table(["Directory", "Project", "Records"], [...byCwd].map(([cwd, row]) => [cwd || "(unreadable record)", row.project ?? "(unresolved)", [...row.classes].map(([c, n]) => `${c} ${n}`).join(", ")]), 0);
  }
  if (plan.needsConfirmation.length) {
    report.section("Attention", String(plan.needsConfirmation.length));
    for (const group of plan.needsConfirmation) report.bullet("warn", `${group.cwd} -> ${group.project}: ${plural(group.count, "record")}; this boot cannot prove the original identity`);
  }
  report.section("Next");
  report.note("Save the preview first: amem spool replay --json > plan.json");
  report.next("amem spool replay --apply --plan plan.json");
  if (plan.needsConfirmation.length) report.next("amem spool replay --apply --plan plan.json --confirm-unverifiable");
  return done(report, s);
}

/** `amem sync` success. A failure stays the thrown refusal text. */
export function syncReportText(r: SyncResult, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const report = frame(s, "Sync", r.pushed ? "synced and pushed" : "synced", opts);
  const rows: [string, unknown][] = [[r.pruneApplication ? "Transported" : "Visible here", plural(r.entries, "long-term entry").replace("entrys", "entries")]];
  const p = r.placementPublication;
  if (p) rows.push(["Placement", `${p.outcome}, ${p.exported} exported, ${p.withheld} withheld`]);
  if (r.checkpoint) rows.push(["Checkpoint", `window ${r.checkpoint.window}, objects ${r.checkpoint.objectsBefore} -> ${r.checkpoint.objectsAfter}`]);
  const a = r.pruneApplication;
  if (a) rows.push(["Prune proofs", `${a.proofComplete} complete, ${a.projectionActive ?? "pending"} foreign projections active, ${a.nativeApplied ?? "pending"} native applied, ${a.held} held`]);
  report.section("Result").kv(rows);
  if (r.placementRealms?.length) {
    report.section("Realms", String(r.placementRealms.length));
    report.table(["Realm", "Outcome", "Publication"], r.placementRealms.map(item => [item.realm === "user" ? "user" : item.realm.slice(0, 16), item.outcome, item.publication === undefined ? "" : String(item.publication)]), 1, { emptyCell: "blank" });
  }
  if (r.warning) { report.section("Attention", "1"); report.bullet("warn", r.warning); }
  return done(report, s);
}

/** `amem sync --status`. */
export function syncStatusReportText(status: SyncStatusReport, now: number, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const interrupted = status.operations.filter(op => op.state === "interrupted").length;
  const report = frame(s, "Sync status", status.operations.length ? `${plural(status.operations.length, "operation")}${interrupted ? `, ${interrupted} interrupted` : ""}` : "no operation recorded", opts);
  if (status.operations.length) {
    report.section("Operations", String(status.operations.length));
    for (const op of status.operations) {
      // An interrupted operation renders as the running snapshot it was; the owner is gone, so it is never a success.
      const line = renderSyncProgress(op.state === "interrupted" ? { ...op, state: "running" } : op, now).replace(/^amem sync: /, "");
      const marker = op.state === "interrupted" ? "warn" : op.state === "running" ? "pending" : op.state === "succeeded" ? "ok" : op.state === "cancelled" ? "absent" : "fail";
      report.bullet(marker, `${op.operationId}: ${op.state === "interrupted" ? `interrupted in ${line.replace(/; last work progress .*$/, "")}; owner gone ${Math.round(op.lastAliveAgoMs / 1000)}s ago; not a successful sync`
        : op.state === "running" ? `${line}; last alive ${Math.round(op.lastAliveAgoMs / 1000)}s ago` : line}`);
    }
  }
  if (status.malformed) report.note(`${plural(status.malformed, "unreadable status file")} ignored`);
  return done(report, s);
}

/** `amem projects`. */
export function projectsReportText(rows: readonly CatalogProject[], split: boolean, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const report = frame(s, "Projects", rows.length ? plural(rows.length, "project shard") : "none", opts);
  if (!rows.length) return done(report, s);
  if (!split) report.note("Curated counts are per project only after amem migrate --shards.");
  report.section("Shards", String(rows.length));
  report.table(["Key", "State", "Capture", "Curated", "Disk", "Last"], rows.map(p => [
    `${p.key}${p.local ? " (local)" : ""}${p.aliases.length ? ` +${p.aliases.length}` : ""}`, p.state, `${p.captureRows} rows`,
    split ? p.curatedEntries === null ? "?" : String(p.curatedEntries) : "-", humanBytes(p.diskBytes), relativeTime(p.captureLastAt, opts.now ?? Date.now())]), 0);
  const aliased = rows.filter(p => p.aliases.length);
  if (aliased.length) { report.section("Aliases"); report.kv(aliased.map(p => [p.key, p.aliases.join(", ")])); }
  return done(report, s);
}

/** `amem usage`. */
export function usageReportText(report_: UsageReport, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const t = report_.totals, report = frame(s, "Usage", plural(t.shards, "project shard"), opts);
  report.section("Totals").kv([["Capture", `${t.captureRows} rows, ${humanBytes(t.captureBytes)}`],
    ["Curated", t.curatedEntries === null ? report_.curatedSplit ? "unavailable" : "unavailable until amem migrate --shards" : `${t.curatedEntries} entries`],
    ["Disk", humanBytes(t.diskBytes)]]);
  if (report_.largest.length) {
    report.section("Largest", String(report_.largest.length));
    report.table(["Key", "Disk", "Capture"], report_.largest.map(p => [`${p.key}${p.state === "active" ? "" : ` (${p.state})`}`, humanBytes(p.diskBytes), `${p.captureRows} rows`]), 0);
  }
  return done(report, s);
}

/** `amem repo status`. */
export function repoStatusReportText(status: { root: string; file: string; state: string; entries: number; reason?: string; skipped: null | { malformed: number; mismatched: number; duplicate: number; withheld: number } },
  project: string, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const report = frame(s, "Repository log", status.state === "unavailable" ? "unavailable" : plural(status.entries, "entry").replace("entrys", "entries"), opts);
  report.note(`project ${project}`);
  const k = status.skipped;
  report.section("Log").kv([["File", status.file], ["State", status.state], ["Entries", status.entries],
    ["Skipped", k ? [k.malformed && `${k.malformed} malformed`, k.mismatched && `${k.mismatched} id mismatch`, k.duplicate && `${k.duplicate} duplicate`, k.withheld && `${k.withheld} withheld by the screen`].filter(Boolean).join(", ") : ""]], 2, { omitEmpty: true });
  if (status.reason) { report.section("Attention", "1"); report.bullet("warn", status.reason); }
  return done(report, s);
}

/** `amem vault-candidates` (one project or across projects); never a note body. */
export function vaultReportText(groups: readonly { project: string; candidates: readonly View[] }[], crossed: boolean, s: Style = PLAIN, opts: RenderOptions = {}): string {
  const count = groups.reduce((sum, g) => sum + g.candidates.length, 0);
  const report = frame(s, "Vault candidates", `${count ? plural(count, "candidate") : "none"}${crossed ? ", across projects" : ""}`, opts);
  if (!count) return done(report, s);
  report.section("Candidates", String(count));
  report.table([...(crossed ? ["Project"] : []), "ID", "Kind", "Title"], groups.flatMap(g => g.candidates.map(row =>
    [...(crossed ? [g.project] : []), shortId(row.id), row.kind, singleLine(row.title ?? "(untitled)")])), crossed ? 3 : 2);
  report.section("Next");
  report.note(crossed ? "Open the candidate's source repository, then review it before recording it in your vault:" : "Review a candidate before recording it in your vault:");
  report.next("amem show <id>");
  return done(report, s);
}
