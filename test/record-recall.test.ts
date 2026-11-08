import { expect, test } from "bun:test";
import { compareRecordRecall } from "../scripts/record-recall-compare.ts";

function report(count = 2, abstentions = 0): any {
  const results = Array.from({ length: count }, (_, index) => {
    const abstention = index >= count - abstentions;
    const ranking = [{ sessionId: "gold-a", turnIndex: 0 }, { sessionId: "gold-b", turnIndex: 0 }, { sessionId: "noise", turnIndex: 0 }];
    return { id: `private-question-canary-${index}`, type: index % 2 ? "multi-session" : "knowledge-update", abstention,
      status: abstention ? "abstention-excluded" : "ok",
      gold: { sessionIds: ["gold-a", "gold-b"], turns: [{ sessionId: "gold-a", turnIndex: 0 }, { sessionId: "gold-b", turnIndex: 0 }],
        corpusSessions: ["gold-a", "gold-b", "noise"].map(sessionId => ({ sessionId, turns: 1 })) },
      rankings: abstention ? {} : { mcp: structuredClone(ranking), library: structuredClone(ranking), bm25: structuredClone(ranking) }, errors: {},
      rows: { input: 3, stored: 3, overExcerptCap: 0, changedExcerpts: 0, retentionDays: 90, duplicateSessionIds: 0 } };
  });
  return { schema: "agent-mem.longmemeval/v2", variant: "S", complete: true, failed: [], questions: count, abstentions, results,
    dataset: { sha256: "a".repeat(64), bytes: 500 }, harnessSha256: "b".repeat(64), definitions: { metric: "shared upstream metrics" }, limit: 50,
    selection: { questionTypes: null, examined: count, skippedByType: 0 }, questionTimeoutMs: 30000,
    // These aggregates are deliberately wrong: the comparator must recompute from validated rankings.
    metrics: { overall: { mcp: { MRR: -999 } } } };
}
const fixture = { allowFixture: true };

test("tiny fixtures require explicit opt-in and aggregate output contains no question IDs or payloads", () => {
  const baseline = report(), candidate = structuredClone(baseline);
  expect(compareRecordRecall(baseline, candidate)).toMatchObject({ complete: false, pass: false, reason: "full-set-required" });
  const result = compareRecordRecall(baseline, candidate, fixture);
  expect(result).toMatchObject({ complete: true, scope: "fixture", pass: true, rule: "strict-no-loss", eligible: 2 });
  if (!result.complete) throw Error("expected complete fixture");
  expect(result.rows).toHaveLength(3 * 2 * 7);
  expect(result.rows.find(row => row.type === "overall" && row.backend === "mcp" && row.metric === "MRR")).toMatchObject({ baseline: 1, candidate: 1, delta: 0 });
  expect(JSON.stringify(result)).not.toContain("private-question-canary");
  expect(result.ordering.mcp).toEqual({ equal: true, changedQuestions: 0, eligibleQuestions: 2 });
});

test("full reports require all 500 questions including 30 abstentions and no filtered selection", () => {
  const baseline = report(500, 30), candidate = structuredClone(baseline);
  expect(compareRecordRecall(baseline, candidate)).toMatchObject({ complete: true, pass: true, scope: "full-longmemeval", questions: 500, eligible: 470, abstentions: 30 });
  for (const mutate of [(r: any) => { r.selection.questionTypes = ["multi-session"]; }, (r: any) => { r.selection.skippedByType = 1; }, (r: any) => { r.selection.examined = 501; }]) {
    const left = structuredClone(baseline); mutate(left);
    expect(compareRecordRecall(left, structuredClone(left))).toMatchObject({ complete: false, pass: false });
  }
});

test("a sub-tolerance MRR loss fails strict no-loss without a significance waiver", () => {
  const baseline = report(), candidate = structuredClone(baseline);
  const noise = Array.from({ length: 31 }, (_, index) => ({ sessionId: `noise-${index}`, turnIndex: 0 }));
  for (const value of [baseline, candidate]) for (const question of value.results) {
    question.gold = { sessionIds: ["gold-a"], turns: [{ sessionId: "gold-a", turnIndex: 0 }],
      corpusSessions: [...noise, { sessionId: "gold-a" }].map(turn => ({ sessionId: turn.sessionId, turns: 1 })) };
    question.rows.input = question.rows.stored = 32;
    question.rankings.bm25 = [noise[0]];
    question.rankings.library = [...noise.slice(0, 29), { sessionId: "gold-a", turnIndex: 0 }];
    question.rankings.mcp = [...question.rankings.library];
  }
  for (const question of candidate.results) question.rankings.mcp = [...noise.slice(0, 30), { sessionId: "gold-a", turnIndex: 0 }];
  const result = compareRecordRecall(baseline, candidate, fixture);
  expect(result).toMatchObject({ complete: true, pass: false });
  if (!result.complete) throw Error("expected complete fixture");
  const loss = result.rows.find(row => row.type === "overall" && row.backend === "mcp" && row.metric === "MRR")!;
  expect(loss.delta!).toBeLessThan(0); expect(loss.delta!).toBeGreaterThan(-0.005); expect(loss.pass).toBe(false);
});

test("changed order is diagnostic only when all metric values remain nondecreasing", () => {
  const baseline = report(), candidate = structuredClone(baseline);
  for (const question of candidate.results) for (const backend of ["mcp", "library"]) {
    const list = question.rankings[backend]; [list[0], list[1]] = [list[1], list[0]];
  }
  candidate.results.reverse();
  const result = compareRecordRecall(baseline, candidate, fixture);
  expect(result).toMatchObject({ complete: true, pass: true, ordering: { mcp: { equal: false, changedQuestions: 2 }, library: { equal: false, changedQuestions: 2 } } });
});

test("failed, partial, missing and timed-out backends stay incomplete rather than losing denominators", () => {
  const baseline = report();
  for (const mutate of [
    (r: any) => { r.complete = false; }, (r: any) => { r.fatal = "interrupted"; },
    (r: any) => { r.failed = [{ status: "timeout" }]; }, (r: any) => { r.results[0].status = "partial"; },
    (r: any) => { r.results[0].status = "timeout"; }, (r: any) => { delete r.results[0].rankings.library; },
    (r: any) => { r.results[0].errors.mcp = "backend did not complete before question deadline"; },
  ]) {
    const candidate = structuredClone(baseline); mutate(candidate);
    expect(compareRecordRecall(baseline, candidate, fixture)).toMatchObject({ complete: false, pass: false });
  }
});

test("existing strict comparison controls reject data, gold, source-row, harness and BM25 drift", () => {
  const baseline = report();
  for (const mutate of [
    (r: any) => { r.dataset.sha256 = "c".repeat(64); }, (r: any) => { r.dataset.bytes++; },
    (r: any) => { r.harnessSha256 = "c".repeat(64); }, (r: any) => { r.definitions.metric = "changed"; },
    (r: any) => { r.results[0].id = "different"; }, (r: any) => { r.results[0].gold.sessionIds = ["noise"]; },
    (r: any) => { r.results[0].rows.changedExcerpts++; }, (r: any) => { r.results[0].rankings.bm25.reverse(); },
    (r: any) => { r.questionTimeoutMs = 60000; },
  ]) {
    const candidate = structuredClone(baseline); mutate(candidate);
    const result = compareRecordRecall(baseline, candidate, fixture);
    expect(result).toMatchObject({ complete: false, pass: false });
    expect(JSON.stringify(result)).not.toContain("private-question-canary");
  }
});

test("an unlabelled turn metric remains null, never an invented zero", () => {
  const baseline = report(); for (const question of baseline.results) question.gold.turns = [];
  const result = compareRecordRecall(baseline, structuredClone(baseline), fixture);
  expect(result).toMatchObject({ complete: true, pass: true });
  if (!result.complete) throw Error("expected complete fixture");
  expect(result.rows.filter(row => row.metric === "turnRecallAt10").every(row => row.baseline === null && row.candidate === null && row.delta === null && row.n === 0)).toBe(true);
});


test("refusals give fixed safe causes and next steps without a fixture escape for full-set failure", () => {
  const baseline = report();
  const incomplete = compareRecordRecall(baseline, { ...baseline, complete: false }, fixture);
  expect(incomplete).toMatchObject({ complete: false, pass: false, reason: "incomplete-or-incompatible-reports",
    cause: "Baseline or candidate evidence is incomplete or its strict comparison controls do not match.",
    nextStep: "Finish full baseline and candidate runs with the same input, harness and controls, then rerun the comparison." });
  const subset = compareRecordRecall(baseline, structuredClone(baseline));
  expect(subset).toMatchObject({ reason: "full-set-required", nextStep: "Run unfiltered 500-question S and M baseline and candidate measurements, then compare each dataset pair." });
  expect(JSON.stringify(subset)).not.toContain("allow-fixture");
  const metadata = compareRecordRecall(baseline, { ...baseline, questionTimeoutMs: 60000 }, fixture);
  expect(metadata).toMatchObject({ reason: "invalid-metadata", nextStep: "Regenerate baseline and candidate reports with the same supported harness and timeout, then rerun the comparison." });
  expect(JSON.stringify([incomplete, subset, metadata])).not.toContain("private-question-canary");
});
