import { Report } from "@staix/cli-output";
import { PLAIN, relativeTime, singleLine, type Style } from "./style.ts";
import { AUDIT_LABELS, type AuditLabel } from "./eval.ts";
import type { AuditSheet, AuditScore } from "./eval-audit.ts";

/** #592: the human eval-audit output, kept out of eval-audit.ts so the write path never imports the output package. */
interface AuditRender { columns?: number; style?: Style; now?: number }
/** Human text for `amem eval audit sample`: where the sheet is, and what filling it costs. Content-free, like the score. */
export function auditSheetText(sheet: AuditSheet, file: string, render?: AuditRender): string {
  const cells = new Set(sheet.notes.map(note => `${note.kind}/${note.age}`));
  const frame = `${sheet.frame}${sheet.truncated ? "+ (the store listing hit its cap, so the frame is a floor)" : ""}`;
  if (render) {
    const s = render.style ?? PLAIN, out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine, keepTokensWhole: true });
    out.header("amem", "Audit sample"); out.section("Sheet");
    out.kv([["Project", sheet.project], ["Drawn", `${sheet.drawn} of ${frame}`], ["Seed", sheet.seed], ["Measured", relativeTime(sheet.asOf, render.now ?? Date.now())], ["Groups", String(cells.size)], ["Root", sheet.root], ["File", file], ["Withheld", String(sheet.withheld)]]);
    out.note("The sheet is mode 0600, local only; never synced or committed.");
    out.note(`Fill both judge columns using ${AUDIT_LABELS.join(", ")}; the rubric is in the sheet.`);
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(file)) out.bullet("warn", "The sheet path contains control characters; inspect --json and pass the exact path to the score command.");
    else out.next(`amem eval audit score '${file.replaceAll("'", "'\\''")}'`);
    return out.render(s.color).join("\n");
  }
  return [
    `audit sample: ${sheet.drawn} of ${frame} ${sheet.project} notes, seed "${sheet.seed}" as of ${sheet.asOf}, ${cells.size} kind/age cells, anchors checked in ${sheet.root}${sheet.withheld ? `, ${sheet.withheld} withheld by the configured policy` : ""}`,
    `sheet: ${file} (0600, local only; never synced and never committed)`,
    `fill judge_a and judge_b with ${AUDIT_LABELS.join(", ")} (rubric in the sheet header), then run \`amem eval audit score ${file}\``,
  ].join("\n");
}

/** Human text for `amem eval audit score`; the JSON is the machine form. */
export function auditScoreText(score: AuditScore, render?: AuditRender): string {
  const row = (label: string, counts: Partial<Record<AuditLabel, number>>) => `${label.padEnd(10)} ${AUDIT_LABELS.map(name => String(counts[name] ?? 0).padStart(4)).join(" ")}`;
  const frame = `${score.frame}${score.truncated ? "+ (the store listing hit its cap, so the frame is a floor)" : ""}`;
  const withheld = score.withheld ? `, ${score.withheld} withheld by the configured policy` : "";
  const head = `audit score: project ${score.project}, ${score.drawn} of ${frame} notes, seed "${score.seed}" as of ${score.asOf}, ${score.labelled} labelled, ${score.unlabelled} not${withheld}`;
  // The joint cells are printed as one line per kind/age/anchor stratum, so a reader sees which label fills each intersection instead of three marginals.
  const strata = new Map<string, Partial<Record<AuditLabel, number>>>();
  for (const cell of score.cells) {
    const key = `${cell.kind}/${cell.age}/${cell.anchor}`, counts = strata.get(key) ?? {};
    counts[cell.label] = cell.count;
    strata.set(key, counts);
  }
  if (render) {
    const s = render.style ?? PLAIN, out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine });
    out.header("amem", "Audit score"); out.section("Summary");
    out.kv([["Project", score.project], ["Drawn", `${score.drawn} of ${frame}`], ["Seed", score.seed], ["Measured", relativeTime(score.asOf, render.now ?? Date.now())], ["Labelled", String(score.labelled)], ["Unlabelled", String(score.unlabelled)], ["Withheld", String(score.withheld)], ["Kappa", score.agreement.kappa === null ? "? (needs both judges and more than one label)" : score.agreement.kappa.toFixed(3)], ["Judge pairs", String(score.agreement.pairs)]]);
    out.section("Labels");
    const rows: [string, Partial<Record<AuditLabel, number>>][] = [["all", score.byLabel], ...Object.entries(score.byKind).map(([kind, counts]): [string, Partial<Record<AuditLabel, number>>] => [`kind ${kind}`, counts]), ...Object.entries(score.byAge).map(([age, counts]): [string, Partial<Record<AuditLabel, number>>] => [`age ${age}`, counts]), ...Object.entries(score.byAnchor).map(([anchor, counts]): [string, Partial<Record<AuditLabel, number>>] => [`anchor ${anchor}`, counts]), ...[...strata.entries()].map(([key, counts]): [string, Partial<Record<AuditLabel, number>>] => [`cross ${key}`, counts])];
    out.table(["GROUP", ...AUDIT_LABELS], rows.map(([name, counts]) => [name, ...AUDIT_LABELS.map(label => String(counts[label] ?? 0))]), 0);
    out.line(""); out.line(`Summary: ${score.labelled} labelled, ${score.unlabelled} unlabelled`);
    return out.render(s.color).join("\n");
  }
  return [
    head,
    `${"".padEnd(10)} ${AUDIT_LABELS.map(name => name.slice(0, 4).padStart(4)).join(" ")}`,
    row("all", score.byLabel),
    ...Object.entries(score.byKind).map(([kind, counts]) => row(`kind ${kind}`, counts)),
    ...Object.entries(score.byAge).map(([age, counts]) => row(`age ${age}`, counts)),
    ...Object.entries(score.byAnchor).map(([anchor, counts]) => row(`anchor ${anchor}`, counts)),
    ...strata.entries().map(([key, counts]) => row(`cross ${key}`, counts)),
    `kappa ${score.agreement.kappa === null ? "n/a (needs both judge columns, and more than one label between them)" : score.agreement.kappa.toFixed(3)} over ${score.agreement.pairs} doubly labelled note(s)`,
  ].join("\n");
}
