/** Measurement-only comparison of two complete LongMemEval v2 retrieval reports. */
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { scoreRetrieval, type Backend, type GoldEvidence, type RankedTurn } from "./longmemeval-metrics.ts";

export const PAIRED_RANDOMIZATION_SEED = 0x6d2b79f5;
export type Bm25Control = "strict" | "reported";
export const BM25_REPORTED_NOTICE = "BM25 ranking-list equality is waived for this reported comparison; BM25 movement is descriptive and does not imply adoption.";
const PERMUTATIONS = 10_000, MAX_REPORT_BYTES = 128 * 1024 * 1024;
export interface CompareOptions { bm25Control?: Bm25Control }
export interface Bm25MovementRow { type: "overall" | string; metric: "sessionRecallAllAt10" | "sessionRecallAnyAt10" | "MRR" | "ndcgAnyAt10"; n: number; baseline: number; candidate: number; delta: number }
export interface Bm25Movement { eligibleQuestions: number; changedQuestions: number; changedRankingLists: number; rows: Bm25MovementRow[] }
type Direction = "gain" | "loss";
export interface PairedRandomizationResult { n: number; delta: number; pValue: number; permutations: number; seed: number }
export interface LongMemEvalComparisonRow {
  type: "overall" | string; backend: "mcp" | "library"; metric: "sessionRecallAllAt10" | "MRR" | "ndcgAnyAt10";
  n: number; baseline: number; candidate: number; delta: number; tolerance: number;
  pGain: number; pLoss: number; guardrailPass: boolean; target: boolean; /** Diagnostic only; pooled targetTests decide primary gain. */ targetGain: boolean;
}
export interface LongMemEvalTargetTest {
  backend: "mcp" | "library"; types: string[]; n: number; baseline: number; candidate: number;
  delta: number; pGain: number; targetGain: boolean;
}
export interface LongMemEvalComparison {
  scope: "single-pair"; ruleVersion: "f14v2"; rows: LongMemEvalComparisonRow[]; targetTests: LongMemEvalTargetTest[];
  bm25Control: Bm25Control; notices: string[]; bm25Movement?: Bm25Movement;
  guardrailsPass: boolean; targetsPass: boolean; pairPass: boolean;
}
type ReportQuestion = {
  upstreamNoUserTarget?: boolean;
  id: string; type: string; abstention: boolean; status: string; gold: GoldEvidence;
  rankings: Record<Backend, readonly RankedTurn[]>; errors?: Record<string, string>; rows: Record<string, unknown>;
};
type Report = Record<string, any> & { results: ReportQuestion[] };

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw Error("LongMemEval compare: " + message); }
function object(v: unknown): v is Record<string, any> { return !!v && typeof v === "object" && !Array.isArray(v); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** Deterministic, local PRNG sign-flip test; does not read or mutate Math.random. */
export function pairedRandomization(base: readonly number[], candidate: readonly number[], direction: Direction = "gain"): PairedRandomizationResult {
  assert(Array.isArray(base) && Array.isArray(candidate) && base.length > 0 && base.length === candidate.length, "paired vectors must be nonempty and equal length");
  assert(direction === "gain" || direction === "loss", "invalid direction");
  assert(base.every(Number.isFinite) && candidate.every(Number.isFinite), "paired values must be finite");
  const diffs = base.map((v, i) => candidate[i]! - v);
  assert(diffs.every(Number.isFinite), "paired differences must be finite");
  assert(Number.isFinite(diffs.reduce((sum, value) => sum + Math.abs(value), 0)), "paired permutation sums must be finite");
  const delta = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  assert(Number.isFinite(delta), "paired mean difference must be finite");
  let state = PAIRED_RANDOMIZATION_SEED >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
  const observed = direction === "gain" ? delta : -delta; let extreme = 0;
  for (let p = 0; p < PERMUTATIONS; p++) {
    let sum = 0;
    for (const diff of diffs) sum += random() < 0.5 ? diff : -diff;
    if ((direction === "gain" ? sum : -sum) / diffs.length >= observed - 1e-15) extreme++;
  }
  return { n: diffs.length, delta, pValue: (extreme + 1) / (PERMUTATIONS + 1), permutations: PERMUTATIONS, seed: PAIRED_RANDOMIZATION_SEED };
}

function validateReport(value: unknown, label: string): Report {
  assert(object(value) && value.schema === "agent-mem.longmemeval/v2", `${label} is not a current v2 report`);
  assert(value.complete === true && value.fatal === undefined, `${label} is incomplete or fatal`);
  assert(Array.isArray(value.failed) && value.failed.length === 0, `${label} has failed paths`);
  assert(object(value.dataset) && typeof value.dataset.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.dataset.sha256) && Number.isSafeInteger(value.dataset.bytes) && value.dataset.bytes > 0, `${label} has invalid dataset identity`);
  assert(typeof value.harnessSha256 === "string" && /^[a-f0-9]{64}$/.test(value.harnessSha256), `${label} has invalid harness identity`);
  assert(object(value.definitions) && object(value.selection) && Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 1000, `${label} has incomplete comparison controls`);
  assert(Array.isArray(value.results) && value.results.length > 0 && value.results.length <= 500 && value.questions === value.results.length, `${label} has invalid question results`);
  const ids = new Set<string>();
  for (const q of value.results as ReportQuestion[]) {
    assert(object(q) && typeof q.id === "string" && q.id.length > 0 && typeof q.type === "string" && q.type.length > 0, `${label} has malformed question identity`);
    assert(!ids.has(q.id), `${label} has duplicate question ID ${q.id}`); ids.add(q.id);
    assert(q.upstreamNoUserTarget === undefined || typeof q.upstreamNoUserTarget === "boolean", `${label} has invalid upstream target metadata`);
    assert(typeof q.abstention === "boolean" && q.status === (q.abstention ? "abstention-excluded" : "ok"), `${label} has incomplete question ${q.id}`);
    assert(object(q.gold) && Array.isArray(q.gold.sessionIds) && q.gold.sessionIds.every(id => typeof id === "string")
      && Array.isArray(q.gold.turns) && Array.isArray(q.gold.corpusSessions), `${label} has incomplete gold evidence for ${q.id}`);
    const corpus = new Map<string, number>(); let corpusTurns = 0;
    for (const session of q.gold.corpusSessions) {
      assert(object(session) && typeof session.sessionId === "string" && Number.isSafeInteger(session.turns) && session.turns >= 0,
        `${label} has malformed corpus metadata for ${q.id}`);
      assert(!corpus.has(session.sessionId), `${label} has duplicate corpus session for ${q.id}`);
      corpus.set(session.sessionId, session.turns); corpusTurns += session.turns;
      assert(corpusTurns <= 1_000_000, `${label} corpus turn bound exceeded for ${q.id}`);
    }
    assert(q.gold.sessionIds.every(id => corpus.has(id)), `${label} has a gold session outside the corpus for ${q.id}`);
    for (const turn of q.gold.turns) assert(object(turn) && typeof turn.sessionId === "string" && corpus.has(turn.sessionId)
      && Number.isSafeInteger(turn.turnIndex) && turn.turnIndex >= 0 && turn.turnIndex < corpus.get(turn.sessionId)!, `${label} has a gold turn outside the corpus for ${q.id}`);
    const rowKeys = ["input", "stored", "overExcerptCap", "changedExcerpts", "retentionDays", "duplicateSessionIds"] as const;
    assert(object(q.rows) && rowKeys.every(key => Number.isSafeInteger(q.rows[key]) && (q.rows[key] as number) >= 0)
      && q.rows.input === q.rows.stored, `${label} has invalid stored-row metadata for ${q.id}`);
    assert(object(q.rankings), `${label} has malformed rankings for ${q.id}`);
    if (q.abstention) assert(Object.keys(q.rankings).length === 0, `${label} has retrieval rankings for excluded question ${q.id}`);
    else assert(["mcp", "library", "bm25"].every(b => Array.isArray(q.rankings[b as Backend])), `${label} has missing rankings for ${q.id}`);
    assert(q.errors === undefined || object(q.errors) && Object.keys(q.errors).length === 0, `${label} has path errors for ${q.id}`);
    for (const backend of ["mcp", "library", "bm25"] as const) {
      const ranking = q.rankings[backend];
      if (q.abstention) continue;
      assert(Array.isArray(ranking) && ranking.length <= value.limit && ranking.every(turn => object(turn) && typeof turn.sessionId === "string" && Number.isSafeInteger(turn.turnIndex)), `${label} has malformed ${backend} ranking for ${q.id}`);
    }
    // Validate every ranked path, including BM25, so invalid evidence cannot hide.
    if (!q.abstention) for (const backend of ["mcp", "library", "bm25"] as const) scoreRetrieval(q.gold, q.rankings[backend]);
  }
  assert(value.abstentions === value.results.filter(q => q.abstention).length, `${label} abstention count disagrees with results`);
  return value as Report;
}

function scoreRows(report: Report, type: string | "overall", backend: "mcp" | "library", metric: LongMemEvalComparisonRow["metric"]): { values: Map<string, number>; mean: number } {
  const selected = report.results.filter(q => !q.abstention && (type === "overall" || q.type === type)).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  assert(selected.length > 0, `no eligible questions in ${type}`);
  const values = new Map<string, number>();
  for (const q of selected) values.set(q.id, scoreRetrieval(q.gold, q.rankings[backend])[metric]);
  const sum = [...values.values()].reduce((s, v) => s + v, 0);
  return { values, mean: sum / values.size };
}

function sameControls(base: Report, candidate: Report, bm25Control: Bm25Control): void {
  for (const key of ["sha256", "bytes"] as const) assert(base.dataset[key] === candidate.dataset[key], `dataset ${key} mismatch`);
  for (const key of ["limit", "harnessSha256"] as const) assert(base[key] === candidate[key], `${key} mismatch`);
  for (const key of ["definitions", "selection"] as const) assert(canonical(base[key]) === canonical(candidate[key]), `${key} mismatch`);
  const a = new Map(base.results.map(q => [q.id, q])), b = new Map(candidate.results.map(q => [q.id, q]));
  assert(a.size === b.size && [...a.keys()].every(id => b.has(id)), "question ID set mismatch");
  for (const [id, left] of a) {
    const right = b.get(id)!;
    for (const key of ["type", "abstention", "gold", "rows", "upstreamNoUserTarget"] as const) assert(canonical(left[key]) === canonical(right[key]), `${key} mismatch for ${id}`);
    if (bm25Control === "strict") assert(canonical(left.rankings.bm25) === canonical(right.rankings.bm25), `BM25 ranking mismatch for ${id}`);
  }
}

export function compareLongMemEval(baseValue: unknown, candidateValue: unknown, targetTypes: readonly string[] = [], options: CompareOptions = {}): LongMemEvalComparison {
  const bm25Control = options.bm25Control ?? "strict";
  assert(bm25Control === "strict" || bm25Control === "reported", "invalid bm25Control");
  const base = validateReport(baseValue, "baseline"), candidate = validateReport(candidateValue, "candidate");
  sameControls(base, candidate, bm25Control);
  assert(Array.isArray(targetTypes) && new Set(targetTypes).size === targetTypes.length && targetTypes.every(t => typeof t === "string" && t.length > 0), "invalid target types");
  const types = [...new Set(base.results.map(q => q.type))].sort();
  for (const type of types) assert(base.results.some(q => q.type === type && !q.abstention), `type ${type} has no eligible questions`);
  for (const type of targetTypes) assert(types.includes(type), `target type ${type} is absent`);
  const rows: LongMemEvalComparisonRow[] = [];
  for (const type of ["overall", ...types] as const) for (const backend of ["mcp", "library"] as const) for (const metric of ["sessionRecallAllAt10", "MRR", "ndcgAnyAt10"] as const) {
    const left = scoreRows(base, type, backend, metric), right = scoreRows(candidate, type, backend, metric);
    const ids = [...left.values.keys()];
    assert(ids.length === right.values.size && ids.every(id => right.values.has(id)), `paired question set mismatch in ${type}`);
    const before = ids.map(id => left.values.get(id)!), after = ids.map(id => right.values.get(id)!);
    const gain = pairedRandomization(before, after, "gain"), loss = pairedRandomization(before, after, "loss"), delta = right.mean - left.mean;
    // Per-type targetGain is diagnostic only. The primary test pools declared targets below.
    const target = type !== "overall" && targetTypes.includes(type) && metric === "sessionRecallAllAt10";
    const tolerance = type === "overall" ? 0.005 : 0.02;
    const guardrailPass = delta >= -tolerance || loss.pValue >= 0.05;
    rows.push({ type, backend, metric, n: ids.length, baseline: left.mean, candidate: right.mean, delta, tolerance,
      pGain: gain.pValue, pLoss: loss.pValue, guardrailPass, target, targetGain: target && delta > 0 && gain.pValue < 0.05 });
  }
  const targetTests: LongMemEvalTargetTest[] = [];
  if (targetTypes.length) for (const backend of ["mcp", "library"] as const) {
    const selected = base.results.filter(q => !q.abstention && targetTypes.includes(q.type)).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const before = selected.map(q => scoreRetrieval(q.gold, q.rankings[backend]).sessionRecallAllAt10);
    const afterById = new Map(candidate.results.map(q => [q.id, q]));
    const after = selected.map(q => {
      const paired = afterById.get(q.id)!;
      return scoreRetrieval(paired.gold, paired.rankings[backend]).sessionRecallAllAt10;
    });
    const baseline = before.reduce<number>((sum, value) => sum + value, 0) / before.length;
    const candidateMean = after.reduce<number>((sum, value) => sum + value, 0) / after.length;
    const delta = candidateMean - baseline, pGain = pairedRandomization(before, after, "gain").pValue;
    targetTests.push({ backend, types: [...targetTypes], n: before.length, baseline, candidate: candidateMean, delta, pGain,
      targetGain: delta > 0 && pGain < 0.05 });
  }
  const guardrailsPass = rows.every(row => row.guardrailPass);
  const targetsPass = targetTests.length === 2 && targetTests.every(test => test.targetGain);
  let bm25Movement: Bm25Movement | undefined;
  if (bm25Control === "reported") {
    const eligible = base.results.filter(q => !q.abstention).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const candidateById = new Map(candidate.results.map(q => [q.id, q]));
    const changedQuestions = eligible.filter(q => canonical(q.rankings.bm25) !== canonical(candidateById.get(q.id)!.rankings.bm25)).length;
    const movementRows: Bm25MovementRow[] = [];
    const movementMetrics = ["sessionRecallAllAt10", "sessionRecallAnyAt10", "MRR", "ndcgAnyAt10"] as const;
    for (const type of ["overall", ...types]) for (const metric of movementMetrics) {
      const selected = eligible.filter(q => type === "overall" || q.type === type);
      const before = selected.map(q => scoreRetrieval(q.gold, q.rankings.bm25)[metric]);
      const after = selected.map(q => scoreRetrieval(q.gold, candidateById.get(q.id)!.rankings.bm25)[metric]);
      const baseline = before.reduce((sum, value) => sum + value, 0) / before.length;
      const candidateMean = after.reduce((sum, value) => sum + value, 0) / after.length;
      movementRows.push({ type, metric, n: selected.length, baseline, candidate: candidateMean, delta: candidateMean - baseline });
    }
    bm25Movement = { eligibleQuestions: eligible.length, changedQuestions, changedRankingLists: changedQuestions, rows: movementRows };
  }
  return { scope: "single-pair", ruleVersion: "f14v2", rows, targetTests, bm25Control, notices: bm25Control === "reported" ? [BM25_REPORTED_NOTICE] : [], ...(bm25Movement ? { bm25Movement } : {}), guardrailsPass, targetsPass, pairPass: guardrailsPass && targetsPass };
}

export function readBoundedReport(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd); assert(stat.isFile() && stat.size <= MAX_REPORT_BYTES, "report must be a regular file no larger than 128 MiB");
    const chunks: Buffer[] = []; let total = 0;
    for (;;) { const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_REPORT_BYTES + 1 - total)); const n = readSync(fd, chunk, 0, chunk.length, null); if (!n) break;
      total += n; assert(total <= MAX_REPORT_BYTES, "report exceeds 128 MiB"); chunks.push(chunk.subarray(0, n)); }
    const after = fstatSync(fd);
    assert(stat.size === total && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs, "report changed during read");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
  } finally { closeSync(fd); }
}

function cliArgs(args: readonly string[]): { baseline: string; candidate: string; targetTypes: string[]; json: boolean; bm25Control: Bm25Control } {
  let baseline: string | undefined, candidate: string | undefined, targetRaw: string | undefined, json = false, bm25Control: Bm25Control = "strict", bm25ControlSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" && !json) { json = true; continue; }
    if (["--baseline", "--candidate", "--target-types", "--bm25-control"].includes(arg) && args[i + 1] !== undefined) {
      const value = args[++i]!; if (arg === "--baseline" && baseline === undefined) baseline = value;
      else if (arg === "--candidate" && candidate === undefined) candidate = value;
      else if (arg === "--target-types" && targetRaw === undefined) targetRaw = value;
      else if (arg === "--bm25-control" && !bm25ControlSeen && (value === "strict" || value === "reported")) { bm25Control = value; bm25ControlSeen = true; }
      else throw Error("LongMemEval compare: duplicate or invalid argument");
      continue;
    }
    throw Error("LongMemEval compare: invalid arguments; use --baseline FILE --candidate FILE [--target-types a,b] [--json]");
  }
  assert(!!baseline && !!candidate, "--baseline and --candidate are required");
  const targetTypes = targetRaw === undefined ? [] : targetRaw.split(",");
  assert(new Set(targetTypes).size === targetTypes.length, "duplicate target type");
  return { baseline, candidate, targetTypes, json, bm25Control };
}

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--help") console.log("bun scripts/longmemeval-compare.ts --baseline FILE --candidate FILE [--target-types knowledge-update,multi-session] [--bm25-control strict|reported] [--json]");
  else {
    const args = cliArgs(process.argv.slice(2)), result = compareLongMemEval(readBoundedReport(args.baseline), readBoundedReport(args.candidate), args.targetTypes, { bm25Control: args.bm25Control });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log("LongMemEval comparison scope: single-pair; this is NOT an adoption decision");
      for (const notice of result.notices) console.log(`NOTICE\t${notice}`);
      if (result.bm25Movement) for (const row of result.bm25Movement.rows) console.log(`BM25 MOVEMENT\t${row.type}\t${row.metric}\tn=${row.n}\t${row.baseline.toFixed(4)} -> ${row.candidate.toFixed(4)}\tdelta=${row.delta.toFixed(4)}`);
      for (const test of result.targetTests) console.log(`POOLED TARGET\t${test.backend}\ttypes=${test.types.join(",")}\tn=${test.n}\t${test.baseline.toFixed(4)} -> ${test.candidate.toFixed(4)}\tdelta=${test.delta.toFixed(4)}\tpGain=${test.pGain.toFixed(4)}\ttargetGain=${test.targetGain}`);
      for (const row of result.rows) console.log(`${row.type}\t${row.backend}\t${row.metric}\tn=${row.n}\t${row.baseline.toFixed(4)} -> ${row.candidate.toFixed(4)}\tdelta=${row.delta.toFixed(4)}\ttol=${row.tolerance.toFixed(3)}\tpGain=${row.pGain.toFixed(4)}\tpLoss=${row.pLoss.toFixed(4)}\tguardrail=${row.guardrailPass}\ttargetGain=${row.targetGain}`);
      console.log(`single-pair verdict: ${args.targetTypes.length ? result.pairPass ? "PASS" : "FAIL" : "guardrails-only (no target declared)"}; guardrails=${result.guardrailsPass}; targets=${result.targetsPass}; NOT an adoption decision`);
    }
  }
}
