import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { fstatSync } from "node:fs";
import { fts5Available, ScreenedSearchIndex, setFts5AvailableForTest } from "../src/memory/search-fts.ts";

type Payload = { id: string; detail: { text: string } };
const now = Date.parse("2026-10-26T00:00:00.000Z");
const at = (daysAgo = 0) => new Date(now - daysAgo * 86400_000).toISOString();
const indexes: ScreenedSearchIndex<Payload>[] = [];
afterEach(() => {
  try { for (const index of indexes.splice(0)) index.close(); }
  finally { setFts5AvailableForTest(undefined); }
});
function index() {
  const value = new ScreenedSearchIndex<Payload>(); indexes.push(value); return value;
}
// Inspect the existing private storage only; production gains no test-only accessor.
const database = (value: ScreenedSearchIndex<Payload>) => (value as unknown as { db: Database }).db;
const row = (ref: string, body = "needle", tier = "long", daysAgo = 0) =>
  ({ ref, body, tier, at: at(daysAgo), value: { id: ref, detail: { text: "공개 합성 자료" } } });

for (const fallback of [false, true]) test(`expiry is filtered before the final ${fallback ? "substring" : "FTS"} LIMIT`, () => {
  setFts5AvailableForTest(fallback ? false : undefined);
  const value = index();
  value.append([
    { ...row("expired-strong"), expiresAt: at() },
    { ...row("invalid-deadline"), expiresAt: "invalid" },
    { ...row("live-weaker", "needle ordinary filler", "short"), expiresAt: new Date(now + 1000).toISOString() },
  ]);
  expect(value.best("needle", 1, now).map(hit => hit.value.id)).toEqual(["live-weaker"]);
  expect(value.best("needle", 1, now + 1000)).toEqual([]);
  value.append([row("no-deadline")]);
  expect(value.best("needle", 1, now + 1000).map(hit => hit.value.id)).toEqual(["no-deadline"]);
  value.append([{ ...row("future-beyond-sqlite-calendar"), expiresAt: new Date(8640000000000000).toISOString() }]);
  expect(value.best("needle", 10, now).map(hit => hit.value.id)).toContain("future-beyond-sqlite-calendar");
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")("spilled TEMP state is owner-only and already unlinked while open", () => {
  const files = () => {
    const result: { ino: number; mode: number; links: number }[] = [];
    // Inspect only this process's descriptor metadata, never file contents or another process.
    for (let fd = 0; fd < 1024; fd++) try {
      const stat = fstatSync(fd);
      if (stat.isFile()) result.push({ ino: stat.ino, mode: stat.mode & 0o777, links: stat.nlink });
    } catch { /* Unused descriptor. */ }
    return result;
  };
  const before = new Set(files().map(file => file.ino)), value = index(), db = database(value);
  db.run("PRAGMA temp.cache_size = -16"); db.run("PRAGMA temp.cache_spill = 1");
  value.append(Array.from({ length: 64 }, (_, n) => row(`spill-${n}`, "needle ".repeat(1024))));
  const spilled = files().filter(file => !before.has(file.ino) && file.links === 0);
  expect(spilled.length).toBeGreaterThan(0);
  expect(spilled.every(file => file.mode === 0o600)).toBe(true);
  value.close();
});

test("query state lives only in SQLite TEMP with a bounded file-backed cache", () => {
  const value = index(), db = database(value);
  value.append([row("private-fixture")]);
  expect(db.query("SELECT COUNT(*) AS n FROM main.sqlite_master").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE name = 'docs'").get()).toEqual({ n: 1 });
  expect(db.query("PRAGMA temp_store").get()).toEqual({ temp_store: 1 });
  expect(db.query("PRAGMA temp.cache_size").get()).toEqual({ cache_size: -2048 });
  expect(db.query("SELECT COUNT(*) AS n FROM temp.docs").get()).toEqual({ n: 1 });
  const main = (db.query("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main");
  expect(main?.file).toBe("");
  // Anonymous temporary-file permissions and unlinking belong to the SQLite VFS.
  // Do not enumerate unrelated processes' descriptors or shared temp directories.
  value.close();
  expect(() => db.query("SELECT COUNT(*) FROM temp.docs").get()).toThrow();
});

test("close is idempotent and closes the SQLite connection", () => {
  const value = index(), db = database(value);
  value.close();
  expect(() => value.close()).not.toThrow();
  expect(() => db.query("SELECT 1").get()).toThrow();
});

test("a caller exception still closes populated TEMP state through finally", () => {
  let db: Database | undefined;
  const failure = new Error("synthetic caller failure after streaming a batch");
  expect(() => {
    const value = index(); db = database(value);
    try {
      value.append([row("first-batch"), row("second-record")]);
      expect(db.query("SELECT COUNT(*) AS n FROM temp.docs").get()).toEqual({ n: 2 });
      throw failure;
    } finally { value.close(); }
  }).toThrow(failure);
  expect(db).toBeDefined();
  expect(() => db!.query("SELECT 1").get()).toThrow();
});

test("streamed batches apply recency and tier before limiting raw BM25 leaders", () => {
  if (!fts5Available()) return;
  for (const scenario of ["recency", "tier"] as const) {
    const value = index();
    // Enough raw leaders to expose implementations that rank only an early top-k page.
    const leaders = Array.from({ length: 48 }, (_, i) => row(`leader-${String(i).padStart(2, "0")}`,
      "needle", "capture", scenario === "recency" ? 365 : 0));
    value.append(leaders.slice(0, 16));
    value.append(leaders.slice(16, 32));
    value.append(leaders.slice(32));
    const target = row(`weighted-${scenario}`, "needle ordinary filler", scenario === "tier" ? "long" : "capture");
    value.append([target, row("nonmatching", "unrelated content")]);
    const first = database(value).query("SELECT ref FROM temp.docs WHERE docs MATCH ? ORDER BY bm25(docs), ref LIMIT 8")
      .all('"needle"') as { ref: string }[];
    expect(first).toHaveLength(8);
    expect(first.every(hit => hit.ref.startsWith("leader-"))).toBe(true);
    const best = value.best("needle", 1, now);
    expect(best).toHaveLength(1);
    expect(best[0]!.value).toEqual(target.value);
    expect(best[0]!.score).toBeGreaterThan(0);
    const wider = value.best("needle", 4, now);
    expect(wider.map(hit => hit.value.id)).not.toContain("nonmatching");
    expect(wider[0]).toEqual(best[0]);
    value.close();
  }
});

test("without FTS the already screened matching stream keeps weighted fallback and payloads", () => {
  setFts5AvailableForTest(false);
  const value = index();
  expect(value.available).toBe(false);
  // The caller supplies only screened matching rows; this class's fallback ranks that corpus.
  value.append([row("recent-capture", "needle", "capture"), row("old-long", "needle", "long", 60)]);
  value.append([row("recent-short", "needle", "short"), row("recent-long", "needle", "long")]);
  const best = value.best("needle", 3, now);
  expect(best.map(hit => hit.value.id)).toEqual(["recent-long", "recent-short", "recent-capture"]);
  expect(best.map(hit => hit.score)).toEqual([1, 0.9, 0.5]);
  expect(best[0]!.value.detail).toEqual({ text: "공개 합성 자료" });
  expect(value.best("needle", 1, now)).toEqual(best.slice(0, 1));
  const db = database(value); value.close(); expect(() => db.query("SELECT 1").get()).toThrow();
});
