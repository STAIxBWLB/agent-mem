/**
 * agent-mem#40 F14: the eval gate for lexical recall changes. Scores each candidate ranking against the committed fixture sets with the SAME code `amem eval` runs
 * (`evalSeeded`, with the candidate passed as its `rank`), so a number here is a number `amem eval` would print for that ranking.
 *
 * The gate is the rule of the issue: a lexical change ships only with an eval gain. A candidate is adopted when it raises MRR or hit@1 on BOTH sets and lowers neither on
 * either. The built-in set was written before F14 and can be fitted by accident, so the held-out set (`test/fixtures/eval-heldout.json`) was written before any candidate ran
 * (the author's record: the history of this branch is squashed, so it no longer shows the order) and is never used to tune: a change that helps only the built-in set does not pass.
 *
 * Usage: bun scripts/f14-gate.ts [--json]
 */
import { evalSeeded, FIXTURE_PATH, readEvalSet, type RankFn } from "../src/memory/eval-fixture.ts";
import type { EvalReport } from "../src/memory/eval.ts";
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

const SETS = [["built-in", FIXTURE_PATH], ["held-out", HELDOUT]] as const;
const KS = [1, 5, 10] as const;
export interface GateRow { name: string; sets: Record<string, { mrr: number; hit1: number; hit10: number; recall10: number; changed: number }>; adopt: boolean }

/**
 * The adoption rule, pure so it is testable: a candidate is adopted when, on EVERY set, it raises MRR or hit@1, and on no set does it lower MRR, hit@1 or hit@10. A change that
 * only matches the baseline is not a gain, and one that helps a set while hurting another is not adopted.
 */
export function adopts(base: Record<string, EvalReport>, got: Record<string, EvalReport>): boolean {
  let better = true, worse = false;
  for (const name of Object.keys(base)) {
    const a = base[name]!, b = got[name]!;
    if (!(b.all.mrr! > a.all.mrr! || b.all.hit[1]! > a.all.hit[1]!)) better = false;
    if (b.all.mrr! < a.all.mrr! || b.all.hit[1]! < a.all.hit[1]! || b.all.hit[10]! < a.all.hit[10]!) worse = true;
  }
  return better && !worse;
}

export function runGate(candidates: readonly [string, RankFn][] = CANDIDATES): GateRow[] {
  const loaded = SETS.map(([name, path]) => [name, readEvalSet(path)] as const);
  const reports = (rank: RankFn) => Object.fromEntries(loaded.map(([name, set]) => [name, evalSeeded(set, KS, rank)])) as Record<string, EvalReport>;
  const base = reports(baseline);
  return candidates.map(([name, rank]) => {
    const got = reports(rank), sets: GateRow["sets"] = {};
    for (const [setName] of SETS) {
      const a = base[setName]!, b = got[setName]!;
      sets[setName] = { mrr: b.all.mrr!, hit1: b.all.hit[1]!, hit10: b.all.hit[10]!, recall10: b.all.recall[10]!,
        changed: b.perQuestion.filter((row, index) => row.rank !== a.perQuestion[index]!.rank).length };
    }
    return { name, sets, adopt: name !== candidates[0]![0] && adopts(base, got) };
  });
}

if (import.meta.main) {
  const rows = runGate();
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`${"candidate".padEnd(38)} ${SETS.map(([name]) => `${name}: MRR / hit@1 / hit@10 / questions moved`.padEnd(46)).join(" ")} adopt`);
    for (const row of rows) console.log(`${row.name.padEnd(38)} ${SETS.map(([name]) => { const s = row.sets[name]!; return `${s.mrr.toFixed(4)} / ${s.hit1.toFixed(3)} / ${s.hit10.toFixed(3)} / ${String(s.changed).padStart(2)}`.padEnd(46); }).join(" ")} ${row.adopt ? "YES" : "no"}`);
  }
}
