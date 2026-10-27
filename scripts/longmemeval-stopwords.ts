/** #104's fixed Lucene33 query-preparation candidate; no production flag. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoryGitEnv, memoryGitSync, realPath } from "../src/memory/platform.ts";

export const STOPWORD_MODES = ["baseline", "stopwords"] as const;
export type StopwordMode = typeof STOPWORD_MODES[number];
export const STOPWORD_FILE = "src/memory/search-fts.ts";
const WORDS = ["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with"] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
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
