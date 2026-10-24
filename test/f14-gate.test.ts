import { expect, test } from "bun:test";
import { adopts, CANDIDATES, runGate } from "../scripts/f14-gate.ts";
import { evalSeeded, FIXTURE_PATH, readEvalSet } from "../src/memory/eval-fixture.ts";
import { runEval, type EvalSet } from "../src/memory/eval.ts";

// agent-mem#40 F14 / AC7: a lexical change ships only with an eval gain. This pins the gate that decides it, and the record of what was measured.
const HELDOUT = new URL("./fixtures/eval-heldout.json", import.meta.url);
/** A report over three questions whose first expected entry sits at the given ranks (null = miss), built through the real scorer. */
function report(ranks: (number | null)[]) {
  const set = { schema: "amem.eval/v1", questions: ranks.map((_, index) => ({ q: `q${index}`, expect: [`e${index}`] })) } as EvalSet;
  return runEval(question => { const index = Number(question.slice(1)), rank = ranks[index]!; return rank === null ? [] : [...Array.from({ length: rank - 1 }, (_, n) => `x${n}`), `e${index}`]; }, q => q.expect, set, "fts5", [1, 5, 10]);
}

test("the adoption rule says yes only for a gain on every set and a loss on none (it can say yes)", () => {
  const base = { a: report([2, 3, null]), b: report([2, 3, null]) };
  expect(adopts(base, { a: report([1, 3, null]), b: report([1, 3, null]) })).toBe(true);                  // MRR and hit@1 up on both
  expect(adopts(base, { a: report([2, 3, null]), b: report([2, 3, null]) })).toBe(false);                 // equal is not a gain
  expect(adopts(base, { a: report([1, 3, null]), b: report([2, 3, null]) })).toBe(false);                 // helps one set only
  expect(adopts(base, { a: report([1, 3, null]), b: report([2, 4, null]) })).toBe(false);                 // helps one, hurts the other
  expect(adopts(base, { a: report([1, 3, 2]), b: report([1, 3, 2]) })).toBe(true);                        // recovering a miss counts too
  // Hurting hit@10 while raising MRR is a loss: rank 1 for one question but another falls out of the top 10.
  expect(adopts({ a: report([2, 3, 5]) }, { a: report([1, 3, null]) })).toBe(false);
});

test("the committed record: no F14 candidate raises MRR or hit@1 on both fixture sets, so none is adopted", () => {
  const rows = runGate();
  expect(rows.map(row => row.name)).toEqual(CANDIDATES.map(([name]) => name));
  expect(rows.filter(row => row.adopt)).toEqual([]);
  const base = rows[0]!;
  expect(base.sets["built-in"]).toMatchObject({ mrr: 0.9063, hit1: 0.875, hit10: 0.9375 });
  expect(base.sets["held-out"]).toMatchObject({ mrr: 0.8739, hit1: 0.8378, hit10: 0.9459 });
  // The baseline row is compared with itself, so it moves no question on any set. A gate whose baseline were some other ranking would show movement here.
  expect(Object.values(base.sets).map(set => set.changed)).toEqual([0, 0]);
  // The candidates really ran: at least one moved a question on a set, so "no gain" is not "no effect".
  expect(rows.slice(1).some(row => Object.values(row.sets).some(set => set.changed > 0))).toBe(true);
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
