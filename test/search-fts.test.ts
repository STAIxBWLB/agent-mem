import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore as LegacyMemoryStore } from "@staix/agent-mem-v1";
import { MemoryStore, fts5Available, CaptureStore, type NoteInput } from "../src/index.ts";
import { setFts5AvailableForTest, type SearchIndex } from "../src/memory/search-fts.ts";


const project = "proj";
const cleanup: (() => void)[] = [];
afterEach(() => { setFts5AvailableForTest(undefined); for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-search-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function store(dir: string, now?: () => number): MemoryStore {
  const s = new MemoryStore({ home: dir, ...(now ? { now } : {}), screen: () => "keep" });
  cleanup.push(() => s.close());
  return s;
}
const note = (text: string, over: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "kimi", source: "hub", text, about: [], ...over });

test("a multi-word natural query matches what the substring filter misses", () => {
  if (!fts5Available()) return; // platform without FTS5: the fallback test below covers this platform
  const dir = home(), s = store(dir);
  s.note(note("keep bun:sqlite as the only storage engine for the derived index"));
  expect(s.list({ project, q: "database storage engine" })).toHaveLength(0); // "database" is absent: substring AND misses
  const result = s.search("database storage engine", { project });
  expect(result.engine).toBe("fts5");
  expect(result.hits.map((h) => h.view?.text)).toEqual(["keep bun:sqlite as the only storage engine for the derived index"]);
});

test("BM25 ranks the stronger match first; curated outranks capture; recency breaks ties", () => {
  if (!fts5Available()) return;
  const dir = home();
  let now = Date.parse("2026-10-17T00:00:00.000Z");
  const s = store(dir, () => now);
  s.note(note("ranking alpha alpha alpha alpha")); // the same terms, four times
  s.note(note("ranking alpha beta gamma delta epsilon zeta")); // once, in a longer document
  const bm25 = s.search("ranking alpha", { project });
  expect(bm25.hits.map((h) => h.view?.text)).toEqual(["ranking alpha alpha alpha alpha", "ranking alpha beta gamma delta epsilon zeta"]);

  s.note(note("the bounded store evicts oldest capture rows first"));
  const capture = new CaptureStore({ home: dir, project, now: () => now });
  cleanup.push(() => capture.close());
  capture.append({ project, agent: "kimi", event: "PostToolUse", excerpt: "the bounded store evicts oldest capture rows first" });
  const twin = s.search("bounded store evicts oldest capture rows", { project });
  expect(twin.hits[0]!.source).toBe("curated"); // the same text in both tiers ranks the curated one first
  expect(twin.hits[1]!.source).toBe("capture");
  expect(twin.hits[1]!.capture!.excerpt).toBe(twin.hits[0]!.view!.text);

  now = Date.parse("2026-09-01T00:00:00.000Z");
  s.note(note("eviction keeps the store bounded")); // written older
  now = Date.parse("2026-10-17T00:00:00.000Z");
  s.note(note("eviction keeps the store bounded")); // the same text, much newer
  const twins = s.search("eviction keeps the store bounded", { project }).hits.filter((h) => h.view?.text === "eviction keeps the store bounded");
  expect(twins).toHaveLength(2);
  expect(twins.map((h) => h.view!.at)).toEqual([...twins.map((h) => h.view!.at)].sort().reverse()); // equal text: newer first
});

test("forgotten entries stay out of search hits", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  const id = s.note(note("a decision that turned out wrong"));
  expect(s.search("turned out wrong", { project }).hits).toHaveLength(1);
  s.forget(id, "person", project);
  expect(s.search("turned out wrong", { project }).hits).toHaveLength(0);
});

test("an expired curated row is pruned out of the FTS copy at the next search", () => {
  if (!fts5Available()) return;
  const dir = home();
  const now = Date.parse("2026-10-17T00:00:00.000Z");
  const s = store(dir, () => now);
  s.note(note("stale short-term note about flaky retries", { tier: "short", expires: "2026-10-01T00:00:00.000Z" }));
  s.note(note("durable note about flaky retries"));
  const result = s.search("flaky retries", { project });
  expect(result.engine).toBe("fts5");
  expect(result.hits.map((h) => h.view?.text)).toEqual(["durable note about flaky retries"]);
  const again = store(dir, () => now); // a fresh handle resyncs the same derived FTS copy
  expect(again.search("flaky retries", { project }).hits.map((h) => h.view?.text)).toEqual(["durable note about flaky retries"]);
});

test("without FTS5 the engine falls back to the substring filter", () => {
  setFts5AvailableForTest(false);
  const dir = home(), s = store(dir);
  s.note(note("keep bun:sqlite as the only storage engine"));
  const capture = new CaptureStore({ home: dir, project });
  cleanup.push(() => capture.close());
  capture.append({ project, agent: "kimi", event: "PostToolUse", excerpt: "storage engine capture row" });
  const result = s.search("storage engine", { project });
  expect(result.engine).toBe("substring");
  expect(result.hits.map((h) => h.view?.text)).toEqual(["keep bun:sqlite as the only storage engine"]); // same set as list()
  expect(result.hits.every((h) => h.source === "curated")).toBe(true); // capture recall needs FTS5
  expect(s.list({ project, q: "storage engine" }).map((v) => v.text)).toEqual(result.hits.map((h) => h.view!.text));
});

test("search results are unchanged by a rebuild: incremental FTS equals a full resync", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  for (let i = 0; i < 12; i++) s.note(note(`note ${i} about bounded capture and eviction${i % 3 === 0 ? " with extra bounded detail" : ""}`));
  const capture = new CaptureStore({ home: dir, project });
  cleanup.push(() => capture.close());
  capture.append({ project, agent: "kimi", event: "PostToolUse", excerpt: "a bounded capture row about eviction" });
  const shape = (r: ReturnType<MemoryStore["search"]>) => r.hits.map((h) => `${h.source}:${h.view?.id ?? h.capture!.id}:${h.score.toFixed(9)}`);
  const before = shape(s.search("bounded eviction", { project }));
  s.rebuild();
  expect(shape(s.search("bounded eviction", { project }))).toEqual(before);
  const fresh = store(dir); // another handle on the same home searches the same derived copies
  expect(shape(fresh.search("bounded eviction", { project }))).toEqual(before);
});

test("rebuild refills the derived FTS copy in one batch instead of one transaction per entry", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  for (let i = 0; i < 24; i++) s.note(note(`note ${i} about batched rebuild`));
  const index = (s as unknown as { searchIndex: SearchIndex }).searchIndex;
  let incremental = 0, batches = 0;
  const add = index.addCurated.bind(index), resync = index.resync.bind(index);
  index.addCurated = (doc) => { incremental++; add(doc); };
  index.resync = (load) => { batches++; resync(load); };
  s.rebuild();
  expect(incremental).toBe(0);
  expect(batches).toBe(1);
  expect(s.search("batched rebuild", { project }).hits).toHaveLength(24);
});

test("the package entry does not expose the FTS test switch", async () => {
  expect("setFts5AvailableForTest" in await import("../src/index.ts")).toBe(false);
});

test("P2-3: prefix terms match inflections and Korean particles; the substring net catches FTS misses", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  s.note(note("eviction keeps the bounded store small"));
  s.note(note("메모리를 정리하는 규칙을 기록한다"));
  s.note(note("메모리 계층은 프로젝트별로 나뉜다"));
  expect(s.search("evict", { project }).hits.map((h) => h.view?.text)).toContain("eviction keeps the bounded store small");
  expect(s.search("eviction", { project }).hits.length).toBeGreaterThan(0); // "evictions" would match too
  expect(s.search("메모리", { project }).hits.map((h) => h.view?.text)).toContain("메모리를 정리하는 규칙을 기록한다");
  expect(s.search("메모리는", { project }).hits.map((h) => h.view?.text)).toContain("메모리 계층은 프로젝트별로 나뉜다");
  // The net: a query FTS cannot answer (punctuation-only terms) still answers like the substring filter.
  const tricky = s.note(note("release uses the v1.2.3 tag format"));
  expect(s.list({ project, q: "v1.2.3" }).map((v) => v.id)).toEqual([tricky]);
  expect(s.search("v1.2.3", { project }).hits.map((h) => h.view?.id)).toEqual([tricky]);
});

test("P2-4: the project filter runs inside the FTS query; a busy sibling project cannot starve the LIMIT", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  for (let i = 0; i < 100; i++) s.note(note(`sibling project note ${i} about zebra crossings`, { project: "other" }));
  const mine = s.note(note("my one note about zebra crossings"));
  const result = s.search("zebra crossings", { project, limit: 10 });
  expect(result.hits.map((h) => h.view?.id)).toContain(mine);
});

test("P2-5: a locked derived search.db never fails or stalls a curated write; the next search resyncs", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  s.note(note("a note written before the lock"));
  // Hold the derived copy's write lock from a raw connection: curated writes must still go through, fast.
  const holder = new Database(join(s.dir, "search.db"));
  holder.run("PRAGMA busy_timeout = 0");
  holder.run("BEGIN EXCLUSIVE");
  const start = performance.now();
  try {
    s.note(note("a note written while the FTS copy was locked"));
    s.note(note("another locked-window note"));
  } finally { holder.run("ROLLBACK"); holder.close(); }
  expect(performance.now() - start).toBeLessThan(1000); // no 3 s stall
  const result = s.search("locked-window note", { project });
  expect(result.hits.map((h) => h.view?.text)).toContain("a note written while the FTS copy was locked");
  expect(result.hits.map((h) => h.view?.text)).toContain("another locked-window note");
});

test("AC8: a published v1 reader is unaffected and capture data never enters a v1 segment", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  const expected = s.note(note("ordinary v1 contract"));
  const segments = (): Record<string, string> => Object.fromEntries(["log", "local"].flatMap((sub) =>
    readdirSync(join(s.dir, sub)).sort().filter((n) => n.endsWith(".jsonl")).map((n) => [`${sub}/${n}`, readFileSync(join(s.dir, sub, n), "utf8")])));
  const before = segments();
  const marker = "capture-only-marker-7f3a9c";
  const capture = new CaptureStore({ home: dir, project });
  cleanup.push(() => capture.close());
  capture.append({ project, agent: "kimi", event: "PostToolUse", excerpt: `a row with ${marker}` });
  const result = s.search("capture-only-marker", { project });
  expect(result.hits.some((h) => h.source === "capture")).toBe(true); // the capture tier is really searched
  expect(segments()).toEqual(before); // no v1 segment gained a byte
  expect(Object.values(segments()).join("")).not.toContain(marker);
  const legacy = new LegacyMemoryStore({ home: dir });
  cleanup.push(() => legacy.close());
  expect(legacy.list({ project }).map((v) => v.id)).toEqual([expected]); // the v1 reader sees only curated truth
});

test("#165 a capture row past the shard's retention window is not recalled while no writer has evicted it", () => {
  if (!fts5Available()) return;
  const dir = home(), at = Date.parse("2026-06-01T00:00:00.000Z");
  const capture = new CaptureStore({ home: dir, project, now: () => at });
  capture.append({ project, agent: "codex", event: "Stop", excerpt: "retention canary excerpt" }); capture.close();
  const fresh = store(dir, () => at + 24 * 3600_000).search("retention canary", { project });
  expect(fresh.hits.some((h) => h.capture?.excerpt === "retention canary excerpt")).toBe(true);
  // 91 days later, past the default 90-day window; nothing appended since, so the row is still in capture.db.
  const later = store(dir, () => at + 91 * 24 * 3600_000).search("retention canary", { project });
  expect(later.hits.some((h) => h.capture)).toBe(false);
});

test("#165 invisible rows filling the candidate cap never hide a visible curated match", () => {
  if (!fts5Available()) return;
  const dir = home();
  let now = Date.parse("2026-10-01T00:00:00.000Z");
  const s = store(dir, () => now);
  // Forty strong matches written before `since`, so search filters them after FTS.
  for (let i = 0; i < 40; i++) { s.note(note(`cap token cap token cap token old ${i}`)); now += 1000; }
  const since = new Date(now + 1000).toISOString(); now += 60_000;
  s.note(note("cap token cap token cap token cap token newest strong"));
  s.note(note("a weak cap token mention that is still visible"));
  const hits = s.search("cap token", { project, since, limit: 2 }).hits.map((h) => h.view?.text);
  expect(hits).toEqual(["cap token cap token cap token cap token newest strong", "a weak cap token mention that is still visible"]);
});

test("#165 a host's capture retention override reaches search", () => {
  if (!fts5Available()) return;
  const dir = home(), at = Date.parse("2026-06-01T00:00:00.000Z");
  const capture = new CaptureStore({ home: dir, project, now: () => at, retentionDays: 365 });
  capture.append({ project, agent: "codex", event: "Stop", excerpt: "override window excerpt" }); capture.close();
  const s = store(dir, () => at + 100 * 24 * 3600_000);
  expect(s.search("override window", { project }).hits.some((h) => h.capture)).toBe(false);
  expect(s.search("override window", { project, captureRetentionDays: 365 }).hits.some((h) => h.capture?.excerpt === "override window excerpt")).toBe(true);
  for (const invalid of [0, -1, Number.NaN]) expect(s.search("override window", { project, captureRetentionDays: invalid }).hits.some((h) => h.capture)).toBe(false);
});

test("#165 capture time is stored as canonical UTC, so `since` compares chronologically", () => {
  if (!fts5Available()) return;
  const dir = home(), capture = new CaptureStore({ home: dir, project, now: () => Date.parse("2026-06-02T00:00:00.000Z") });
  capture.append({ project, agent: "codex", event: "Stop", excerpt: "offset clock excerpt", at: "2026-06-01T01:00:00+02:00" });
  expect(() => capture.append({ project, agent: "codex", event: "Stop", excerpt: "bad clock", at: "not a time" })).toThrow("parseable time");
  capture.close();
  const s = store(dir, () => Date.parse("2026-06-02T00:00:00.000Z"));
  const hit = s.search("offset clock", { project }).hits.find((h) => h.capture);
  expect(hit?.capture?.at).toBe("2026-05-31T23:00:00.000Z");
  expect(s.search("offset clock", { project, since: "2026-06-01T00:00:00.000Z" }).hits.some((h) => h.capture)).toBe(false);
});
