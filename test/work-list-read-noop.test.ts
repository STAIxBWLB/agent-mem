import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { hashJSON, canonicalJSON } from "../src/memory/generation.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "amem-work-noop-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const store = new WorkListStore({ base, project: "fixture/noop", policy: () => true }); cleanup.push(() => store.close());
  await store.write("plan", { goal: "keep", status: "doing" });
  const observer = new Database(join(store.dir, "index.db")); cleanup.push(() => observer.close());
  const version = () => (observer.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  return { base, store, observer, version };
}

test("unchanged work-list reads keep another connection's SQLite data_version unchanged", async () => {
  const f = await fixture(), before = f.version(), expected = [{ list: "plan", fields: { goal: "keep", status: "doing" }, items: [], closed: false }];
  expect(await f.store.read()).toEqual(expected);
  expect(await f.store.read()).toEqual(expected);
  expect(f.version()).toBe(before);
  // A no-op must remain a no-op across a new store handle too, not just an in-memory cache hit.
  const reopened = new WorkListStore({ base: f.base, project: "fixture/noop", policy: () => true });
  try { expect(await reopened.read()).toEqual(expected); expect(f.version()).toBe(before); } finally { reopened.close(); }
});

test("append and forced rebuild still commit and incremental work views equal rebuild", async () => {
  const f = await fixture(), before = f.version();
  await f.store.write("plan", { goal: "next" });
  expect(f.version()).not.toBe(before);
  const incremental = await f.store.read(), afterAppend = f.version();
  expect(incremental[0]?.fields.goal).toBe("next");
  expect(f.version()).toBe(afterAppend);
  f.store.rebuild(); expect(f.version()).not.toBe(afterAppend);
  const afterRebuild = f.version(); expect(await f.store.read()).toEqual(incremental); expect(f.version()).toBe(afterRebuild);
});

test("a new empty segment records its head once and removed segments still trigger reset", async () => {
  const f = await fixture(), name = "fedcba9876543210.jsonl", file = join(f.store.dir, "log", name), before = f.version();
  writeFileSync(file, ""); const expected = await f.store.read();
  expect(f.version()).not.toBe(before);
  expect(f.observer.query("SELECT bytes FROM work_heads WHERE file = ?").get(name)).toEqual({ bytes: 0 });
  const first = f.version(); expect(await f.store.read()).toEqual(expected); expect(f.version()).toBe(first);
  unlinkSync(file); expect(await f.store.read()).toEqual(expected); expect(f.version()).not.toBe(first);
  expect(f.observer.query("SELECT file FROM work_heads WHERE file = ?").get(name)).toBeNull();
});

test("unchanged heads never suppress legacy replay-key backfill", async () => {
  const f = await fixture(), expected = await f.store.read();
  f.observer.run("UPDATE work_ops SET replay = ''"); const before = f.version();
  expect(await f.store.read()).toEqual(expected);
  expect(f.version()).not.toBe(before);
  expect(f.observer.query("SELECT count(*) AS n FROM work_ops WHERE replay = ''").get()).toEqual({ n: 0 });
  const backfilled = f.version(); expect(await f.store.read()).toEqual(expected); expect(f.version()).toBe(backfilled);
});

test("same-size full-prefix replacement still resets the derived index and matches rebuild", async () => {
  const f = await fixture(), folder = join(f.store.dir, "log"), file = join(folder, readdirSync(folder)[0]!), previous = readFileSync(file, "utf8");
  const { id: _id, ...body } = JSON.parse(previous.trim()); body.fields.goal = "next";
  const replacement = canonicalJSON({ ...body, id: hashJSON(body) }) + "\n";
  expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(previous)); writeFileSync(file, replacement);
  const before = f.version(), incremental = await f.store.read();
  expect(f.version()).not.toBe(before); expect(incremental[0]?.fields.goal).toBe("next");
  f.store.rebuild(); expect(await f.store.read()).toEqual(incremental);
});
