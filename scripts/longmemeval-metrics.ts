/** Retrieval-only metrics; no generated answers or answer-quality judgments. */
export type Backend = "mcp" | "library" | "bm25";
export interface RankedTurn { sessionId: string; turnIndex: number }
export interface GoldEvidence { sessionIds: readonly string[]; turns: readonly RankedTurn[]; corpusSessions: readonly { sessionId: string; turns: number }[] }
export interface QuestionRetrieval {
  id: string;
  type: string;
  abstention: boolean;
  gold: GoldEvidence;
  rankings: Partial<Record<Backend, readonly RankedTurn[]>>;
  errors?: Partial<Record<Backend, string>>;
}
export interface RetrievalMetrics {
  sessionRecallAnyAt5: 0 | 1;
  sessionRecallAllAt5: 0 | 1;
  sessionRecallAnyAt10: 0 | 1;
  sessionRecallAllAt10: 0 | 1;
  ndcgAnyAt10: number;
  MRR: number;
  turnRecallAt10: number | null;
}
export type AggregateScore = {
  eligible: number;
  success: number;
  failure: number;
  turnLabelled: number;
} & { [K in keyof RetrievalMetrics]: number | null };
export interface MetricsReport {
  overall: Record<Backend, AggregateScore>;
  byType: Record<string, Record<Backend, AggregateScore>>;
}
const BACKENDS: readonly Backend[] = ["mcp", "library", "bm25"];
const PRIMARY = ["sessionRecallAnyAt5", "sessionRecallAllAt5", "sessionRecallAnyAt10", "sessionRecallAllAt10", "ndcgAnyAt10", "MRR"] as const;
const turnKey = (turn: RankedTurn): string => JSON.stringify([turn.sessionId, turn.turnIndex]);

/* MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/** TypeScript port of src/retrieval/eval_utils.py at
 * xiaowu0162/LongMemEval 9e0b455f4ef0e2ab8f2e582289761153549043fc.
 * MIT, Copyright (c) 2024 Di Wu. NumPy operations become equivalent array operations.
 * Keep upstream's repeated-session relevance and effective_k control flow unchanged.
 */
export function dcg(relevances: readonly number[], k: number): number {
  relevances = relevances.slice(0, k);
  if (relevances.length) {
    return relevances[0]! + relevances.slice(1).reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  }
  return 0;
}
export function ndcg(rankings: readonly number[], correct_docs: readonly string[], corpus_ids: readonly string[], k = 10): number {
  const relevances = corpus_ids.map(doc_id => correct_docs.includes(doc_id) ? 1 : 0);
  const sorted_relevances = rankings.slice(0, k).map(idx => relevances[idx]!);
  const ideal_relevance = [...relevances].sort((a, b) => b - a);
  const ideal_dcg = dcg(ideal_relevance, k), actual_dcg = dcg(sorted_relevances, k);
  if (ideal_dcg === 0) return 0;
  return actual_dcg / ideal_dcg;
}
export function evaluate_retrieval(rankings: readonly number[], correct_docs: readonly string[], corpus_ids: readonly string[], k = 10): [number, number, number] {
  const recalled_docs = new Set(rankings.slice(0, k).map(idx => corpus_ids[idx]!));
  const recall_any = Number(correct_docs.some(doc => recalled_docs.has(doc)));
  const recall_all = Number(correct_docs.every(doc => recalled_docs.has(doc)));
  const ndcg_score = ndcg(rankings, correct_docs, corpus_ids, k);
  return [recall_any, recall_all, ndcg_score];
}
export function evaluate_retrieval_turn2session(rankings: readonly number[], correct_docs: readonly string[], corpus_ids: readonly string[], k = 10): [number, number, number] {
  const strip_turn_id = (docid: string) => docid.split("_").slice(0, -1).join("_");
  correct_docs = [...new Set(correct_docs.map(strip_turn_id))];
  corpus_ids = corpus_ids.map(strip_turn_id);
  let effective_k = k;
  let unique_docids = new Set(rankings.slice(0, effective_k).map(idx => corpus_ids[idx]!));
  while (effective_k <= corpus_ids.length && unique_docids.size < k) {
    effective_k += 1;
    unique_docids = new Set(rankings.slice(0, effective_k).map(idx => corpus_ids[idx]!));
  }
  return evaluate_retrieval(rankings, correct_docs, corpus_ids, effective_k);
}

/** Adapt amem's returned turns to upstream corpus indices, preserving all corpus relevances. */
export function scoreRetrieval(gold: GoldEvidence, rankedTurns: readonly RankedTurn[]): RetrievalMetrics {
  const corpus_ids: string[] = [], offsets = new Map<string, { offset: number; turns: number }>();
  for (const session of gold.corpusSessions) {
    if (offsets.has(session.sessionId) || !Number.isSafeInteger(session.turns) || session.turns < 0) throw Error("invalid benchmark corpus");
    offsets.set(session.sessionId, { offset: corpus_ids.length, turns: session.turns });
    for (let i = 0; i < session.turns; i++) corpus_ids.push(session.sessionId + "_" + i);
  }
  const rankings = rankedTurns.map(turn => {
    const session = offsets.get(turn.sessionId);
    if (!session || !Number.isSafeInteger(turn.turnIndex) || turn.turnIndex < 0 || turn.turnIndex >= session.turns) throw Error("ranked turn outside benchmark corpus");
    return session.offset + turn.turnIndex;
  });
  const correct_docs = gold.sessionIds.map(id => id + "_0");
  const at5 = evaluate_retrieval_turn2session(rankings, correct_docs, corpus_ids, 5);
  const at10 = evaluate_retrieval_turn2session(rankings, correct_docs, corpus_ids, 10);
  const first = rankedTurns.findIndex(turn => gold.sessionIds.includes(turn.sessionId));
  const goldTurns = new Set(gold.turns.map(turnKey)), returnedTurns = new Set(rankedTurns.slice(0, 10).map(turnKey));
  return {
    sessionRecallAnyAt5: at5[0] as 0 | 1, sessionRecallAllAt5: at5[1] as 0 | 1,
    sessionRecallAnyAt10: at10[0] as 0 | 1, sessionRecallAllAt10: at10[1] as 0 | 1,
    ndcgAnyAt10: at10[2],
    // Extras, absent from upstream eval_utils: raw-turn reciprocal rank and gold-turn fraction.
    MRR: first < 0 ? 0 : 1 / (first + 1),
    turnRecallAt10: goldTurns.size ? [...goldTurns].filter(key => returnedTurns.has(key)).length / goldTurns.size : null,
  };
}

function aggregateBackend(questions: readonly QuestionRetrieval[], backend: Backend): AggregateScore {
  const result: AggregateScore = {
    eligible: questions.length, success: 0, failure: 0, turnLabelled: 0,
    sessionRecallAnyAt5: null, sessionRecallAllAt5: null,
    sessionRecallAnyAt10: null, sessionRecallAllAt10: null,
    ndcgAnyAt10: null, MRR: null, turnRecallAt10: null,
  };
  const sums: Record<typeof PRIMARY[number], number> = {
    sessionRecallAnyAt5: 0, sessionRecallAllAt5: 0, sessionRecallAnyAt10: 0,
    sessionRecallAllAt10: 0, ndcgAnyAt10: 0, MRR: 0,
  };
  let turnSum = 0;
  for (const question of questions) {
    const ranking = question.rankings[backend], failed = ranking === undefined || question.errors?.[backend] !== undefined;
    if (failed) result.failure++; else result.success++;
    const scored = scoreRetrieval(question.gold, failed ? [] : ranking);
    for (const key of PRIMARY) sums[key] += scored[key];
    if (scored.turnRecallAt10 !== null) { result.turnLabelled++; turnSum += scored.turnRecallAt10; }
  }
  for (const key of PRIMARY) result[key] = result.eligible ? sums[key] / result.eligible : null;
  result.turnRecallAt10 = result.turnLabelled ? turnSum / result.turnLabelled : null;
  return result;
}

/** Missing/error backends stay in eligible denominators and contribute zero, not survivorship bias. */
export function aggregateMetrics(questions: readonly QuestionRetrieval[]): MetricsReport {
  const eligible = questions.filter(question => !question.abstention);
  const aggregate = (rows: readonly QuestionRetrieval[]): Record<Backend, AggregateScore> => Object.fromEntries(BACKENDS.map(backend => [backend, aggregateBackend(rows, backend)])) as Record<Backend, AggregateScore>;
  const groups = new Map<string, QuestionRetrieval[]>();
  for (const question of eligible) {
    const group = groups.get(question.type) ?? [];
    group.push(question); groups.set(question.type, group);
  }
  return { overall: aggregate(eligible), byType: Object.fromEntries([...groups].map(([type, rows]) => [type, aggregate(rows)])) };
}
