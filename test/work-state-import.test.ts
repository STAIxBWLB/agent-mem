import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importClaudeMemWorkState } from "../src/memory/import.ts";
import { appendAlias } from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(synced = true) {
  const base = mkdtempSync(join(tmpdir(), "amem-work-import-")); dirs.push(base);
  const file = join(base, "source.db"), db = new Database(file);
  db.run(`CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER${synced ? ", origin_device_id TEXT, origin_local_id TEXT" : ""})`);
  const add = (project: string, list: string, fields: unknown, at = 100, origin?: [string, string]) => {
    db.query(`INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch${synced ? ", origin_device_id, origin_local_id" : ""}) VALUES (?, ?, ?, ?${synced ? ", ?, ?" : ""})`)
      .run(project, list, JSON.stringify(fields), at, ...(synced ? [origin?.[0] ?? null, origin?.[1] ?? null] : []));
  };
  const alias = (name = "old/app") => appendAlias(base, { alias: name, key: "github.com/o/app", actor: "person", machine: "fixture" });
  const opts = { base, project: "github.com/o/app", policy: () => true, db: file };
  return { base, file, db, add, alias, opts };
}

test("work_state import requires reviewed D2 aliases, reduces scalar/null updates, preserves source bytes and append receipts", async () => {
  const f = fixture();
  f.add("old/app", "release", { task: "ship", status: "todo", count: 1 });
  f.add("old/app", "release", { task: "ship", status: "done", count: null });
  f.add("old/app", "release", { detail: "latest", enabled: true });
  f.add("old/app", "release", { status: "done", detail: null });
  f.add("other/app", "unrelated", { status: "doing" });
  f.db.close(); const before = readFileSync(f.file);
  expect(await importClaudeMemWorkState(f.opts)).toMatchObject({ read: 0, added: 0 });
  f.alias();
  expect(await importClaudeMemWorkState(f.opts)).toMatchObject({ read: 4, added: 4, skipped: { invalid: 0, policy: 0 }, cursor: 4 });
  const store = new WorkListStore(f.opts);
  try {
    expect(await store.read()).toEqual([]);
    const expected = [{ list: "release", fields: { enabled: true, status: "done" }, items: [{ task: "ship", fields: { status: "done" } }], closed: true }];
    expect(await store.read(undefined, true)).toEqual(expected);
    const log = join(store.dir, "log", readdirSync(join(store.dir, "log"))[0]!);
    const appended = readFileSync(log);
    expect(await importClaudeMemWorkState({ ...f.opts, restart: true })).toMatchObject({ read: 4, added: 0 });
    expect(readFileSync(log)).toEqual(appended);
    store.rebuild(); expect(await store.read(undefined, true)).toEqual(expected);
  } finally { store.close(); }
  expect(readFileSync(f.file)).toEqual(before);
});

test("bounded work import advances invalid and policy skips without leaking another project", async () => {
  const f = fixture(false); f.alias();
  f.add("other/app", "hidden", { status: "doing" });
  f.add("old/app", "release", { nested: { invalid: true } });
  f.add("old/app", "release", { detail: "withheld" });
  f.add("old/app", "release", { task: "ship", status: "doing" });
  f.db.close();
  const opts = { ...f.opts, limit: 1, policy: (row: unknown) => !JSON.stringify(row).includes("withheld") };
  expect(await importClaudeMemWorkState(opts)).toMatchObject({ read: 1, added: 0, skipped: { invalid: 1, policy: 0 }, cursor: 2 });
  expect(await importClaudeMemWorkState(opts)).toMatchObject({ read: 1, added: 0, skipped: { invalid: 0, policy: 1 }, cursor: 3 });
  expect(await importClaudeMemWorkState(opts)).toMatchObject({ read: 1, added: 1, cursor: 4 });
  expect(await importClaudeMemWorkState(opts)).toMatchObject({ read: 0, more: false, cursor: 4 });
  const store = new WorkListStore(f.opts);
  try { expect(await store.read()).toEqual([{ list: "release", fields: {}, items: [{ task: "ship", fields: { status: "doing" } }], closed: false }]); } finally { store.close(); }
});

test("synced source receipts deduplicate a copied database and retain numeric source sequence for tied epochs", async () => {
  const f = fixture(); f.alias();
  f.add("old/app", "release", { status: "done" }, 100, ["device", "10"]);
  f.add("old/app", "release", { status: "doing" }, 100, ["device", "9"]);
  f.db.close();
  expect(await importClaudeMemWorkState(f.opts)).toMatchObject({ added: 2 });
  const copy = join(f.base, "copy.db"); await Bun.write(copy, readFileSync(f.file));
  expect(await importClaudeMemWorkState({ ...f.opts, db: copy })).toMatchObject({ read: 2, added: 0 });
  const store = new WorkListStore(f.opts);
  try { expect(await store.read()).toEqual([]); expect(await store.read(undefined, true)).toMatchObject([{ closed: true }]); } finally { store.close(); }
});

test("missing work_state table is a compatible no-op and superseded aliases do not import", async () => {
  const f = fixture(); f.alias(); f.add("old/app", "release", { status: "doing" });
  appendAlias(f.base, { alias: "old/app", key: "other", actor: "person", machine: "fixture" });
  f.db.close(); expect(await importClaudeMemWorkState(f.opts)).toMatchObject({ read: 0 });
  const db = new Database(f.file); db.run("DROP TABLE work_state_entries"); db.close();
  expect(await importClaudeMemWorkState(f.opts)).toMatchObject({ read: 0, added: 0, more: false });
});

test("secret screening and policy errors fail closed before work state changes", async () => {
  const f = fixture(); f.alias();
  f.add("old/app", "release", { detail: "token: abcdefgh12345678" });
  f.add("old/app", "release", { status: "done" });
  f.db.close();
  expect(await importClaudeMemWorkState({ ...f.opts, policy: () => { throw new Error("unavailable"); } }))
    .toMatchObject({ read: 2, added: 0, skipped: { invalid: 0, policy: 2 } });
  expect(await importClaudeMemWorkState({ ...f.opts, restart: true }))
    .toMatchObject({ read: 2, added: 1, skipped: { invalid: 0, policy: 1 } });
  const store = new WorkListStore(f.opts);
  try { expect(await store.read(undefined, true)).toEqual([{ list: "release", fields: { status: "done" }, items: [], closed: true }]); } finally { store.close(); }
});

test("a changed imported source receipt refuses without advancing past the failed row", async () => {
  const f = fixture(); f.alias(); f.add("old/app", "release", { status: "doing" }); f.db.close();
  expect(await importClaudeMemWorkState(f.opts)).toMatchObject({ added: 1 });
  const db = new Database(f.file);
  db.query("UPDATE work_state_entries SET fields = ? WHERE id = 1").run(JSON.stringify({ status: "done" })); db.close();
  await expect(importClaudeMemWorkState({ ...f.opts, restart: true })).rejects.toThrow("source receipt conflicts");
  const store = new WorkListStore(f.opts);
  try { expect(await store.read()).toMatchObject([{ closed: false, fields: { status: "doing" } }]); } finally { store.close(); }
});
