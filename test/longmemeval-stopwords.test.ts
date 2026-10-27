import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STOPWORD_FILE, patchStopwordSource, prepareStopwordRuntime } from "../scripts/longmemeval-stopwords.ts";

const source = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const WORDS = ["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with"];
const quoted = (...terms: string[]) => terms.map((term) => `"${term}" *`).join(" OR ");

test("fixed Lucene33 transform is exact, baseline is identity, and drift or unknown modes fail closed", () => {
  const original = source(STOPWORD_FILE);
  expect(patchStopwordSource(original, "baseline")).toBe(original);
  expect(patchStopwordSource(original, "stopwords")).not.toBe(original);
  expect(() => patchStopwordSource(original.replace("const KOREAN_PARTICLES =", "const PARTICLES ="), "stopwords")).toThrow("source anchor changed");
  expect(() => patchStopwordSource(original, "other" as "baseline")).toThrow("unknown stopword mode");
});

test("private baseline and fixed candidate runtimes preserve only the exact lowercase whole-word list", async () => {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(head.exitCode).toBe(0);
  const baseline = prepareStopwordRuntime(join(import.meta.dir, ".."), head.stdout.toString().trim(), "baseline");
  const candidate = prepareStopwordRuntime(join(import.meta.dir, ".."), head.stdout.toString().trim(), "stopwords");
  try {
    const baseModule = await import(pathToFileURL(join(baseline.root, STOPWORD_FILE)).href);
    const candidateModule = await import(pathToFileURL(join(candidate.root, STOPWORD_FILE)).href);
    for (const word of WORDS) {
      expect(candidateModule.ftsTerms(`${word} needle`)).toBe(quoted("needle"));
      expect(candidateModule.ftsTerms(`${word.toUpperCase()} needle`)).toBe(quoted("needle"));
    }
    expect(baseModule.ftsTerms("the needle")).toBe(quoted("the", "needle"));
    expect(candidateModule.ftsTerms("what did i say about deploy")).toBe(quoted("what", "did", "i", "say", "about", "deploy"));
    expect(candidateModule.ftsTerms("i did about have were therefore android")).toBe(quoted("i", "did", "about", "have", "were", "therefore", "android"));
    expect(candidateModule.ftsTerms("therefore android needle")).toBe(quoted("therefore", "android", "needle"));
  } finally {
    candidate.cleanup();
    baseline.cleanup();
  }
});

test("single stopwords, all-stopword fallback, Korean variants, punctuation, and bounded windows retain contract", async () => {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(head.exitCode).toBe(0);
  const baseline = prepareStopwordRuntime(join(import.meta.dir, ".."), head.stdout.toString().trim(), "baseline");
  const candidate = prepareStopwordRuntime(join(import.meta.dir, ".."), head.stdout.toString().trim(), "stopwords");
  try {
    const baseModule = await import(pathToFileURL(join(baseline.root, STOPWORD_FILE)).href);
    const candidateModule = await import(pathToFileURL(join(candidate.root, STOPWORD_FILE)).href);
    expect(candidateModule.ftsTerms("the")).toBe(quoted("the"));
    expect(candidateModule.ftsTerms("the and of")).toBe(baseModule.ftsTerms("the and of"));
    expect(candidateModule.ftsTerms("the 메모리는 to")).toBe(quoted("메모리는", "메모리"));
    expect(candidateModule.ftsTerms('"the" (needle)!')).toBe(quoted("needle"));

    const first32Stopwords = WORDS.slice(0, 32).join(" ");
    expect(candidateModule.ftsTerms(`${first32Stopwords} needle`)).toBe(baseModule.ftsTerms(`${first32Stopwords} needle`));
    expect(candidateModule.ftsTerms(`${first32Stopwords} needle`)).not.toContain("needle");
    const withKoreanVariants = Array.from({ length: 32 }, (_, index) => `메모리${index}는`).join(" ");
    expect(candidateModule.ftsTerms(withKoreanVariants).split(" OR ")).toHaveLength(64);
    expect(candidateModule.ftsTerms(withKoreanVariants)).toBe(baseModule.ftsTerms(withKoreanVariants));
  } finally {
    candidate.cleanup();
    baseline.cleanup();
  }
});

test("runtime metadata pins source changes to search-fts and leaves baseline bytes untouched", () => {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(head.exitCode).toBe(0);
  const root = join(import.meta.dir, "..");
  const baseline = prepareStopwordRuntime(root, head.stdout.toString().trim(), "baseline");
  const candidate = prepareStopwordRuntime(root, head.stdout.toString().trim(), "stopwords");
  try {
    const original = readFileSync(join(baseline.root, STOPWORD_FILE), "utf8");
    expect(baseline.changes).toEqual([{ file: STOPWORD_FILE, before: sha(original), after: sha(original), changed: false }]);
    expect(baseline.patch).toBe("");
    expect(candidate.changes).toHaveLength(1);
    expect(candidate.changes[0]!.file).toBe(STOPWORD_FILE);
    expect(candidate.changes[0]!.before).toBe(sha(original));
    expect(candidate.changes[0]!.changed).toBe(true);
    expect(candidate.patch).toContain("LUCENE_ENGLISH_STOPWORDS");
  } finally {
    candidate.cleanup();
    baseline.cleanup();
  }
});
