import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore as LegacyMemoryStore } from "@staix/agent-mem-v1";
import { MemoryStore, fts5Available, setFts5AvailableForTest, CaptureStore, type NoteInput } from "../src/index.ts";
import { captureHome } from "../src/memory/home.ts";

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
  const capture = new CaptureStore({ home: dir, now: () => now });
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
  const capture = new CaptureStore({ home: dir });
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
  const capture = new CaptureStore({ home: dir });
  cleanup.push(() => capture.close());
  capture.append({ project, agent: "kimi", event: "PostToolUse", excerpt: "a bounded capture row about eviction" });
  const shape = (r: ReturnType<MemoryStore["search"]>) => r.hits.map((h) => `${h.source}:${h.view?.id ?? h.capture!.id}:${h.score.toFixed(9)}`);
  const before = shape(s.search("bounded eviction", { project }));
  s.rebuild();
  expect(shape(s.search("bounded eviction", { project }))).toEqual(before);
  const fresh = store(dir); // another handle on the same home searches the same derived copies
  expect(shape(fresh.search("bounded eviction", { project }))).toEqual(before);
});

test("AC8: a published v1 reader is unaffected and capture data never enters a v1 segment", () => {
  if (!fts5Available()) return;
  const dir = home(), s = store(dir);
  const expected = s.note(note("ordinary v1 contract"));
  const segments = (): Record<string, string> => Object.fromEntries(["log", "local"].flatMap((sub) =>
    readdirSync(join(s.dir, sub)).sort().filter((n) => n.endsWith(".jsonl")).map((n) => [`${sub}/${n}`, readFileSync(join(s.dir, sub, n), "utf8")])));
  const before = segments();
  const marker = "capture-only-marker-7f3a9c";
  const capture = new CaptureStore({ home: dir });
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
