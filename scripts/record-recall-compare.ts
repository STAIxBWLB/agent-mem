/** Measurement-only strict no-loss comparison. No F14 tolerance or significance waiver. */
import { readBoundedReport, validateLongMemEvalPair } from "./longmemeval-compare.ts";
import { aggregateMetrics, type RankedTurn, type RetrievalMetrics } from "./longmemeval-metrics.ts";

const BACKENDS = ["mcp", "library"] as const;
const METRICS = ["sessionRecallAnyAt5", "sessionRecallAllAt5", "sessionRecallAnyAt10", "sessionRecallAllAt10", "ndcgAnyAt10", "MRR", "turnRecallAt10"] as const;
const TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "knowledge-update", "temporal-reasoning"] as const;
export interface RecordRecallDelta {
  type: string; backend: typeof BACKENDS[number]; metric: keyof RetrievalMetrics; n: number;
  baseline: number | null; candidate: number | null; delta: number | null; pass: boolean;
}
export type RecordRecallComparison = { complete: false; pass: false; reason: "incomplete-or-incompatible-reports" | "full-set-required" | "invalid-metadata" | "report-unavailable"; cause: string; nextStep: string }
  | { complete: true; pass: boolean; scope: "full-longmemeval" | "fixture"; rule: "strict-no-loss";
      dataset: { sha256: string; bytes: number }; questions: number; eligible: number; abstentions: number; questionTimeoutMs: number;
      ordering: Record<typeof BACKENDS[number], { equal: boolean; changedQuestions: number; eligibleQuestions: number }>;
      rows: RecordRecallDelta[] };
const REFUSAL = {
  "incomplete-or-incompatible-reports": {
    cause: "Baseline or candidate evidence is incomplete or its strict comparison controls do not match.",
    nextStep: "Finish full baseline and candidate runs with the same input, harness and controls, then rerun the comparison.",
  },
  "full-set-required": {
    cause: "The reports do not cover the full unfiltered 500-question LongMemEval set.",
    nextStep: "Run unfiltered 500-question S and M baseline and candidate measurements, then compare each dataset pair.",
  },
  "invalid-metadata": {
    cause: "The reports contain unsupported or inconsistent comparison metadata.",
    nextStep: "Regenerate baseline and candidate reports with the same supported harness and timeout, then rerun the comparison.",
  },
  "report-unavailable": {
    cause: "The explicit report inputs or comparison arguments could not be read or validated.",
    nextStep: "Check --baseline and --candidate inputs are readable complete report files and use valid comparison arguments, then rerun.",
  },
} as const;
const refused = (reason: Extract<RecordRecallComparison, { complete: false }>["reason"]): RecordRecallComparison => ({ complete: false, pass: false, reason, ...REFUSAL[reason] });
const equalOrdering = (left: readonly RankedTurn[], right: readonly RankedTurn[]) => left.length === right.length
  && left.every((turn, index) => turn.sessionId === right[index]!.sessionId && turn.turnIndex === right[index]!.turnIndex);

/** Recompute metrics from validated per-question rankings; reported aggregate scores are never trusted. */
export function compareRecordRecall(baseValue: unknown, candidateValue: unknown, options: { allowFixture?: boolean } = {}): RecordRecallComparison {
  let pair: ReturnType<typeof validateLongMemEvalPair>;
  try { pair = validateLongMemEvalPair(baseValue, candidateValue); }
  catch { return refused("incomplete-or-incompatible-reports"); }
  const { baseline, candidate } = pair;
  const fixture = options.allowFixture === true;
  if (options.allowFixture !== undefined && typeof options.allowFixture !== "boolean") return refused("invalid-metadata");
  // Per-type labels are a closed public vocabulary, never arbitrary report text in aggregate output.
  if (baseline.results.some(question => !(TYPES as readonly string[]).includes(question.type))
    || !Number.isSafeInteger(baseline.questionTimeoutMs) || baseline.questionTimeoutMs < 1000 || baseline.questionTimeoutMs > 300_000
    || candidate.questionTimeoutMs !== baseline.questionTimeoutMs) return refused("invalid-metadata");
  if (!baseline.results.some(question => !question.abstention)) return refused("incomplete-or-incompatible-reports");
  if (!fixture && (baseline.questions !== 500 || baseline.abstentions !== 30 || baseline.results.filter(question => !question.abstention).length !== 470
    || baseline.selection.questionTypes !== null || baseline.selection.examined !== 500 || baseline.selection.skippedByType !== 0)) return refused("full-set-required");
  // Stable summation order avoids a reordered report manufacturing floating-point drift.
  const ordered = (questions: typeof baseline.results) => [...questions].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const before = aggregateMetrics(ordered(baseline.results)), after = aggregateMetrics(ordered(candidate.results));
  const rows: RecordRecallDelta[] = [];
  for (const type of ["overall", ...Object.keys(before.byType).sort()]) for (const backend of BACKENDS) {
    const left = (type === "overall" ? before.overall : before.byType[type])?.[backend];
    const right = (type === "overall" ? after.overall : after.byType[type])?.[backend];
    if (!left || !right || left.failure || right.failure || left.eligible !== right.eligible || left.turnLabelled !== right.turnLabelled) return refused("incomplete-or-incompatible-reports");
    for (const metric of METRICS) {
      const a = left[metric], b = right[metric], n = metric === "turnRecallAt10" ? left.turnLabelled : left.eligible;
      if (a === null || b === null) {
        if (a !== b || n !== 0) return refused("invalid-metadata");
        rows.push({ type, backend, metric, n, baseline: null, candidate: null, delta: null, pass: true });
      } else {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return refused("invalid-metadata");
        rows.push({ type, backend, metric, n, baseline: a, candidate: b, delta: b - a, pass: b >= a });
      }
    }
  }
  const pairedById = new Map(candidate.results.map(question => [question.id, question]));
  const eligible = baseline.results.filter(question => !question.abstention);
  const ordering = Object.fromEntries(BACKENDS.map(backend => {
    const changedQuestions = eligible.filter(question => !equalOrdering(question.rankings[backend], pairedById.get(question.id)!.rankings[backend])).length;
    return [backend, { equal: changedQuestions === 0, changedQuestions, eligibleQuestions: eligible.length }];
  })) as Extract<RecordRecallComparison, { complete: true }>["ordering"];
  return { complete: true, pass: rows.every(row => row.pass), scope: fixture ? "fixture" : "full-longmemeval", rule: "strict-no-loss",
    dataset: { sha256: baseline.dataset.sha256, bytes: baseline.dataset.bytes }, questions: baseline.questions, eligible: eligible.length,
    abstentions: baseline.abstentions, questionTimeoutMs: baseline.questionTimeoutMs, ordering, rows };
}

function cli(args: readonly string[]): { baseline: string; candidate: string; allowFixture: boolean } {
  let baseline: string | undefined, candidate: string | undefined, allowFixture = false, json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--allow-fixture" && !allowFixture) { allowFixture = true; continue; }
    if (arg === "--json" && !json) { json = true; continue; }
    if (arg === "--baseline" && baseline === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) { baseline = args[++index]; continue; }
    if (arg === "--candidate" && candidate === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) { candidate = args[++index]; continue; }
    throw Error("invalid comparison arguments; use --baseline FILE --candidate FILE [--allow-fixture] [--json]");
  }
  if (!baseline || !candidate) throw Error("comparison needs --baseline FILE and --candidate FILE");
  return { baseline, candidate, allowFixture };
}
if (import.meta.main) {
  let result: RecordRecallComparison;
  try {
    const args = cli(process.argv.slice(2));
    result = compareRecordRecall(readBoundedReport(args.baseline), readBoundedReport(args.candidate), { allowFixture: args.allowFixture });
  } catch { result = refused("report-unavailable"); }
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}
