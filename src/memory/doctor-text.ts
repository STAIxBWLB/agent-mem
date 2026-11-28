import { CLIS, type DoctorReport, type Section, type SectionStatus } from "./doctor.ts";
import { humanBytes, relativeTime, singleLine, wordedFacts, wordedKey, PLAIN, type Style } from "./style.ts";
import { validPlacementWriterRefusal } from "./sync-placement-refusal-category.ts";
import { writerRefusalText } from "./sync-progress-text.ts";
import { attention, reportFrame, stateRows, STATE_WORD, type Finding, type ReportTextOptions } from "./status-text.ts";

/** #592: the human doctor report, kept out of doctor.ts so the doctor's checks never import the output package. */
/** Section order and one-line names for the person-facing report (#125). */
const SECTION_TITLE: Record<keyof DoctorReport["sections"], string> = {
  duplicates: "duplicate notes", stale: "stale path references", candidates: "review candidates", capture: "capture per CLI", brief: "session brief",
  index: "index equals rebuild", readers: "reader leases", policy: "policy in effect", cadence: "ingest and sync cadence", drops: "recent capture drops",
  writers: "placement writers",
  spool: "pending hook spool",
  setup: "native setup registrations",
  masked: "forgotten or pruned entries (informational)",
  transition: "project key transition",
};

/**
 * #590 C4: every hint a section emits, as one finding and the complete commands that act on it. `--json` keeps the hint text unchanged;
 * only the human report reads this table. A hint missing from it renders as a finding with no `→`, never as text with an embedded command.
 * `test/status-doctor-layout.test.ts` checks every hint producer against this table.
 */
export const DOCTOR_HINTS: Readonly<Record<string, (section: Record<string, unknown>) => Finding>> = {
  "amem dedupe previews the imported duplicates; amem dedupe --apply reconciles them": () =>
    ({ text: "imported duplicate notes can be reconciled", next: ["amem dedupe", "amem dedupe --apply"] }),
  "The person can inspect these examples with amem show <id> from their own shell.": section => {
    const first = Array.isArray(section.examples) ? String(section.examples[0] ?? "") : "";
    // #511 AC3: an agent-marked `show` may withhold these ids, so the finding says where they open.
    return { text: `${section.missingReferences} notes reference paths that no longer exist; open the examples from your own shell`, next: first ? [`amem show ${first}`] : [] };
  },
  "the index differs from a rebuild of the logs: run amem rebuild": () => ({ text: "the index differs from a rebuild of the logs", next: ["amem rebuild"] }),
  "a section is partial or unavailable in the brief: see coverage": () => ({ text: "a brief section is partial or unavailable", next: [] }),
  "the brief uses over 90% of its budget": () => ({ text: "the session brief uses over 90% of its budget", next: [] }),
  "a reader lease of a process that is gone is cleared by the next reader; an unreadable one needs a look": () =>
    ({ text: "a reader lease is stale or unreadable; the next reader clears a stale one", next: [] }),
  "capture rows were dropped recently (see counts by reason); amem doctor --json keeps the numbers": () =>
    ({ text: "capture rows were dropped recently", next: ["amem doctor --json"] }),
  "pending hook spool needs attention: capture can be dropped when both tiers fill; supported orphan recovery is pending": () =>
    ({ text: "the hook spool is nearly full; capture is dropped when both tiers fill", next: [] }),
  "sync has failed repeatedly; amem sync --force shows why": () => ({ text: "sync has failed 3 or more times in a row", next: ["amem sync --force"] }),
  "no recent successful sync: run amem sync": () => ({ text: "no recent successful sync", next: ["amem sync"] }),
  "run amem review walk": section => ({ text: `${section.dueWithin7Days} candidates expire within 7 days`, next: ["amem review walk"] }),
};
/** Capture hints name a CLI; each maps to a finding and the commands for that CLI. */
export function captureFinding(cli: string, hint: string): Finding {
  const known = new Set<string>(CLIS);
  const ingest = known.has(cli) && cli !== "claude" ? [`amem ingest ${cli}`] : [];
  if (hint.startsWith(`the ${cli} `) && hint.includes("unsafe symlink")) return { text: `${cli}: a native session root is an unsafe symlink and was skipped`, next: ingest };
  if (hint.startsWith("run amem setup")) return { text: `${cli}: capture is not set up`, next: known.has(cli) ? [`amem setup ${cli} --apply`, ...ingest] : [] };
  if (hint.includes("/hooks trust review")) return { text: "codex: the hook is registered but has never captured; approve it in the Codex /hooks trust review", next: [] };
  const state = /capture is (\w+)/.exec(hint)?.[1] ?? "not fresh", where = hint.includes("on this machine") ? "on this machine" : "in this project";
  return { text: `${cli}: capture is ${state} ${where}; open a session`, next: ingest };
}
export function hintFinding(name: string, hint: string, section: Record<string, unknown>): Finding {
  const mapped = DOCTOR_HINTS[hint];
  return mapped ? mapped(section) : { text: `${SECTION_TITLE[name as keyof typeof SECTION_TITLE] ?? name}: ${hint.replace(/[:;,]?\s*(?:run |see |use )?\bamem [a-z].*$/, "").replace(/[:;,]\s*$/, "").trim() || "needs a look"}`, next: [] };
}
/** #590 C6: a writer refusal is one finding; each command it names is one `→` line. The fixed refusal text stays in `--json`. */
export function writerFinding(section: Record<string, unknown>): Finding {
  const reason = String(section.reason ?? "");
  // #624: the checkpoint renewal comes first. Its saving preview is a subshell, so the finding names the bare checkpoint command; the reason keeps the saving form.
  const commands = reason.includes("amem setup agy --list") ? ["amem setup agy --refresh", "amem setup agy --list"] : [...reason.matchAll(/amem (?:migrate --sync-placement --(?:checkpoint|dry-run|resume|abandon)|formats raise home [0-9.]+|setup [a-z]+ --(?:apply|undo))/g)].map(match => match[0]);
  // #639: a renewal needs the complete root list, so the read-only listing that prints it comes first. A stale agy receipt
  // (#636) is fixed first, so its single command stays alone.
  if (commands.includes("amem migrate --sync-placement --checkpoint")) commands.unshift("amem migrate --sync-placement --writers");
  return { text: `placement writer proof is ${section.cause ?? "unverified"} (${section.category ?? "unknown"} category)`, next: [...new Set(commands)] };
}

function sectionFact(name: string, detail: Record<string, unknown>, now: number): string[] {
  if (name === "capture" && detail.clis && typeof detail.clis === "object") {
    return Object.entries(detail.clis as Record<string, Record<string, unknown>>).map(([cli, row]) =>
      `${cli} hook ${row.hook}${row.setup ? ` (${row.setup})` : ""}, capture ${row.capture}${row.lastCaptureAt ? ` ${relativeTime(String(row.lastCaptureAt), now)}` : ""}, ${row.rows} rows; machine-wide ${row.machineCapture ?? "unknown"}${row.machineLastCaptureAt ? ` ${relativeTime(String(row.machineLastCaptureAt), now)}` : ""}${row.note ? `, ${row.note}` : ""}`);
  }
  if (name === "cadence") {
    const sync = (detail.sync ?? {}) as Record<string, unknown>, ingest = (detail.ingest ?? {}) as Record<string, string>;
    return [`ingest ${Object.entries(ingest).map(([cli, how]) => `${cli} ${how}`).join(", ")}`,
      `sync remote ${sync.remote}${sync.remote === "configured" ? `, last ok ${relativeTime(sync.lastOkAt as string | null, now)}, ${sync.failures} failures${sync.due ? ", due" : ""}` : ""}`,
      ...(validPlacementWriterRefusal(sync.writerRefusal) ? [`last failure: ${writerRefusalText(sync.writerRefusal)}`] : [])];
  }
  if (name === "drops") {
    if (detail.counts === undefined) return [];
    const counts = Object.entries((detail.counts ?? {}) as Record<string, number>);
    return [`${counts.length ? counts.map(([reason, n]) => `${reason.replaceAll("_", " ")} ${n}`).join(", ") : "none"} in the recent metrics tail${detail.malformedLines ? `, ${detail.malformedLines} malformed lines skipped` : ""}`];
  }
  if (name === "spool") {
    if (!detail.active || !detail.reserve) return [];
    const tiers = ["active", "reserve"].map(tierName => {
      const tier = detail[tierName] as { files: number; bytes: number; maxFiles: number; maxBytes: number };
      return `${tierName} ${tier.files} of ${tier.maxFiles} files, ${humanBytes(tier.bytes)} of ${humanBytes(tier.maxBytes)}`;
    });
    const kinds = detail.kinds as { native: number; summaries: number; unclassified: number; complete: boolean };
    return [`${String(detail.fill).replaceAll("_", " ")}; ${tiers.join("; ")}; ${detail.claimed} claimed${detail.oldestAt ? `, oldest ${relativeTime(String(detail.oldestAt), now)}` : ""}${detail.complete ? "" : " (counts are lower bounds)"}`,
      `native ${kinds.native}, summaries ${kinds.summaries}, unclassified ${kinds.unclassified}; classification ${detail.classificationCoverage}${kinds.complete ? "" : " (native and summary counts are lower bounds)"}`];
  }
  if (name === "setup" && Array.isArray(detail.entries)) {
    const entries = detail.entries as { target?: unknown; file?: unknown; entry?: unknown; reason?: unknown; expectedFile?: unknown; phase?: unknown }[];
    if (!entries.length) return [`${detail.checked ?? 0} registrations match their receipts`];
    return entries.map(item => singleLine(`${item.target}${item.phase ? ` (${item.phase})` : ""} ${item.file}${item.expectedFile ? `, expected ${item.expectedFile}` : ""} ${item.entry}: ${item.reason}`));
  }
  if (name === "writers") return typeof detail.writers === "number" ? [`${detail.writers} writers match the active inventory`] : [];
  if (name === "brief" && typeof detail.tokens === "number") {
    const missing = Object.entries((detail.coverage ?? {}) as Record<string, unknown>).filter(([, value]) => value && value !== "complete").map(([key, value]) => `${wordedKey(key)} ${value}`);
    return [`${detail.tokens} of ${detail.budget} tokens${missing.length ? `, coverage: ${missing.join(", ")}` : ""}`];
  }
  if (name === "policy") return [`machine ${detail.machine ?? "none (defaults)"}, repo ${detail.repo ?? "none"}, ${detail.denyPaths} deny paths, ${detail.piiPatterns} PII patterns`];
  if (name === "index") return detail.liveIndex ? [`live index ${detail.liveIndex}, equal to a rebuild`] : [];
  if (name === "readers") return [`${detail.live ?? 0} live, ${detail.stale ?? 0} stale, ${detail.unreadable ?? 0} unreadable`];
  if (name === "duplicates" && typeof detail.notes === "number") return [`${detail.notes} notes, ${detail.identicalGroups ?? 0} identical groups, ${detail.importedGroups ?? 0} imported groups${detail.truncated ? `, ${detail.truncated}` : ""}`,
    ...(Array.isArray(detail.examples) && detail.examples.length ? [`examples ${(detail.examples as unknown[]).map(item => Array.isArray(item) ? item.join(" = ") : String(item)).join(", ")}`] : [])];
  if (name === "stale" && typeof detail.checked === "number") return [`${detail.checked} checked, ${detail.missingReferences ?? 0} missing`,
    ...(Array.isArray(detail.examples) && detail.examples.length ? [`examples ${(detail.examples as unknown[]).join(", ")}`] : [])];
  if (name === "transition") return [`was ${detail.previousKey}${typeof detail.previousCuratedNotes === "number" ? ` (${detail.previousCuratedNotes} curated notes)` : ""}, now ${detail.key}; see Attention`];
  if (name === "masked") return [`${detail.forgets ?? 0} forgotten, ${detail.prunes ?? 0} pruned; see docs/purge.md`];
  if (name === "candidates") return [`${detail.count ?? 0} pending${detail.unshown ? `, ${detail.unshown} never shown` : ""}${detail.oldestExpiresInDays !== null && detail.oldestExpiresInDays !== undefined ? `, oldest expires in ${detail.oldestExpiresInDays} d` : ""}`];
  const { examples, note: _note, ...rest } = detail;
  const line = wordedFacts(rest);
  return [...(line ? [line] : []), ...(Array.isArray(examples) && examples.length ? [`examples ${examples.map(item => Array.isArray(item) ? item.join(" = ") : String(item)).join(", ")}`] : [])];
}

/** The person-facing report (#125, #590): state, findings with their commands, one row per check, then the summary. `amem doctor --json` keeps the full report. */
export function doctorText(report: DoctorReport, s: Style = PLAIN, opts: ReportTextOptions & { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const entries = Object.entries(report.sections) as [keyof DoctorReport["sections"], Section & { hint?: string; reason?: string }][];
  const count = (status: SectionStatus) => entries.filter(([, section]) => section.status === status).length;
  const findings: Finding[] = [];
  for (const [name, item] of entries) {
    if (name === "writers" && item.status === "attention") findings.push(writerFinding(item));
    // #659: a stale acon plugin manifest is refreshed by its own setup command.
    if (name === "setup" && Array.isArray(item.entries) && (item.entries as { target?: unknown; kind?: unknown }[]).some(entry => entry.target === "console" && entry.kind === "drift"))
      findings.push({ text: "the acon console plugin manifest is stale", next: ["amem setup console --apply"] });
    if (name === "transition") findings.push({ text: `this directory resolved to ${item.previousKey} before and to ${item.key} now`, next: [String(item.aliasCommand), String(item.keepCommand)] });
    if (item.hint) findings.push(hintFinding(name, item.hint, item));
    if (name === "capture" && item.clis) for (const [cli, row] of Object.entries(item.clis as Record<string, { hint?: string }>)) if (row.hint) findings.push(captureFinding(cli, row.hint));
  }
  const out = reportFrame(s, "doctor", report.status === "skipped" ? "ok" : STATE_WORD[report.status], opts, report.home);
  out.note(`project ${report.project}`);
  attention(out, findings);
  out.section("Checks", String(entries.length));
  const order: Record<SectionStatus, number> = { attention: 0, unavailable: 1, skipped: 2, ok: 3 };
  entries.sort((a, b) => order[a[1].status] - order[b[1].status]);
  const rows = entries.flatMap(([name, section]) => {
    const { status, hint: _hint, reason, ...detail } = section;
    const facts = name === "writers" && status === "attention" ? [] : sectionFact(name, detail, now);
    const writerRefusal = name === "writers" && status === "attention";
    const fact = writerRefusal ? `${section.cause} (${section.category} category); see Attention`
      : [...facts, ...(reason ? [singleLine(reason)] : [])].join("; ") || (status === "ok" ? "nothing to report" : SECTION_TITLE[name]);
    return [{ state: status, name, fact }];
  });
  stateRows(out, rows, s);
  if (count("skipped")) { out.line(""); out.note(`${count("skipped")} skipped: nothing to check here`); }
  out.summary({ warnings: count("attention"), unknown: count("unavailable"), ok: count("ok") });
  return out.render(s.color).join("\n");
}
