import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createMemoryMcp } from "../src/mcp-memory.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { captureSearch } from "../src/memory/search-fts.ts";
import { captureWeightedScore } from "../src/memory/search-score.ts";
import { MemoryStore } from "../src/memory/store.ts";

const roots: string[] = [], now = Date.parse("2026-11-01T00:00:00.000Z"), project = "capture-event-ranking", text = "conversationneedle";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(event: "Stop" | "UserPromptSubmit") {
  const root = mkdtempSync(join(tmpdir(), "amem-event-ranking-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now });
  const append = (event: string, session?: string, excerpt = text, at?: string) => {
    const result = capture.append({ project, agent: "claude", event, excerpt, paths: [], ...(session ? { session } : {}), ...(at ? { at } : {}) });
    if (!("id" in result)) throw Error("fixture capture unexpectedly spooled");
    return result.id;
  };
  const tool = append("PostToolUse"), conversational = append(event), dir = capture.dir; capture.close();
  return { root, base, dir, tool, conversational };
}

for (const event of ["Stop", "UserPromptSubmit"] as const) test(`${event} wins an equal-BM25 capture match before LIMIT`, () => {
  const f = fixture(event), hits = captureSearch(f.dir, text, 2);
  expect(hits.map(hit => hit.row.id)).toEqual([f.conversational, f.tool]);
  expect(hits[0]!.rank).toBe(hits[1]!.rank); // The raw BM25 values remain available, not rewritten as weighted ranks.
  expect(captureSearch(f.dir, text, 1)[0]!.row.id).toBe(f.conversational);
});

test("library and MCP prefer conversational capture while retaining the curated equal-match priority", async () => {
  const f = fixture("Stop"), store = new MemoryStore({ memoryDir: f.base, deferPromotions: true, now: () => now });
  const curated = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
  const expected = [curated, `capture:${f.conversational}`, `capture:${f.tool}`];
  try {
    const hits = store.search(text, { project, limit: 3, explain: true }).hits;
    expect(hits.map(hit => hit.view?.id ?? `capture:${hit.capture!.id}`)).toEqual(expected);
  } finally { store.close(); }
  const mcp = createMemoryMcp({ cwd: f.root, base: f.base, project });
  try {
    const result = await mcp.tools.amem_search({ query: text, limit: 3, explain: true }) as { hits: { view?: { id: string }; capture?: { id: number } }[] };
    expect(result.hits.map(hit => hit.view?.id ?? `capture:${hit.capture!.id}`)).toEqual(expected);
  } finally { mcp.close(); }
});

test("one-per-session fill widens past a full 32-row prefix from one session", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-session-fill-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now });
  const sessionA = "a".repeat(16), sessionB = "b".repeat(16), ids: number[] = [];
  try {
    for (let i = 0; i < 33; i++) {
      const result = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: text, paths: [], session: sessionA });
      if (!("id" in result)) throw Error("fixture capture unexpectedly spooled"); ids.push(result.id);
    }
    const bestA = capture.append({ project, agent: "claude", event: "Stop", excerpt: text, paths: [], session: sessionA });
    const other = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: text, paths: [], session: sessionB });
    if (!("id" in bestA) || !("id" in other)) throw Error("fixture capture unexpectedly spooled");
    const hits = captureSearch(capture.dir, text, 2);
    expect(hits.map(hit => hit.row.id)).toEqual([bestA.id, other.id]);
    expect(new Set(hits.map(hit => hit.row.session)).size).toBe(2);
    const store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => now });
    try {
      const search = store.search(text, { project, limit: 2 }).hits;
      expect(search.map(hit => hit.capture?.id)).toEqual([bestA.id, other.id]);
    } finally { store.close(); }
  } finally { capture.close(); }
});

test("rows without a valid session hash remain independent groups", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-sessionless-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now });
  try {
    const first = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: text, paths: [] });
    const second = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: text, paths: [], session: "invalid" });
    if (!("id" in first) || !("id" in second)) throw Error("fixture capture unexpectedly spooled");
    expect(captureSearch(capture.dir, text, 2).map(hit => hit.row.id)).toEqual([first.id, second.id]);
  } finally { capture.close(); }
});

test("library and MCP fill two capture slots with the best of three same-session rows and the next session", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-two-sessions-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now });
  const ids: number[] = [];
  try {
    for (const [event, session] of [["PostToolUse", "a"], ["Stop", "a"], ["PostToolUseFailure", "a"], ["PostToolUse", "b"]]) {
      const result = capture.append({ project, agent: "claude", event: event!, excerpt: text, paths: [], session: session!.repeat(16) });
      if (!("id" in result)) throw Error("fixture capture unexpectedly spooled"); ids.push(result.id);
    }
  } finally { capture.close(); }
  const expected = [ids[1]!, ids[3]!], store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => now });
  try { expect(store.search(text, { project, limit: 2 }).hits.map(hit => hit.capture?.id)).toEqual(expected); }
  finally { store.close(); }
  const mcp = createMemoryMcp({ cwd: root, base, project });
  try {
    const result = await mcp.tools.amem_search({ query: text, limit: 2 }) as { hits: { capture?: { id: number } }[] };
    expect(result.hits.map(hit => hit.capture?.id)).toEqual(expected);
  } finally { mcp.close(); }
});

test("store keeps the legacy curated position when the conversational weight would cross it", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-slot-")); roots.push(root);
  const base = join(root, "memory"); let clock = now - 20 * 86400_000;
  const store = new MemoryStore({ memoryDir: base, deferPromotions: true, now: () => clock });
  const curated = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
  clock = now;
  const capture = new CaptureStore({ memoryDir: base, project, now: () => now }), session = "c".repeat(16);
  try {
    capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: text, paths: [], session });
    const conversational = capture.append({ project, agent: "claude", event: "Stop", excerpt: text, paths: [], session });
    if (!("id" in conversational)) throw Error("fixture capture unexpectedly spooled");
    const hits = store.search(text, { project, limit: 2, explain: true }).hits;
    expect(hits.map(hit => hit.view?.id ?? `capture:${hit.capture!.id}`)).toEqual([curated, `capture:${conversational.id}`]);
    const noteScore = hits[0]!.score, captureHit = hits[1]!;
    expect(captureWeightedScore(captureHit.scoreDetails!.rawBm25Rank!, "Stop", captureHit.capture!.at, now)).toBeGreaterThan(noteScore);
  } finally { capture.close(); store.close(); }
});

test("MCP screens captures before grouping so a refused row cannot hide its public same-session row", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-screened-session-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now }), session = "d".repeat(16);
  let hidden: number, safe: number, other: number;
  try {
    const privateRow = capture.append({ project, agent: "claude", event: "Stop", excerpt: `${text} private-codename`, paths: [], session });
    const publicRow = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: `${text} public`, paths: [], session });
    const otherSession = capture.append({ project, agent: "claude", event: "PostToolUse", excerpt: `${text} other`, paths: [], session: "e".repeat(16) });
    if (!("id" in privateRow) || !("id" in publicRow) || !("id" in otherSession)) throw Error("fixture capture unexpectedly spooled");
    hidden = privateRow.id; safe = publicRow.id; other = otherSession.id;
  } finally { capture.close(); }
  writeFileSync(join(base, "amem.config.json"), JSON.stringify({ piiPatterns: ["private-codename"] }));
  const mcp = createMemoryMcp({ cwd: root, base, project });
  try {
    const result = await mcp.tools.amem_search({ query: text, limit: 10 }) as { hits: { capture?: { id: number } }[] };
    const ids = result.hits.map(hit => hit.capture?.id).filter((id): id is number => id !== undefined);
    expect(ids).toContain(safe); expect(ids).toContain(other); expect(ids).not.toContain(hidden);
  } finally { mcp.close(); }
});

test("collapsed capture rows remain reachable through timeline and show", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-timeline-sessions-")); roots.push(root);
  const base = join(root, "memory"), capture = new CaptureStore({ memoryDir: base, project, now: () => now }), session = "f".repeat(16);
  const ids: number[] = [];
  try {
    for (const event of ["PostToolUse", "Stop", "PostToolUseFailure"]) {
      const result = capture.append({ project, agent: "claude", event, excerpt: text, paths: [], session });
      if (!("id" in result)) throw Error("fixture capture unexpectedly spooled"); ids.push(result.id);
    }
  } finally { capture.close(); }
  const mcp = createMemoryMcp({ cwd: root, base, project });
  try {
    const search = await mcp.tools.amem_search({ query: text, limit: 10 }) as { hits: { source: string; capture?: { id: number; event: string } }[] };
    expect(search.hits.filter(hit => hit.source === "capture").map(hit => hit.capture!.id)).toEqual([ids[1]!]);
    expect(search.hits.find(hit => hit.source === "capture")?.capture?.event).toBe("Stop");
    const timeline = await mcp.tools.amem_timeline({ limit: 20 }) as { source?: string; capture?: { id: number } }[];
    for (const id of ids) expect(timeline.filter(row => row.source === "capture").map(row => row.capture!.id)).toContain(id);
    for (const id of ids) expect(await mcp.tools.amem_show({ id: `capture:${id}` })).not.toBeNull();
  } finally { mcp.close(); }
});

test("captureSearch reads a legacy database with no session attribution column", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-legacy-capture-search-")); roots.push(root);
  const dir = join(root, "machine"); mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "capture.db"));
  try {
    db.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, at TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL, event TEXT NOT NULL, tool TEXT, paths TEXT NOT NULL, status TEXT, excerpt TEXT NOT NULL, bytes INTEGER NOT NULL, spool_id TEXT)");
    db.run("CREATE VIRTUAL TABLE fts USING fts5(body)");
    db.query("INSERT INTO rows (id, at, project, agent, event, tool, paths, status, excerpt, bytes, spool_id) VALUES (1, ?, ?, ?, ?, NULL, '[]', NULL, ?, 1, NULL)").run(new Date(now).toISOString(), project, "claude", "PostToolUse", text);
    db.query("INSERT INTO fts (rowid, body) VALUES (1, ?)").run(text);
  } finally { db.close(); }
  expect(captureSearch(dir, text, 1)).toMatchObject([{ row: { id: 1, excerpt: text } }]);
});
