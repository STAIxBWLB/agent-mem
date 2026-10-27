/** Measurement-only factor isolation. Never adds a production ranking switch. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";
import { runLongMemEval } from "./longmemeval.ts";

export const ABLATIONS = ["baseline", "recency-off", "tier-off", "both-off"] as const;
export type Ablation = typeof ABLATIONS[number];
const FILES = ["src/memory/store.ts", "src/memory/search-fts.ts"] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const DRIVER_AT_LOAD = sha(readFileSync(import.meta.filename, "utf8"));
function once(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw Error("ablation source anchor changed: " + from);
  return source.replace(from, to);
}
/** Exact, version-fenced changes only in disposable runtime worktrees. */
export function ablateSource(source: string, file: typeof FILES[number], mode: Ablation): string {
  if (!ABLATIONS.includes(mode)) throw Error("unknown ablation");
  const recency = mode === "recency-off" || mode === "both-off", tier = mode === "tier-off" || mode === "both-off";
  if (file === "src/memory/store.ts") {
    const age = "const recency = (at: string): number => 1 / (1 + Math.max(0, now - Date.parse(at)) / (30 * 24 * 3600_000));";
    source = once(source, age, recency ? "const recency = (_at: string): number => 1;" : age);
    const curated = '(view.tier === "long" ? 1 : 0.9)';
    source = once(source, curated, tier ? "1" : curated);
    const capture = "score: -rank * 0.5 * recency(row.at)";
    return once(source, capture, tier ? "score: -rank * 1 * recency(row.at)" : capture);
  }
  const weight = "CASE tier WHEN 'long' THEN 1.0 WHEN 'capture' THEN 0.5 ELSE 0.9 END";
  source = once(source, weight, tier ? "1.0" : weight);
  const age = "/ (1 + max(0, (julianday(?) - julianday(at)) / 30.0))";
  // Keep the clock bind and valid-date arithmetic identical; zero removes only its ranking effect.
  return once(source, age, recency ? "/ (1 + 0.0 * max(0, (julianday(?) - julianday(at)) / 30.0))" : age);
}
function git(source: string, args: string[]): string {
  const result = memoryGitSync(["-C", source, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: memoryGitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, { repositoryIsolation: true }),
  });
  if (result.status !== 0) throw Error("ablation Git operation failed: " + args[0]);
  return result.stdout.trim();
}
export interface AblationOptions {
  input: string; outputDir: string; baseCommit: string; sourceRoot?: string;
  questionTypes?: readonly string[]; maxQuestions?: number;
}
export async function runAblations(options: AblationOptions): Promise<any> {
  const source = realPath(resolve(options.sourceRoot ?? join(import.meta.dir, ".."))), input = realPath(resolve(options.input));
  if (!/^[a-f0-9]{40}$/.test(options.baseCommit) || git(source, ["rev-parse", options.baseCommit + "^{commit}"]) !== options.baseCommit) throw Error("invalid ablation base commit");
  // A fresh private directory prevents a summary/report path from overwriting input or earlier evidence.
  const output = resolve(options.outputDir); mkdirSync(output, { mode: 0o700 });
  const temporary = mkdtempSync(join(tmpdir(), "amem-lme-ablation-")), runs: any[] = [];
  try {
    for (const mode of ABLATIONS) {
      if (sha(readFileSync(import.meta.filename, "utf8")) !== DRIVER_AT_LOAD) throw Error("ablation driver changed during run");
      const runtime = join(temporary, mode); git(source, ["worktree", "add", "--detach", runtime, options.baseCommit]);
      try {
        const changes = FILES.map(file => {
          const before = readFileSync(join(runtime, file), "utf8"), after = ablateSource(before, file, mode);
          if (after !== before) writeFileSync(join(runtime, file), after);
          return { file, before: sha(before), after: sha(after), changed: before !== after };
        });
        if (mode !== "baseline") {
          git(runtime, ["add", "--", ...FILES]);
          git(runtime, ["-c", "user.name=LongMemEval measurement", "-c", "user.email=benchmark@example.invalid", "commit", "--no-gpg-sign", "-m", "test: isolate " + mode + " for LongMemEval measurement"]);
        }
        const commit = git(runtime, ["rev-parse", "HEAD"]), patch = git(runtime, ["diff", "--no-ext-diff", "--no-textconv", options.baseCommit, "HEAD", "--", ...FILES]);
        const provenance = { mode, baseCommit: options.baseCommit, runtimeCommit: commit, patchSha256: sha(patch), changes, driverSha256: DRIVER_AT_LOAD };
        writeFileSync(join(output, mode + "-provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
        const report = await runLongMemEval({ input, output: join(output, mode + ".json"), sourceRoot: runtime,
          variant: "M-" + mode, questionTypes: options.questionTypes ?? ["knowledge-update", "multi-session"],
          ...(options.maxQuestions === undefined ? {} : { maxQuestions: options.maxQuestions }) });
        if (report.fatal || report.failed.length || (!report.complete && options.maxQuestions === undefined) || process.exitCode) throw Error("incomplete ablation: " + mode);
        if (runs.length) {
          const base = runs[0].report;
          if (report.dataset.sha256 !== base.dataset.sha256 || report.harnessSha256 !== base.harnessSha256 || report.questions !== base.questions) throw Error("ablation controls changed");
          for (let i = 0; i < report.results.length; i++) {
            const a = base.results[i], b = report.results[i];
            if (JSON.stringify([a.id, a.type, a.gold, a.rows, a.rankings.bm25]) !== JSON.stringify([b.id, b.type, b.gold, b.rows, b.rankings.bm25])) throw Error("ablation corpus or BM25 control changed");
          }
        }
        runs.push({ provenance, report });
      } finally { git(source, ["worktree", "remove", "--force", runtime]); }
    }
    // ponytail: these four factors target the fixed capture benchmark, not arbitrary score tuning;
    // add a separately reviewed experiment rather than exposing production ranking flags.
    const summary = { schema: "agent-mem.longmemeval-ablation/v1", baseCommit: options.baseCommit, driverSha256: DRIVER_AT_LOAD,
      runs: runs.map(({ provenance, report }) => ({ ...provenance, dataset: report.dataset, harnessSha256: report.harnessSha256,
        selection: report.selection, questions: report.questions, abstentions: report.abstentions, complete: report.complete,
        metrics: report.metrics, wallMs: report.wallMs,
        rankingChanges: Object.fromEntries(["mcp", "library", "bm25"].map(backend => [backend,
          report.results.filter((q: any, i: number) => JSON.stringify(q.rankings[backend]) !== JSON.stringify(runs[0].report.results[i].rankings[backend])).length])) })) };
    writeFileSync(join(output, "matrix.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    console.log("LONGMEMEVAL_ABLATION " + JSON.stringify(summary)); return summary;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--input", "--output-dir", "--base-commit", "--source-root", "--max-questions"].includes(key) || value === undefined || Object.hasOwn(values, key)) throw Error("invalid ablation arguments");
    values[key] = value;
  }
  if (!values["--input"] || !values["--output-dir"] || !values["--base-commit"]) throw Error("--input, --output-dir and --base-commit are required");
  await runAblations({ input: values["--input"], outputDir: values["--output-dir"], baseCommit: values["--base-commit"],
    ...(values["--source-root"] ? { sourceRoot: values["--source-root"] } : {}),
    ...(values["--max-questions"] ? { maxQuestions: Number(values["--max-questions"]) } : {}) });
}
