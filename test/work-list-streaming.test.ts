import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { WorkListStore, type WorkListFields, type WorkListPolicy, type WorkListSource } from "../src/memory/work-lists.ts";

function fixture(policy: WorkListPolicy = () => true) {
  const base = mkdtempSync(join(tmpdir(), "amem-work-stream-")), project = "fixture/work-stream";
  const store = new WorkListStore({ base, project, policy });
  return { base, project, store, close() { store.close(); rmSync(base, { recursive: true, force: true }); } };
}
function row(project: string, machine: string, index: number, fields: WorkListFields, source?: WorkListSource, at = index) {
  const body = { schema: "agent-mem.work-list/v1", project, machine, at, nonce: index.toString(16).padStart(32, "0"), list: "release", fields,
    ...(source ? { source } : {}) };
  return { ...body, id: hashJSON(body) };
}
function segment(f: ReturnType<typeof fixture>, machine: string, rows: ReturnType<typeof row>[]) {
  const file = join(f.store.dir, "log", `${machine}.jsonl`), text = rows.map(value => canonicalJSON(value) + "\n").join("");
  writeFileSync(file, text);
  return { file, text };
}

// This is a transparent SQL materialization guard, not a replacement store or mocked row source.
// Iterators are allowed; .all() is allowed only for SQL that explicitly bounds the payload page.
test("work-list payload reads never materialize an unbounded all() result", async () => {
  const f = fixture(), machine = "a".repeat(16);
  segment(f, machine, Array.from({ length: 500 }, (_, index) => row(f.project, machine, index, { progress: index })));
  const original = Database.prototype.query;
  let payloadReads = 0, unbounded = 0;
  const preparing = spyOn(Database.prototype, "query");
  preparing.mockImplementation((function(this: Database, sql: string) {
    const statement = Reflect.apply(original, this, [sql]);
    if (!/\bpayload\b/i.test(sql) || !/\bFROM\s+work_ops\b/i.test(sql) || !/^\s*(SELECT|WITH)\b/i.test(sql)) return statement;
    payloadReads++;
    return new Proxy(statement, { get(target, key) {
      if (key === "all" && !/\bLIMIT\b/i.test(sql)) return () => { unbounded++; throw new Error("unbounded work payload .all() was reached"); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof Database.prototype.query);
  try {
    expect(await f.store.read("release", true)).toEqual([{ list: "release", fields: { progress: 499 }, items: [], closed: false }]);
    expect(payloadReads).toBeGreaterThan(0);
    expect(unbounded).toBe(0);
  } finally { preparing.mockRestore(); f.close(); }
});

test("current work-list policy screens a 10006-operation history before latest fields and open-state reduction", async () => {
  const f = fixture(input => (input as { fields: WorkListFields }).fields.privateGate !== true), machine = "b".repeat(16);
  const rows = Array.from({ length: 10001 }, (_, index) => row(f.project, machine, index, { progress: index, status: "doing", temporary: "clear" }));
  rows.push(row(f.project, machine, 10001, { temporary: null, count: 10001 }));
  rows.push(row(f.project, machine, 10002, { status: "done", progress: -1, privateGate: true }));
  rows.push(row(f.project, machine, 10003, { task: "compile", status: "todo", detail: "old" }));
  rows.push(row(f.project, machine, 10004, { task: "compile", status: "done", detail: null }));
  rows.push(row(f.project, machine, 10005, { task: "compile", status: "dropped", privateGate: true }));
  const log = segment(f, machine, rows);
  const expected = [{ list: "release", fields: { progress: 10000, status: "doing", count: 10001 }, items: [{ task: "compile", fields: { status: "done" } }], closed: false }];
  try {
    expect(await f.store.read()).toEqual(expected);
    expect(await f.store.read("release")).toEqual(expected);
    expect(readFileSync(log.file, "utf8")).toBe(log.text);
    f.store.rebuild();
    expect(await f.store.read()).toEqual(expected);
    expect(readFileSync(log.file, "utf8")).toBe(log.text);
  } finally { f.close(); }
});

test("an asynchronous policy read holds its initial history frontier across a concurrent append", async () => {
  let enter!: () => void, release!: () => void, hold = true;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const allowed = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const f = fixture(() => { if (!hold) return true; hold = false; enter(); return allowed; });
  const machine = "c".repeat(16);
  segment(f, machine, Array.from({ length: 10001 }, (_, index) => row(f.project, machine, index, { progress: index })));
  const writer = new WorkListStore({ base: f.base, project: f.project, policy: () => true, now: () => 20000 });
  const initial = f.store.read("release");
  // A premature refusal is a named assertion failure, never an unhandled rejection or hung barrier.
  const reached = Promise.race([entered.then(() => true), initial.then(() => false, () => false)]);
  try {
    expect(await reached).toBe(true);
    await expect(writer.write("release", { progress: 20000, appended: true })).resolves.toMatchObject({ already: false });
    release();
    expect(await initial).toEqual([{ list: "release", fields: { progress: 10000 }, items: [], closed: false }]);
    expect(await f.store.read("release")).toEqual([{ list: "release", fields: { progress: 20000, appended: true }, items: [], closed: false }]);
  } finally { release(); await initial.catch(() => {}); writer.close(); f.close(); }
});

test("same-epoch imports retain numeric leading-zero ties and UTF-16 source order across machines", async () => {
  const f = fixture(), left = "d".repeat(16), right = "e".repeat(16), at = 500;
  const origin = { source: "fixture-import", machine: "source-device", at };
  const numeric = ["work-10", "work-0010", "work-9", "work-0009"];
  const leftRows = numeric.map((id, index) => row(f.project, left, index, { numeric: id }, { ...origin, id }, at));
  // UTF-8 BINARY collation orders these origins opposite to JavaScript's UTF-16 lexical comparison.
  const supplementary = row(f.project, right, 0, { unicode: "supplementary origin" }, { ...origin, source: "source-𐀀", id: "1" }, at);
  const bmp = row(f.project, left, 10, { unicode: "BMP origin" }, { ...origin, source: "source-豈", id: "1" }, at);
  const logs = [segment(f, left, [bmp, ...leftRows]), segment(f, right, [supplementary])];
  const expected = [{ list: "release", fields: { numeric: "work-10", unicode: "BMP origin" }, items: [], closed: false }];
  try {
    expect(await f.store.read("release")).toEqual(expected);
    f.store.rebuild();
    expect(await f.store.read("release")).toEqual(expected);
    for (const log of logs) expect(readFileSync(log.file, "utf8")).toBe(log.text);
  } finally { f.close(); }
});

test("a legacy derived index and later legacy-writer rows regain replay metadata without changing logs", async () => {
  const f = fixture(), machine = "f".repeat(16);
  const log = segment(f, machine, Array.from({ length: 30 }, (_, index) => row(f.project, machine, index, { progress: index })));
  let reopened: WorkListStore | undefined;
  try {
    const expected = [{ list: "release", fields: { progress: 29 }, items: [], closed: false }];
    expect(await f.store.read()).toEqual(expected);
    f.store.close();
    const legacy = new Database(join(f.store.dir, "index.db"));
    try { legacy.run("DROP INDEX work_replay"); legacy.run("ALTER TABLE work_ops DROP COLUMN replay"); } finally { legacy.close(); }
    reopened = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
    expect(await reopened.read()).toEqual(expected);
    const oldWriter = new Database(join(f.store.dir, "index.db"));
    try { oldWriter.run("UPDATE work_ops SET replay = ''"); } finally { oldWriter.close(); }
    expect(await reopened.read()).toEqual(expected);
    reopened.rebuild();
    expect(await reopened.read()).toEqual(expected);
    expect(readFileSync(log.file, "utf8")).toBe(log.text);
  } finally { reopened?.close(); f.close(); }
});

test("closing a store releases a policy-held WAL reader and rejects rather than returning a partial view", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const allowed = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const f = fixture(() => { enter(); return allowed; }), machine = "9".repeat(16);
  segment(f, machine, [row(f.project, machine, 0, { progress: 0 }), row(f.project, machine, 1, { progress: 1 })]);
  const reading = f.store.read().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  const checkpoint = new Database(join(f.store.dir, "index.db"));
  checkpoint.run("PRAGMA busy_timeout = 0");
  try {
    await entered;
    expect((checkpoint.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }).busy).toBe(1);
    f.store.close();
    expect((checkpoint.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }).busy).toBe(0);
    release();
    const result = await reading;
    expect(result.value).toBeUndefined();
    expect(result.error?.message).toContain("closed");
  } finally { release(); await reading; checkpoint.close(); f.close(); }
});
