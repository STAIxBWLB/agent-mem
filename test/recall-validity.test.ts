import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryId, MEMORY_SCHEMA, MemoryStore, openShardStore, type NoteEntry, type NoteInput, type OpEntry } from "../src/memory/store.ts";
import { SegmentReader } from "../src/memory/bridge.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { realPath } from "../src/memory/platform.ts";
import { runCli } from "../src/cli.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { rawMemoryCommand } from "../src/memory/commands.ts";
import { createIntentBriefSource, recallGraph, recallRows, recallShow } from "../src/memory/recall.ts";
import { applyPrune, planPrune } from "../src/memory/prune.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Mode = "legacy" | "generation" | "shards";
async function fixture(mode: Mode) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-recall-"))), base = join(root, "memory"), project = "recall-project"; let now = Date.parse("2026-10-20T00:00:00.000Z");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  if (mode !== "legacy") { const seed = new MemoryStore({ memoryDir: base, deferPromotions: true }); seed.close();
    if (mode === "generation") await migrate({ memoryDir: base, generation: "c".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
    else await migrateShards({ memoryDir: base, generation: "d".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  }
  const options = { memoryDir: base, now: () => now, deferPromotions: true, screen: () => "promote" as const };
  const store = mode === "shards" ? openShardStore({ ...options, project }) : new MemoryStore(options); cleanup.push(() => store.close());
  const note = (text: string, extra: Partial<NoteInput> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: ["path:public.ts"], ...extra });
  const bytes = () => readdirSync(base, { recursive: true, withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith(".jsonl")).map(row => [join(row.parentPath, row.name), readFileSync(join(row.parentPath, row.name), "utf8")]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  return { root, base, project, store, note, bytes, clock: () => now, advance: (ms: number) => { now += ms; }, iso: () => new Date(now).toISOString() };
}
for (const mode of ["legacy", "generation", "shards"] as const) {
  test(`${mode}: retained recall folds time without changing internal get or authored bytes`, async () => {
    const f = await fixture(mode), old = f.note("old boundary"); f.advance(1000); const beforeNew = f.iso(); f.advance(1000); const newer = f.note("new boundary"); f.advance(1000); f.store.supersede(old, newer, "person", f.project);
    const expired = f.note("retained expired body", { tier: "short", expires: new Date(f.clock() + 1000).toISOString() }); f.advance(2000);
    f.store.list({ project: f.project }); const before = f.bytes();
    expect(f.store.get(old, f.project)?.supersededBy).toBe(newer);
    expect(f.store.recallState(f.project).views.map(row => row.id)).toEqual([newer]);
    const history = f.store.recallState(f.project, { person: true, history: true }); expect(history.views.map(row => row.id)).toEqual(expect.arrayContaining([old, newer, expired]));
    expect(history.relations).toContainEqual({ from: old, to: newer, kind: "supersede", at: new Date(Date.parse(beforeNew) + 2000).toISOString() });
    expect(f.store.recallState(f.project, { person: true, asOf: beforeNew }).views.map(row => row.id)).toEqual([old]); expect(f.bytes()).toEqual(before);
    const snapshot = f.store.recallState(f.project, { person: true, history: true }); f.store.rebuild(); expect(f.store.recallState(f.project, { person: true, history: true })).toEqual(snapshot);
  });
  test(`${mode}: current forget masks every past date and returns only id/time stubs`, async () => {
    const f = await fixture(mode), id = f.note("FORGOTTEN_BODY_SENTINEL"), past = f.iso(); f.advance(1000); f.store.forget(id, "person", f.project); const forgotten = f.iso(); f.advance(1000);
    for (const options of [{ person: true, history: true }, { person: true, asOf: past }, { person: true, history: true, asOf: past }]) {
      const state = f.store.recallState(f.project, { ...options, person: true }); expect(state.views).toEqual([]); expect(state.forgotten).toEqual([{ id, at: forgotten }]); expect(JSON.stringify(state)).not.toContain("FORGOTTEN_BODY_SENTINEL");
    }
  });
  test(`${mode}: forgetting a promoted copy also masks its earlier short source`, async () => {
    const f = await fixture(mode), short = f.note("FORGOTTEN_PROMOTION_SENTINEL", { tier: "short" }), past = f.iso(); f.advance(1000); const long = f.store.promote(short, "person", f.project)!; expect(long).not.toBe(short); f.advance(1000); f.store.forget(long, "person", f.project);
    const state = f.store.recallState(f.project, { person: true, history: true, asOf: past }); expect(state.views).toEqual([]); expect(state.forgotten.map(row => row.id).sort()).toEqual([short, long].sort()); expect(JSON.stringify(state)).not.toContain("FORGOTTEN_PROMOTION_SENTINEL");
  });
  if (mode !== "legacy") test(`${mode}: current durable prune never exposes retained text through past recall`, async () => {
    const f = await fixture(mode), id = f.note("PRUNED_BODY_SENTINEL", { tier: "short", expires: new Date(f.clock() + 1000).toISOString() }), past = f.iso(); f.advance(2000);
    const auth = { project: f.project, actor: "person" as const, authorize: () => true }, plan = planPrune(f.store.prunePort(), { cutoff: f.iso(), targets: [id] }, auth); expect(plan.rows).toHaveLength(1); applyPrune(f.store.prunePort(), plan, auth);
    const state = f.store.recallState(f.project, { person: true, history: true, asOf: past }); expect(state.views).toEqual([]); expect(JSON.stringify(state)).not.toContain("PRUNED_BODY_SENTINEL");
  });
}
test("retained history rejects invalid/future dates and over-budget sources without authored writes", async () => {
  const f = await fixture("legacy"); f.note("public valid row"); const before = f.bytes();
  for (const asOf of ["2026-02-30", "2026-10-21", "2026-10-19T00:00:00+00:00", "not-a-date"]) expect(() => f.store.recallState(f.project, { person: true, asOf })).toThrow("as-of");
  expect(() => f.store.recallState(f.project, { maxBytes: 16 })).toThrow(); expect(() => f.store.recallState(f.project, { maxRows: 0 })).toThrow(); expect(f.bytes()).toEqual(before);
});
test("unverified complete rows are skipped visibly and incomplete tails never become recall evidence", async () => {
  const f = await fixture("legacy"), id = f.note("verified row"), file = join(f.store.dir, "log", `${f.store.machine.id}.jsonl`);
  appendFileSync(file, '{"schema":"agent-hub.memory/v1","id":"bad"}\n{"not":"complete"');
  const before = f.bytes(), state = f.store.recallState(f.project, { person: true, history: true }); expect(state.views.map(row => row.id)).toEqual([id]); expect(state.malformed).toBe(1); expect(state.incomplete).toBe(true); expect(f.bytes()).toEqual(before);
});

test("as-of uses retained promotion provenance time and labels its unrecoverable event time", async () => {
  const f = await fixture("legacy"), id = f.note("original fact", { tier: "short" }), past = f.iso(); f.advance(1000); const promoted = f.store.promote(id, "person", f.project)!;
  const state = f.store.recallState(f.project, { person: true, asOf: past }); expect(state.views.map(row => row.id)).toEqual([promoted]);
  expect(state.incomplete).toBe(true); expect(state.notices).toEqual(["promotion time unknown: tier before promotion cannot be recovered"]); expect(state.views[0]!.at).toBe(past);
});

test("public search and show preserve reducer revival after the replacement is forgotten", async () => {
  const f = await fixture("legacy"), old = f.note("reviving public original"); f.advance(1000); const newer = f.note("public replacement"); f.store.supersede(old, newer, "person", f.project);
  expect(recallRows(f.store, f.project, { query: "original" }).views).toEqual([]); expect(recallShow(f.store, f.project, old).entry).toBeUndefined(); expect(f.store.get(old, f.project)?.supersededBy).toBe(newer);
  f.advance(1000); f.store.forget(newer, "person", f.project);
  expect(recallRows(f.store, f.project, { query: "original" }).views.map(row => row.id)).toEqual([old]); expect(recallShow(f.store, f.project, old).entry?.id).toBe(old);
});

test("history output limit also bounds forgotten stubs and reports incompleteness", async () => {
  const f = await fixture("legacy"), first = f.note("first forgotten fact"), second = f.note("second forgotten fact"); f.advance(1000); f.store.forget(first, "person", f.project); f.store.forget(second, "person", f.project);
  const result = JSON.parse(await rawMemoryCommand(["list", "--history", "--limit", "1", "--json"], f.root, { person: true, store: f.store, open: () => f.store, project: f.project, readable: rows => rows, importPolicy: () => () => false }));
  expect(result.entries).toEqual([]); expect(result.forgotten).toHaveLength(1); expect(result.incomplete).toBe(true); expect(JSON.stringify(result)).not.toContain("forgotten fact");
});

for (const mode of ["generation", "shards"] as const) test(`${mode}: history budget fences a newly appended generation segment before read/hash/materialization`, async () => {
  const f = await fixture(mode), body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: f.iso(), machine: f.store.machine.id, project: f.project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "new generation row data ".repeat(80), about: [] };
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), JSON.stringify({ ...body, id: entryId(body) }) + "\n", { mode: 0o600 });
  const before = f.bytes(), read = SegmentReader.prototype.read; let bytes = 0;
  SegmentReader.prototype.read = function (...args: Parameters<SegmentReader["read"]>) { const start = this.metrics().bytesRead; try { return read.apply(this, args); } finally { bytes += this.metrics().bytesRead - start; } };
  try { expect(() => f.store.recallState(f.project, { person: true, history: true, maxBytes: 16 })).toThrow("read byte budget"); expect(bytes).toBeLessThanOrEqual(16); }
  finally { SegmentReader.prototype.read = read; }
  expect(f.bytes()).toEqual(before);
});

test("retained-history host authorization is explicit and precedes opening a store", async () => {
  const f = await fixture("legacy"), id = f.note("person-only retained body"); let opens = 0;
  const opts = { project: f.project, open: () => { opens++; return f.store; }, readable: (rows: import("../src/memory/store.ts").View[]) => rows, importPolicy: () => () => false };
  for (const person of [undefined, false]) for (const flags of [["--history"], ["--as-of", f.iso()], [`--as-of=${f.iso()}`]]) {
    await expect(rawMemoryCommand(["show", id, ...flags], f.root, { ...opts, person })).rejects.toThrow("authenticated person");
  }
  expect(opens).toBe(0);
  const history = JSON.parse(await rawMemoryCommand(["show", id, "--history", "--json"], f.root, { ...opts, person: true, store: f.store })); expect(history.views.map((row: { id: string }) => row.id)).toEqual([id]); expect(opens).toBe(0);
});

test("all retained recall entry points require explicit person intent before any store query", () => {
  let reads = 0;
  const unread = new Proxy({}, { get() { reads++; throw Error("unexpected read"); } }) as MemoryStore;
  for (const person of [undefined, false]) for (const options of [{ history: true }, { asOf: "2020-01-01" }]) {
    expect(() => MemoryStore.prototype.recallState.call(unread, "project", { ...options, person })).toThrow("authenticated person");
    expect(() => recallRows(unread, "project", { ...options, person })).toThrow("authenticated person");
    expect(() => recallShow(unread, "project", "invalid", { ...options, person })).toThrow("authenticated person");
    expect(() => recallGraph(unread, "project", "path:public.ts", 1, { ...options, person })).toThrow("authenticated person");
  }
  expect(reads).toBe(0);
});
test("default recall retains finite future timestamps while an explicit as-of cutoff excludes them", async () => {
  const f = await fixture("legacy"), past = f.iso(); f.advance(86400_000); const future = f.note("clock skewed public fact"); f.advance(-86400_000);
  expect(recallRows(f.store, f.project).views.map(view => view.id)).toEqual([future]); expect(recallShow(f.store, f.project, future).entry?.id).toBe(future);
  expect(f.store.recallState(f.project).views.map(view => view.id)).toEqual([future]);
  expect(recallRows(f.store, f.project, { person: true, asOf: past }).views).toEqual([]);
});
test("default CLI graph resolves live starts and excludes superseded/expired neighbours while person history can show them", async () => {
  const f = await fixture("legacy"), project = memoryProjectKey(f.root), note = (text: string, extra: Partial<NoteInput> = {}) => f.note(text, { project, ...extra });
  const old = note("OLD_GRAPH_SENTINEL"), current = note("current graph boundary"); f.store.supersede(old, current, "person", project);
  const expired = note("EXPIRED_GRAPH_SENTINEL", { tier: "short", expires: new Date(f.clock() - 1000).toISOString() }); const before = f.bytes(), saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
  try {
    const context = { cwd: f.root, env: {}, stdinTTY: true };
    await expect(runCli(["graph", old, "--json"], context)).rejects.toThrow("no memory entry");
    const graph = JSON.parse(await runCli(["graph", "path:public.ts", "--json"], context));
    expect(JSON.stringify(graph)).not.toContain(old); expect(JSON.stringify(graph)).not.toContain(expired); expect(JSON.stringify(graph)).not.toContain("OLD_GRAPH_SENTINEL"); expect(JSON.stringify(graph)).not.toContain("EXPIRED_GRAPH_SENTINEL"); expect(JSON.stringify(graph)).toContain(current); expect(f.bytes()).toEqual(before);
    const history = JSON.parse(await runCli(["graph", "path:public.ts", "--history", "--json"], context)); expect(JSON.stringify(history)).toContain(old); expect(JSON.stringify(history)).toContain(expired); expect(f.bytes()).toEqual(before);
    f.store.forget(old, "person", project); expect(JSON.stringify(recallGraph(f.store, project, "path:public.ts", 1, { person: true, history: true }))).not.toContain(old);
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
});
test("live graph projection preserves existing valid graph JSON", async () => {
  const f = await fixture("legacy"), id = f.note("public graph golden");
  expect(recallGraph(f.store, f.project, id)).toEqual(f.store.graph(f.project, `mem:${id}`));
});
for (const mode of ["generation", "shards"] as const) test(`${mode}: successful retained capture reports an unfinished own segment tail without authoring rows`, async () => {
  const f = await fixture(mode), id = f.note("complete prefix"); appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), '{"unfinished":'); const before = f.bytes();
  const result = f.store.recallState(f.project, { person: true, history: true }); expect(result.views.map(view => view.id)).toEqual([id]); expect(result.malformed).toBe(0); expect(result.incomplete).toBe(true); expect(result.sourceIncomplete).toBe(true); expect(f.bytes()).toEqual(before);
});
for (const mode of ["generation"] as const) test(`${mode}: migrated malformed legacy lines remain visible in retained diagnostics`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-retained-malformed-"))), base = join(root, "memory"), project = "diagnostic-project"; cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const seed = new MemoryStore({ memoryDir: base, deferPromotions: true }), id = seed.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "verified migrated note", about: [] }), file = join(seed.dir, "log", `${seed.machine.id}.jsonl`); seed.close(); appendFileSync(file, '{"not":"a valid note"}\n');
  if (mode === "generation") await migrate({ memoryDir: base, generation: "e".repeat(32), mode: "apply", authorizedPerson: true, tty: true });
  else await migrateShards({ memoryDir: base, mode: "apply", authorizedPerson: true, tty: true });
  const store = mode === "generation" ? new MemoryStore({ memoryDir: base, deferPromotions: true }) : openShardStore({ memoryDir: base, project, deferPromotions: true });
  try { const before = readFileSync(file, "utf8"), state = store.recallState(project, { person: true, history: true }); expect(state.views.map(view => view.id)).toEqual([id]); expect(state.malformed).toBeGreaterThan(0); expect(state.incomplete).toBe(true); expect(state.sourceIncomplete).toBe(true); expect(readFileSync(file, "utf8")).toBe(before); }
  finally { store.close(); }
});
test("promotion uncertainty follows emitted rows after query, cap, show selection and current forget", async () => {
  const f = await fixture("legacy"), unchanged = f.note("unrelated unchanged contract"); f.advance(1000); const short = f.note("promoted fact", { tier: "short" }); f.advance(1000); const promoted = f.store.promote(short, "person", f.project)!;
  for (const state of [recallRows(f.store, f.project, { person: true, history: true, query: "unchanged" }), recallShow(f.store, f.project, unchanged, { person: true, history: true }).state!]) { expect(state.notices).toEqual([]); expect(state.incomplete).toBe(false); }
  expect(recallShow(f.store, f.project, promoted, { person: true, history: true }).state!.notices).toEqual(["promotion time unknown: tier before promotion cannot be recovered"]);
  f.advance(1000); f.note("newest plain contract"); const capped = recallRows(f.store, f.project, { person: true, history: true, limit: 1 }); expect(capped.notices).toEqual([]); expect(capped.incomplete).toBe(true);
  const text = await rawMemoryCommand(["list", "--history", "--json"], f.root, { person: true, store: f.store, open: () => f.store, project: f.project, readable: rows => rows.filter(view => view.id === unchanged), importPolicy: () => () => false }); expect(JSON.parse(text)).toMatchObject({ notices: [], incomplete: false });
  f.store.forget(promoted, "person", f.project); const after = f.store.recallState(f.project, { person: true, history: true }); expect(after.notices).toEqual([]); expect(after.incomplete).toBe(false);
});

for (const mode of ["legacy", "generation", "shards"] as const) test(`${mode}: intent snapshot detects same-handle, other-handle and raw appended forget without stale bodies`, async () => {
  const f = await fixture(mode), own = f.note("own writer target"), peer = f.note("other writer target"), raw = f.note("raw writer target"), first = f.store.intentSnapshot(f.project);
  first.assertCurrent(); f.store.forget(own, "person", f.project); expect(() => first.assertCurrent()).toThrow("changed");
  const second = f.store.intentSnapshot(f.project); expect(second.rows.some(view => view.id === own)).toBe(false);
  const opts = { memoryDir: f.base, deferPromotions: true, now: f.clock }, other = mode === "shards" ? openShardStore({ ...opts, project: f.project }) : new MemoryStore(opts);
  try { other.forget(peer, "person", f.project); } finally { other.close(); }
  expect(() => second.assertCurrent()).toThrow("changed");
  const third = f.store.intentSnapshot(f.project); expect(third.rows.some(view => view.id === peer)).toBe(false);
  const body: Omit<OpEntry, "id"> = { schema: MEMORY_SCHEMA, op: "forget", at: f.iso(), machine: f.store.machine.id, target: raw, actor: "person" };
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), JSON.stringify({ ...body, id: entryId(body) }) + "\n");
  expect(() => third.assertCurrent()).toThrow("changed"); expect(f.store.intentSnapshot(f.project).rows).toEqual([]);
});
test("intent snapshot selects genre/project refs before bodies despite 5001 newer findings and foreign shares", async () => {
  const f = await fixture("legacy"), first = f.note("first eligible contract"); f.advance(1000); const second = f.note("second eligible fail", { kind: "fail" }); f.advance(1000); const third = f.note("third eligible decision", { kind: "decision" });
  const lines: string[] = [];
  for (let index = 0; index < 5001; index++) {
    const body: Omit<NoteEntry, "id"> = { schema: MEMORY_SCHEMA, op: "note", at: f.iso(), machine: f.store.machine.id, project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: `unrelated finding ${index}`, about: [] };
    lines.push(JSON.stringify({ ...body, id: entryId(body) }));
  }
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), lines.join("\n") + "\n"); f.note("foreign eligible share", { project: "foreign-project", scope: "shared", kind: "fail" }); f.store.beginRecallRead();
  type Statement = { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  const db = (f.store as unknown as { db: { query(sql: string): Statement } }).db, query = db.query; let bodyQueries = 0, bodies = 0;
  db.query = function (sql: string) { const statement = query.call(this, sql); if (!/^SELECT \* FROM entries/.test(sql)) return statement; return { get: statement.get.bind(statement), all: (...args: unknown[]) => { bodyQueries++; const rows = statement.all(...args); bodies += rows.length; return rows; } }; };
  try {
    const snapshot = f.store.intentSnapshot(f.project); expect(snapshot.rows.map(view => view.id)).toEqual([third, second, first]); expect(snapshot.truncated).toBe(false); expect(bodyQueries).toBe(1); expect(bodies).toBe(3);
    const cut = f.store.intentSnapshot(f.project, 2); expect(cut.rows.map(view => view.id)).toEqual([third, second]); expect(cut.truncated).toBe(true);
  } finally { db.query = query; }
});
test("snapshot guard performs metadata SQL only and detects derived/index, alias and profile changes", async () => {
  for (const changed of ["derived", "alias", "profile"] as const) {
    const f = await fixture("legacy"); f.note("guarded public note"); const snapshot = f.store.intentSnapshot(f.project);
    type Statement = { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
    const db = (f.store as unknown as { db: { query(sql: string): Statement } }).db, query = db.query, sqls: string[] = [];
    db.query = function (sql: string) { sqls.push(sql); return query.call(this, sql); };
    try { snapshot.assertCurrent(); expect(sqls.every(sql => sql === "PRAGMA data_version" || sql === "SELECT total_changes() AS n")).toBe(true); }
    finally { db.query = query; }
    if (changed === "derived") f.store.rebuild();
    if (changed === "alias") appendFileSync(join(f.base, "aliases.jsonl"), "changed metadata\n");
    if (changed === "profile") writeFileSync(join(f.base, "profile.json"), '{"changed":true}');
    expect(() => snapshot.assertCurrent()).toThrow();
  }
});
test("strict snapshot preparation propagates refresh failure rather than returning a stale forgotten cache", async () => {
  const f = await fixture("legacy"), id = f.note("stale cache target");
  const body: Omit<OpEntry, "id"> = { schema: MEMORY_SCHEMA, op: "forget", at: f.iso(), machine: f.store.machine.id, target: id, actor: "person" };
  appendFileSync(join(f.store.dir, "log", `${f.store.machine.id}.jsonl`), JSON.stringify({ ...body, id: entryId(body) }) + "\n");
  const refresh = f.store.refresh; f.store.refresh = () => { throw Error("fixture refresh unavailable"); };
  try { expect(() => f.store.intentSnapshot(f.project)).toThrow("refresh unavailable"); expect(() => f.store.beginRecallRead()).toThrow("refresh unavailable"); }
  finally { f.store.refresh = refresh; }
  expect(f.store.intentSnapshot(f.project).rows).toEqual([]);
});
test("intent source prepares only one snapshot, preserves truncation, and exposes a metadata freshness guard", async () => {
  const f = await fixture("legacy"), id = f.note("single snapshot"); let calls = 0;
  const snapshot = f.store.intentSnapshot.bind(f.store); f.store.intentSnapshot = (...args) => { calls++; return snapshot(...args); };
  const source = createIntentBriefSource(f.store, f.project); expect(() => source.assertCurrent()).toThrow("not been prepared");
  const first = source.notes(); expect(source.notes()).toBe(first); expect(first.map(view => view.id)).toEqual([id]); expect(calls).toBe(1); expect(source.truncated()).toBe(false); source.assertCurrent();
  f.store.forget(id, "person", f.project); expect(() => source.assertCurrent()).toThrow("changed"); expect(calls).toBe(1);
});
test("prepared paged recall prunes derived expired cache before capturing its revision", async () => {
  const f = await fixture("legacy"); f.note("expired cached row", { tier: "short", expires: new Date(f.clock() + 1000).toISOString() }); const live = f.note("current paged row"); f.advance(2000);
  const assertCurrent = f.store.beginRecallRead(), page = f.store.readPage({ project: f.project, limit: 10 }); expect(page.rows.map(view => view.id)).toEqual([live]); expect(() => assertCurrent()).not.toThrow();
});
