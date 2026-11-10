import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCuratedBriefCache, curatedCacheFresh, noteDisplay, validCachedCurated } from "../src/brief-curated.ts";
import { readBriefCache, writeBriefCache } from "../src/brief-cache.ts";
import { migrate } from "../src/memory/migrate.ts";
import { MemoryStore, type View } from "../src/memory/store.ts";
import { BRIEF_CACHE_BYTES } from "../src/brief-cache.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const view = (text = "hello", extra: Partial<View> = {}): View => ({ id: "a".repeat(32), at: "2026-11-10T00:00:00.000Z", machine: "b".repeat(16),
  project: "p", scope: "project", tier: "long", kind: "decision", peer: "person", title: "title", text, task: null, about: [], source: "person",
  supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false, ...extra });

test("curated metadata remains optional and capture cache shape stays unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-")); roots.push(root);
  const row = view();
  const store = { withDeferredPromotions: <T>(work: () => T) => work(), readPage: () => ({ rows: [row] }) };
  buildCuratedBriefCache(store as Pick<MemoryStore, "readPage" | "withDeferredPromotions">, { base: root, project: "p", directory: root, binding: "generation-a", now: () => 1000 });
  const cache = readBriefCache({ directory: root, project: "p", section: "curated" })!;
  expect(cache.curated).toEqual({ builtAt: 1000, binding: "generation-a", expiresAt: null });
  expect(validCachedCurated(cache.rows[0]!, "p")).toBe(true);
  expect(validCachedCurated({ ...cache.rows[0]!, data: {} }, "p")).toBe(false);
  expect(validCachedCurated({ ...cache.rows[0]!, source: { ...(cache.rows[0]!.source as View), expiresAt: new Date(2000).toISOString() } }, "p", 2000)).toBe(false);
  const capture = { schema: "agent-mem.brief-cache/v1" as const, project: "p", section: "capture" as const, builtThrough: 1, partial: false, rows: [{ source: {}, data: {}, partial: false }] };
  writeBriefCache({ directory: root, project: "p", section: "capture" }, capture);
  expect(readBriefCache({ directory: root, project: "p", section: "capture" })?.curated).toBeUndefined();
});

test("display and freshness enforce binding, future, expiry and 24 hour age", () => {
  const shown = noteDisplay(view("x".repeat(300)));
  expect(shown.data).toMatchObject({ text: "x".repeat(240) }); expect(shown.partial).toBe(true);
  const metadata = { curated: { builtAt: 1000, binding: "b", expiresAt: 2000 } };
  expect(curatedCacheFresh(metadata, "b", 1500)).toBe(true);
  expect(curatedCacheFresh(metadata, "other", 1500)).toBe(false);
  expect(curatedCacheFresh({ curated: { ...metadata.curated, binding: "next" } }, "b", 1500)).toBe(false);
  expect(curatedCacheFresh(metadata, "b", 2000)).toBe(false);
  expect(curatedCacheFresh({ curated: { ...metadata.curated, builtAt: 1501 } }, "b", 1500)).toBe(false);
  expect(curatedCacheFresh({ curated: { ...metadata.curated, expiresAt: null } }, "b", 1000 + 24 * 60 * 60 * 1000 - 1)).toBe(true);
  expect(curatedCacheFresh({ curated: { ...metadata.curated, expiresAt: null } }, "b", 1000 + 24 * 60 * 60 * 1000)).toBe(false);
});

test("standalone screening withholds private source and host policy is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-")); roots.push(root);
  const source = view("private 123-45-6789");
  const store = { withDeferredPromotions: <T>(work: () => T) => work(), readPage: () => ({ rows: [source] }) };
  expect(() => buildCuratedBriefCache(store as Pick<MemoryStore, "readPage" | "withDeferredPromotions">, { base: root, project: "p", directory: root, binding: "b", policy: { host: { screen: async () => true } } })).toThrow(/synchronous standalone policy/);
  buildCuratedBriefCache(store as Pick<MemoryStore, "readPage" | "withDeferredPromotions">, { base: root, project: "p", directory: root, binding: "b" });
  expect(readBriefCache({ directory: root, project: "p", section: "curated" })!.rows).toHaveLength(0);
});

test("source screening and complete cached rows stay within the shared byte cap", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-")); roots.push(root);
  const oversized = view("visible excerpt", { about: ["a".repeat(12_000), "b".repeat(12_000), "c".repeat(12_000)] });
  const privateRow = view("private 123-45-6789", { id: "c".repeat(32) });
  const publicRow = view("public row", { id: "d".repeat(32) });
  const rows = [oversized, privateRow, publicRow];
  const store = { withDeferredPromotions: <T>(work: () => T) => work(), readPage: () => ({ rows }) };
  buildCuratedBriefCache(store as Pick<MemoryStore, "readPage" | "withDeferredPromotions">, { base: root, project: "p", directory: root, binding: "b", now: () => 10_000 });
  const binding = { directory: root, project: "p", section: "curated" as const }, cache = readBriefCache(binding)!;
  expect(cache.rows.map(row => (row.source as View).id)).toEqual([publicRow.id]);
  expect(cache.partial).toBe(true);
  expect(Bun.file(join(root, "brief-curated.json")).size).toBeLessThanOrEqual(BRIEF_CACHE_BYTES);
  expect(JSON.stringify(cache)).not.toContain("123-45-6789");
});

test("cache selection and earliest expiry match the real MemoryStore readPage", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-curated-real-")); roots.push(root);
  const project = "curated-parity", generation = "e".repeat(32);
  const initial = new MemoryStore({ memoryDir: root, deferPromotions: true }); initial.close();
  await migrate({ memoryDir: root, generation, mode: "apply", authorizedPerson: true, tty: true });
  const now = Date.now(), store = new MemoryStore({ memoryDir: root, deferPromotions: true, now: () => now });
  try {
    const expiryTimes = [now + 30_000, now + 10_000, now + 60_000, now + 70_000, null, null];
    for (let index = 0; index < 6; index++) store.note({ op: "note", project, scope: "project", tier: expiryTimes[index] === null ? "long" : "short", kind: "decision", peer: "person", source: "person",
      text: `row ${index}`, about: [], ...(expiryTimes[index] === null ? {} : { expires: new Date(expiryTimes[index]!).toISOString() }) });
    const expected: View[] = [];
    let after: { position: number; id: string } | undefined;
    for (let pageNo = 0; pageNo < 4 && expected.length < 4; pageNo++) {
      const page = store.readPage({ project, limit: 32, after });
      for (const item of page.rows) {
        if (item.project !== project || item.supersededBy || item.expiresAt !== null && Date.parse(item.expiresAt) <= now) continue;
        if (expected.length === 4) break;
        expected.push(item);
      }
      if (!page.next) break;
      after = { position: page.next.position, id: page.next.id };
    }
    buildCuratedBriefCache(store, { base: root, project, directory: root, binding: generation, now: () => now });
    const cache = readBriefCache({ directory: root, project, section: "curated" })!;
    expect(cache.rows.map(row => (row.source as View).id)).toEqual(expected.map(item => item.id));
    expect(cache.curated?.expiresAt).toBe(Math.min(...expected.flatMap(item => item.expiresAt ? [Date.parse(item.expiresAt)] : [])));
  } finally { store.close(); }
});
