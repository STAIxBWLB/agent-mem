import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { fstatSync } from "node:fs";
import { fts5Available, ftsTerms, ScreenedSearchIndex, setFts5AvailableForTest } from "../src/memory/search-fts.ts";

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
  if (value.available) {
    expect(db.query("SELECT COUNT(*) AS n FROM temp.records").get()).toEqual({ n: 1 });
    expect(db.query("SELECT body FROM temp.docs").get()).toEqual({ body: null });
    expect(db.query("SELECT payload FROM temp.records").get()).toEqual({ payload: JSON.stringify(row("private-fixture").value) });
    expect(db.query("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE name = 'docs_content'").get()).toEqual({ n: 0 });
    expect((db.query("PRAGMA temp.table_info(docs)").all() as { name: string }[]).map(column => column.name)).toEqual(["body"]);
  }
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
    const first = database(value).query("SELECT r.ref FROM temp.docs JOIN temp.records r ON r.rowid = docs.rowid WHERE docs MATCH ? ORDER BY bm25(docs), r.ref LIMIT 8")
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

test("contentless TEMP ranking and scores equal the prior full-content schema", () => {
  if (!fts5Available()) return;
  const value = index(), reference = new Database(":memory:");
  // Freeze the previous query-local schema and score formula as a differential oracle.
  // Both corpora get exactly the same bodies, append order, deadlines and payloads.
  reference.run("CREATE VIRTUAL TABLE docs USING fts5(body, ref UNINDEXED, tier UNINDEXED, at UNINDEXED, payload UNINDEXED, expires UNINDEXED)");
  const samples: (ReturnType<typeof row> & { expiresAt?: string | null })[] = [
    row("strong-capture", "needle needle exactanchor", "capture"),
    row("old-long", "needle exactanchor", "long", 60),
    row("recent-short", "needle ordinary filler", "short"),
    row("recent-long", "needle ordinary filler", "long"),
    row("accent", "café needle", "long", 1),
    row("korean", "메모리를 정리하는 규칙", "long"),
    { ...row("expired-strong", "exactanchor exactanchor", "long"), expiresAt: at() },
    { ...row("invalid-expiry", "needle exactanchor", "long"), expiresAt: "invalid" },
    { ...row("wide-date", "needle distant deadline", "short"), expiresAt: new Date(8640000000000000).toISOString() },
    { ...row("future", "needle exactanchor", "long"), expiresAt: new Date(now + 1000).toISOString() },
  ];
  try {
    value.append(samples.slice(0, 4)); value.append(samples.slice(4));
    const insert = reference.query("INSERT INTO docs (body, ref, tier, at, payload, expires) VALUES (?, ?, ?, ?, ?, ?)");
    for (const sample of samples) {
      const deadline = sample.expiresAt == null ? null : Date.parse(sample.expiresAt);
      insert.run(sample.body, sample.ref, sample.tier, sample.at, JSON.stringify(sample.value),
        deadline !== null && !Number.isFinite(deadline) ? Number.MIN_SAFE_INTEGER : deadline);
    }
    for (const query of ["needle", "exactanchor needle", "cafe", "메모리는", "missingterm"]) {
      const match = ftsTerms(query);
      const expectedRanks = reference.query("SELECT ref, bm25(docs) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank, ref").all(match);
      const actualRanks = database(value).query("SELECT r.ref, bm25(docs) AS rank FROM docs JOIN records r ON r.rowid = docs.rowid WHERE docs MATCH ? ORDER BY rank, r.ref").all(match);
      expect(actualRanks).toEqual(expectedRanks);
      for (const useFts of [true, false]) for (const instant of [now, now + 1000]) for (const limit of [1, 3, 20]) {
        const rank = useFts ? "-bm25(docs)" : "1.0";
        const rows = reference.query(`SELECT payload, ${rank} * CASE tier WHEN 'long' THEN 1.0 WHEN 'capture' THEN 0.5 ELSE 0.9 END
          / (1 + max(0, (julianday(?) - julianday(at)) / 30.0)) AS score FROM docs
          WHERE (expires IS NULL OR expires > ?) ${useFts ? "AND docs MATCH ?" : ""} ORDER BY score DESC, ref LIMIT ?`)
          .all(new Date(instant).toISOString(), instant, ...(useFts ? [match] : []), limit) as { payload: string; score: number }[];
        expect(value.best(query, limit, instant, useFts)).toEqual(rows.map(hit => ({ value: JSON.parse(hit.payload), score: hit.score })));
      }
    }
  } finally { reference.close(); }
});

test("a failed append batch rolls both payload records and contentless terms back", () => {
  if (!fts5Available()) return;
  const value = index(), db = database(value);
  value.append([row("retained")]);
  const circular = { ...row("invalid").value, self: undefined as unknown }; circular.self = circular;
  expect(() => value.append([row("rolled-back"), { ...row("invalid"), value: circular }])).toThrow();
  expect(db.query("SELECT ref FROM records ORDER BY rowid").all()).toEqual([{ ref: "retained" }]);
  expect(value.best("needle", 10, now).map(hit => hit.value.id)).toEqual(["retained"]);
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
