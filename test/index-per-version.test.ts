import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INDEX_VERSION, indexFileName } from "../src/memory/index-file.ts";
import { MemoryStore } from "../src/memory/store.ts";

// #199 AC4: two releases with different INDEX_VERSION alternate on one home without dropping each other's derived index.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const schemaVersion = (file: string) => { const db = new Database(file, { readonly: true }); try { return (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version; } finally { db.close(); } };
const userVersion = (file: string) => { const db = new Database(file, { readonly: true }); try { return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version; } finally { db.close(); } };
const note = (text: string) => ({ op: "note" as const, project: "p", scope: "project" as const, tier: "long" as const, kind: "finding" as const, peer: "person", text, about: [], source: "person" as const });

test("each index version has its own file; version 3 keeps the released names", () => {
  expect(INDEX_VERSION).toBe(3);
  expect([indexFileName(false), indexFileName(true)]).toEqual(["index.db", "index-v2.db"]);
  const names = [false, true].flatMap(foreign => [3, 4, 5].map(version => indexFileName(foreign, version)));
  expect(new Set(names).size).toBe(names.length);
  expect(indexFileName(false, 4)).toBe("index-v4.db"); expect(indexFileName(true, 4)).toBe("index-v2-i4.db");
});

test("a newer version's index beside this one is neither opened nor dropped, and this one stays warm", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-index-version-")); roots.push(home);
  const first = new MemoryStore({ memoryDir: home, screen: () => "keep" }); first.note(note("alternating index")); first.close();
  const ours = join(home, indexFileName(false)), future = join(home, indexFileName(false, INDEX_VERSION + 1));
  const db = new Database(future, { create: true }); db.run(`PRAGMA user_version = ${INDEX_VERSION + 1}`); db.run("CREATE TABLE future_rows (id TEXT)"); db.close();
  const futureBytes = readFileSync(future), schema = schemaVersion(ours);
  for (let round = 0; round < 2; round++) {
    const store = new MemoryStore({ memoryDir: home });
    try { expect(store.list({ project: "p" }).map(row => row.text)).toEqual(["alternating index"]); } finally { store.close(); }
    // The other version reopening its own file changes nothing here either.
    const other = new Database(future); other.run("INSERT INTO future_rows VALUES ('x')"); other.close();
  }
  expect(schemaVersion(ours)).toBe(schema); expect(userVersion(ours)).toBe(INDEX_VERSION);
  expect(userVersion(future)).toBe(INDEX_VERSION + 1); expect(readFileSync(future).length).toBeGreaterThanOrEqual(futureBytes.length);
});

test("this release and the published 0.17.0 share the version-3 index without a rebuild", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-index-v017-")); roots.push(home);
  const v017 = pathToFileURL(resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v017/src/memory/store.ts")).href;
  const run = (code: string) => { const result = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, AMEM_HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0); return result.stdout.toString(); };
  run(`const { MemoryStore } = await import(${JSON.stringify(v017)}); const s = new MemoryStore({ memoryDir: ${JSON.stringify(home)}, screen: () => "keep" }); s.note(${JSON.stringify(note("shared by 0.17.0"))}); s.close();`);
  const ours = join(home, indexFileName(false)), schema = schemaVersion(ours);
  const mine = new MemoryStore({ memoryDir: home, screen: () => "keep" }); try { mine.note(note("shared by this release")); } finally { mine.close(); }
  expect(run(`const { MemoryStore } = await import(${JSON.stringify(v017)}); const s = new MemoryStore({ memoryDir: ${JSON.stringify(home)} }); console.log(s.list({ project: "p" }).length); s.close();`).trim()).toBe("2");
  expect(schemaVersion(ours)).toBe(schema);
});
