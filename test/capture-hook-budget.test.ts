import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { CaptureStore } from "../src/memory/capture.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const row = (project: string, excerpt: string) => ({ at: new Date().toISOString(), project, agent: "claude", event: "Stop", excerpt });

test("bounded hook writer initializes an empty shard and keeps replay idempotent", () => {
  const f = hookFixture();
  try {
    const store = new CaptureStore({ memoryDir: f.base, project: f.project, hookBudget: () => 1000 });
    try {
      const input = row(f.project, "bounded row");
      const first = store.append(input, { receipt: "a".repeat(64) });
      if (!("id" in first)) throw Error("empty store unexpectedly spooled");
      expect(store.append(input, { receipt: "a".repeat(64) })).toMatchObject({ id: first.id, already: true });
      expect(store.rows()).toHaveLength(1);
    } finally { store.close(); }
  } finally { f.close(); }
});

test("bounded hook writer defers a cold nonempty FTS build without losing rows", () => {
  const f = hookFixture();
  try {
    const store = new CaptureStore({ memoryDir: f.base, project: f.project });
    store.append(row(f.project, "existing cold row")); const file = join(store.dir, "capture.db"); store.close();
    const db = new Database(file);
    db.run("DROP TRIGGER rows_ai; DROP TRIGGER rows_ad; DROP TRIGGER rows_au; DROP TABLE fts"); db.close();
    expect(() => new CaptureStore({ memoryDir: f.base, project: f.project, hookBudget: () => 1000 })).toThrow("cold index deferred");
    const check = new Database(file); expect(check.query("SELECT name FROM sqlite_master WHERE name='fts'").get()).toBeNull(); check.close();
    const recovered = new CaptureStore({ memoryDir: f.base, project: f.project });
    try { expect(recovered.rows().map(r => r.excerpt)).toEqual(["existing cold row"]); recovered.append(row(f.project, "later row")); expect(recovered.stats().rows).toBe(2); }
    finally { recovered.close(); }
  } finally { f.close(); }
});

test("bounded hook writer drains older spool rows before admitting a newer row", () => {
  const f = hookFixture();
  try {
    const initial = new CaptureStore({ memoryDir: f.base, project: f.project }), dir = initial.dir; initial.close();
    const spool = join(dir, "spool"); mkdirSync(spool, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(join(spool, "spool-00000001.jsonl"), Array.from({ length: 100 }, (_, i) => JSON.stringify({ at, project: f.project, agent: "claude", event: "Stop", tool: null, paths: [], status: null, excerpt: `old ${i}`, bytes: 10, nonce: String(i) })).join("\n") + "\n");
    const store = new CaptureStore({ memoryDir: f.base, project: f.project, hookBudget: () => 1000 });
    try {
      expect(() => store.append(row(f.project, "newest"), { receipt: "newest" })).toThrow("backlog deferred");
      expect(store.stats().rows).toBe(32);
      expect(() => store.append(row(f.project, "newest"), { receipt: "newest" })).toThrow("backlog deferred");
      expect(store.stats().rows).toBe(64);
      expect(() => store.append(row(f.project, "newest"), { receipt: "newest" })).toThrow("backlog deferred");
      store.append(row(f.project, "newest"), { receipt: "b".repeat(64) });
      expect(store.rows().map(r => r.excerpt)).toEqual([...Array.from({ length: 100 }, (_, i) => `old ${i}`), "newest"]);
    } finally { store.close(); }
  } finally { f.close(); }
});

test("bounded hook writer refuses an expired budget and defers legacy migration", () => {
  const f = hookFixture();
  try {
    const store = new CaptureStore({ memoryDir: f.base, project: f.project, hookBudget: () => 0 });
    try { expect(() => store.append(row(f.project, "too late"))).toThrow("deadline"); expect(store.stats().rows).toBe(0); }
    finally { store.close(); }
    mkdirSync(join(f.base, "capture")); writeFileSync(join(f.base, "capture", "capture.db"), "legacy fixture");
    expect(() => new CaptureStore({ memoryDir: f.base, project: f.project, hookBudget: () => 1000 })).toThrow("migration deferred");
  } finally { f.close(); }
});
