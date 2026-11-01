import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { captureSearch } from "../src/memory/search-fts.ts";
import { CAPTURE_CONVERSATION_WEIGHT, captureEventWeight, captureEventWeightSql, captureWeightedScore } from "../src/memory/search-score.ts";
import { MemoryStore } from "../src/memory/store.ts";

const roots: string[] = [], now = Date.now(), project = "capture-summary-ranking", text = "summaryrankneedle", at = new Date(now).toISOString();
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("Title, Recap, and Compact use the same 1.25 numeric and SQL conversational weight", () => {
  const sql = captureEventWeightSql("r.event");
  for (const event of ["Title", "Recap", "Compact"]) {
    expect(captureEventWeight(event)).toBe(CAPTURE_CONVERSATION_WEIGHT);
    expect(captureWeightedScore(-0.01, event, at, now)).toBe(captureWeightedScore(-0.01, "PostToolUse", at, now) * CAPTURE_CONVERSATION_WEIGHT);
    expect(sql).toContain(`'${event}'`);
  }
  expect(captureEventWeight("PostToolUse")).toBe(1);
  expect(sql).toContain("ELSE 1.0");
});

test("all three summary events outrank equal-BM25 tool captures and keep raw BM25 ranks", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-summary-ranking-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now });
  const toolIds: number[] = [], summaryIds: number[] = [];
  try {
    for (const event of ["Title", "Recap", "Compact"] as const) {
      const raw = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: text, at, paths: [] });
      const summary = capture.append({ project, agent: "claude", event, excerpt: text, at, paths: [] });
      if (!("id" in raw) || !("id" in summary)) throw new Error("fixture capture unexpectedly spooled");
      toolIds.push(raw.id); summaryIds.push(summary.id);
    }
    const hits = captureSearch(capture.dir, text, 6, undefined, { now });
    expect(hits.map(hit => hit.row.id)).toEqual([...summaryIds, ...toolIds]);
    expect(hits.slice(0, 3).every(hit => hit.rank === hits[3]!.rank)).toBe(true);
  } finally { capture.close(); }

  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => now });
  try {
    const curated = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
    const hits = store.search(text, { project, limit: 2 }).hits;
    expect(hits.map(hit => hit.view?.id ?? `capture:${hit.capture!.id}`)).toEqual([curated, `capture:${summaryIds[0]}`]);
  } finally { store.close(); }
});
