import { expect, test } from "bun:test";
import fixture from "./fakes/longmemeval-three.json";
import { aggregateMetrics, rankSessions, scoreRetrieval, type GoldEvidence, type QuestionRetrieval, type RankedTurn } from "../scripts/longmemeval-metrics.ts";

const turn = (sessionId: string, turnIndex = 0): RankedTurn => ({ sessionId, turnIndex });
const discount = (rank: number) => 1 / Math.log2(rank + 1);
const evidence = (index: number): GoldEvidence => {
  const question = fixture[index]!;
  return {
    sessionIds: question.answer_session_ids,
    turns: question.haystack_sessions.flatMap((session, sessionIndex) => session.flatMap((row, turnIndex) => row.has_answer ? [turn(question.haystack_session_ids[sessionIndex]!, turnIndex)] : [])),
  };
};
const question = (index: number, rankings: QuestionRetrieval["rankings"], errors?: QuestionRetrieval["errors"]): QuestionRetrieval => ({
  id: fixture[index]!.question_id, type: fixture[index]!.question_type,
  abstention: fixture[index]!.question_id.endsWith("_abs"), gold: evidence(index), rankings, ...(errors ? { errors } : {}),
});

test("synthetic raw fixture has three questions with zero-based turn evidence and an abstention", () => {
  expect(fixture).toHaveLength(3);
  expect(evidence(0)).toEqual({ sessionIds: ["single-evidence"], turns: [turn("single-evidence", 0)] });
  expect(evidence(1)).toEqual({ sessionIds: ["multi-amber", "multi-teal"], turns: [turn("multi-amber", 0), turn("multi-teal", 1)] });
  expect(evidence(2)).toEqual({ sessionIds: [], turns: [] });
});

test("session ranks compact duplicate sessions in best-turn order without changing turn ranks", () => {
  const ranking = Object.freeze([turn("noise"), turn("a", 3), turn("a", 1), turn("b", 2), turn("noise", 4)]);
  expect(rankSessions(ranking)).toEqual(["noise", "a", "b"]);
  expect(ranking).toEqual([turn("noise"), turn("a", 3), turn("a", 1), turn("b", 2), turn("noise", 4)]);
});

test("session any/all cutoffs, standard binary NDCG and full-list MRR use distinct session ranks", () => {
  const gold = { sessionIds: ["a", "b", "a"], turns: [turn("a"), turn("b"), turn("a", 99)] };
  const ranking = [turn("noise-1"), turn("a"), turn("a", 2), turn("noise-2"), turn("noise-3"), turn("noise-4"), turn("noise-5"), turn("b")];
  const result = scoreRetrieval(gold, ranking);
  expect(result.sessionRecallAnyAt5).toBe(1); expect(result.sessionRecallAllAt5).toBe(0);
  expect(result.sessionRecallAnyAt10).toBe(1); expect(result.sessionRecallAllAt10).toBe(1);
  expect(result.NDCGAt10).toBeCloseTo((discount(2) + discount(7)) / (discount(1) + discount(2)), 12);
  expect(result.MRR).toBe(0.5); expect(result.turnRecallAt10).toBeCloseTo(2 / 3, 12);
  // Standard discount distinguishes rank 2 from rank 1 (unlike the upstream method=0 convention).
  expect(scoreRetrieval({ sessionIds: ["a"], turns: [] }, [turn("noise"), turn("a")]).NDCGAt10).toBeCloseTo(1 / Math.log2(3), 12);
});

test("five and ten are inclusive session cutoffs; duplicate turn labels do not inflate recall", () => {
  const ranking = Array.from({ length: 10 }, (_, index) => turn(index === 4 ? "a" : index === 9 ? "b" : `noise-${index}`));
  const result = scoreRetrieval({ sessionIds: ["a", "b"], turns: [turn("a"), turn("a"), turn("b")] }, ranking);
  expect(result.sessionRecallAnyAt5).toBe(1); expect(result.sessionRecallAllAt5).toBe(0);
  expect(result.sessionRecallAllAt10).toBe(1); expect(result.turnRecallAt10).toBe(1);
  expect(result.NDCGAt10).toBeCloseTo((discount(5) + discount(10)) / (discount(1) + discount(2)), 12);
});

test("turn recall uses the first ten turns, while session recall compacts duplicate sessions", () => {
  const ranking = [...Array.from({ length: 10 }, (_, index) => turn("a", index)), turn("b")];
  const result = scoreRetrieval({ sessionIds: ["a", "b"], turns: [turn("a"), turn("b")] }, ranking);
  expect(result.sessionRecallAllAt5).toBe(1); expect(result.turnRecallAt10).toBe(0.5);
});

test("MRR includes a first relevant session at rank fifty despite zero top-ten metrics", () => {
  const ranking = [...Array.from({ length: 49 }, (_, index) => turn(`noise-${index}`)), turn("answer")];
  expect(scoreRetrieval({ sessionIds: ["answer"], turns: [turn("answer")] }, ranking)).toEqual({
    sessionRecallAnyAt5: 0, sessionRecallAllAt5: 0, sessionRecallAnyAt10: 0, sessionRecallAllAt10: 0,
    NDCGAt10: 0, MRR: 1 / 50, turnRecallAt10: 0,
  });
});

test("overall and type means retain missing/error backends in denominators and exclude abstentions", () => {
  const first = [turn("single-evidence")], both = [turn("multi-amber"), turn("multi-teal", 1)];
  const questions = [question(0, { mcp: first, library: first }),
    question(1, { mcp: both, library: [], bm25: [turn("multi-amber")] }, { mcp: "retrieval failed" }),
    question(2, { mcp: first, library: first, bm25: first })];
  const result = aggregateMetrics(questions);
  expect(result.overall.mcp).toEqual({ eligible: 2, success: 1, failure: 1, turnLabelled: 2,
    sessionRecallAnyAt5: 0.5, sessionRecallAllAt5: 0.5, sessionRecallAnyAt10: 0.5, sessionRecallAllAt10: 0.5,
    NDCGAt10: 0.5, MRR: 0.5, turnRecallAt10: 0.5 });
  expect(result.overall.library).toEqual({ ...result.overall.mcp, success: 2, failure: 0 });
  expect(result.overall.bm25).toMatchObject({ eligible: 2, success: 1, failure: 1, turnLabelled: 2,
    sessionRecallAnyAt5: 0.5, sessionRecallAllAt5: 0, sessionRecallAnyAt10: 0.5, sessionRecallAllAt10: 0, MRR: 0.5, turnRecallAt10: 0.25 });
  expect(result.overall.bm25.NDCGAt10).toBeCloseTo(1 / (2 * (1 + discount(2))), 12);
  expect(result.byType["single-session-user"]!.mcp.eligible).toBe(1);
  expect(result.byType["multi-session"]!.mcp).toMatchObject({ eligible: 1, success: 0, failure: 1, turnLabelled: 1, MRR: 0, turnRecallAt10: 0 });
  expect(result.byType["multi-session"]!.library).toMatchObject({ success: 1, failure: 0, MRR: 0 });
});

test("no turn labels remain diagnostic null, including backend failures", () => {
  const entry: QuestionRetrieval = { id: "unlabelled", type: "single-session-user", abstention: false,
    gold: { sessionIds: ["answer"], turns: [] }, rankings: { mcp: [turn("answer")] } };
  expect(scoreRetrieval(entry.gold, entry.rankings.mcp!).turnRecallAt10).toBeNull();
  const result = aggregateMetrics([entry]);
  expect(result.overall.mcp).toMatchObject({ eligible: 1, success: 1, failure: 0, turnLabelled: 0, turnRecallAt10: null, MRR: 1 });
  expect(result.overall.library).toMatchObject({ eligible: 1, success: 0, failure: 1, turnLabelled: 0, turnRecallAt10: null, MRR: 0 });
});

test("empty eligible sets produce null means, and empty gold never yields vacuous all-session success", () => {
  for (const entries of [[], [question(2, {})]]) {
    const result = aggregateMetrics(entries);
    expect(result.byType).toEqual({});
    for (const backend of ["mcp", "library", "bm25"] as const) expect(result.overall[backend]).toEqual({
      eligible: 0, success: 0, failure: 0, turnLabelled: 0,
      sessionRecallAnyAt5: null, sessionRecallAllAt5: null, sessionRecallAnyAt10: null, sessionRecallAllAt10: null,
      NDCGAt10: null, MRR: null, turnRecallAt10: null,
    });
  }
  expect(scoreRetrieval({ sessionIds: [], turns: [] }, [turn("noise")])).toEqual({
    sessionRecallAnyAt5: 0, sessionRecallAllAt5: 0, sessionRecallAnyAt10: 0, sessionRecallAllAt10: 0,
    NDCGAt10: 0, MRR: 0, turnRecallAt10: null,
  });
});

test("a declared backend error overrides even a perfect ranking, including an empty error message", () => {
  const result = aggregateMetrics([question(0, { mcp: [turn("single-evidence")] }, { mcp: "" })]);
  expect(result.overall.mcp).toMatchObject({ eligible: 1, success: 0, failure: 1, turnLabelled: 1,
    sessionRecallAnyAt5: 0, NDCGAt10: 0, MRR: 0, turnRecallAt10: 0 });
});
