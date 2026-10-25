/**
 * F13 (agent-mem#40, AC7): local recall evaluation. A question set is a list of (question, expected entry) pairs; the evaluation replays each question
 * through a search function and reports recall@k, hit@k and MRR. No model judge, no network, no embedding: a result either is one of the expected
 * entries or it is not. This leaf has no imports, so the parser and the arithmetic are testable without a store.
 *
 * Two shapes of set:
 *  - self-contained: `entries` are synthetic notes seeded into a throwaway store, and `expect` names them by `key` (the committed fixture is one);
 *  - the person's own: no `entries`, `expect` holds real entry ids (or `mem:<id>`, or a prefix of 8 or more hex characters) and the bound project's store is searched.
 */
export const EVAL_SCHEMA = "amem.eval/v1";
export const MAX_QUESTIONS = 500, MAX_ENTRIES = 200, MAX_QUESTION_CHARS = 500, MAX_EXPECT = 20, MAX_ENTRY_CHARS = 4000, MAX_SET_BYTES = 1024 * 1024, MAX_K = 100;
export const DEFAULT_KS: readonly number[] = [1, 5, 10];

export const EVAL_KINDS = ["decision", "finding", "contract", "fail"] as const;
export interface EvalEntry { key: string; title?: string; text: string; kind?: (typeof EVAL_KINDS)[number]; tier?: "short" | "long"; about?: string[] }
/** `tag` is an optional label for what a question probes (a test counts them); it never changes the scoring. */
export interface EvalQuestion { q: string; expect: string[]; tag?: string }
export interface EvalSet { schema: typeof EVAL_SCHEMA; entries?: EvalEntry[]; questions: EvalQuestion[] }

const fail = (message: string): never => { throw new Error(`invalid eval set: ${message}`); };
const object = (value: unknown, what: string): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : fail(`${what} must be an object`);
function exact(row: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`${what} has an unknown key "${key.slice(0, 40)}"`);
}
const text = (value: unknown, what: string, max: number): string => typeof value === "string" && value.trim() !== "" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : fail(`${what} must be a non-empty string of at most ${max} characters`);

/** Strict, bounded parse of untrusted JSON. Unknown keys are errors, so a typo cannot silently change what is measured. */
export function parseEvalSet(raw: unknown): EvalSet {
  const root = object(raw, "the set");
  exact(root, ["schema", "entries", "questions"], "the set");
  if (root.schema !== EVAL_SCHEMA) fail(`schema must be "${EVAL_SCHEMA}"`);
  const entries: EvalEntry[] = [], keys = new Set<string>();
  if (root.entries !== undefined) {
    if (!Array.isArray(root.entries) || !root.entries.length || root.entries.length > MAX_ENTRIES) fail(`entries must hold 1 to ${MAX_ENTRIES} items when present`);
    for (const [index, item] of (root.entries as unknown[]).entries()) {
      const row = object(item, `entries[${index}]`);
      exact(row, ["key", "title", "text", "kind", "tier", "about"], `entries[${index}]`);
      const key = text(row.key, `entries[${index}].key`, 80);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) fail(`entries[${index}].key may use letters, digits, ".", "_" and "-"`);
      if (keys.has(key)) fail(`entries[${index}].key "${key}" repeats`);
      keys.add(key);
      const kind = row.kind === undefined ? undefined : (EVAL_KINDS as readonly unknown[]).includes(row.kind) ? row.kind as EvalEntry["kind"] : fail(`entries[${index}].kind must be one of ${EVAL_KINDS.join(", ")}`);
      const tier = row.tier === undefined ? undefined : row.tier === "short" || row.tier === "long" ? row.tier : fail(`entries[${index}].tier must be short or long`);
      const about = row.about === undefined ? undefined : Array.isArray(row.about) && row.about.length <= 20 ? (row.about as unknown[]).map((value, at) => text(value, `entries[${index}].about[${at}]`, 200)) : fail(`entries[${index}].about must be a list of at most 20 strings`);
      entries.push({ key, text: text(row.text, `entries[${index}].text`, MAX_ENTRY_CHARS), ...(row.title === undefined ? {} : { title: text(row.title, `entries[${index}].title`, 200) }), ...(kind ? { kind } : {}), ...(tier ? { tier } : {}), ...(about ? { about } : {}) });
    }
  }
  if (!Array.isArray(root.questions) || !root.questions.length || root.questions.length > MAX_QUESTIONS) fail(`questions must hold 1 to ${MAX_QUESTIONS} items`);
  const questions = (root.questions as unknown[]).map((item, index): EvalQuestion => {
    const row = object(item, `questions[${index}]`);
    exact(row, ["q", "expect", "tag"], `questions[${index}]`);
    const tag = row.tag === undefined ? undefined : typeof row.tag === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(row.tag) ? row.tag : fail(`questions[${index}].tag must be 1 to 40 characters of a-z, 0-9 and "-", starting with a letter`);
    if (!Array.isArray(row.expect) || !row.expect.length || row.expect.length > MAX_EXPECT) fail(`questions[${index}].expect must hold 1 to ${MAX_EXPECT} entries`);
    const expect = [...new Set((row.expect as unknown[]).map((value, at) => text(value, `questions[${index}].expect[${at}]`, 80)))];
    for (const name of expect) {
      if (keys.size && !keys.has(name)) fail(`questions[${index}].expect names "${name.slice(0, 40)}", which is not an entry key`);
      if (!keys.size && !/^(?:mem:)?[0-9a-f]{8,32}$/.test(name)) fail(`questions[${index}].expect must be an entry id, optionally written mem:<id> as a brief prints it, or a prefix of 8 or more hex characters when the set has no entries`);
    }
    return { q: text(row.q, `questions[${index}].q`, MAX_QUESTION_CHARS), expect, ...(tag ? { tag } : {}) };
  });
  return { schema: EVAL_SCHEMA, ...(entries.length ? { entries } : {}), questions };
}

/** `--k 1,5,10`: ascending, unique, 1 to MAX_K. */
export function parseKs(value: string | undefined): number[] {
  if (value === undefined) return [...DEFAULT_KS];
  const parts = value.split(",").map(part => part.trim());
  const ks = parts.map(part => /^[0-9]{1,3}$/.test(part) ? Number(part) : NaN);
  if (!ks.length || ks.some(k => !Number.isInteger(k) || k < 1 || k > MAX_K)) throw new Error(`--k must be a comma-separated list of integers from 1 to ${MAX_K}`);
  return [...new Set(ks)].sort((a, b) => a - b);
}

export interface EvalQuestionResult {
  q: string;
  /** True when at least one expected entry exists in the searched store. Only those can be recalled. */
  answerable: boolean;
  /** 1-based rank of the first expected result, or null when none is in the examined window. */
  rank: number | null;
  /** How many of the question's present entries are within each k. */
  found: Record<number, number>;
  /** Names the question lists. */
  named: number;
  /** Distinct entries those names stand for in this store. A second name for the same entry adds nothing. */
  present: number;
  /** Distinct names the store holds no entry for. */
  missing: number;
}
/** `recall` and `hit` are null when no question counts (no answerable question), never 0: an empty average is not a measured zero. */
export interface EvalAggregate { questions: number; recall: Record<number, number | null>; hit: Record<number, number | null>; mrr: number | null }
export interface EvalReport {
  /** The search that was scored: the ranked, project-scoped `store.search` (BM25 with tier and recency weights) that MCP and hub recall use, NOT the `amem search` command's substring filter. */
  engine: string;
  ks: number[];
  /** Every question. A question whose expected entry is not in the store scores 0, as a search that cannot find it would. */
  all: EvalAggregate;
  /** Only questions with at least one present entry, scored over their present entries only: what the ranking alone achieved. */
  answerable: EvalAggregate;
  perQuestion: EvalQuestionResult[];
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
function aggregate(rows: readonly EvalQuestionResult[], ks: readonly number[], every: boolean): EvalAggregate {
  const mean = (pick: (row: EvalQuestionResult) => number): number | null => rows.length ? round(rows.reduce((sum, row) => sum + pick(row), 0) / rows.length) : null;
  // In `all` the denominator is every distinct thing the question wanted (present entries plus names with no entry), so a question with nothing present scores 0; in `answerable`
  // only the present entries count.
  const denominator = (row: EvalQuestionResult) => every ? row.present + row.missing : row.present;
  return {
    questions: rows.length,
    recall: Object.fromEntries(ks.map(k => [k, mean(row => denominator(row) ? row.found[k]! / denominator(row) : 0)])),
    hit: Object.fromEntries(ks.map(k => [k, mean(row => row.rank !== null && row.rank <= k ? 1 : 0)])),
    mrr: mean(row => row.rank === null ? 0 : 1 / row.rank),
  };
}

/**
 * Score a ranking. `rank(question)` returns the ranked entry ids, best first, at least `max(ks)` of them. `resolve(question)` returns, for each expected name of that question, the ONE
 * entry id it stands for, or undefined when the store holds none (it is called once per question, never inside the ranking loop, and may throw to refuse an ambiguous name).
 * Two names for the same entry count once. recall@k is the share of a question's present entries within the first k results, hit@k is whether any is, and MRR is the mean of
 * 1/rank of the first expected result.
 */
export function runEval(rank: (question: string) => readonly string[], resolve: (question: EvalQuestion) => readonly (string | undefined)[], set: EvalSet, engine: string, ks: readonly number[] = DEFAULT_KS): EvalReport {
  const window = Math.max(...ks);
  const perQuestion = set.questions.map((question): EvalQuestionResult => {
    const resolved = resolve(question);
    const wanted = new Set(resolved.filter((id): id is string => id !== undefined));
    const ranked = [...new Set(rank(question.q))].slice(0, window);
    const found: Record<number, number> = Object.fromEntries(ks.map(k => [k, 0]));
    let first: number | null = null;
    ranked.forEach((id, index) => {
      if (!wanted.has(id)) return;
      first ??= index + 1;
      for (const k of ks) if (index + 1 <= k) found[k]!++;
    });
    const missing = new Set(question.expect.filter((_, index) => resolved[index] === undefined)).size;
    return { q: question.q, answerable: wanted.size > 0, rank: first, found, named: question.expect.length, present: wanted.size, missing };
  });
  return { engine, ks: [...ks], all: aggregate(perQuestion, ks, true), answerable: aggregate(perQuestion.filter(row => row.answerable), ks, false), perQuestion };
}

const pct = (value: number | null): string => value === null ? "  n/a" : value.toFixed(3);
/** Human text for `amem eval`; the JSON report is the machine form. */
export function evalText(report: EvalReport, label: string): string {
  const head = (name: string, row: EvalAggregate) => `${name.padEnd(11)} ${String(row.questions).padStart(4)}  ${report.ks.map(k => `${pct(row.recall[k] ?? null)}/${pct(row.hit[k] ?? null)}`.padStart(13)).join(" ")}  ${pct(row.mrr).padStart(6)}`;
  return [
    `eval: ${label} (${report.engine === "substring" ? "substring fallback" : "ranked store.search, engine " + report.engine}; this is the ranking MCP and hub recall use, not the \`amem search\` filter)`,
    `${"".padEnd(11)} ${"n".padStart(4)}  ${report.ks.map(k => `@${k} recall/hit`.padStart(13)).join(" ")}  ${"MRR".padStart(6)}`,
    head("all", report.all),
    head("answerable", report.answerable),
    ...(report.answerable.questions < report.all.questions ? [`${report.all.questions - report.answerable.questions} question(s) name an entry this store does not hold (they score 0 in "all")`] : []),
    ...report.perQuestion.filter(row => row.rank === null || row.rank > Math.min(...report.ks)).map(row => `  ${row.rank === null ? "miss" : `rank ${row.rank}`}${row.answerable ? "" : " (not in store)"}: ${row.q.slice(0, 100)}`),
  ].join("\n");
}
