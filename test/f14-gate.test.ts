import { expect, test } from "bun:test";
import { adopts, CANDIDATES, FIXTURE_NAMES, runGate, type AdoptionInput } from "../scripts/f14-gate.ts";
import { evalSeeded, FIXTURE_PATH, readEvalSet } from "../src/memory/eval-fixture.ts";
import { runEval, type EvalSet } from "../src/memory/eval.ts";

// agent-mem#40 F14 / AC7: a lexical change ships only with an eval gain. This pins the gate that decides it, and the record of what was measured.
const HELDOUT = new URL("./fixtures/eval-heldout.json", import.meta.url);
/** A report over three questions whose first expected entry sits at the given ranks (null = miss), built through the real scorer. */
function report(ranks: (number | null)[]) {
  const set = { schema: "amem.eval/v1", questions: ranks.map((_, index) => ({ q: `q${index}`, expect: [`e${index}`] })) } as EvalSet;
  return runEval(question => { const index = Number(question.slice(1)), rank = ranks[index]!; return rank === null ? [] : [...Array.from({ length: rank - 1 }, (_, n) => `x${n}`), `e${index}`]; }, q => q.expect, set, "fts5", [1, 5, 10]);
}

function lme(hits: boolean[], hash: string) {
  const results = hits.map((hit, i) => {
    const good = `gold-${i}`, bad = `other-${i}`, ranking = [{ sessionId: hit ? good : bad, turnIndex: 0 }];
    return { id: `q-${i}`, type: i % 2 ? "multi-session" : "knowledge-update", abstention: false, status: "ok",
      gold: { sessionIds: [good], turns: [{ sessionId: good, turnIndex: 0 }], corpusSessions: [{ sessionId: good, turns: 1 }, { sessionId: bad, turns: 1 }] },
      rankings: { mcp: ranking, library: ranking, bm25: [{ sessionId: bad, turnIndex: 0 }] }, errors: {},
      rows: { input: 2, stored: 2, overExcerptCap: 0, changedExcerpts: 0, retentionDays: 90, duplicateSessionIds: 0 } };
  });
  return { schema: "agent-mem.longmemeval/v2", complete: true, failed: [], dataset: { sha256: hash.repeat(64), bytes: 1000 },
    harnessSha256: "c".repeat(64), definitions: { metrics: "upstream" }, limit: 50,
    selection: { questionTypes: null, examined: hits.length, skippedByType: 0 }, questions: hits.length, abstentions: 0, results };
}
function evidence(): AdoptionInput {
  const baselineFixtures = Object.fromEntries(FIXTURE_NAMES.map(name => [name, report([2, 3, null])]));
  const s = lme(Array(40).fill(false), "a"), m = lme(Array(40).fill(false), "b");
  return { target: { fixtureSets: ["temporal"], longMemEvalTypes: [] }, baselineFixtures, candidateFixtures: { ...baselineFixtures, temporal: report([1, 3, null]) },
    longMemEval: { S: { baseline: s, candidate: structuredClone(s) }, M: { baseline: m, candidate: structuredClone(m) } }, privateAc4: "pass" };
}

test("F14v2 admits fixture target gain while unrelated fixture scores remain equal", () => {
  const input = evidence(), before = structuredClone(input), verdict = adopts(input);
  expect(verdict.adopt).toBe(true); expect(verdict.status).toBe("pass"); expect(verdict.ruleVersion).toBe("f14v2"); expect(input).toEqual(before);
  input.candidateFixtures.temporal = input.baselineFixtures.temporal!;
  expect(adopts(input)).toMatchObject({ adopt: false, status: "fail" });
});

test("every non-target fixture guardrail covers MRR, hit@1 and hit@10, including Korean and temporal", () => {
  for (const name of FIXTURE_NAMES) {
    const input = evidence(); input.target.fixtureSets = [name === "temporal" ? "built-in" : "temporal"];
    input.candidateFixtures[input.target.fixtureSets[0]!] = report([1, 3, null]);
    input.candidateFixtures[name] = report([2, 4, null]);
    expect(adopts(input).reasons.some(reason => reason.includes(`fixture guardrail ${name}`))).toBe(true);
  }
  const input = evidence(); input.candidateFixtures.ko = report([1, 20, null]);
  expect(adopts(input).adopt).toBe(false); // MRR and hit@1 gain cannot hide lost hit@10 on a non-target.
});

test("fixture targets must gain without losing MRR, hit@1 or hit@10", () => {
  const cases = [
    { before: [2, 3, null], after: [1, null, null], losing: "hit10" }, // MRR and hit@1 gain, hit@10 loss.
    { before: [2, 2, 2], after: [1, 10, 10], losing: "mrr" },        // hit@1 gain, MRR loss.
    { before: [1, 10, 10], after: [2, 2, 2], losing: "hit1" },       // MRR gain, hit@1 loss.
  ];
  for (const name of FIXTURE_NAMES) for (const entry of cases) {
    const input = evidence(); input.target.fixtureSets = [name];
    const baseline = report(entry.before), candidate = report(entry.after);
    input.baselineFixtures[name] = baseline; input.candidateFixtures[name] = candidate;
    expect(candidate.all.mrr! > baseline.all.mrr! || candidate.all.hit[1]! > baseline.all.hit[1]!).toBe(true);
    if (entry.losing === "hit10") {
      expect(candidate.all.mrr!).toBeGreaterThan(baseline.all.mrr!);
      expect(candidate.all.hit[10]!).toBeLessThan(baseline.all.hit[10]!);
    }
    const verdict = adopts(input);
    expect(verdict.adopt).toBe(false); expect(verdict.status).toBe("fail");
    expect(verdict.reasons.some(reason => reason.includes(`fixture guardrail ${name}`))).toBe(true);
  }
});

test("fixture primary accepts MRR-only or hit@1-only gains", () => {
  const input = evidence(); input.candidateFixtures.temporal = report([2, 2, null]);
  expect(adopts(input).adopt).toBe(true);
  input.baselineFixtures.temporal = report([2, 2, 2]); input.candidateFixtures.temporal = report([1, 4, 4]);
  expect(adopts(input).adopt).toBe(true);
  input.baselineFixtures.ko = report([1, 10, 10]); input.candidateFixtures.ko = report([2, 2, 2]);
  expect(adopts(input).reasons.some(reason => reason.includes("fixture guardrail ko"))).toBe(true);
});

test("LongMemEval target gain needs significant all@10 improvement on both backends and datasets", () => {
  const input = evidence(); input.target = { fixtureSets: [], longMemEvalTypes: ["knowledge-update", "multi-session"] };
  input.candidateFixtures = { ...input.baselineFixtures };
  input.longMemEval!.S!.candidate = lme(Array(40).fill(true), "a"); input.longMemEval!.M!.candidate = lme(Array(40).fill(true), "b");
  expect(adopts(input).adopt).toBe(true);
  input.longMemEval!.M!.candidate = structuredClone(input.longMemEval!.M!.baseline);
  expect(adopts(input)).toMatchObject({ adopt: false, status: "fail" });
});

test("pooled target gain allows one unchanged type but needs each backend and each dataset", () => {
  const input = evidence(); input.target = { fixtureSets: [], longMemEvalTypes: ["knowledge-update", "multi-session"] };
  input.candidateFixtures = { ...input.baselineFixtures };
  input.longMemEval!.S!.candidate = lme(Array.from({ length: 40 }, (_, i) => i % 2 === 0), "a");
  input.longMemEval!.M!.candidate = lme(Array.from({ length: 40 }, (_, i) => i % 2 === 0), "b");
  expect(adopts(input).adopt).toBe(true);
  const candidate = input.longMemEval!.M!.candidate as ReturnType<typeof lme>;
  const baseline = input.longMemEval!.M!.baseline as ReturnType<typeof lme>;
  candidate.results.forEach((q, i) => { q.rankings.library = baseline.results[i]!.rankings.library; });
  expect(adopts(input).reasons.some(reason => reason.includes("pooled target M/library"))).toBe(true);
});

test("LongMemEval guardrails reject significant loss beyond tolerance but waive nonsignificant loss", () => {
  const input = evidence();
  input.longMemEval!.S = { baseline: lme(Array(40).fill(true), "a"), candidate: lme(Array(40).fill(false), "a") };
  expect(adopts(input).reasons.some(reason => reason.includes("significant loss beyond"))).toBe(true);
  input.longMemEval!.S.candidate = lme([false, ...Array(39).fill(true)], "a");
  expect(adopts(input).adopt).toBe(true);
});

test("missing or mismatched evidence cannot establish adoption; private AC4 remains explicit", () => {
  const missing = evidence(); delete missing.longMemEval!.M;
  expect(adopts(missing)).toMatchObject({ adopt: false, status: "incomplete" });
  const ac4 = evidence(); delete ac4.privateAc4;
  expect(adopts(ac4)).toMatchObject({ adopt: false, status: "incomplete" });
  ac4.privateAc4 = "fail"; expect(adopts(ac4)).toMatchObject({ adopt: false, status: "fail" });
  ac4.privateAc4 = "missing"; ac4.candidateFixtures.temporal = ac4.baselineFixtures.temporal!;
  expect(adopts(ac4).status).toBe("incomplete"); // Any missing piece stays incomplete, even alongside a failed primary.
  const subset = evidence(); (subset.longMemEval!.S!.baseline as any).selection.questionTypes = ["knowledge-update"];
  (subset.longMemEval!.S!.candidate as any).selection.questionTypes = ["knowledge-update"];
  expect(adopts(subset)).toMatchObject({ adopt: false, status: "incomplete" });
  const sameDataset = evidence(); sameDataset.longMemEval!.M = structuredClone(sameDataset.longMemEval!.S!);
  expect(adopts(sameDataset)).toMatchObject({ adopt: false, status: "incomplete" });
  const noTarget = evidence(); noTarget.target = { fixtureSets: [], longMemEvalTypes: [] };
  expect(adopts(noTarget)).toMatchObject({ adopt: false, status: "incomplete" });
  const invalid = evidence(); invalid.candidateFixtures.ko!.all.mrr = NaN;
  expect(adopts(invalid)).toMatchObject({ adopt: false, status: "incomplete" });
});

test("BM25 movement requires explicit reported mode and never waives other evidence controls", () => {
  const input = evidence();
  const candidate = input.longMemEval!.S!.candidate as ReturnType<typeof lme>;
  candidate.results[0]!.rankings.bm25 = [{ sessionId: candidate.results[0]!.gold.sessionIds[0]!, turnIndex: 0 }];
  expect(adopts(input)).toMatchObject({ adopt: false, status: "incomplete" });
  input.bm25Control = "reported";
  const verdict = adopts(input);
  expect(verdict.adopt).toBe(true);
  expect(verdict.reasons.some(reason => reason.includes("BM25") && reason.includes("waiv"))).toBe(true);
  (candidate as any).dataset.sha256 = "f".repeat(64);
  expect(adopts(input)).toMatchObject({ adopt: false, status: "incomplete" });
});

test("the default runner reports all four baselines without retroactively running old candidates", () => {
  const rows = runGate();
  expect(rows.map(row => row.name)).toEqual([CANDIDATES[0]![0]]);
  expect(rows.filter(row => row.adopt)).toEqual([]);
  expect(rows[0]!.sets["built-in"]).toMatchObject({ mrr: 0.9063, hit1: 0.875, hit10: 0.9375 });
  expect(rows[0]!.sets["held-out"]).toMatchObject({ mrr: 0.8739, hit1: 0.8378, hit10: 0.9459 });
  expect(rows[0]!.sets.ko).toMatchObject({ mrr: 0.8934, hit1: 0.8684 });
  expect(rows[0]!.sets.temporal).toMatchObject({ mrr: 0.6782, hit1: 0.4444 });
  expect(Object.values(rows[0]!.sets).map(set => set.changed)).toEqual([0, 0, 0, 0]);
  expect(() => runGate(CANDIDATES)).toThrow("pre-register");
});

test("the held-out set is a valid, synthetic, self-contained set that is not the built-in one", () => {
  const held = readEvalSet(HELDOUT), builtIn = readEvalSet(FIXTURE_PATH);
  expect(held.entries!.length).toBeGreaterThanOrEqual(25); expect(held.questions.length).toBeGreaterThanOrEqual(30);
  const keys = new Set(held.entries!.map(entry => entry.key)), builtKeys = new Set(builtIn.entries!.map(entry => entry.key));
  expect([...keys].filter(key => builtKeys.has(key))).toEqual([]);                                         // no entry shared with the set the candidates could be fitted to
  expect(new Set(held.questions.map(question => question.q.toLowerCase())).size).toBe(held.questions.length);
  const queries = new Set(builtIn.questions.map(question => question.q.toLowerCase()));
  expect(held.questions.filter(question => queries.has(question.q.toLowerCase()))).toEqual([]);
  expect(JSON.stringify(held)).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}|agent-hub|AKIA|sk-[A-Za-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY/);
  const report = evalSeeded(held, [1, 5, 10]);
  expect(report.engine).toBe("fts5"); expect(report.answerable.questions).toBe(held.questions.length);
});

test("evalSeeded scores a custom ranking when given one, and the default is store.search", () => {
  const set = readEvalSet(FIXTURE_PATH);
  expect(evalSeeded(set, [1]).engine).toBe("fts5");
  const nothing = evalSeeded(set, [1, 10], () => []);
  expect(nothing.engine).toBe("custom"); expect(nothing.all.mrr).toBe(0); expect(nothing.all.hit[10]).toBe(0);
  const calls: number[] = [];
  evalSeeded(set, [1, 7], (_store, _question, window) => { calls.push(window); return []; });
  expect(new Set(calls)).toEqual(new Set([7]));                                                            // the window is the largest k
});

test("the F14 record claims only what was measured: no embedding verdict, no number nobody can rerun, no commit-order claim the history cannot show (review round 1)", async () => {
  const { readFileSync } = await import("node:fs");
  const section = (() => { const text = readFileSync(new URL("../docs/contracts.md", import.meta.url), "utf8"); return text.slice(text.indexOf("## Lexical recall changes are gated by eval")); })();
  expect(section).not.toMatch(/evidence for the embedding/i);                                    // the R5 question is the person's, judged on real memory
  expect(section).toContain("not evidence for or against the embedding revisit");
  expect(section).toContain("`amem eval --set` is run on a question set drawn from a real memory");
  expect(section).not.toMatch(/distractor/i);                                                    // that run was never committed, so no number from it belongs in a contract
  expect(section).not.toMatch(/not reproducible/i);
  const header = readFileSync(new URL("../scripts/f14-gate.ts", import.meta.url), "utf8").split("*/")[0]!;
  expect(header).not.toContain("committed first");                                              // the branch is squashed: the history cannot show an order
  expect(header).toContain("the author's record");
});
