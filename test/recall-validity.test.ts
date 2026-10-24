import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryId, MEMORY_SCHEMA, MemoryStore, openShardStore, type NoteEntry, type NoteInput } from "../src/memory/store.ts";
import { SegmentReader } from "../src/memory/bridge.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { realPath } from "../src/memory/platform.ts";
import { rawMemoryCommand } from "../src/memory/commands.ts";
import { recallRows, recallShow } from "../src/memory/recall.ts";
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
    const history = f.store.recallState(f.project, { history: true }); expect(history.views.map(row => row.id)).toEqual(expect.arrayContaining([old, newer, expired]));
    expect(history.relations).toContainEqual({ from: old, to: newer, kind: "supersede", at: new Date(Date.parse(beforeNew) + 2000).toISOString() });
    expect(f.store.recallState(f.project, { asOf: beforeNew }).views.map(row => row.id)).toEqual([old]); expect(f.bytes()).toEqual(before);
    const snapshot = f.store.recallState(f.project, { history: true }); f.store.rebuild(); expect(f.store.recallState(f.project, { history: true })).toEqual(snapshot);
  });
  test(`${mode}: current forget masks every past date and returns only id/time stubs`, async () => {
    const f = await fixture(mode), id = f.note("FORGOTTEN_BODY_SENTINEL"), past = f.iso(); f.advance(1000); f.store.forget(id, "person", f.project); const forgotten = f.iso(); f.advance(1000);
    for (const options of [{ history: true }, { asOf: past }, { history: true, asOf: past }]) {
      const state = f.store.recallState(f.project, options); expect(state.views).toEqual([]); expect(state.forgotten).toEqual([{ id, at: forgotten }]); expect(JSON.stringify(state)).not.toContain("FORGOTTEN_BODY_SENTINEL");
    }
  });
  test(`${mode}: forgetting a promoted copy also masks its earlier short source`, async () => {
    const f = await fixture(mode), short = f.note("FORGOTTEN_PROMOTION_SENTINEL", { tier: "short" }), past = f.iso(); f.advance(1000); const long = f.store.promote(short, "person", f.project)!; expect(long).not.toBe(short); f.advance(1000); f.store.forget(long, "person", f.project);
    const state = f.store.recallState(f.project, { history: true, asOf: past }); expect(state.views).toEqual([]); expect(state.forgotten.map(row => row.id).sort()).toEqual([short, long].sort()); expect(JSON.stringify(state)).not.toContain("FORGOTTEN_PROMOTION_SENTINEL");
  });
  if (mode !== "legacy") test(`${mode}: current durable prune never exposes retained text through past recall`, async () => {
    const f = await fixture(mode), id = f.note("PRUNED_BODY_SENTINEL", { tier: "short", expires: new Date(f.clock() + 1000).toISOString() }), past = f.iso(); f.advance(2000);
    const auth = { project: f.project, actor: "person" as const, authorize: () => true }, plan = planPrune(f.store.prunePort(), { cutoff: f.iso(), targets: [id] }, auth); expect(plan.rows).toHaveLength(1); applyPrune(f.store.prunePort(), plan, auth);
    const state = f.store.recallState(f.project, { history: true, asOf: past }); expect(state.views).toEqual([]); expect(JSON.stringify(state)).not.toContain("PRUNED_BODY_SENTINEL");
  });
}
test("retained history rejects invalid/future dates and over-budget sources without authored writes", async () => {
  const f = await fixture("legacy"); f.note("public valid row"); const before = f.bytes();
  for (const asOf of ["2026-02-30", "2026-10-21", "2026-10-19T00:00:00+00:00", "not-a-date"]) expect(() => f.store.recallState(f.project, { asOf })).toThrow("as-of");
  expect(() => f.store.recallState(f.project, { maxBytes: 16 })).toThrow(); expect(() => f.store.recallState(f.project, { maxRows: 0 })).toThrow(); expect(f.bytes()).toEqual(before);
});
test("unverified complete rows are skipped visibly and incomplete tails never become recall evidence", async () => {
  const f = await fixture("legacy"), id = f.note("verified row"), file = join(f.store.dir, "log", `${f.store.machine.id}.jsonl`);
  appendFileSync(file, '{"schema":"agent-hub.memory/v1","id":"bad"}\n{"not":"complete"');
  const before = f.bytes(), state = f.store.recallState(f.project, { history: true }); expect(state.views.map(row => row.id)).toEqual([id]); expect(state.malformed).toBe(1); expect(state.incomplete).toBe(true); expect(f.bytes()).toEqual(before);
});

test("as-of uses retained promotion provenance time and labels its unrecoverable event time", async () => {
  const f = await fixture("legacy"), id = f.note("original fact", { tier: "short" }), past = f.iso(); f.advance(1000); const promoted = f.store.promote(id, "person", f.project)!;
  const state = f.store.recallState(f.project, { asOf: past }); expect(state.views.map(row => row.id)).toEqual([promoted]);
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
  try { expect(() => f.store.recallState(f.project, { history: true, maxBytes: 16 })).toThrow("read byte budget"); expect(bytes).toBeLessThanOrEqual(16); }
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
