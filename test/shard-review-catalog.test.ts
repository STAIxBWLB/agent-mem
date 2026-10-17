import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { readCatalog, rebuildCatalog, scanCatalog } from "../src/memory/catalog.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { shardDir } from "../src/memory/shard.ts";
import { MemoryStore } from "../src/memory/store.ts";

const A = "github.com/catalog-review/curated", B = "github.com/catalog-review/capture-only";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-review-catalog-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const base = join(home, "memory"), store = new MemoryStore({ home });
  store.note({ op: "note", project: A, scope: "project", tier: "long", kind: "finding", peer: "codex", source: "person", text: "curated fixture", about: [] }); store.close();
  function capture(key: string, excerpt: string) {
    const writer = new CaptureStore({ home, project: key });
    try { writer.append({ project: key, agent: "codex", event: "Stop", excerpt }); } finally { writer.close(); }
  }
  capture(A, "capture A"); capture(B, "capture B");
  const options = { memoryDir: base, authorizedPerson: true, tty: true };
  async function interrupt() { await expect(migrateShards({ ...options, mode: "apply", checkpoint: stage => { if (stage === "before-active") throw new Error("fixture interrupted"); } })).rejects.toThrow("fixture interrupted"); }
  return { home, base, capture, interrupt, apply: () => migrateShards({ ...options, mode: "apply" }), resume: () => migrateShards({ ...options, mode: "resume" }) };
}

test("F9 captured migration keeps capture catalog readable and curated stats explicitly unavailable without initialization", async () => {
  const f = fixture(); await f.interrupt();
  const captureOnly = shardDir(f.base, B);
  expect(existsSync(join(captureOnly, "generation.json"))).toBe(false);
  for (const rows of [scanCatalog(f.base), rebuildCatalog({ home: f.home }), readCatalog({ home: f.home })]) {
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ captureRows: 1, curatedAvailable: false, curatedEntries: null, curatedLastAt: null });
  }
  expect(existsSync(join(captureOnly, "generation.json"))).toBe(false);
  expect(existsSync(join(captureOnly, "generation-seal.json"))).toBe(false);
  expect(existsSync(join(captureOnly, "index.db"))).toBe(false);
  await f.resume();
  const active = rebuildCatalog({ home: f.home });
  expect(active.find(row => row.key === A)).toMatchObject({ curatedAvailable: true, curatedEntries: 1 });
  expect(active.find(row => row.key === B)).toMatchObject({ curatedAvailable: true, curatedEntries: 0 });
});

test("F9 cached catalog reflects interrupted curated availability without refreshing lagged capture counts", async () => {
  const f = fixture(); await f.apply();
  const saved = rebuildCatalog({ home: f.home }); expect(saved.find(row => row.key === A)?.curatedEntries).toBe(1);
  // Simulate a previously active selection whose resumed migration is interrupted before activation.
  const journalPath = join(f.base, "shards.json");
  const { readProfileJSON, writeProfileJSON } = await import("../src/memory/generation.ts");
  const active = readProfileJSON(journalPath) as Record<string, unknown>;
  writeProfileJSON(journalPath, { ...active, phase: "captured" });
  f.capture(A, "new capture after cached receipt");
  const cached = readCatalog({ home: f.home }).find(row => row.key === A)!;
  expect(cached).toMatchObject({ captureRows: 1, curatedAvailable: false, curatedEntries: null, curatedLastAt: null });
  expect(scanCatalog(f.base).find(row => row.key === A)).toMatchObject({ captureRows: 2, curatedAvailable: false, curatedEntries: null });
});

test("F9 rebuilding a branch-local NOT NULL curated count catalog permits unavailable null receipts", async () => {
  const f = fixture(); await f.interrupt();
  const db = new Database(join(f.base, "catalog.db"));
  db.run(`CREATE TABLE projects (hash TEXT PRIMARY KEY,key TEXT NOT NULL,local INTEGER NOT NULL,aliases TEXT NOT NULL,capture_rows INTEGER NOT NULL,capture_bytes INTEGER NOT NULL,capture_last_at TEXT,curated_entries INTEGER NOT NULL DEFAULT 0,curated_last_at TEXT,cap_mb REAL NOT NULL,retention_days REAL NOT NULL)`); db.close();
  const rebuilt = rebuildCatalog({ home: f.home });
  expect(rebuilt.every(row => row.curatedEntries === null)).toBe(true);
  expect(readCatalog({ home: f.home })).toEqual(rebuilt);
});

test("F9 an active malformed curated index still refuses fresh catalog derivation", async () => {
  const f = fixture(); await f.apply();
  const index = join(shardDir(f.base, A), "index.db");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(index + suffix, { force: true });
  mkdirSync(index);
  expect(() => scanCatalog(f.base)).toThrow();
  expect(() => rebuildCatalog({ home: f.home })).toThrow();
});
