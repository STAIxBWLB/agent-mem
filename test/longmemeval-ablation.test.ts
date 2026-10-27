import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realPath } from "../src/memory/platform.ts";
import { ABLATIONS, ablateSource, runAblations } from "../scripts/longmemeval-ablation.ts";
const source = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");

test("shared recipe transforms are exact and fail closed; legacy transforms remain pinned", () => {
  const helper = source("src/memory/search-score.ts");
  expect(ablateSource(helper, "src/memory/search-score.ts", "baseline")).toBe(helper);
  expect(ablateSource(helper, "src/memory/search-score.ts", "tier-off")).toContain('const TIER_FACTOR: ScoreExpr = { op: "constant", value: 1 };');
  expect(ablateSource(helper, "src/memory/search-score.ts", "recency-off")).toContain('right: { op: "multiply", left: { op: "constant", value: 0 }, right: DENOMINATOR }');
  const both = ablateSource(helper, "src/memory/search-score.ts", "both-off");
  expect(both).toContain('const TIER_FACTOR: ScoreExpr = { op: "constant", value: 1 };');
  expect(both).toContain('right: { op: "multiply", left: { op: "constant", value: 0 }, right: DENOMINATOR }');
  expect(() => ablateSource(helper.replace('const RECENCY_FACTOR: ScoreExpr = { op: "reciprocal", value: DENOMINATOR };', "drifted"), "src/memory/search-score.ts", "baseline")).toThrow("source anchor changed");
  expect(() => ablateSource("unrecognized version", "src/memory/search-score.ts", "recency-off")).toThrow("source anchor changed");

  // Frozen historical anchors keep pinned runtime 8a0f73f compatible without downloading or checking it out in this test.
  const legacyStore = `const recency = (at: string): number => 1 / (1 + Math.max(0, now - Date.parse(at)) / (30 * 24 * 3600_000));\n(view.tier === "long" ? 1 : 0.9)\nscore: -rank * 0.5 * recency(row.at)`;
  const legacyFts = `CASE tier WHEN 'long' THEN 1.0 WHEN 'capture' THEN 0.5 ELSE 0.9 END\n/ (1 + max(0, (julianday(?) - julianday(at)) / 30.0))`;
  expect(ablateSource(legacyStore, "src/memory/store.ts", "baseline")).toBe(legacyStore);
  expect(ablateSource(legacyStore, "src/memory/store.ts", "recency-off")).toContain("const recency = (_at: string): number => 1;");
  expect(ablateSource(legacyStore, "src/memory/store.ts", "tier-off")).toContain("score: -rank * 1 * recency(row.at)");
  expect(ablateSource(legacyFts, "src/memory/search-fts.ts", "both-off")).toContain("/ (1 + 0.0 * max(0, (julianday(?) - julianday(at)) / 30.0))");
  expect(() => ablateSource("drifted", "src/memory/store.ts", "baseline")).toThrow("source anchor changed");
});

test("actual patched screened index isolates age while tier is a uniform capture control", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-ablation-index-")), rankings: Record<string, string[]> = {};
  try {
    for (const mode of ABLATIONS) {
      const dir = join(root, mode, "memory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "search-score.ts"), ablateSource(source("src/memory/search-score.ts"), "src/memory/search-score.ts", mode));
      writeFileSync(join(dir, "search-fts.ts"), source("src/memory/search-fts.ts"));
    }
    for (const mode of ABLATIONS) {
      const file = join(root, mode, "memory", "search-fts.ts");
      const { ScreenedSearchIndex } = await import(pathToFileURL(realPath(file)).href), index = new ScreenedSearchIndex();
      try {
        index.append([{ body: "needle needle needle needle", ref: "old", tier: "capture", at: "2020-01-01T00:00:00Z", value: "old" },
          { body: "needle other other other", ref: "new", tier: "capture", at: "2024-01-01T00:00:00Z", value: "new" }]);
        rankings[mode] = index.best("needle", 2, Date.parse("2024-01-01T00:00:00Z")).map((row: any) => row.value);
      } finally { index.close(); }
    }
    expect(rankings.baseline).toEqual(["new", "old"]);
    expect(rankings["tier-off"]).toEqual(rankings.baseline);
    expect(rankings["recency-off"]).toEqual(["old", "new"]);
    expect(rankings["both-off"]).toEqual(rankings["recency-off"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tier removal changes only relative tier factors at the same age", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-ablation-tiers-"));
  try {
    for (const mode of ["baseline", "tier-off"] as const) {
      const dir = join(root, mode, "memory"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "search-score.ts"), ablateSource(source("src/memory/search-score.ts"), "src/memory/search-score.ts", mode));
      const file = join(dir, "search-fts.ts"); writeFileSync(file, source("src/memory/search-fts.ts"));
      const { ScreenedSearchIndex } = await import(pathToFileURL(realPath(file)).href), index = new ScreenedSearchIndex();
      try {
        index.append(["long", "short", "capture"].map(tier => ({ body: "needle", ref: tier, tier, at: "2024-01-01T00:00:00Z", value: tier })));
        const rows = index.best("needle", 3, Date.parse("2024-01-01T00:00:00Z")), scores = Object.fromEntries(rows.map((row: any) => [row.value, row.score]));
        expect(scores.short / scores.long).toBeCloseTo(mode === "baseline" ? 0.9 : 1, 12);
        expect(scores.capture / scores.long).toBeCloseTo(mode === "baseline" ? 0.5 : 1, 12);
      } finally { index.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("four-runtime matrix keeps fixture corpus/BM25 fixed and removes every temporary checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-ablation-matrix-"));
  try {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(head.exitCode).toBe(0);
    const report = await runAblations({ input: join(import.meta.dir, "fakes/longmemeval-three.json"), outputDir: join(root, "reports"),
      baseCommit: head.stdout.toString().trim(), questionTypes: ["multi-session"] });
    expect(report.runs.map((run: any) => run.mode)).toEqual([...ABLATIONS]);
    expect(report.runs.every((run: any) => run.complete && run.questions === 1 && run.rankingChanges.bm25 === 0)).toBe(true);
    for (const mode of ABLATIONS) {
      const saved = JSON.parse(readFileSync(join(root, "reports", mode + ".json"), "utf8"));
      expect(existsSync(saved.runtime.root)).toBe(false);
    }
    expect(report.runs[0].changes).toHaveLength(1);
    expect(report.runs[0].changes[0].file).toBe("src/memory/search-score.ts");
    expect(report.runs[0].changes.every((file: any) => !file.changed)).toBe(true);
    expect(report.runs.slice(1).every((run: any) => run.changes.length === 1 && run.changes[0].changed)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
