import { MARKER_COLUMN, MARKERS, Report, markerCell, wrap } from "@staix/cli-output";
import { humanBytes, singleLine, wordedKey, PLAIN, type Style } from "./style.ts";

/** The `amem status` object as the CLI builds it; `amem status --json` prints it unchanged. */
export interface StatusView {
  home: { path: string; source: string };
  config: { machine: string | null; repo: string | null; denyPaths: number; piiPatterns: number } & Record<string, unknown>;
  candidates: { unavailable: string } | ({ count: number; oldestExpiresInDays: number | null; dueWithin7Days: number; unshown: number; warning?: string });
  active: boolean; generation?: string; phase?: string;
  pending: Record<string, unknown> & { rows: number };
  deadLeasesRemoved?: { lease: string; at: string }[]; refusals?: string[];
}

/** Human rendering options (#590): `--verbose` history lines, the wrap width and the version in the context line. */
export interface ReportTextOptions { verbose?: boolean; columns?: number; version?: string }

/** One `⚠` finding and the complete commands that act on it (#590 C4); a finding without a known fix has none. */
export interface Finding { text: string; next: readonly string[] }

type State = "ok" | "attention" | "unavailable";
// #590 S2: one word per state in the header, the rows and the summary line (`⚠ 2 warnings  ? 1 unknown  ✓ 8 ok`).
export const STATE_WORD: Record<State, string> = { ok: "ok", attention: "warning", unavailable: "unknown" };
const MARKER: Record<State, "ok" | "warn" | "unknown"> = { ok: "ok", attention: "warn", unavailable: "unknown" };

/** Shared report frame for status and doctor: one header line with the state, one context line, then sections. */
export function reportFrame(s: Style, name: string, state: string, opts: ReportTextOptions, home: { path: string; source: string }): Report {
  const report = new Report(opts.columns, s.ascii, { sanitize: singleLine });
  report.header("amem", name, state);
  report.note(`${opts.version ? `amem ${opts.version}, ` : ""}home ${home.path} (${home.source})`);
  return report;
}
/** `⚠` rows, each followed by its `→` commands. */
export function attention(report: Report, findings: readonly Finding[]): void {
  if (!findings.length) return;
  report.section("Attention", String(findings.length));
  for (const finding of findings) { report.bullet("warn", finding.text); for (const command of finding.next) report.next(command); }
}
/** A state row: marker, padded state word, padded name, then the fact; a wrapped fact continues under itself (#590 S1, S2). */
export function stateRows(report: Report, rows: readonly { state: State | "skipped"; name: string; fact: string }[], s: Style): void {
  const words = rows.map(row => row.state === "skipped" ? "skipped" : STATE_WORD[row.state]);
  const wordWidth = Math.max(...words.map(word => word.length)), nameWidth = Math.max(...rows.map(row => row.name.length + 1));
  const lead = 2 + MARKER_COLUMN + 1 + wordWidth + 2 + nameWidth + 2;
  rows.forEach((row, index) => {
    const marker = row.state === "skipped" ? "absent" : MARKER[row.state];
    const lines = wrap(singleLine(row.fact), report.columns === undefined ? undefined : Math.max(10, report.columns - lead), 0);
    report.append([[{ text: "  " }, { text: markerCell(marker, s.ascii), role: MARKERS[marker].role }, { text: " " },
      { text: words[index]!.padEnd(wordWidth), role: MARKERS[marker].role }, { text: "  " }, { text: `${row.name}:`.padEnd(nameWidth), role: "key" }, { text: "  " }, { text: lines[0] ?? "" }],
      ...lines.slice(1).map(line => [{ text: " ".repeat(lead) + line }])]);
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Person-facing `amem status` (#125, #590): overall state, findings with their commands, then the memory facts. */
export function statusText(status: StatusView, s: Style = PLAIN, opts: ReportTextOptions = {}): string {
  const findings: Finding[] = [];
  const candidates = status.candidates;
  let candidateFact: string, candidateState: State;
  if ("unavailable" in candidates) { candidateState = "unavailable"; candidateFact = candidates.unavailable; }
  else {
    candidateState = candidates.dueWithin7Days ? "attention" : "ok";
    candidateFact = candidates.count ? `${candidates.count} pending${candidates.unshown ? `, ${candidates.unshown} never shown` : ""}${candidates.oldestExpiresInDays !== null ? `, oldest expires in ${candidates.oldestExpiresInDays} d` : ""}` : "none pending";
    if (candidates.dueWithin7Days) findings.push({ text: `${plural(candidates.dueWithin7Days, "candidate")} expire within 7 days`, next: ["amem review walk"] });
  }
  const refusals = status.refusals ?? [];
  const interrupted = status.phase === "captured" && !status.active;   // authoring refuses until activation (generation-index.ts)
  const migrationState: State = refusals.length || status.pending.rows || interrupted ? "attention" : "ok";
  if (interrupted) findings.push({ text: "a shard migration stopped after capture; authoring is refused until it activates", next: ["amem migrate --shards --resume"] });
  for (const reason of refusals) findings.push({ text: `migration refusal: ${reason}`, next: [] });
  if (status.pending.rows && !interrupted) findings.push({ text: `${plural(status.pending.rows, "old-layout row")} wait for the shard migration`, next: ["amem migrate --shards --dry-run", "amem migrate --shards --resume"] });
  const overall: State = candidateState === "unavailable" ? "unavailable" : candidateState === "attention" || migrationState === "attention" ? "attention" : "ok";
  const { machine, repo, denyPaths, piiPatterns, ...limits } = status.config;
  const limitFacts = Object.entries(limits).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => typeof value === "number" && key.endsWith("Bytes") ? `${wordedKey(key)} ${humanBytes(value)}`
      : typeof value === "object" ? `${wordedKey(key)} ${Array.isArray(value) ? value.length : Object.keys(value as object).length} set` : `${wordedKey(key)} ${String(value)}`);
  const pendingFacts = Object.entries(status.pending).filter(([key, value]) => !key.endsWith("Ids") && value !== 0 && value !== undefined && value !== null)
    .map(([key, value]) => typeof value === "object" ? plural(Object.keys(value as object).length, wordedKey(key).replace(/^by /, "")) : key.endsWith("Bytes") && typeof value === "number" ? `${wordedKey(key)} ${humanBytes(value)}` : `${wordedKey(key)} ${String(value)}`)
    .filter(fact => !/^0 /.test(fact));
  const layout = status.active ? `shards active${status.generation ? `, generation ${status.generation.slice(0, 8)}` : ""}` : status.phase ? `shard migration ${status.phase}${interrupted ? ", not active" : ""}` : "single home";

  const report = reportFrame(s, "status", STATE_WORD[overall], opts, status.home);
  attention(report, findings);
  report.section("Memory");
  stateRows(report, [
    { state: "ok", name: "policy", fact: `machine ${machine ?? "none (defaults)"}, repo ${repo ?? "none"}, ${plural(denyPaths, "deny path")}, ${plural(piiPatterns, "PII pattern")}${limitFacts.length ? `, ${limitFacts.join(", ")}` : ""}` },
    { state: candidateState, name: "candidates", fact: candidateFact },
    { state: migrationState, name: "layout", fact: `${layout}; ${pendingFacts.length ? `pending ${pendingFacts.join(", ")}` : "no pending old-layout appends"}` },
  ], s);
  if (opts.verbose && status.deadLeasesRemoved?.length) report.note(`${status.deadLeasesRemoved.length} dead reader leases removed during the last migration`);
  return report.render(s.color).join("\n");
}
