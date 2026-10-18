import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { WorkListStore, type WorkListFields } from "../src/memory/work-lists.ts";

const CEILING = 5000, refusal = "work-list read exceeds 5000-row ceiling";
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "amem-work-budget-")), project = "fixture/work-budget";
  const store = new WorkListStore({ base, project, policy: () => true });
  return { base, project, store, close() { store.close(); rmSync(base, { recursive: true, force: true }); } };
}

for (const named of [false, true]) test(`work-list ${named ? "named-list" : "whole-project"} read refuses over 5000 persisted rows before payload materialization`, async () => {
  const f = fixture();
  // An isolated derived DB is sufficient: empty log/heads means refresh has no new rows or reset to perform.
  // Corrupt payloads prove the refusal precedes decode as well as .all(), rather than hiding a payload failure.
  const db = new Database(join(f.store.dir, "index.db"));
  db.transaction(() => {
    const insert = db.query("INSERT INTO work_ops (id, at, machine, payload, position) VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i <= CEILING; i++) insert.run(`synthetic-${i}`, i, "a".repeat(16), "invalid payload must never be loaded", i);
  })();
  db.close();
  const index = (f.store as unknown as { db: Database }).db;
  const query = index.query.bind(index);
  let materializations = 0;
  const preparing = spyOn(index, "query");
  preparing.mockImplementation(((sql: string) => {
    const statement = query(sql);
    if (!/^\s*SELECT\s+payload\s*,\s*position\s+FROM\s+work_ops/i.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === "all") return () => { materializations++; throw new Error("unbounded work payload .all() was reached"); };
      return Reflect.get(target, key, target);
    } });
  }) as typeof index.query);
  try {
    let error: unknown;
    try { await f.store.read(named ? "one-list" : undefined, true); } catch (caught) { error = caught; }
    expect((error as Error | undefined)?.message).toBe(refusal);
    expect(materializations).toBe(0);
  } finally { preparing.mockRestore(); f.close(); }
});

for (const count of [CEILING - 1, CEILING]) test(`work-list ${count}-row boundary preserves complete reduction and rebuild; append remains allowed`, async () => {
  const f = fixture(), machine = "a".repeat(16);
  let text = "";
  for (let i = 0; i < count; i++) {
    const fields: WorkListFields = i < count - 4 ? { progress: i, transient: "clear" }
      : i === count - 4 ? { status: "doing", transient: null, ready: true }
      : i === count - 3 ? { task: "compile", status: "todo", detail: "old" }
      : i === count - 2 ? { task: "compile", status: "done", detail: null } : { status: "done" };
    const body = { schema: "agent-mem.work-list/v1", project: f.project, machine, at: i, nonce: i.toString(16).padStart(32, "0"), list: "release", fields };
    text += canonicalJSON({ ...body, id: hashJSON(body) }) + "\n";
  }
  writeFileSync(join(f.store.dir, "log", `${machine}.jsonl`), text);
  try {
    const expected = [{ list: "release", fields: { progress: count - 5, ready: true, status: "done" }, items: [{ task: "compile", fields: { status: "done" } }], closed: true }];
    expect(await f.store.read()).toEqual([]);
    expect(await f.store.read(undefined, true)).toEqual(expected);
    expect(await f.store.read("release", true)).toEqual(expected);
    f.store.rebuild();
    expect(await f.store.read(undefined, true)).toEqual(expected);
    expect(await f.store.read("release", true)).toEqual(expected);
    if (count === CEILING) {
      await expect(f.store.write("beyond", { status: "doing" })).resolves.toMatchObject({ already: false });
      await expect(f.store.read()).rejects.toThrow(refusal);
      await expect(f.store.read("release", true)).rejects.toThrow(refusal);
    }
  } finally { f.close(); }
});
