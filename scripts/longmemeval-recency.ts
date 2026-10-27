/** #105's fixed, pre-registered runtime variants. No production ranking flag. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";
import { runLongMemEval } from "./longmemeval.ts";
import { hashLongMemEvalFile } from "./longmemeval-input.ts";

export const RECENCY_BASE = "80764b5ad609f7c873bdd3f7490b974cc71b808b";
const DATASETS = {
  S: { sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442", bytes: 277383467 },
  M: { sha256: "9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f", bytes: 2737100077 },
} as const;
export const RECENCY_MODES = ["baseline", "recency-tie", "floor-half"] as const;
export type RecencyMode = typeof RECENCY_MODES[number];
export const RECENCY_FILES = ["src/memory/search-score.ts", "src/memory/store.ts", "src/memory/search-fts.ts"] as const;
export type RecencyFile = typeof RECENCY_FILES[number];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const DRIVER_AT_LOAD = sha(readFileSync(import.meta.filename, "utf8"));
const BASE_HASHES: Record<RecencyFile, string> = {
  "src/memory/search-score.ts": "430b5c3eab721c0fe5ea3e3faa1cbd2a9dbff4e9e24d8a670aec78d90cf793c5",
  "src/memory/store.ts": "ff98b78f0fb9eafba9a20def215734b152148b3d4543464aa6d995a1da737968",
  "src/memory/search-fts.ts": "3f920be7c6c655b5e0706ab6e12ee35a06e2d56acec6cb18d42fa838f3012e51"
};
const TIE_PATCHES: Record<RecencyFile, readonly (readonly [string, string])[]> = {
  "src/memory/search-score.ts": [
    [
      "const SCORE: ScoreExpr = { op: \"multiply\", left: { op: \"multiply\", left: { op: \"negative\", value: { op: \"rank\" } }, right: TIER_FACTOR }, right: RECENCY_FACTOR };",
      "const SCORE: ScoreExpr = { op: \"multiply\", left: { op: \"negative\", value: { op: \"rank\" } }, right: TIER_FACTOR };"
    ],
    [
      "  recencyFactor: number | null;",
      "  recencyFactor: number | null;\n  /** Curve key used only to order exactly equal primary scores. */\n  recencyTieBreaker?: number | null;"
    ],
    [
      "{ rawBm25Rank: string; tierFactor: string; recencyFactor: string }",
      "{ rawBm25Rank: string; tierFactor: string; recencyFactor: string; recencyTieBreaker: string }"
    ],
    [
      "recencyFactor: sql(RECENCY_FACTOR, rank) }",
      "recencyFactor: \"1.0\", recencyTieBreaker: sql(RECENCY_FACTOR, rank) }"
    ],
    [
      "recencyFactor: numeric(RECENCY_FACTOR, rank, tier, at, now), finalScore",
      "recencyFactor: 1, recencyTieBreaker: numeric(RECENCY_FACTOR, rank, tier, at, now), finalScore"
    ]
  ],
  "src/memory/store.ts": [
    [
      "import { rankedScore, rankedScoreDetails, unrankedScoreDetails, type SearchScoreDetails }",
      "import { rankedScore, rankedScoreDetails, unrankedScoreDetails, compareRankedScores, scoreRecencyKey, type SearchScoreDetails }"
    ],
    [
      "* #13 R5: natural-language search over the curated tier and this machine's capture tier, ranked by BM25 with\n   * tier and recency weights (curated outranks capture; a newer row beats an older one at equal text). Visibility",
      "* #13 R5: natural-language search over the curated tier and this machine's capture tier, ranked by BM25 x tier.\n   * Recency orders exactly equal primary scores. Visibility"
    ],
    [
      "hits.sort((a, b) => b.score - a.score || ref(a).localeCompare(ref(b)));",
      "hits.sort((a, b) => compareRankedScores(a.score, a.view?.at ?? a.capture!.at, b.score, b.view?.at ?? b.capture!.at, now) || ref(a).localeCompare(ref(b)));"
    ],
    [
      "for (const view of this.list({ ...f, q })) {\n        const hit: SearchHit = { source: \"curated\", score: 0, view };\n        if (f.explain) hit.scoreDetails = unrankedScoreDetails(\"curated\", hit.score);",
      "for (const view of this.list({ ...f, q })) {\n        const hit: SearchHit = { source: \"curated\", score: 0, view };\n        if (f.explain) hit.scoreDetails = { ...unrankedScoreDetails(\"curated\", hit.score), recencyTieBreaker: scoreRecencyKey(view.at, now) };"
    ]
  ],
  "src/memory/search-fts.ts": [
    [
      "import { rankedScoreSql, rankedScoreSqlDetails, type ScoreFactors }",
      "import { rankedScoreSql, rankedScoreSqlDetails, scoreRecencySql, type ScoreFactors }"
    ],
    [
      "const SCREENED_SCORE = rankedScoreSql(), SCREENED_SUBSTRING_SCORE = rankedScoreSql(\"-1.0\");",
      "const SCREENED_SCORE = rankedScoreSql(), SCREENED_SUBSTRING_SCORE = rankedScoreSql(\"-1.0\");\nconst SCREENED_RECENCY_KEY = scoreRecencySql();"
    ],
    [
      "${factors.recencyFactor} AS recencyFactor`",
      "${factors.recencyFactor} AS recencyFactor, ${factors.recencyTieBreaker} AS recencyTieBreaker`"
    ],
    [
      "ORDER BY score DESC, ref LIMIT ?",
      "ORDER BY score DESC, ${SCREENED_RECENCY_KEY} DESC, ref LIMIT ?"
    ],
    [
      "explain ? statement.all(instant, instant, now, ...(useFts ? [ftsTerms(query)] : []), limit)\n      : statement.all(instant, now, ...(useFts ? [ftsTerms(query)] : []), limit)",
      "explain ? statement.all(instant, now, ...(useFts ? [ftsTerms(query)] : []), instant, limit)\n      : statement.all(now, ...(useFts ? [ftsTerms(query)] : []), instant, limit)"
    ],
    [
      "recencyFactor?: number | null }[]",
      "recencyFactor?: number | null; recencyTieBreaker?: number | null }[]"
    ],
    [
      "recencyFactor: row.recencyFactor ?? null, finalScore",
      "recencyFactor: row.recencyFactor ?? null, recencyTieBreaker: row.recencyTieBreaker ?? null, finalScore"
    ]
  ]
};
const FLOOR_PATCHES: readonly (readonly [string, string])[] = [
  [
    "op: \"add\" | \"multiply\" | \"max\"",
    "op: \"add\" | \"multiply\" | \"max\" | \"min\""
  ],
  [
    "const RECENCY_FACTOR: ScoreExpr = { op: \"reciprocal\", value: DENOMINATOR };",
    "const RECENCY_FACTOR: ScoreExpr = { op: \"reciprocal\", value: { op: \"min\", left: { op: \"constant\", value: 2 }, right: DENOMINATOR } };"
  ],
  [
    "    case \"max\": return Math.max(numeric(expr.left, rank, tier, at, now), numeric(expr.right, rank, tier, at, now));",
    "    case \"max\": return Math.max(numeric(expr.left, rank, tier, at, now), numeric(expr.right, rank, tier, at, now));\n    case \"min\": return Math.min(numeric(expr.left, rank, tier, at, now), numeric(expr.right, rank, tier, at, now));"
  ],
  [
    "    case \"max\": return `max(${get(expr.left)}, ${get(expr.right)})`;",
    "    case \"max\": return `max(${get(expr.left)}, ${get(expr.right)})`;\n    case \"min\": return `min(${get(expr.left)}, ${get(expr.right)})`;"
  ]
];
const TIE_EXPORTS = "\n/** Recency is a secondary key, never a primary-score multiplier. */\nexport function scoreRecencyKey(at: string, now: number): number { return numeric(RECENCY_FACTOR, 0, \"long\", at, now); }\nexport function scoreRecencySql(): string { return sql(RECENCY_FACTOR, \"0.0\"); }\nexport function compareRankedScores(aScore: number, aAt: string, bScore: number, bAt: string, now: number): number {\n  if (aScore !== bScore) return bScore - aScore;\n  return scoreRecencyKey(bAt, now) - scoreRecencyKey(aAt, now);\n}\n";
function once(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw Error("recency source anchor changed: " + from);
  return source.replace(from, to);
}
export function patchRecencySource(source: string, file: RecencyFile, mode: RecencyMode): string {
  if (!RECENCY_MODES.includes(mode) || !RECENCY_FILES.includes(file)) throw Error("unknown recency mode or file");
  // Validate the complete pinned seam even for baseline and unchanged floor files.
  let tie = source;
  for (const [from, to] of TIE_PATCHES[file]) tie = once(tie, from, to);
  if (mode === "recency-tie") return tie + (file === "src/memory/search-score.ts" ? TIE_EXPORTS : "");
  if (mode === "floor-half" && file === "src/memory/search-score.ts") for (const [from, to] of FLOOR_PATCHES) source = once(source, from, to);
  return source;
}
function git(root: string, args: string[], trim = true): string {
  const result = memoryGitSync(["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: memoryGitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, { repositoryIsolation: true }),
  });
  if (result.status !== 0) throw Error("recency Git operation failed: " + args[0]);
  return trim ? result.stdout.trim() : result.stdout;
}
export function prepareRecencyRuntime(sourceRoot: string, mode: RecencyMode) {
  const source = realPath(resolve(sourceRoot));
  if (!RECENCY_MODES.includes(mode) || git(source, ["rev-parse", RECENCY_BASE + "^{commit}"]) !== RECENCY_BASE) throw Error("invalid recency mode or base");
  const temporary = mkdtempSync(join(tmpdir(), "amem-105-runtime-")), runtime = join(temporary, mode);
  let added = false;
  const cleanup = () => { if (added) { git(source, ["worktree", "remove", "--force", runtime]); added = false; } rmSync(temporary, { recursive: true, force: true }); };
  try {
    git(source, ["worktree", "add", "--detach", runtime, RECENCY_BASE]); added = true;
    const changes = RECENCY_FILES.map(file => {
      const before = readFileSync(join(runtime, file), "utf8");
      if (sha(before) !== BASE_HASHES[file]) throw Error("pinned runtime source changed: " + file);
      const after = patchRecencySource(before, file, mode);
      if (after !== before) writeFileSync(join(runtime, file), after);
      return { file, before: sha(before), after: sha(after), changed: after !== before };
    });
    if (mode !== "baseline") {
      git(runtime, ["add", "--", ...RECENCY_FILES]);
      git(runtime, ["-c", "user.name=Recency measurement", "-c", "user.email=benchmark@example.invalid", "commit", "--no-gpg-sign", "-m", "test: measure pre-registered " + mode]);
    }
    const patch = git(runtime, ["diff", "--no-ext-diff", "--no-textconv", RECENCY_BASE, "HEAD", "--", ...RECENCY_FILES], false);
    return { root: runtime, commit: git(runtime, ["rev-parse", "HEAD"]), changes, patch, patchSha256: sha(patch), cleanup };
  } catch (error) { cleanup(); throw error; }
}
async function fileSha(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export interface RecencyConditionOptions { sourceRoot?: string; mode: RecencyMode; input: string; output: string; variant: "S" | "M"; fixturesOutput?: string; maxQuestions?: number }
export async function runRecencyCondition(options: RecencyConditionOptions): Promise<void> {
  if (sha(readFileSync(import.meta.filename, "utf8")) !== DRIVER_AT_LOAD) throw Error("recency driver changed");
  if (!["S", "M"].includes(options.variant)) throw Error("recency variant must be S or M");
  if (options.maxQuestions === undefined) {
    const identity = await hashLongMemEvalFile(realPath(resolve(options.input))), expected = DATASETS[options.variant];
    if (identity.sha256 !== expected.sha256 || identity.bytes !== expected.bytes) throw Error("pre-registered dataset identity mismatch");
  }
  const source = realPath(resolve(options.sourceRoot ?? join(import.meta.dir, "..")));
  const output = resolve(options.output), fixtures = options.fixturesOutput === undefined ? undefined : resolve(options.fixturesOutput);
  const newFiles = [output, output + ".jsonl", output + ".md", output + ".provenance.json", output + ".receipt.json", output + ".patch", ...(fixtures ? [fixtures] : [])];
  if (new Set(newFiles).size !== newFiles.length || newFiles.some(file => existsSync(file))) throw Error("recency output files must be new and distinct");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (fixtures) mkdirSync(dirname(fixtures), { recursive: true, mode: 0o700 });
  const runtime = prepareRecencyRuntime(source, options.mode), originalLog = console.log;
  try {
    const provenance = { issue: 105, mode: options.mode, variant: options.variant, baseCommit: RECENCY_BASE, runtimeCommit: runtime.commit,
      driverSha256: DRIVER_AT_LOAD, patchSha256: runtime.patchSha256, changes: runtime.changes };
    writeFileSync(output + ".provenance.json", JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(output + ".patch", runtime.patch, { mode: 0o600 });
    if (fixtures) {
      const api = await import(pathToFileURL(join(runtime.root, "src/memory/eval-fixture.ts")).href);
      const sets = { "built-in": "src/memory/eval-set.json", "held-out": "test/fixtures/eval-heldout.json", ko: "src/memory/eval-set-ko.json", temporal: "test/fixtures/eval-temporal.json" };
      const reports = Object.fromEntries(Object.entries(sets).map(([name, file]) => [name, api.evalSeeded(api.readEvalSet(join(runtime.root, file)))]));
      writeFileSync(fixtures, JSON.stringify({ ...provenance, reports }, null, 2) + "\n", { mode: 0o600 });
      originalLog("RECENCY_FIXTURES " + JSON.stringify({ mode: options.mode, sets: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, (report as any).all])) }));
    }
    // Keep full evidence on disk; do not stream multi-megabyte corpus metadata to the controller log.
    console.log = (...args: unknown[]) => { if (!(typeof args[0] === "string" && args[0].startsWith("LONGMEMEVAL_REPORT "))) originalLog(...args); };
    const report = await runLongMemEval({ input: options.input, output, sourceRoot: runtime.root, variant: options.variant + "-105-" + options.mode,
      ...(options.maxQuestions === undefined ? {} : { maxQuestions: options.maxQuestions }) });
    if (report.failed.length || report.fatal || (!report.complete && options.maxQuestions === undefined)) throw Error("recency run incomplete or failed");
    if (sha(readFileSync(import.meta.filename, "utf8")) !== DRIVER_AT_LOAD) throw Error("recency driver changed during run");
    const receipt = { ...provenance, complete: report.complete, dataset: { sha256: report.dataset.sha256, bytes: report.dataset.bytes }, harnessSha256: report.harnessSha256,
      reportSha256: await fileSha(output), questions: report.questions, abstentions: report.abstentions, failed: report.failed.length, metrics: report.metrics };
    writeFileSync(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    originalLog("RECENCY_RECEIPT " + JSON.stringify(receipt));
  } finally { console.log = originalLog; runtime.cleanup(); }
}
if (import.meta.main) {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--mode", "--input", "--output", "--variant", "--fixtures-output", "--source-root", "--max-questions"].includes(key) || value === undefined || Object.hasOwn(values, key)) throw Error("invalid recency arguments");
    values[key] = value;
  }
  if (!values["--mode"] || !values["--input"] || !values["--output"] || !["S", "M"].includes(values["--variant"] ?? "")) throw Error("--mode --input --output and --variant S|M are required");
  await runRecencyCondition({ mode: values["--mode"] as RecencyMode, input: values["--input"]!, output: values["--output"]!, variant: values["--variant"] as "S" | "M",
    ...(values["--fixtures-output"] ? { fixturesOutput: values["--fixtures-output"] } : {}), ...(values["--source-root"] ? { sourceRoot: values["--source-root"] } : {}),
    ...(values["--max-questions"] ? { maxQuestions: Number(values["--max-questions"]) } : {}) });
}
