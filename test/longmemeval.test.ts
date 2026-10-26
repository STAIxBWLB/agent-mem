import { expect, test } from "bun:test";
import fixture from "./fakes/longmemeval-three.json";
import { aggregateMetrics, dcg, ndcg, evaluate_retrieval, evaluate_retrieval_turn2session, scoreRetrieval,
  type GoldEvidence, type QuestionRetrieval, type RankedTurn } from "../scripts/longmemeval-metrics.ts";
const turn = (sessionId: string, turnIndex = 0): RankedTurn => ({ sessionId, turnIndex });
function evidence(index: number): GoldEvidence {
  const q = fixture[index]!;
  return { sessionIds: q.answer_session_ids,
    corpusSessions: q.haystack_sessions.map((rows, i) => ({ sessionId: q.haystack_session_ids[i]!, turns: rows.length })),
    turns: q.haystack_sessions.flatMap((rows, i) => rows.flatMap((row, j) => row.has_answer ? [turn(q.haystack_session_ids[i]!, j)] : [])) };
}
const question = (index: number, rankings: QuestionRetrieval["rankings"], errors?: QuestionRetrieval["errors"]): QuestionRetrieval => ({
  id: fixture[index]!.question_id, type: fixture[index]!.question_type, abstention: fixture[index]!.question_id.includes("_abs"),
  gold: evidence(index), rankings, ...(errors ? { errors } : {}),
});

test("three invented questions include single/multi-session gold and abstention", () => {
  expect(fixture).toHaveLength(3);
  expect(evidence(0).turns).toEqual([turn("single-evidence")]);
  expect(evidence(1).sessionIds).toEqual(["multi-amber", "multi-teal"]);
  expect(evidence(2).sessionIds).toEqual([]);
});
test("upstream dcg weights ranks one and two equally, then rank three by log2(3)", () => {
  expect(dcg([], 10)).toBe(0);
  expect(dcg([1, 1, 1, 1], 3)).toBeCloseTo(2 + 1 / Math.log2(3), 12);
  expect(dcg([0, 1], 2)).toBe(1);
  expect(dcg([1, 1], 1)).toBe(1);
});
test("upstream ndcg uses every corpus relevance for its ideal, not only retrieved documents", () => {
  expect(ndcg([2, 0, 1], ["a"], ["a", "a", "noise"], 3)).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 12);
  expect(ndcg([0], ["absent"], ["noise"], 10)).toBe(0);
});
test("upstream evaluate_retrieval uses the top k raw indices and vacuous all for empty gold", () => {
  expect(evaluate_retrieval([2, 0, 1], ["a", "b"], ["a", "b", "noise"], 2)).toEqual([1, 0, 0.5]);
  expect(evaluate_retrieval([], [], ["a"], 10)).toEqual([0, 1, 0]);
});
test("upstream turn2session widens k without compacting repeated session contributions to DCG", () => {
  const corpus = ["a_0", "a_1", "noise_0", "b_0"];
  // k=2 widens to three turns: relevance [1,1,0], full-corpus ideal [1,1,1].
  const result = evaluate_retrieval_turn2session([0, 1, 2, 3], ["a_0", "b_0"], corpus, 2);
  expect(result[0]).toBe(1); expect(result[1]).toBe(0);
  expect(result[2]).toBeCloseTo(2 / (2 + 1 / Math.log2(3)), 12);
});
test("upstream five/ten cutoffs are inclusive with hand-computed DCG", () => {
  const corpus = Array.from({ length: 10 }, (_, i) => (i === 4 ? "a" : i === 9 ? "b" : "noise" + i) + "_0");
  const ranking = corpus.map((_, i) => i), gold = ["a_0", "b_0"];
  const at5 = evaluate_retrieval_turn2session(ranking, gold, corpus, 5);
  const at10 = evaluate_retrieval_turn2session(ranking, gold, corpus, 10);
  expect(at5[0]).toBe(1); expect(at5[1]).toBe(0); expect(at5[2]).toBeCloseTo(1 / Math.log2(5) / 2, 12);
  expect(at10[1]).toBe(1); expect(at10[2]).toBeCloseTo((1 / Math.log2(5) + 1 / Math.log2(10)) / 2, 12);
});
test("upstream repeated SID uses cumulative ordinals and includes every relevant corpus turn in ideal", () => {
  const gold: GoldEvidence = { sessionIds: ["answer_a", "b"], turns: [turn("answer_a"), turn("b")],
    corpusSessions: [{ sessionId: "answer_a", turns: 3 }, { sessionId: "noise", turns: 1 }, { sessionId: "b", turns: 1 }] };
  const ranking = [turn("answer_a"), turn("answer_a", 1), turn("noise"), turn("b")];
  // Fewer than five unique sessions: effective_k reaches corpus length+1, including all four ranked turns.
  const result = scoreRetrieval(gold, ranking);
  expect(result.sessionRecallAllAt5).toBe(1);
  expect(result.ndcgAnyAt10).toBeCloseTo((2 + 1 / Math.log2(4)) / (2 + 1 / Math.log2(3) + 1 / Math.log2(4)), 12);
  expect(result.turnRecallAt10).toBe(1);
});
test("truncated rankings do not truncate the upstream ideal corpus or change the exhaustion rule", () => {
  expect(evaluate_retrieval_turn2session([0, 1], ["a_0"], ["a_0", "a_1", "a_2"], 5)[2])
    .toBeCloseTo(2 / (2 + 1 / Math.log2(3)), 12);
});
test("MRR and fractional turn recall are explicitly raw-turn extras, not compact session metrics", () => {
  const corpusSessions = [{ sessionId: "noise", turns: 10 }, { sessionId: "a", turns: 1 }];
  const ranking = [...Array.from({ length: 10 }, (_, i) => turn("noise", i)), turn("a")];
  const result = scoreRetrieval({ sessionIds: ["a"], turns: [turn("a")], corpusSessions }, ranking);
  expect(result.MRR).toBe(1 / 11); expect(result.turnRecallAt10).toBe(0); expect(result.sessionRecallAnyAt5).toBe(1);
});
test("overall/type means retain failed backends in denominators and exclude abstention", () => {
  const first = [turn("single-evidence")], both = [turn("multi-amber"), turn("multi-teal", 1)];
  const result = aggregateMetrics([question(0, { mcp: first, library: first }),
    question(1, { mcp: both, library: [], bm25: [turn("multi-amber")] }, { mcp: "failed" }), question(2, {})]);
  expect(result.overall.mcp).toMatchObject({ eligible: 2, success: 1, failure: 1, turnLabelled: 2,
    sessionRecallAnyAt5: 0.5, sessionRecallAllAt5: 0.5, MRR: 0.5, turnRecallAt10: 0.5 });
  expect(result.overall.library).toMatchObject({ eligible: 2, success: 2, failure: 0 });
  expect(result.byType["multi-session"]!.mcp.MRR).toBe(0);
  expect(result.overall.bm25.turnRecallAt10).toBe(0.25);
});
test("no turn labels stay null; empty eligible means stay null", () => {
  const gold: GoldEvidence = { sessionIds: ["a"], turns: [], corpusSessions: [{ sessionId: "a", turns: 1 }] };
  expect(scoreRetrieval(gold, [turn("a")]).turnRecallAt10).toBeNull();
  expect(aggregateMetrics([question(2, {})]).overall.mcp).toMatchObject({ eligible: 0, ndcgAnyAt10: null, MRR: null, turnRecallAt10: null });
});
test("backend error overrides a returned ranking, and unknown corpus indices fail closed", () => {
  expect(aggregateMetrics([question(0, { mcp: [turn("single-evidence")] }, { mcp: "" })]).overall.mcp)
    .toMatchObject({ failure: 1, MRR: 0, ndcgAnyAt10: 0 });
  expect(() => scoreRetrieval(evidence(0), [turn("unknown")])).toThrow("outside benchmark corpus");
});
