/**
 * F14v2 (#107) supersedes the #82 every-set-gain rule: pre-register the target,
 * require target gain, and enforce all fixture and LongMemEval guardrails, including declared targets.
 * For the author's record of older experiments remains in docs/contracts.md; those
 * candidates are never automatically re-admitted under this rule.
 * Usage: bun scripts/f14-gate.ts [--json] prints baseline fixtures only.
 */
import { evalSeeded, FIXTURE_PATH, KO_FIXTURE_PATH, readEvalSet, type RankFn } from "../src/memory/eval-fixture.ts";
import type { EvalReport } from "../src/memory/eval.ts";
import { compareLongMemEval, BM25_REPORTED_NOTICE, type Bm25Control, type LongMemEvalComparison } from "./longmemeval-compare.ts";
import type { View } from "../src/memory/store.ts";

const PROJECT = "example.test/eval/fixture";
const HELDOUT = new URL("../test/fixtures/eval-heldout.json", import.meta.url);
const GENERIC = new Set(["src", "ts", "js", "sh", "md", "json", "path", "ops", "test", "index", "lib"]);
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const nodeWords = (node: string): string[] => words(node.replace(/^[a-z]+:/, "")).filter(word => !GENERIC.has(word) && word.length > 2);
const idsOf = (hits: { view?: View }[]): View[] => hits.flatMap(hit => hit.view ? [hit.view] : []);

/** The shipped ranking: `store.search`. */
const baseline: RankFn = (store, question, window) => idsOf(store.search(question, { project: PROJECT, limit: window, includeCapture: false }).hits).map(view => view.id);

/** Candidate 1: expand the query with the words of the `about` nodes whose own words the query already names. */
const expandAbout: RankFn = (store, question, window) => {
  const queryWords = new Set(words(question)), add = new Set<string>();
  for (const view of store.list({ project: PROJECT, limit: Number.MAX_SAFE_INTEGER })) for (const node of view.about) {
    const own = nodeWords(node);
    if (own.some(word => queryWords.has(word))) for (const word of own) if (!queryWords.has(word)) add.add(word);
  }
  return baseline(store, [question, ...[...add].slice(0, 8)].join(" "), window);
};

/** Candidate 2: append the live entries that share an `about` node with the top `k` lexical hits (1 hop), never displacing a hit. */
const oneHopAppend = (k: number): RankFn => (store, question, window) => {
  const hits = idsOf(store.search(question, { project: PROJECT, limit: window, includeCapture: false }).hits), seen = new Set(hits.map(view => view.id));
  const nodes = new Set(hits.slice(0, k).flatMap(view => view.about));
  const neighbours = store.list({ project: PROJECT, limit: Number.MAX_SAFE_INTEGER }).filter(view => !seen.has(view.id) && view.about.some(node => nodes.has(node)));
  return [...hits, ...neighbours].slice(0, window).map(view => view.id);
};

/** Candidate 3: a score blend. Every live entry sharing an `about` node with a hit gets `alpha` times that hit's score, merged with the lexical scores by max. */
const oneHopBlend = (alpha: number): RankFn => (store, question, window) => {
  const hits = store.search(question, { project: PROJECT, limit: window, includeCapture: false }).hits.filter(hit => hit.view);
  const score = new Map(hits.map(hit => [hit.view!.id, hit.score]));
  for (const view of store.list({ project: PROJECT, limit: Number.MAX_SAFE_INTEGER })) for (const hit of hits) {
    if (hit.view!.id === view.id || !view.about.some(node => hit.view!.about.includes(node))) continue;
    score.set(view.id, Math.max(score.get(view.id) ?? -Infinity, alpha * hit.score));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, window).map(([id]) => id);
};

/** Candidate 4: boost the entries that are about a node the query names, by up to three places among the hits. */
const nodeBoost: RankFn = (store, question, window) => {
  const hits = idsOf(store.search(question, { project: PROJECT, limit: window, includeCapture: false }).hits), queryWords = new Set(words(question));
  const named = new Set<string>();
  const all = store.list({ project: PROJECT, limit: Number.MAX_SAFE_INTEGER });
  for (const view of all) for (const node of view.about) if (nodeWords(node).some(word => queryWords.has(word))) named.add(node);
  const kept = new Set(hits.map(view => view.id));
  const scored = [...hits.map((view, index) => ({ view, score: -index + (view.about.some(node => named.has(node)) ? 3 : 0) })),
    ...all.filter(view => !kept.has(view.id) && view.about.some(node => named.has(node))).map((view, index) => ({ view, score: -window + index }))];
  return scored.sort((a, b) => b.score - a.score).slice(0, window).map(item => item.view.id);
};

/** Candidate 5: pseudo-relevance feedback. Add the three rarest new words of the top hit to the query and search again. */
const feedback: RankFn = (store, question, window) => {
  const first = store.search(question, { project: PROJECT, limit: 1, includeCapture: false }).hits[0]?.view;
  if (!first) return baseline(store, question, window);
  const queryWords = new Set(words(question)), df = new Map<string, number>();
  for (const view of store.list({ project: PROJECT, limit: Number.MAX_SAFE_INTEGER })) for (const word of new Set(words(`${view.title ?? ""} ${view.text}`))) df.set(word, (df.get(word) ?? 0) + 1);
  const add = [...new Set(words(`${first.title ?? ""} ${first.text}`))].filter(word => !queryWords.has(word) && word.length >= 4).sort((a, b) => (df.get(a) ?? 1) - (df.get(b) ?? 1));
  return baseline(store, [question, ...add.slice(0, 3)].join(" "), window);
};

export const CANDIDATES: readonly [string, RankFn][] = [
  ["baseline (store.search)", baseline], ["expand query with about-node words", expandAbout], ["1-hop append (top 1)", oneHopAppend(1)], ["1-hop append (top 3)", oneHopAppend(3)],
  ["1-hop score blend (0.5)", oneHopBlend(0.5)], ["boost about-node entries", nodeBoost], ["pseudo-relevance feedback", feedback],
];

export const FIXTURE_NAMES = ["built-in", "held-out", "ko", "temporal"] as const;
export type FixtureName = typeof FIXTURE_NAMES[number];
const SETS: readonly [FixtureName, URL][] = [["built-in", FIXTURE_PATH], ["held-out", HELDOUT], ["ko", KO_FIXTURE_PATH], ["temporal", new URL("../test/fixtures/eval-temporal.json", import.meta.url)]];
const KS = [1, 5, 10] as const;
export interface PreRegisteredTarget { fixtureSets: readonly FixtureName[]; longMemEvalTypes: readonly string[] }
export interface ReportPair { baseline: unknown; candidate: unknown }
export interface AdoptionInput {
  target: PreRegisteredTarget;
  /** Explicit pre-registered query-preparation experiment; default keeps BM25 lists fixed. */
  bm25Control?: Bm25Control;
  baselineFixtures: Record<string, EvalReport>;
  candidateFixtures: Record<string, EvalReport>;
  longMemEval?: Partial<Record<"S" | "M", ReportPair>>;
  /** External reviewer attestation, not inferred from public fixture or benchmark results. */
  privateAc4?: "pass" | "fail" | "missing";
}
export interface AdoptionVerdict {
  ruleVersion: "f14v2";
  adopt: boolean;
  status: "pass" | "fail" | "incomplete";
  reasons: string[];
  comparisons: Partial<Record<"S" | "M", LongMemEvalComparison>>;
}
function validTarget(target: PreRegisteredTarget | undefined): target is PreRegisteredTarget {
  return !!target && Array.isArray(target.fixtureSets) && Array.isArray(target.longMemEvalTypes)
    && target.fixtureSets.length + target.longMemEvalTypes.length > 0 && target.longMemEvalTypes.length <= 32
    && new Set(target.fixtureSets).size === target.fixtureSets.length && new Set(target.longMemEvalTypes).size === target.longMemEvalTypes.length
    && target.fixtureSets.every(name => FIXTURE_NAMES.includes(name))
    && target.longMemEvalTypes.every(name => typeof name === "string" && /^[a-z][a-z-]{0,63}$/.test(name));
}
function validFixturePair(a: EvalReport | undefined, b: EvalReport | undefined): boolean {
  try {
    if (!a || !b || !Array.isArray(a.ks) || !Array.isArray(b.ks) || !a.all || !b.all || !Array.isArray(a.perQuestion) || !Array.isArray(b.perQuestion)
      || !a.ks.includes(1) || !a.ks.includes(10) || !b.ks.includes(1) || !b.ks.includes(10)
      || a.all.questions <= 0 || a.all.questions !== a.perQuestion.length || a.all.questions !== b.all.questions || b.all.questions !== b.perQuestion.length) return false;
    for (const r of [a, b]) for (const n of [r.all.mrr, r.all.hit[1], r.all.hit[10]]) if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return false;
    const identities = (r: EvalReport) => r.perQuestion.map(q => JSON.stringify([q.q, q.named, q.present, q.missing, q.answerable])).sort();
    const left = identities(a), right = identities(b);
    return new Set(a.perQuestion.map(q => q.q)).size === a.perQuestion.length && left.every((q, i) => q === right[i]);
  } catch { return false; }
}
/** Pure evidence gate. Pre-registration timing and provenance are reviewed against the candidate issue externally. */
export function adopts(input: AdoptionInput): AdoptionVerdict {
  const reasons: string[] = [], comparisons: AdoptionVerdict["comparisons"] = {};
  let incomplete = false, failed = false;
  const missing = (reason: string) => { reasons.push(reason); incomplete = true; };
  const reject = (reason: string) => { reasons.push(reason); failed = true; };
  if (input?.bm25Control === "reported") reasons.push(BM25_REPORTED_NOTICE);
  const target = input?.target;
  if (!validTarget(target)) return { ruleVersion: "f14v2", adopt: false, status: "incomplete", reasons: [...reasons, "an explicit valid pre-registered target is required"], comparisons };
  for (const name of FIXTURE_NAMES) {
    const a = input.baselineFixtures?.[name], b = input.candidateFixtures?.[name];
    if (!validFixturePair(a, b)) { missing(`fixture ${name}: missing, invalid or mismatched reports`); continue; }
    if (target.fixtureSets.includes(name)) {
      if (!(b!.all.mrr! > a!.all.mrr! || b!.all.hit[1]! > a!.all.hit[1]!)) reject(`fixture target ${name}: no MRR or hit@1 gain`);
    }
    if (b!.all.mrr! < a!.all.mrr! || b!.all.hit[1]! < a!.all.hit[1]! || b!.all.hit[10]! < a!.all.hit[10]!) reject(`fixture guardrail ${name}: MRR, hit@1 or hit@10 decreased`);
  }
  for (const dataset of ["S", "M"] as const) {
    const pair = input.longMemEval?.[dataset];
    if (!pair) { missing(`LongMemEval ${dataset}: paired reports required`); continue; }
    try {
      const result = compareLongMemEval(pair.baseline, pair.candidate, target.longMemEvalTypes, { bm25Control: input.bm25Control });
      const full = (report: any) => report.selection?.questionTypes === null && report.selection?.skippedByType === 0 && report.selection?.examined === report.questions;
      if (!full(pair.baseline) || !full(pair.candidate)) { missing(`LongMemEval ${dataset}: full unfiltered dataset reports required`); continue; }
      comparisons[dataset] = result;
      for (const row of result.rows) {
        if (!row.guardrailPass) reject(`LongMemEval ${dataset}/${row.type}/${row.backend}/${row.metric}: significant loss beyond ${row.tolerance}`);
      }
      for (const test of result.targetTests) if (!test.targetGain) reject(`LongMemEval pooled target ${dataset}/${test.backend}: no significant all@10 gain across ${test.types.join(",")}`);
    } catch (error) { missing(`LongMemEval ${dataset}: ${error instanceof Error ? error.message : "invalid evidence"}`); }
  }
  const sReport = input.longMemEval?.S?.baseline as { dataset?: { sha256?: string } } | undefined;
  const mReport = input.longMemEval?.M?.baseline as { dataset?: { sha256?: string } } | undefined;
  if (sReport?.dataset?.sha256 && sReport.dataset.sha256 === mReport?.dataset?.sha256) missing("LongMemEval S/M: distinct dataset identities required");
  if (input.privateAc4 === "fail") reject("private AC4: loss reported by reviewer");
  else if (input.privateAc4 !== "pass") missing("private AC4: reviewer no-loss rerun pending");
  const status = incomplete ? "incomplete" : failed ? "fail" : "pass";
  if (status === "pass") reasons.push("pre-registered target gains and all guardrails pass, including reviewer AC4 attestation");
  return { ruleVersion: "f14v2", adopt: status === "pass", status, reasons, comparisons };
}
export interface GateRow {
  name: string;
  sets: Record<string, { mrr: number; hit1: number; hit10: number; recall10: number; changed: number }>;
  adopt: boolean;
  verdict: AdoptionVerdict;
}
/** Baseline-only by default; old candidate templates require explicit new pre-registration and complete evidence. */
export function runGate(candidates: readonly [string, RankFn][] = CANDIDATES.slice(0, 1), evidence?: Omit<AdoptionInput, "baselineFixtures" | "candidateFixtures">): GateRow[] {
  if (candidates.some(([, rank]) => rank !== baseline) && !validTarget(evidence?.target)) throw Error("pre-register targets before measuring a candidate");
  const loaded = SETS.map(([name, path]) => [name, readEvalSet(path)] as const);
  const reports = (rank?: RankFn) => Object.fromEntries(loaded.map(([name, set]) => [name, evalSeeded(set, KS, rank)])) as Record<string, EvalReport>;
  const base = reports();
  return candidates.map(([name, rank]) => {
    const got = rank === baseline ? base : reports(rank), sets: GateRow["sets"] = {};
    for (const [setName] of SETS) {
      const a = base[setName]!, b = got[setName]!;
      sets[setName] = { mrr: b.all.mrr!, hit1: b.all.hit[1]!, hit10: b.all.hit[10]!, recall10: b.all.recall[10]!,
        changed: b.perQuestion.filter((row, index) => row.rank !== a.perQuestion[index]!.rank).length };
    }
    const verdict = adopts({ target: { fixtureSets: [], longMemEvalTypes: [] }, ...evidence, baselineFixtures: base, candidateFixtures: got });
    return { name, sets, adopt: verdict.adopt, verdict };
  });
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--json") || args.length > 1) throw Error("usage: bun scripts/f14-gate.ts [--json]");
  const rows = runGate();
  if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) {
    console.log(row.name);
    for (const name of FIXTURE_NAMES) console.log(`${name}: ${JSON.stringify(row.sets[name])}`);
    console.log(`F14v2: ${row.verdict.status}; ${row.verdict.reasons.join("; ")}`);
  }
}
