import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type Entry } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { GENERATION_OP_CONTRACTS, PRUNE_GENERATION_CONTRACT, assertSharedV1Op } from "../src/memory/ops-contract.ts";
import { applyPrune, planPrune, pruneId, validatePruneRow, type PruneRow } from "../src/memory/prune.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const NOW = Date.parse("2030-01-01T00:00:00.000Z"), G = "c".repeat(32);
async function authored() {
  const home = mkdtempSync(join(tmpdir(), "amem-gen-replay-author-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const old = new MemoryStore({ home, ttlMs: 1, now: () => NOW - 10000 });
  const id = old.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", text: "synthetic replay target", about: ["path:public.ts"], source: "person" });
  old.demote(id, "person"); old.close();
  const memory = join(home, "memory"), machine = JSON.parse(readFileSync(join(memory, "machine.json"), "utf8"));
  const rows = readFileSync(join(memory, "log", `${machine.id}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line) as Entry);
  await migrate({ memoryDir: memory, mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const writer = new MemoryStore({ home, now: () => NOW, deferPromotions: true }); cleanup.push(() => writer.close());
  const auth = { project: "agent-hub", actor: "person" as const, authorize: () => true };
  const plan = planPrune(writer.prunePort(), { cutoff: new Date(NOW).toISOString() }, auth);
  applyPrune(writer.prunePort(), plan, auth);
  return { id, rows, machine, prune: plan.rows[0]!.payload };
}
for (const order of [[0, 1], [1, 0]]) test(`generation replay all tables converge with pending prune, tail, duplicate and witness order ${order.join("-")}`, async () => {
  const f = await authored(), home = mkdtempSync(join(tmpdir(), "amem-gen-replay-reader-")), memory = join(home, "memory");
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(memory, "log"), { recursive: true }); mkdirSync(join(memory, "local"));
  writeFileSync(join(memory, "machine.json"), JSON.stringify(f.machine) + "\n");
  await migrate({ memoryDir: memory, mode: "apply", generation: G, authorizedPerson: true, tty: true });
  let now = NOW;
  const store = new MemoryStore({ home, now: () => now, deferPromotions: true }); cleanup.push(() => store.close());
  function equality() { store.refresh(); const before = store.derivedTables(); store.rebuild(); expect(store.derivedTables()).toEqual(before); }
  const line = canonicalJSON(f.prune) + "\n", segment = join(store.dir, "local", `${f.machine.id}.jsonl`), middle = Math.floor(line.length / 2);
  appendFileSync(segment, line.slice(0, middle)); equality();
  expect(store.prunePort().snapshot().durablePruneIds).toEqual([]);
  appendFileSync(segment, line.slice(middle)); equality();
  expect(store.prunePort().snapshot().pruned).toEqual([]); // Complete but pending: immutable witnesses are not here yet.
  for (const index of order) {
    appendFileSync(join(memory, "log", `witness-${index}.jsonl`), JSON.stringify(f.rows[index]) + "\n"); equality();
    if (index === 0 && order[0] === 0) expect(store.get(f.id)?.id).toBe(f.id);
  }
  expect(store.get(f.id)).toBeUndefined();
  const before = store.derivedTables(); appendFileSync(segment, line); equality();
  for (const name of ["entries", "ops", "edges", "goals", "generation_rows", "generation_prunes", "generation_targets"]) expect(store.derivedTables()[name]).toEqual(before[name]);
  now = NOW - 20000; equality(); expect(store.get(f.id)).toBeUndefined();
  expect(store.graph("agent-hub", `mem:${f.id}`).nodes).toEqual([]);
});

test("generation registry binds every enabled op to the real prune schema and retained contract fixtures", async () => {
  const f = await authored(), row = f.prune;
  expect(Object.keys(GENERATION_OP_CONTRACTS)).toEqual(["prune", "vault_link"]);
  expect(PRUNE_GENERATION_CONTRACT.implemented).toBe(true);
  expect(PRUNE_GENERATION_CONTRACT.status).toBe("truth-changing");
  expect(PRUNE_GENERATION_CONTRACT.payloadVersion).toBe(row.schema);
  expect([...PRUNE_GENERATION_CONTRACT.required].sort()).toEqual(Object.keys(row).sort());
  expect(() => assertSharedV1Op("prune")).toThrow(); expect(validatePruneRow(row, G, "local")).toEqual(row);
  for (const field of PRUNE_GENERATION_CONTRACT.required) {
    const copy = structuredClone(row) as unknown as Record<string, unknown>; delete copy[field];
    if (field !== "id") { const { id: _id, ...body } = copy; copy.id = pruneId(body as unknown as Omit<PruneRow, "id">); }
    expect(() => validatePruneRow(copy, G, "local")).toThrow();
  }
  for (const reference of PRUNE_GENERATION_CONTRACT.fixtures) {
    const [path, name] = reference.split("#");
    expect(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).toContain(`test("${name}"`);
  }
});


test("generation refresh applies only new complete suffix rows; unchanged reads never reapply history", async () => {
  const parent = mkdtempSync(join(tmpdir(), "amem-gen-incremental-")), memory = join(parent, "memory");
  cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const legacy = new MemoryStore({ home: parent, profile: "shared-v1", now: () => NOW }); cleanup.push(() => legacy.close());
  legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", text: "first immutable row", about: [], source: "person" });
  await migrate({ memoryDir: memory, mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home: parent, now: () => NOW, deferPromotions: true }); cleanup.push(() => store.close());
  // Instrument the real reducer callback, not a time threshold or replacement implementation.
  const runtime = store as unknown as { apply(line: string, source: string): void };
  const original = runtime.apply.bind(store), applied: string[] = [];
  runtime.apply = (line, source) => { applied.push((JSON.parse(line) as Entry).id); original(line, source); };
  store.list(); store.list(); store.refresh(); expect(applied).toEqual([]);
  const next = legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", text: "new complete suffix row", about: [], source: "person" });
  expect(store.get(next)?.text).toBe("new complete suffix row"); expect(applied).toEqual([next]);
  store.list(); store.refresh(); expect(applied).toEqual([next]);
  const before = store.derivedTables(); store.rebuild(); expect(store.derivedTables()).toEqual(before);
  expect(applied.length).toBe(3); // One new suffix plus two rows in the explicit full rebuild.
});

for (const method of ["refresh", "rebuild"] as const) test(`generation ${method} never moves a concurrently indexed source watermark backward`, async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-gen-watermark-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const legacy = new MemoryStore({ home, profile: "shared-v1", now: () => NOW }); cleanup.push(() => legacy.close());
  legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", text: "stable initial input", about: [], source: "person" });
  await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const first = new MemoryStore({ home, now: () => NOW, deferPromotions: true }), second = new MemoryStore({ home, now: () => NOW, deferPromotions: true });
  cleanup.push(() => { first.close(); second.close(); });
  const internal = (first as unknown as { generationIndex: { capture(): unknown } }).generationIndex, capture = internal.capture.bind(internal);
  let armed = true, late = "";
  internal.capture = () => {
    const input = capture();
    if (armed) {
      armed = false;
      late = legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", text: "indexed between capture and commit", about: [], source: "person" });
      second.refresh();
    }
    return input;
  };
  first[method]();
  const before = first.derivedTables(); first.rebuild(); expect(first.derivedTables()).toEqual(before);
  expect(first.get(late)?.text).toBe("indexed between capture and commit");
});

test("generation prune masks and view rows share the WAL snapshot when another handle prunes at read entry", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-gen-mask-snapshot-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const legacy = new MemoryStore({ home, now: () => NOW - 10000 });
  const id = legacy.note({ op: "note", project: "agent-hub", scope: "project", tier: "short", kind: "finding", peer: "person", text: "read snapshot target", about: [], source: "person", expires: new Date(NOW - 5000).toISOString() }); legacy.close();
  await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: G, authorizedPerson: true, tty: true });
  const writer = new MemoryStore({ home, now: () => NOW, deferPromotions: true }); cleanup.push(() => writer.close());
  const auth = { project: "agent-hub", actor: "person" as const, authorize: () => true }, plan = planPrune(writer.prunePort(), { cutoff: new Date(NOW).toISOString() }, auth);
  let armed = false;
  const reader = new MemoryStore({ home, deferPromotions: true, now: () => {
    if (armed) { armed = false; applyPrune(writer.prunePort(), plan, auth); }
    return NOW - 8000;
  } }); cleanup.push(() => reader.close());
  expect(reader.list().map(row => row.id)).toContain(id);
  armed = true; expect(reader.list().map(row => row.id)).not.toContain(id);
  expect(reader.get(id)).toBeUndefined();
});

test("real generation prune writer matches the frozen independent payload, proof hashes, id and segment bytes", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/generation-prune.json", import.meta.url), "utf8")) as { note: import("../src/memory/store.ts").NoteEntry; prune: PruneRow; canonicalLine: string };
  const home = mkdtempSync(join(tmpdir(), "amem-gen-frozen-writer-")), memory = join(home, "memory"); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(memory); writeFileSync(join(memory, "machine.json"), JSON.stringify({ id: fixture.note.machine, label: fixture.note.machine }) + "\n");
  const old = new MemoryStore({ home, now: () => Date.parse(fixture.note.at) });
  const { id, schema: _schema, at: _at, machine: _machine, ...input } = fixture.note;
  expect(old.note(input)).toBe(id); old.close();
  await migrate({ memoryDir: memory, mode: "apply", generation: fixture.prune.generation, authorizedPerson: true, tty: true });
  const store = new MemoryStore({ home, now: () => Date.parse(fixture.prune.at), deferPromotions: true }); cleanup.push(() => store.close());
  const auth = { project: fixture.note.project, actor: "person" as const, authorize: () => true };
  const plan = planPrune(store.prunePort(), { cutoff: fixture.prune.cutoff }, auth);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.payload).toEqual(fixture.prune);
  applyPrune(store.prunePort(), plan, auth);
  expect(readFileSync(join(store.dir, "local", `${fixture.prune.machine}.jsonl`), "utf8")).toBe(fixture.canonicalLine);
  expect(store.get(id)).toBeUndefined();
});
