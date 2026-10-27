/** #104's fixed Lucene33 query-preparation candidate; no production flag. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLongMemEval } from "./longmemeval.ts";
import { hashLongMemEvalFile } from "./longmemeval-input.ts";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";

export const STOPWORD_BASE = "6d557ad6c9df158d25e312f9f751b37fc0d2499a";
export const STOPWORD_TARGET_TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "knowledge-update", "temporal-reasoning"] as const;
const DATASETS = {
  S: { sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442", bytes: 277383467 },
  M: { sha256: "9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f", bytes: 2737100077 },
} as const;
export const STOPWORD_MODES = ["baseline", "stopwords"] as const;
export type StopwordMode = typeof STOPWORD_MODES[number];
export const STOPWORD_FILE = "src/memory/search-fts.ts";
const WORDS = ["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with"] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const DRIVER_AT_LOAD = sha(readFileSync(import.meta.filename, "utf8"));
function once(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw Error("stopword source anchor changed: " + from);
  return source.replace(from, to);
}
export function patchStopwordSource(source: string, mode: StopwordMode): string {
  if (!STOPWORD_MODES.includes(mode)) throw Error("unknown stopword mode");
  const declaration = `/** Fixed Lucene EnglishAnalyzer set (#104); no query-dependent list or tuning. */\nconst LUCENE_ENGLISH_STOPWORDS: ReadonlySet<string> = new Set(${JSON.stringify(WORDS)});\n\n`;
  const marked = once(source, "const KOREAN_PARTICLES =", declaration + "const KOREAN_PARTICLES =");
  const old = '  return variants.map((t) => `"${t.replaceAll(\'"\', \'""\')}" *`).join(" OR ");';
  const candidate = once(marked, old, '  const informative = variants.filter(term => !LUCENE_ENGLISH_STOPWORDS.has(term));\n  const selected = informative.length ? informative : variants;\n  return selected.map((t) => `"${t.replaceAll(\'"\', \'""\')}" *`).join(" OR ");');
  return mode === "baseline" ? source : candidate;
}
function git(root: string, args: string[], trim = true): string {
  const result = memoryGitSync(["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: memoryGitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, { repositoryIsolation: true }),
  });
  if (result.status !== 0) throw Error("stopword Git operation failed: " + args[0]);
  return trim ? result.stdout.trim() : result.stdout;
}
/** Caller fixes the post-#105 baseline before measurement; constructing a runtime never fetches a ref. */
export function prepareStopwordRuntime(sourceRoot: string, baseCommit: string, mode: StopwordMode) {
  const source = realPath(resolve(sourceRoot));
  if (!STOPWORD_MODES.includes(mode) || !/^[a-f0-9]{40}$/.test(baseCommit) || git(source, ["rev-parse", baseCommit + "^{commit}"]) !== baseCommit) throw Error("invalid stopword mode or base");
  const temporary = mkdtempSync(join(tmpdir(), "amem-104-runtime-")), root = join(temporary, mode);
  let added = false;
  const cleanup = () => { if (added) { git(source, ["worktree", "remove", "--force", root]); added = false; } rmSync(temporary, { recursive: true, force: true }); };
  try {
    git(source, ["worktree", "add", "--detach", root, baseCommit]); added = true;
    const before = readFileSync(join(root, STOPWORD_FILE), "utf8"), after = patchStopwordSource(before, mode);
    if (after !== before) {
      writeFileSync(join(root, STOPWORD_FILE), after);
      git(root, ["add", "--", STOPWORD_FILE]);
      git(root, ["-c", "user.name=Stopword measurement", "-c", "user.email=benchmark@example.invalid", "commit", "--no-gpg-sign", "-m", "test: measure pre-registered Lucene33 stopwords"]);
    }
    const patch = git(root, ["diff", "--no-ext-diff", "--no-textconv", baseCommit, "HEAD", "--", STOPWORD_FILE], false);
    return { root, commit: git(root, ["rev-parse", "HEAD"]), changes: [{ file: STOPWORD_FILE, before: sha(before), after: sha(after), changed: before !== after }], patch, patchSha256: sha(patch), cleanup };
  } catch (error) { cleanup(); throw error; }
}

async function fileSha(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export interface StopwordConditionOptions { sourceRoot?: string; mode: StopwordMode; input: string; output: string; variant: "S" | "M"; fixturesOutput?: string; maxQuestions?: number }
export async function runStopwordCondition(options: StopwordConditionOptions): Promise<void> {
  if (sha(readFileSync(import.meta.filename, "utf8")) !== DRIVER_AT_LOAD || !STOPWORD_MODES.includes(options.mode) || !["S", "M"].includes(options.variant)) throw Error("stopword driver/mode/variant changed or invalid");
  const source = realPath(resolve(options.sourceRoot ?? join(import.meta.dir, ".."))), output = resolve(options.output), fixtures = options.fixturesOutput === undefined ? undefined : resolve(options.fixturesOutput);
  const newFiles = [output, output + ".jsonl", output + ".md", output + ".provenance.json", output + ".receipt.json", output + ".patch", ...(fixtures ? [fixtures] : [])];
  if (new Set(newFiles).size !== newFiles.length || newFiles.some(file => existsSync(file))) throw Error("stopword output files must be new and distinct");
  if (options.maxQuestions === undefined) {
    const identity = await hashLongMemEvalFile(realPath(resolve(options.input))), expected = DATASETS[options.variant];
    if (identity.sha256 !== expected.sha256 || identity.bytes !== expected.bytes) throw Error("pre-registered dataset identity mismatch");
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (fixtures) mkdirSync(dirname(fixtures), { recursive: true, mode: 0o700 });
  const runtime = prepareStopwordRuntime(source, STOPWORD_BASE, options.mode), originalLog = console.log;
  try {
    const provenance = { issue: 104, mode: options.mode, variant: options.variant, baseCommit: STOPWORD_BASE, runtimeCommit: runtime.commit,
      driverSha256: DRIVER_AT_LOAD, patchSha256: runtime.patchSha256, changes: runtime.changes };
    writeFileSync(output + ".provenance.json", JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(output + ".patch", runtime.patch, { mode: 0o600 });
    if (fixtures) {
      const api = await import(pathToFileURL(join(runtime.root, "src/memory/eval-fixture.ts")).href);
      const sets = { "built-in": "src/memory/eval-set.json", "held-out": "test/fixtures/eval-heldout.json", ko: "src/memory/eval-set-ko.json", temporal: "test/fixtures/eval-temporal.json" };
      const reports = Object.fromEntries(Object.entries(sets).map(([name, file]) => [name, api.evalSeeded(api.readEvalSet(join(runtime.root, file)))]));
      writeFileSync(fixtures, JSON.stringify({ ...provenance, reports }, null, 2) + "\n", { mode: 0o600 });
      originalLog("STOPWORD_FIXTURES " + JSON.stringify({ mode: options.mode, sets: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, (report as any).all])) }));
    }
    console.log = (...args: unknown[]) => { if (!(typeof args[0] === "string" && args[0].startsWith("LONGMEMEVAL_REPORT "))) originalLog(...args); };
    const report = await runLongMemEval({ input: options.input, output, sourceRoot: runtime.root, variant: options.variant + "-104-" + options.mode,
      ...(options.maxQuestions === undefined ? {} : { maxQuestions: options.maxQuestions }) });
    if (report.failed.length || report.fatal || (!report.complete && options.maxQuestions === undefined)) throw Error("stopword run incomplete or failed");
    if (sha(readFileSync(import.meta.filename, "utf8")) !== DRIVER_AT_LOAD) throw Error("stopword driver changed during run");
    const receipt = { ...provenance, complete: report.complete, dataset: { sha256: report.dataset.sha256, bytes: report.dataset.bytes }, harnessSha256: report.harnessSha256,
      reportSha256: await fileSha(output), questions: report.questions, abstentions: report.abstentions, failed: report.failed.length, metrics: report.metrics };
    writeFileSync(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    originalLog("STOPWORD_RECEIPT " + JSON.stringify(receipt));
  } finally { console.log = originalLog; runtime.cleanup(); }
}
if (import.meta.main) {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--mode", "--input", "--output", "--variant", "--fixtures-output", "--source-root", "--max-questions"].includes(key) || value === undefined || Object.hasOwn(values, key)) throw Error("invalid stopword arguments");
    values[key] = value;
  }
  if (!values["--mode"] || !values["--input"] || !values["--output"] || !["S", "M"].includes(values["--variant"] ?? "")) throw Error("--mode --input --output and --variant S|M are required");
  await runStopwordCondition({ mode: values["--mode"] as StopwordMode, input: values["--input"]!, output: values["--output"]!, variant: values["--variant"] as "S" | "M",
    ...(values["--fixtures-output"] ? { fixturesOutput: values["--fixtures-output"] } : {}), ...(values["--source-root"] ? { sourceRoot: values["--source-root"] } : {}),
    ...(values["--max-questions"] ? { maxQuestions: Number(values["--max-questions"]) } : {}) });
}
