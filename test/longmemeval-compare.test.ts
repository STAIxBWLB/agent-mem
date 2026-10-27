import { describe, expect, test } from "bun:test";
import { compareLongMemEval, BM25_REPORTED_NOTICE, pairedRandomization, PAIRED_RANDOMIZATION_SEED, readBoundedReport } from "../scripts/longmemeval-compare.ts";

import { mkdtempSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function report(hits: readonly boolean[], options: { reverse?: boolean } = {}): any {
  const results = hits.map((hit, i) => {
    const id = `q-${String(i).padStart(3, "0")}`, sessionId = `gold-${i}`, other = `other-${i}`;
    const ranking = hit ? [{ sessionId, turnIndex: 0 }] : [{ sessionId: other, turnIndex: 0 }];
    return { id, type: i % 2 ? "multi-session" : "knowledge-update", abstention: false, status: "ok",
      gold: { sessionIds: [sessionId], turns: [{ sessionId, turnIndex: 0 }], corpusSessions: [{ sessionId, turns: 1 }, { sessionId: other, turns: 1 }] },
      rankings: { mcp: ranking, library: ranking, bm25: [{ sessionId: other, turnIndex: 0 }] }, errors: {},
      rows: { input: 2, stored: 2, overExcerptCap: 0, changedExcerpts: 0, retentionDays: 90, duplicateSessionIds: 0 } };
  });
  if (options.reverse) results.reverse();
  return { schema: "agent-mem.longmemeval/v2", variant: "S", dataset: { sha256: "a".repeat(64), bytes: 500 },
    runtime: { commit: "a".repeat(40), version: "0.10.0" }, harnessCommit: "b".repeat(40), harnessSha256: "c".repeat(64),
    definitions: { metric: "upstream" }, platform: "linux", bun: "1.4.2", limit: 50, questionTimeoutMs: 30000,
    selection: { questionTypes: null, examined: hits.length, skippedByType: 0 }, complete: true, questions: results.length,
    abstentions: 0, failed: [], metrics: {}, results };
}
function withAbstention(value: any) {
  const abstention = structuredClone(value.results.find((q: any) => q.id === "q-000")!);
  abstention.id = "q-abstention"; abstention.abstention = true; abstention.status = "abstention-excluded";
  abstention.rankings = {}; abstention.rows = { input: 0, stored: 0, overExcerptCap: 0, changedExcerpts: 0, retentionDays: 0, duplicateSessionIds: 0 };
  value.results.push(abstention); value.questions++; value.abstentions++;
  return value;
}
function rankShiftPair(count = 30) {
  const baseline = report(Array(count).fill(false)), candidate = structuredClone(baseline);
  for (const [index, left] of baseline.results.entries()) {
    const right = candidate.results.find((q: any) => q.id === left.id)!;
    const gold = left.gold.sessionIds[0];
    const noise = Array.from({ length: 31 }, (_, j) => `noise-${index}-${String(j).padStart(2, "0")}`);
    left.gold.corpusSessions = [{ sessionId: gold, turns: 1 }, ...noise.map(sessionId => ({ sessionId, turns: 1 }))];
    right.gold.corpusSessions = structuredClone(left.gold.corpusSessions);
    left.rankings.bm25 = [{ sessionId: noise[0], turnIndex: 0 }];
    right.rankings.bm25 = structuredClone(left.rankings.bm25);
    left.rows.input = left.rows.stored = right.rows.input = right.rows.stored = noise.length + 1;
    const before = [...noise.slice(0, 29).map(sessionId => ({ sessionId, turnIndex: 0 })), { sessionId: gold, turnIndex: 0 }];
    const after = [...noise.slice(0, 30).map(sessionId => ({ sessionId, turnIndex: 0 })), { sessionId: gold, turnIndex: 0 }];
    left.rankings.mcp = before; left.rankings.library = before;
    right.rankings.mcp = after; right.rankings.library = after;
  }
  return { baseline, candidate };
}

describe("pairedRandomization", () => {
  test("is deterministic, uses fixed work, and computes one-sided tails in either direction", () => {
    const left = [0, 0, 0, 0, 0, 0], right = [1, 1, 1, 1, 1, 1];
    const first = pairedRandomization(left, right), second = pairedRandomization(left, right);
    expect(first).toEqual(second); expect(first).toMatchObject({ n: 6, delta: 1, permutations: 10000, seed: PAIRED_RANDOMIZATION_SEED });
    expect(first.pValue).toBeLessThan(0.05);
    expect(pairedRandomization(right, left, "loss").pValue).toBe(first.pValue);
    expect(pairedRandomization(left, left).pValue).toBe(1);
    expect(left).toEqual([0, 0, 0, 0, 0, 0]);
  });
  test("rejects empty, unequal, nonfinite, and overflowed vectors", () => {
    expect(() => pairedRandomization([], [])).toThrow();
    expect(() => pairedRandomization([1], [])).toThrow();
    expect(() => pairedRandomization([NaN], [1])).toThrow();
    expect(() => pairedRandomization([-Number.MAX_VALUE], [Number.MAX_VALUE])).toThrow();
    expect(() => pairedRandomization([0, 0, 0], [1e308, 1e308, 1e308])).toThrow();
  });
});

describe("compareLongMemEval", () => {
  test("aligns reordered rows by ID, recomputes scores, and reports significant target gains", () => {
    const base = report(Array(30).fill(false)), candidate = report(Array(30).fill(true), { reverse: true });
    const result = compareLongMemEval(base, candidate, ["knowledge-update", "multi-session"]);
    expect(result.scope).toBe("single-pair"); expect(result.pairPass).toBe(true);
    expect(result.ruleVersion).toBe("f14v2");
    expect(result.rows).toHaveLength(18);
    expect(result.rows.filter(row => row.target)).toHaveLength(4);
    expect(result.rows.filter(row => row.target).every(row => row.targetGain)).toBe(true);
    expect(result.targetTests).toHaveLength(2);
    expect(result.targetTests.every((test: any) => test.targetGain && test.n === 30)).toBe(true);
    expect(result.rows.find(row => row.type === "overall" && row.backend === "mcp" && row.metric === "sessionRecallAllAt10")?.delta).toBe(1);
  });

  test("pools target types for primary gain while retaining per-type guardrails", () => {
    const baselineHits = Array(30).fill(false) as boolean[], candidateHits = [...baselineHits];
    for (let i = 0; i < candidateHits.length; i += 2) candidateHits[i] = true;
    const result = compareLongMemEval(report(baselineHits), report(candidateHits), ["knowledge-update", "multi-session"]);
    expect(result.targetsPass).toBe(true);
    expect(result.targetTests.every((test: any) => test.targetGain && test.delta === 0.5)).toBe(true);
    const unchangedType = result.rows.find(row => row.type === "multi-session" && row.backend === "mcp" && row.metric === "sessionRecallAllAt10");
    expect(unchangedType?.delta).toBe(0); expect(unchangedType?.targetGain).toBe(false);
    const lossHits = Array(30).fill(true) as boolean[], lossCandidate = [...lossHits];
    for (let i = 0; i < lossCandidate.length; i += 2) lossCandidate[i] = false;
    const loss = compareLongMemEval(report(lossHits), report(lossCandidate), ["knowledge-update", "multi-session"]);
    expect(loss.guardrailsPass).toBe(false); expect(loss.pairPass).toBe(false);
  });

  test("accepts current abstention-excluded rows with empty rankings and preserves their identity", () => {
    const base = withAbstention(report(Array(30).fill(false))), candidate = withAbstention(report(Array(30).fill(true), { reverse: true }));
    const result = compareLongMemEval(base, candidate, ["knowledge-update", "multi-session"]);
    expect(result.pairPass).toBe(true);
    expect(result.rows.every(row => row.n === 30 || row.n === 15)).toBe(true);
    candidate.results.find((q: any) => q.id === "q-abstention")!.rankings.bm25 = [];
    expect(() => compareLongMemEval(base, candidate, ["knowledge-update", "multi-session"])).toThrow("retrieval rankings for excluded question");
  });

  test("fails significant beyond-tolerance loss, but allows a small nonsignificant loss", () => {
    const base = report(Array(30).fill(true)), largeLoss = report(Array(30).fill(false));
    const failed = compareLongMemEval(base, largeLoss, ["knowledge-update", "multi-session"]);
    expect(failed.guardrailsPass).toBe(false);
    const sparseBase = report(Array(30).fill(true)), sparseCandidate = report([false, ...Array(29).fill(true)]);
    const sparse = compareLongMemEval(sparseBase, sparseCandidate, ["knowledge-update", "multi-session"]);
    expect(sparse.rows.every(row => row.guardrailPass)).toBe(true);
  });

  test("allows significant MRR loss when its magnitude stays within tolerance", () => {
    const pair = rankShiftPair(), result = compareLongMemEval(pair.baseline, pair.candidate);
    const rows = result.rows.filter(row => row.metric === "MRR");
    expect(rows).toHaveLength(6);
    expect(rows.every(row => row.delta < 0 && row.pLoss < 0.05 && row.guardrailPass)).toBe(true);
    expect(rows.find(row => row.type === "overall")!.delta).toBeCloseTo(1 / 31 - 1 / 30, 12);
    expect(rows.find(row => row.type === "overall")!.delta).toBeGreaterThan(-0.005);
  });

  test("refuses mismatched dataset, controls, question identity, evidence, rankings, and metadata", () => {
    const mismatch = (change: (r: any) => void) => { const a = report([true, false]), b = report([true, false]); change(b); expect(() => compareLongMemEval(a, b, ["knowledge-update", "multi-session"])).toThrow(); };
    mismatch(r => { r.dataset.sha256 = "d".repeat(64); });
    mismatch(r => { r.results.pop(); r.questions--; });
    mismatch(r => { r.results[0].type = "multi-session"; });
    mismatch(r => { r.results[0].gold.sessionIds = ["other"] });
    mismatch(r => { r.results[0].rankings.bm25[0].turnIndex = 1; });
    mismatch(r => { r.results[0].rows.stored++; });
    mismatch(r => { r.harnessSha256 = "d".repeat(64); });
    mismatch(r => { r.limit = 20; });
  });

  test("reported BM25 mode waives only ranking equality and reports recomputed movement", () => {
    const base = report([true, false]), candidate = structuredClone(base);
    candidate.results[0].rankings.bm25 = [{ sessionId: "gold-0", turnIndex: 0 }];
    expect(() => compareLongMemEval(base, candidate)).toThrow("BM25 ranking mismatch");
    const result = compareLongMemEval(base, candidate, [], { bm25Control: "reported" });
    expect(result.bm25Control).toBe("reported"); expect(result.notices).toEqual([BM25_REPORTED_NOTICE]);
    expect(result.bm25Movement).toMatchObject({ eligibleQuestions: 2, changedQuestions: 1, changedRankingLists: 1 });
    expect(result.bm25Movement!.rows).toHaveLength(12);
    expect(result.bm25Movement!.rows.find(row => row.type === "overall" && row.metric === "sessionRecallAllAt10")).toMatchObject({ n: 2, baseline: 0, candidate: 0.5, delta: 0.5 });
    expect(result.bm25Movement!.rows.find(row => row.type === "knowledge-update" && row.metric === "MRR")?.delta).toBe(1);
  });

  test("reported BM25 mode keeps every non-BM25 control and report validation strict", () => {
    const mismatch = (change: (r: any) => void) => { const a = report([true, false]), b = report([true, false]); change(b); expect(() => compareLongMemEval(a, b, [], { bm25Control: "reported" })).toThrow(); };
    mismatch(r => { r.dataset.sha256 = "d".repeat(64); });
    mismatch(r => { r.results[1].id = "new-id"; });
    mismatch(r => { r.results[0].gold.sessionIds = ["other"]; });
    mismatch(r => { r.results[0].rows.stored++; });
    mismatch(r => { r.definitions.metric = "different"; });
    mismatch(r => { r.selection.examined++; });
    mismatch(r => { r.harnessSha256 = "d".repeat(64); });
    mismatch(r => { r.limit = 20; });
    const invalid = report([true, false]); invalid.results[0].rankings.bm25[0].turnIndex = 99;
    expect(() => compareLongMemEval(invalid, report([true, false]), [], { bm25Control: "reported" })).toThrow();
    const incomplete = report([true, false]); incomplete.complete = false;
    expect(() => compareLongMemEval(incomplete, report([true, false]), [], { bm25Control: "reported" })).toThrow();
    expect(() => compareLongMemEval(report([true]), report([true]), [], { bm25Control: "waive" as any })).toThrow("invalid bm25Control");
  });

  test("refuses duplicate IDs, invalid rankings, NaN scores, failed paths, and incomplete reports", () => {
    const invalid = (change: (r: any) => void) => { const a = report([true, false]), b = report([true, false]); change(a); expect(() => compareLongMemEval(a, b)).toThrow(); };
    invalid(r => { r.results[1].id = r.results[0].id; });
    invalid(r => { r.results[0].rankings.mcp[0].turnIndex = 999; });
    invalid(r => { r.results[0].rankings.mcp[0].turnIndex = NaN; });
    invalid(r => { r.complete = false; });
    invalid(r => { r.failed = [{ id: "q", status: "partial" }]; });
    invalid(r => { r.results[0].errors = { mcp: "failed" }; });
    invalid(r => { r.results[0].errors = null; });
    invalid(r => { delete r.results[0].rankings.bm25; });
    invalid(r => { r.results[0].gold.sessionIds = [17]; });
    invalid(r => { r.results[0].gold.corpusSessions.push({ sessionId: "gold-0", turns: 2 }); });
    invalid(r => { r.results[0].gold.corpusSessions[0].turns = -1; });
    invalid(r => { r.results[0].gold.turns[0].turnIndex = 99; });
    invalid(r => { r.results[0].rows.retentionDays = Infinity; });
    invalid(r => { r.results[0].rankings.mcp = Array(51).fill({ sessionId: "other-0", turnIndex: 0 }); });
    invalid(r => { r.limit = 1001; });
    invalid(r => { r.results = Array(501).fill(r.results[0]); r.questions = 501; });
  });

  test("does not mutate report inputs", () => {
    const a = report([true, false]), b = report([false, true], { reverse: true });
    const beforeA = structuredClone(a), beforeB = structuredClone(b);
    compareLongMemEval(a, b, ["knowledge-update", "multi-session"]);
    expect(a).toEqual(beforeA); expect(b).toEqual(beforeB);
  });
});


test("report reader bounds regular files and refuses malformed UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-compare-report-")), file = join(dir, "report.json");
  try {
    writeFileSync(file, JSON.stringify({ report: true }));
    expect(readBoundedReport(file)).toEqual({ report: true });
    expect(() => readBoundedReport(dir)).toThrow("regular file");
    writeFileSync(file, Buffer.from([255]));
    expect(() => readBoundedReport(file)).toThrow();
    truncateSync(file, 128 * 1024 * 1024 + 1);
    expect(() => readBoundedReport(file)).toThrow("128 MiB");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
