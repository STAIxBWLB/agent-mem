/** Retrieval-only metrics; no generated answers or answer-quality judgments. */
export type Backend = "mcp" | "library" | "bm25";
export interface RankedTurn { sessionId: string; turnIndex: number }
export interface GoldEvidence { sessionIds: readonly string[]; turns: readonly RankedTurn[] }
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
  NDCGAt10: number;
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
const PRIMARY = ["sessionRecallAnyAt5", "sessionRecallAllAt5", "sessionRecallAnyAt10", "sessionRecallAllAt10", "NDCGAt10", "MRR"] as const;
const turnKey = (turn: RankedTurn): string => JSON.stringify([turn.sessionId, turn.turnIndex]);

/** A session's best turn fixes its position; later turns of it consume no session slot. */
export function rankSessions(rankedTurns: readonly RankedTurn[]): string[] {
  return [...new Set(rankedTurns.map(turn => turn.sessionId))];
}

/** Binary session NDCG@10 discounts rank r by 1/log2(r+1); MRR has no top-ten cutoff. */
export function scoreRetrieval(gold: GoldEvidence, rankedTurns: readonly RankedTurn[]): RetrievalMetrics {
  const sessions = rankSessions(rankedTurns), expected = new Set(gold.sessionIds);
  const any = (k: number): 0 | 1 => Number(sessions.slice(0, k).some(id => expected.has(id))) as 0 | 1;
  const all = (k: number): 0 | 1 => Number(expected.size > 0 && [...expected].every(id => sessions.slice(0, k).includes(id))) as 0 | 1;
  const discount = (rank: number): number => 1 / Math.log2(rank + 1);
  const dcg = sessions.slice(0, 10).reduce((sum, id, index) => sum + (expected.has(id) ? discount(index + 1) : 0), 0);
  const ideal = Array.from({ length: Math.min(10, expected.size) }, (_, index) => discount(index + 1)).reduce((sum, value) => sum + value, 0);
  const first = sessions.findIndex(id => expected.has(id));
  const goldTurns = new Set(gold.turns.map(turnKey)), returnedTurns = new Set(rankedTurns.slice(0, 10).map(turnKey));
  const foundTurns = [...goldTurns].filter(key => returnedTurns.has(key)).length;
  return {
    sessionRecallAnyAt5: any(5), sessionRecallAllAt5: all(5),
    sessionRecallAnyAt10: any(10), sessionRecallAllAt10: all(10),
    NDCGAt10: ideal ? dcg / ideal : 0,
    MRR: first < 0 ? 0 : 1 / (first + 1),
    turnRecallAt10: goldTurns.size ? foundTurns / goldTurns.size : null,
  };
}

function aggregateBackend(questions: readonly QuestionRetrieval[], backend: Backend): AggregateScore {
  const result: AggregateScore = {
    eligible: questions.length, success: 0, failure: 0, turnLabelled: 0,
    sessionRecallAnyAt5: null, sessionRecallAllAt5: null,
    sessionRecallAnyAt10: null, sessionRecallAllAt10: null,
    NDCGAt10: null, MRR: null, turnRecallAt10: null,
  };
  const sums: Record<typeof PRIMARY[number], number> = {
    sessionRecallAnyAt5: 0, sessionRecallAllAt5: 0, sessionRecallAnyAt10: 0,
    sessionRecallAllAt10: 0, NDCGAt10: 0, MRR: 0,
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
