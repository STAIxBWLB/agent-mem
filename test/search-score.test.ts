import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rankedScore, rankedScoreDetails } from "../src/memory/search-score.ts";
import { ftsTerms, fts5Available, ScreenedSearchIndex, setFts5AvailableForTest } from "../src/memory/search-fts.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { CaptureStore } from "../src/memory/capture.ts";

const now = Date.parse("2026-10-26T12:34:56.789Z"), day = 86400_000;
const roots: string[] = [];
afterEach(() => { setFts5AvailableForTest(undefined); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("numeric recipe preserves the frozen pre-explain arithmetic exactly", () => {
  // Frozen compatibility oracle from the old store, not another production formula.
  for (const rank of [-0, -0.000001, -0.1234567890123, -12.5]) for (const tier of ["long", "short", "capture", "constructor"]) for (const days of [-3, 0, 0.00001, 30, 3000]) {
    const at = new Date(now - days * day).toISOString();
    const factor = tier === "long" ? 1 : tier === "capture" ? 0.5 : 0.9;
    const old = -rank * factor * (1 / (1 + Math.max(0, now - Date.parse(at)) / (30 * 24 * 3600_000)));
    const score = rankedScore(rank, tier, at, now);
    expect(Object.is(score, old)).toBe(true);
    expect(rankedScoreDetails(tier === "capture" ? "capture" : "curated", rank, tier, at, now, score)).toMatchObject({ rawBm25Rank: rank, tierFactor: factor, finalScore: score, matchMode: "fts5" });
  }
});

for (const useFts of [true, false]) test.skipIf(useFts && !fts5Available())(`screened ${useFts ? "FTS" : "substring"} score bytes match old SQL, and opt-in fields use those factors`, () => {
  const index = new ScreenedSearchIndex<{ id: string }>();
  try {
    index.append(["long", "short", "capture"].flatMap((tier, i) => [-2, 0, 0.1, 30, 2000].map((days, n) => ({ body: "needle ".repeat(i + 1) + "background", ref: `${i}-${n}`, tier, at: new Date(now - days * day).toISOString(), value: { id: `${i}-${n}` } }))));
    const db = (index as unknown as { db: Database }).db, rank = useFts ? "-bm25(docs)" : "1.0";
    const old = db.query(`SELECT payload, ${rank} * CASE tier WHEN 'long' THEN 1.0 WHEN 'capture' THEN 0.5 ELSE 0.9 END
      / (1 + max(0, (julianday(?) - julianday(at)) / 30.0)) AS score FROM docs WHERE (expires IS NULL OR expires > ?)${useFts ? " AND docs MATCH ?" : ""} ORDER BY score DESC, ref LIMIT ?`)
      .all(new Date(now).toISOString(), now, ...(useFts ? [ftsTerms("needle")] : []), 20) as { payload: string; score: number }[];
    const expected = old.map(row => ({ value: JSON.parse(row.payload), score: row.score }));
    expect(JSON.stringify(index.best("needle", 20, now, useFts))).toBe(JSON.stringify(expected));
    const explained = index.best("needle", 20, now, useFts, true);
    expect(JSON.stringify(explained.map(({ scoreDetails, ...hit }) => hit))).toBe(JSON.stringify(expected));
    for (const hit of explained) {
      expect(hit.scoreDetails!.finalScore).toBe(hit.score);
      expect(hit.scoreDetails!.matchMode).toBe(useFts ? "fts5" : "substring");
      if (useFts) expect(hit.scoreDetails!.rawBm25Rank!).toBeLessThan(0); else expect(hit.scoreDetails!.rawBm25Rank).toBeNull();
      expect(hit.scoreDetails!.tierFactor!).toBeGreaterThan(0);
      expect(hit.scoreDetails!.recencyFactor!).toBeGreaterThan(0);
    }
  } finally { index.close(); }
});

test.skipIf(!fts5Available())("library explanations preserve curated/capture selection and are absent by default", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-score-details-")); roots.push(root);
  let clock = now - 45 * day;
  const project = "explain-project", store = new MemoryStore({ home: root, now: () => clock, screen: () => "keep" });
  try {
    store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "needle old curated", about: [] });
    clock = now - day;
    store.note({ op: "note", project, scope: "project", tier: "short", kind: "finding", peer: "person", source: "person", text: "needle recent curated", about: [] }, true);
    clock = now;
    const capture = new CaptureStore({ home: root, project, now: () => now });
    try { capture.append({ project, agent: "test", event: "tool", excerpt: "needle capture", at: new Date(now - 3600_000).toISOString() }); } finally { capture.close(); }
    const plain = store.search("needle", { project }), off = store.search("needle", { project, explain: false }), on = store.search("needle", { project, explain: true });
    expect(JSON.stringify(off)).toBe(JSON.stringify(plain));
    expect(JSON.stringify({ ...on, hits: on.hits.map(({ scoreDetails, ...hit }) => hit) })).toBe(JSON.stringify(plain));
    expect(on.hits.some(hit => hit.source === "capture")).toBe(true);
    for (const hit of on.hits) expect(hit.scoreDetails).toMatchObject({ source: hit.source, finalScore: hit.score, matchMode: "fts5" });
    const fallback = store.search("eedle", { project, includeCapture: false, explain: true });
    expect(fallback.hits.length).toBeGreaterThan(0);
    expect(fallback.hits.every(hit => hit.scoreDetails?.rawBm25Rank === null && hit.scoreDetails?.matchMode === "substring")).toBe(true);
  } finally { store.close(); }
});

test("library FTS-unavailable fallback reports unapplied factors as null", () => {
  setFts5AvailableForTest(false);
  const root = mkdtempSync(join(tmpdir(), "amem-score-fallback-")); roots.push(root);
  const project = "fallback-project", store = new MemoryStore({ home: root, now: () => now, screen: () => "keep" });
  try {
    store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "needle", about: [] });
    const result = store.search("needle", { project, explain: true });
    expect(result.hits[0]!.scoreDetails).toEqual({ source: "curated", rawBm25Rank: null, tierFactor: null, recencyFactor: null, finalScore: 0, matchMode: "substring" });
  } finally { store.close(); }
});
