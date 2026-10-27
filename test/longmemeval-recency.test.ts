import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RECENCY_FILES, RECENCY_MODES, patchRecencySource, prepareRecencyRuntime } from "../scripts/longmemeval-recency.ts";
import type { ScoreFactors } from "../src/memory/search-score.ts";
import type { SearchHit } from "../src/memory/store.ts";

type RuntimeHit = { value: { id: string }; score: number; scoreDetails?: ScoreFactors & { recencyTieBreaker?: number | null } };

const sourceRoot = join(import.meta.dir, "..");
const now = Date.parse("2026-10-26T12:34:56.789Z"), day = 86_400_000;
const iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();

test("recency transform validates the frozen seam and baseline is byte-identical", () => {
  expect(RECENCY_MODES).toEqual(["baseline", "recency-tie", "floor-half"]);
  const runtime = prepareRecencyRuntime(sourceRoot, "baseline");
  try {
    for (const file of RECENCY_FILES) {
      const source = readFileSync(join(runtime.root, file), "utf8");
      const anchor = file === "src/memory/search-score.ts" ? "const SCORE:" : file === "src/memory/store.ts"
        ? "hits.sort((a, b) => b.score - a.score || ref(a).localeCompare(ref(b)));"
        : "ORDER BY score DESC, ref LIMIT ?";
      expect(patchRecencySource(source, file, "baseline")).toBe(source);
      expect(() => patchRecencySource(source.replace(anchor, "drifted source anchor"), file, "baseline")).toThrow("recency source anchor changed");
      expect(() => patchRecencySource(source, file, "unknown" as never)).toThrow("unknown recency mode or file");
    }
  } finally { runtime.cleanup(); }
});

test("floor-half uses the old maximum curve at future, current, and aged timestamps", async () => {
  const runtime = prepareRecencyRuntime(sourceRoot, "floor-half");
  try {
    const score = await import(pathToFileURL(join(runtime.root, "src/memory/search-score.ts")).href);
    const { ScreenedSearchIndex } = await import(pathToFileURL(join(runtime.root, "src/memory/search-fts.ts")).href);
    for (const daysAgo of [-3, 0, 30, 365]) {
      const oldFactor = 1 / (1 + Math.max(0, daysAgo / 30));
      const expectedFactor = Math.max(0.5, oldFactor);
      expect(score.rankedScore(-2, "long", iso(daysAgo), now)).toBe(-(-2) * expectedFactor);
    }
    expect(score.rankedScoreSql()).toContain(" / ");
    const index = new ScreenedSearchIndex();
    try {
      index.append([{ ref: "aged-floor", body: "needle", tier: "long", at: iso(365), value: { id: "aged-floor" } }]);
      const [hit] = index.best("needle", 1, now, false, true) as RuntimeHit[];
      expect(hit?.score).toBe(0.5);
      expect(hit?.scoreDetails?.recencyFactor).toBe(0.5);
      expect(hit?.scoreDetails?.rawBm25Rank).toBeNull();
    } finally { index.close(); }
  } finally { runtime.cleanup(); }
});

test("exact primary scores use recency only as a secondary key, without epsilon bins", async () => {
  const runtime = prepareRecencyRuntime(sourceRoot, "recency-tie");
  try {
    const score = await import(pathToFileURL(join(runtime.root, "src/memory/search-score.ts")).href);
    const old = iso(30), recent = iso(0);
    expect(score.compareRankedScores(1, old, 1, recent, now)).toBeGreaterThan(0);
    expect(score.compareRankedScores(1 + Number.EPSILON, old, 1, recent, now)).toBeLessThan(0);
    expect(score.compareRankedScores(1, old, 1 + Number.EPSILON, recent, now)).toBeGreaterThan(0);
    expect(score.compareRankedScores(1, recent, 1, old, now)).toBeLessThan(0);
    expect(score.scoreRecencyKey(recent, now)).toBe(1);
  } finally { runtime.cleanup(); }
});

test("screened FTS and substring ranking keep strict score order and explain the tie curve", async () => {
  const runtime = prepareRecencyRuntime(sourceRoot, "recency-tie");
  try {
    const { ScreenedSearchIndex, fts5Available } = await import(pathToFileURL(join(runtime.root, "src/memory/search-fts.ts")).href);
    for (const useFts of [true, false]) {
      if (useFts && !fts5Available()) continue;
      const index = new ScreenedSearchIndex();
      try {
        index.append([
          { ref: "old", body: "needle ordinary", tier: "long", at: iso(30), value: { id: "old" } },
          { ref: "new", body: "needle ordinary", tier: "long", at: iso(0), value: { id: "new" } },
          { ref: "z-stable", body: "needle ordinary", tier: "long", at: iso(0), value: { id: "z" } },
          { ref: "a-stable", body: "needle ordinary", tier: "long", at: iso(0), value: { id: "a" } },
          { ref: "weaker", body: "needle ordinary filler words", tier: "short", at: iso(0), value: { id: "weaker" } },
          { ref: "expired-strong", body: "needle", tier: "long", at: iso(0), expiresAt: iso(0), value: { id: "expired" } },
          { ref: "live-expiring", body: "needle ordinary filler words", tier: "short", at: iso(0), expiresAt: iso(-1), value: { id: "live" } },
        ]);
        const plain = index.best("needle", 10, now, useFts) as RuntimeHit[];
        const explained = index.best("needle", 10, now, useFts, true) as RuntimeHit[];
        expect(plain.some(hit => hit.value.id === "expired")).toBe(false);
        expect(plain.some(hit => hit.value.id === "live")).toBe(true);
        expect(explained.map(({ scoreDetails: _details, ...hit }) => hit)).toEqual(plain);
        expect(plain.findIndex(hit => hit.value.id === "new")).toBeLessThan(plain.findIndex(hit => hit.value.id === "old"));
        expect(plain.findIndex(hit => hit.value.id === "a")).toBeLessThan(plain.findIndex(hit => hit.value.id === "z"));
        for (let i = 1; i < plain.length; i++) expect(plain[i - 1]!.score).toBeGreaterThanOrEqual(plain[i]!.score);
        for (const hit of explained) {
          expect(hit.scoreDetails?.finalScore).toBe(hit.score);
          expect(hit.scoreDetails?.matchMode).toBe(useFts ? "fts5" : "substring");
          expect(hit.scoreDetails?.recencyFactor).toBe(1);
          expect(hit.scoreDetails?.recencyTieBreaker).toBeCloseTo(scoreKey(hit.value.id === "old" ? iso(30) : iso(0), now), 10);
          if (useFts) expect(hit.scoreDetails?.rawBm25Rank).toBeLessThan(0);
          else expect(hit.scoreDetails?.rawBm25Rank).toBeNull();
        }
      } finally { index.close(); }
    }
  } finally { runtime.cleanup(); }
});

test("MemoryStore ranks identical older and newer notes by recency after primary score", async () => {
  const runtime = prepareRecencyRuntime(sourceRoot, "recency-tie");
  try {
    const { MemoryStore } = await import(pathToFileURL(join(runtime.root, "src/memory/store.ts")).href);
    const root = join(runtime.root, ".recency-test-home");
    let clock = now - 30 * day;
    const store = new MemoryStore({ home: root, now: () => clock, screen: () => "keep" });
    try {
      const note = (text: string) => ({ op: "note" as const, project: "recency-test", scope: "project" as const, tier: "long" as const,
        kind: "finding" as const, peer: "person", source: "person" as const, title: "same title", text, about: [] as string[] });
      const strongOldId = store.note(note("needle needle needle needle needle"));
      const duplicateOldId = store.note(note("needle identical text"));
      clock = now;
      const duplicateNewId = store.note(note("needle identical text"));
      const hits = store.search("needle", { project: "recency-test", explain: true }).hits as SearchHit[];
      const strongOld = hits.find(hit => hit.view?.id === strongOldId)!;
      const duplicateOld = hits.find(hit => hit.view?.id === duplicateOldId)!;
      const duplicateNew = hits.find(hit => hit.view?.id === duplicateNewId)!;
      expect(strongOld.score).toBeGreaterThan(duplicateNew.score);
      expect(hits.indexOf(strongOld)).toBeLessThan(hits.indexOf(duplicateNew));
      expect(hits.indexOf(duplicateNew)).toBeLessThan(hits.indexOf(duplicateOld));
    } finally { store.close(); }
  } finally { runtime.cleanup(); }
});

function scoreKey(at: string, instant: number): number { return 1 / (1 + Math.max(0, (instant - Date.parse(at)) / (30 * day))); }
