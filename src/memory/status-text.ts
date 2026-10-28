import { facts, label, PLAIN, type Style } from "./style.ts";

/** The `amem status` object as the CLI builds it; `amem status --json` prints it unchanged. */
export interface StatusView {
  home: { path: string; source: string };
  config: { machine: string | null; repo: string | null; denyPaths: number; piiPatterns: number } & Record<string, unknown>;
  candidates: { unavailable: string } | ({ count: number; oldestExpiresInDays: number | null; dueWithin7Days: number; unshown: number; warning?: string });
  active: boolean; generation?: string; phase?: string;
  pending: Record<string, unknown> & { rows: number };
  deadLeasesRemoved?: { lease: string; at: string }[]; refusals?: string[];
}

/** Person-facing `amem status` (#125): overall state, the effective home and policy, the counts that matter, then next actions. Zero counters are summarized, never listed. */
export function statusText(status: StatusView, s: Style = PLAIN): string {
  const actions: string[] = [], warnings: string[] = [];
  const candidates = status.candidates;
  let candidateLine: string, candidateState: "ok" | "attention" | "unavailable";
  if ("unavailable" in candidates) { candidateState = "unavailable"; candidateLine = candidates.unavailable; warnings.push(candidates.unavailable); }
  else {
    candidateState = candidates.dueWithin7Days ? "attention" : "ok";
    candidateLine = candidates.count ? `${candidates.count} pending${candidates.unshown ? ` (${candidates.unshown} never shown)` : ""}${candidates.oldestExpiresInDays !== null ? `, oldest expires in ${candidates.oldestExpiresInDays} days` : ""}` : "none pending";
    if (candidates.warning) actions.push(candidates.warning);
    else if (candidates.count) actions.push("review pending candidates: amem review walk");
  }
  const refusals = status.refusals ?? [];
  const interrupted = status.phase === "captured" && !status.active;   // authoring refuses until activation (generation-index.ts)
  const migrationState: "ok" | "attention" = refusals.length || status.pending.rows || interrupted ? "attention" : "ok";
  if (interrupted) actions.push("a shard migration stopped after capture and authoring is refused until it activates: amem migrate --shards --resume");
  if (refusals.length) warnings.push(...refusals.map(reason => `migration refusal: ${reason}`));
  if (status.pending.rows && !interrupted) actions.push(`${status.pending.rows} old-layout rows wait for the shard migration: amem migrate --shards --dry-run`);
  const overall = candidateState === "unavailable" ? "unavailable" : candidateState === "attention" || migrationState === "attention" ? "attention" : "ok";
  const { machine, repo, denyPaths, piiPatterns, ...limits } = status.config;
  const pendingCounts = facts(Object.fromEntries(Object.entries(status.pending).filter(([key]) => !key.endsWith("Ids"))));
  const lines = [
    `${s.bold("amem status:")} ${overall === "ok" ? s.ok(overall) : overall === "attention" ? s.attention(overall) : s.error(overall)}`,
    `home     ${status.home.path} ${s.dim(`(${status.home.source})`)}`,
    "",
    `${label(s, "ok")} policy: machine ${machine ?? "none (defaults)"}, repo ${repo ?? "none"}; ${denyPaths} deny paths, ${piiPatterns} PII patterns${facts(limits) ? `; ${facts(limits)}` : ""}`,
    `${label(s, candidateState)} candidates: ${candidateLine}`,
    `${label(s, migrationState)} layout: ${status.active ? `shards active${status.generation ? ` (generation ${status.generation.slice(0, 8)})` : ""}` : status.phase ? `shard migration ${status.phase}${interrupted ? ", not active" : ""}` : "single home"}; ${pendingCounts ? `pending ${pendingCounts}` : "no pending old-layout appends"}`,
    ...(status.deadLeasesRemoved?.length ? [`            ${s.dim(`${status.deadLeasesRemoved.length} dead reader leases removed`)}`] : []),
    ...(warnings.length ? ["", "Warnings:", ...warnings.map(warning => `  - ${s.attention(warning)}`)] : []),
    "", actions.length ? "Next actions:" : "Next actions: none", ...actions.map(action => `  - ${action}`),
    s.dim("Full report: amem status --json; health checks: amem doctor"),
  ];
  return lines.join("\n");
}
