import { Report } from "@staix/cli-output";
import { PLAIN, singleLine, type Style } from "./style.ts";
import type { EvalAggregate, EvalReport } from "./eval.ts";
const pct = (value: number | null): string => value === null ? "  n/a" : value.toFixed(3);


/** #592: the human eval output, kept out of eval.ts so the write path never imports the output package. */
/** Human text for `amem eval`; the JSON report is the machine form. */
export function evalText(report: EvalReport, label: string, render?: { columns?: number; style?: Style }): string {
  if (render) {
    const s = render.style ?? PLAIN, out = new Report(render.columns ?? 80, s.ascii, { sanitize: singleLine });
    out.header("amem", "Evaluation"); out.section("Results");
    out.kv([["Set", label], ["Engine", report.engine], ["Questions", String(report.all.questions)], ["Answerable", String(report.answerable.questions)], ["All MRR", report.all.mrr === null ? "?" : report.all.mrr.toFixed(3)], ["Answerable MRR", report.answerable.mrr === null ? "?" : report.answerable.mrr.toFixed(3)]]);
    if (report.answerable.questions < report.all.questions) out.note(`${report.all.questions - report.answerable.questions} questions name entries this store does not hold; they score zero in all.`);
    out.section("Cutoffs", String(report.ks.length));
    const number = (value: number | null | undefined) => value == null ? "?" : value.toFixed(3);
    out.table(["K", "ALL RECALL", "ALL HIT", "ANSWERABLE RECALL", "ANSWERABLE HIT"], report.ks.map(k => [String(k), number(report.all.recall[k]), number(report.all.hit[k]), number(report.answerable.recall[k]), number(report.answerable.hit[k])]), 0);
    const missed = report.perQuestion.filter(row => row.rank === null || row.rank > Math.min(...report.ks));
    if (missed.length) { out.section("Questions to review", String(missed.length)); out.table(["RESULT", "QUESTION"], missed.map(row => [row.rank === null ? "miss" : `rank ${row.rank}`, `${row.answerable ? "" : "not in store: "}${row.q}`]), 1); }
    out.line(""); out.line(`Summary: ${report.all.questions} questions, ${report.answerable.questions} answerable`);
    return out.render(s.color).join("\n");
  }
  const head = (name: string, row: EvalAggregate) => `${name.padEnd(11)} ${String(row.questions).padStart(4)}  ${report.ks.map(k => `${pct(row.recall[k] ?? null)}/${pct(row.hit[k] ?? null)}`.padStart(13)).join(" ")}  ${pct(row.mrr).padStart(6)}`;
  return [
    `eval: ${label} (${report.engine === "substring" ? "substring fallback" : "ranked store.search, engine " + report.engine}; same ranked search path as default \`amem search\`; \`--filter\` keeps legacy substring matching)`,
    `${"".padEnd(11)} ${"n".padStart(4)}  ${report.ks.map(k => `@${k} recall/hit`.padStart(13)).join(" ")}  ${"MRR".padStart(6)}`,
    head("all", report.all),
    head("answerable", report.answerable),
    ...(report.answerable.questions < report.all.questions ? [`${report.all.questions - report.answerable.questions} question(s) name an entry this store does not hold (they score 0 in "all")`] : []),
    ...report.perQuestion.filter(row => row.rank === null || row.rank > Math.min(...report.ks)).map(row => `  ${row.rank === null ? "miss" : `rank ${row.rank}`}${row.answerable ? "" : " (not in store)"}: ${row.q.slice(0, 100)}`),
  ].join("\n");
}
