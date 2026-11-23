import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { MEMORY_SCHEMA, MemoryStore, openShardStore, entryId, type NoteInput, type OpInput } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const project = "fixture#project", at = "2030-01-01T00:00:00.000Z";
const key = (id: number, owner = project) => `${owner}#${id}@1`;
const note = (task: string): NoteInput => ({
  op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "fixture", text: task, task, source: "hub", about: [],
});
const settle = (target: string): OpInput => ({ op: "settle", target, by: "2030-01-02T00:00:00.000Z", actor: "fixture" });

function fixture() {
  const memoryDir = mkdtempSync(join(tmpdir(), "amem-unsettled-"));
  cleanup.push(() => rmSync(memoryDir, { recursive: true, force: true }));
  const clock = { now: Date.parse(at) };
  const store = new MemoryStore({ memoryDir, now: () => clock.now, screen: () => "promote" });
  cleanup.push(() => store.close());
  const segment = join(memoryDir, "local", store.machine.id + ".jsonl");
  function append(rows: (NoteInput | OpInput)[]) {
    const lines = rows.map(row => {
      const body = { ...row, schema: MEMORY_SCHEMA, at, machine: store.machine.id } as const;
      return JSON.stringify({ ...body, id: entryId(body) });
    });
    appendFileSync(segment, lines.join("\n") + "\n");
  }
  return { store, clock, segment, append };
}

// Count rows returned by the real keyset query. Its query plan must seek the
// project index, so LIMIT cannot hide a scan of historical settlements.
function measuredPage(store: MemoryStore, limit: number, after?: string, readableStores = 1) {
  const original = Database.prototype.query;
  let keyQueries = 0, candidateRows = 0, settlementQueries = 0;
  const intercept = spyOn(Database.prototype, "query").mockImplementation((function(this: Database, sql: string) {
    const statement = original.call(this, sql);
    const candidates = /^SELECT\s+task\s+FROM\s+unsettled_tasks\b/i.test(sql.trim());
    const settlements = sql.includes("FROM json_each") && sql.includes("FROM ops");
    if (!candidates && !settlements) return statement;
    const db = this;
    return { all(...params: Parameters<typeof statement.all>) {
      const plan = original.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
      const rows = statement.all(...params);
      if (candidates) {
        keyQueries++;
        expect(plan.some(row => /SEARCH unsettled_tasks USING/.test(row.detail))).toBe(true);
        expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
        candidateRows += rows.length;
      } else {
        settlementQueries++;
        expect(plan.some(row => /SEARCH ops\b.*\bops_settlement\b.*target=\?/.test(row.detail))).toBe(true);
        expect(JSON.parse(String(params[0])).length).toBeLessThanOrEqual(limit);
      }
      return rows;
    } } as typeof statement;
  }) as typeof Database.prototype.query);
  try {
    const page = store.unsettledTaskKeys(project, { after, limit });
    expect(keyQueries).toBe(readableStores);
    expect(settlementQueries).toBe(readableStores > 1 && candidateRows ? readableStores : 0);
    expect(candidateRows).toBeLessThanOrEqual(readableStores * (limit + 1));
    return { page, candidateRows };
  } finally { intercept.mockRestore(); }
}

test("warm discovery seeks outstanding keys and agrees with a full point-predicate pass", () => {
  const f = fixture();
  const history = Array.from({ length: 1000 }, (_, i) => key(i));
  f.append(history.flatMap((task, i) => i % 2 ? [note(task), settle(task)] : [settle(task), note(task)]));
  f.store.refresh();
  expect(measuredPage(f.store, 5)).toEqual({ page: { keys: [] }, candidateRows: 0 });

  const open = Array.from({ length: 20 }, (_, i) => key(i + 1000));
  // The board would mark these approved, but their settlement rows never reached the log.
  const interrupted = [key(1100), key(1101), key(1102)];
  const expected = [...open, ...interrupted].sort();
  f.append([...expected.map(note), note(open[0]!), { ...note(open[0]!), text: "second entry" },
    note(key(1, "fixture")), note(key(2, project + "-extra")), note(key(3, project + "#extra")),
    { ...note(key(6, "different-task-project")), project, text: "note and task namespaces differ" }]);
  f.store.refresh();
  const predicate = [...history, ...open, ...interrupted, key(9999)]
    .filter(task => f.store.hasTask(task) && !f.store.settled(task, { includeLegacy: true })).sort();
  expect(predicate).toEqual(expected);

  const found: string[] = [], cursors = new Set<string>();
  let after: string | undefined;
  do {
    const { page } = measuredPage(f.store, 5, after);
    found.push(...page.keys);
    after = page.next;
    if (after !== undefined) { expect(cursors.has(after)).toBe(false); cursors.add(after); }
  } while (after !== undefined);
  expect(found).toEqual(predicate);
  expect(f.store.unsettledTaskKeys("different-task-project").keys).toEqual([key(6, "different-task-project")]);
  expect(f.store.unsettledTaskKeys("fixture").keys).toEqual([key(1, "fixture")]);
  expect(f.store.unsettledTaskKeys(project + "#extra").keys).toEqual([key(3, project + "#extra")]);
  const before = f.store.derivedTables();
  f.store.rebuild();
  expect(f.store.derivedTables()).toEqual(before);
  expect(f.store.unsettledTaskKeys(project, { limit: 100 }).keys).toEqual(predicate);
}, 20_000);

test("the page limit is bounded and cursors stay in their project", () => {
  const { store } = fixture();
  expect(() => store.unsettledTaskKeys("  ")).toThrow("Task discovery requires a non-empty project. Pass the board's project key.");
  for (const limit of [0, 1.5, 257]) expect(() => store.unsettledTaskKeys(project, { limit }))
    .toThrow("Task discovery limit must be an integer from 1 to 256. Omit limit to use 64.");
  expect(store.unsettledTaskKeys(project, { limit: 256 })).toEqual({ keys: [] });
  for (const after of ["", key(1, "another")]) expect(() => store.unsettledTaskKeys(project, { after }))
    .toThrow("Invalid task discovery cursor. Use the next cursor returned for the same project, or omit after to start a new sweep.");
});

test("a later pass includes writes behind the cursor, and discovery refreshes without promoting", () => {
  const { store, append, segment } = fixture();
  append([note(key(2)), note(key(4))]);
  const first = store.unsettledTaskKeys(project, { limit: 1 });
  expect(first.keys).toEqual([key(2)]);
  expect(first.next).toBeDefined();
  append([note(key(1)), note(key(3)), settle(key(4)),
    { ...note(key(5)), tier: "short", kind: "decision" }, settle(key(5))]);
  const bytes = readFileSync(segment);
  expect(store.unsettledTaskKeys(project, { after: first.next })).toEqual({ keys: [key(3)] });
  expect(store.unsettledTaskKeys(project)).toEqual({ keys: [key(1), key(2), key(3)] });
  expect(readFileSync(segment)).toEqual(bytes);
  expect(store.derivedTables().entries).toHaveLength(5);
});

test("expiry removes a task only when its last indexed note is pruned", () => {
  const { store, append, clock } = fixture();
  const task = key(1);
  append([1, 2].map(seconds => ({ ...note(task), tier: "short", expires: new Date(clock.now + seconds * 1000).toISOString() })));
  expect(store.unsettledTaskKeys(project).keys).toEqual([task]);
  for (const expected of [[task], []]) {
    clock.now += 1000;
    expect(store.prune()).toBe(1);
    expect(store.unsettledTaskKeys(project).keys).toEqual(expected);
    expect(store.hasTask(task)).toBe(expected.length > 0);
    const before = store.derivedTables();
    store.rebuild();
    expect(store.derivedTables()).toEqual(before);
  }
});

test("a settlement in the overlay can empty a page while the cursor still reaches alias and shared entries", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "amem-unsettled-overlay-"));
  cleanup.push(() => rmSync(memoryDir, { recursive: true, force: true }));
  const alias = "fixture/legacy";
  const seed = new MemoryStore({ memoryDir });
  try {
    seed.note(note(key(1)));
    seed.note({ ...note(key(2)), project: alias });
    seed.note({ ...note(key(3)), scope: "shared" });
    seed.note({ ...note(key(2)), scope: "shared", text: "duplicate task in another readable store" });
    seed.note({ ...note(key(4, alias)), project: alias });
  } finally { seed.close(); }
  await migrateShards({ memoryDir, mode: "apply", authorizedPerson: true, tty: true });
  const reconciled = openShardStore({ memoryDir, project, reconcile: { canonical: project, aliases: [alias] } });
  cleanup.push(() => reconciled.close());
  const user = openShardStore({ memoryDir, user: true });
  try { user.settle(key(1), "fixture"); } finally { user.close(); }
  const expected = [key(1), key(2), key(3)].filter(task => reconciled.hasTask(task) && !reconciled.settled(task, { includeLegacy: true }));
  expect(expected).toEqual([key(2), key(3)]);
  const first = measuredPage(reconciled, 1, undefined, 3).page;
  expect(first.keys).toEqual([]);
  expect(first.next).toBeDefined();
  const second = measuredPage(reconciled, 1, first.next, 3).page;
  expect(second.keys).toEqual([key(2)]);
  expect(second.next).toBeDefined();
  const third = measuredPage(reconciled, 1, second.next, 3).page;
  expect(third).toEqual({ keys: [key(3)] });
  expect([...first.keys, ...second.keys, ...third.keys]).toEqual(expected);
  expect(reconciled.unsettledTaskKeys(alias).keys).toEqual([key(4, alias)]);
});
