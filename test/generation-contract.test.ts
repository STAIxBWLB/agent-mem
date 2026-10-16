import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore as LegacyV1 } from "@staix/agent-mem-v1";
import { MemoryStore as LegacyV02 } from "@staix/agent-mem-v02";
import { MemoryStore, entryId, type NoteInput } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { realPath } from "../src/memory/platform.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { planPrune, applyPrune, type PruneAuthorization } from "../src/memory/prune.ts";
import { derivedTables } from "./contract/replay.ts";

const G = "c".repeat(32), PROJECT = "agent-hub", START = Date.parse("2026-10-16T00:00:00.000Z"), DEADLINE = START + 1000;
const readers = [{ label: "published 0.1.1", alias: "@staix/agent-mem-v1", Store: LegacyV1 }, { label: "published 0.2.0", alias: "@staix/agent-mem-v02", Store: LegacyV02 }] as const;
type OldStore = LegacyV1 | LegacyV02;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string { const value = realPath(mkdtempSync(join(tmpdir(), "amem-generation-contract-"))); cleanup.push(() => rmSync(value, { recursive: true, force: true })); return value; }
function input(text: string, over: Partial<NoteInput> = {}): NoteInput { return { op: "note", project: PROJECT, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: ["path:src/public.ts"], ...over }; }
function legacyAuth(): PruneAuthorization { return { project: PROJECT, actor: "person", authorize: () => true }; }
function rootBytes(memoryDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const folder of ["log", "local"]) for (const name of readdirSync(join(memoryDir, folder)).sort()) result[`${folder}/${name}`] = readFileSync(join(memoryDir, folder, name)).toString("base64");
  for (const name of readdirSync(memoryDir).filter(name => name === "machine.json" || /^index\.db(?:-|$)/.test(name)).sort()) result[name] = readFileSync(join(memoryDir, name)).toString("base64");
  return result;
}
function segmentBytes(dir: string, folder: "log" | "local"): Record<string, string> {
  return Object.fromEntries(readdirSync(join(dir, folder)).sort().filter(name => name.endsWith(".jsonl")).map(name => [name, readFileSync(join(dir, folder, name), "utf8")]));
}
function allRows(dir: string, folder: "log" | "local"): Record<string, unknown>[] {
  return Object.values(segmentBytes(dir, folder)).flatMap(bytes => bytes.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>));
}
async function fixture(beforeMigration?: (parent: string) => void) {
  const parent = home(); let now = START;
  const source = new MemoryStore({ home: parent, now: () => now, deferPromotions: true, profile: "shared-v1" });
  const seed = source.note(input("legacy finite finding", { tier: "short", expires: new Date(DEADLINE).toISOString() }));
  const anchor = source.note(input("independent original authority"));
  const memoryDir = source.dir, machine = source.machine.id; source.close();
  beforeMigration?.(parent);
  const before = rootBytes(memoryDir);
  const migration = await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true, now: () => now });
  expect(migration.profile.generation).toBe(G);
  expect(rootBytes(memoryDir)).toEqual(before);
  const store = new MemoryStore({ home: parent, now: () => now, deferPromotions: true });
  cleanup.push(() => store.close());
  expect(store.dir).toBe(join(memoryDir, "generations", G));
  expect(store.machine.id).toBe(machine);
  return { parent, memoryDir, store, seed, anchor, machine, clock: (value: number) => { now = value; }, now: () => now };
}
function prune(store: MemoryStore, target: string, now: number) {
  const plan = planPrune(store.prunePort(), { cutoff: new Date(now).toISOString(), targets: [target] }, legacyAuth());
  expect(plan.counts.selected).toBe(1);
  expect(plan.rows.every(row => row.placement === "local")).toBe(true);
  expect(applyPrune(store.prunePort(), plan, legacyAuth()).completed).toEqual(plan.rows.map(row => row.payload.id));
  return plan;
}
function childRead(alias: string, parent: string, now: number): { id: string; text: string; tier: string }[] {
  const code = `import { MemoryStore } from ${JSON.stringify(alias)}; const s=new MemoryStore({home:process.argv[1],now:()=>${now}});try{console.log(JSON.stringify(s.list({project:"agent-hub",limit:100}).map(({id,text,tier})=>({id,text,tier})).sort((a,b)=>a.id.localeCompare(b.id))))}finally{s.close()}`;
  const result = Bun.spawnSync([process.execPath, "--eval", code, parent], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(new TextDecoder().decode(result.stderr)).toBe(""); expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as { id: string; text: string; tier: string }[];
}
function lateWrites(old: OldStore, anchor: string) {
  const late = old.note(input("late v1 independent note"));
  old.demote(late, "person", PROJECT);
  const origin = old.note(input("late v1 promoted note", { tier: "short", task: "agent-hub#1@1" }));
  const promoted = old.promote(origin, "person", PROJECT)!;
  expect(promoted).toBeDefined(); expect(promoted).not.toBe(origin);
  expect(old.supersede(anchor, promoted, "person", PROJECT)).toBe(true);
  return { late, promoted, origin };
}

for (const reader of readers) {
  test(`C1 ${reader.label}: an unannounced read-only reader remains on v1 during isolated generation writes`, async () => {
    const legacy: { store?: OldStore } = {};
    try {
      const f = await fixture(parent => { legacy.store = new reader.Store({ home: parent, now: () => START }); legacy.store.list({ project: PROJECT }); });
      const old = legacy.store;
      if (!old) throw new Error("legacy fixture was not opened before migration");
      const expected = old.list({ project: PROJECT }), before = rootBytes(f.memoryDir);
      const gen = f.store.note(input("generation-only authority"));
      expect(f.store.get(gen, PROJECT)).toBeDefined();
      expect(rootBytes(f.memoryDir)).toEqual(before);
      expect(old.list({ project: PROJECT })).toEqual(expected);
      expect(old.get(gen, PROJECT)).toBeUndefined();
      expect(allRows(f.memoryDir, "log").some(row => row.op === "prune")).toBe(false);
    } finally { legacy.store?.close(); }
  });

  test(`C1 ${reader.label}: same machine identity writes distinct legacy and generation segments`, async () => {
    const legacy: { store?: OldStore } = {};
    try {
      const f = await fixture(parent => { legacy.store = new reader.Store({ home: parent, now: () => START }); });
      const old = legacy.store;
      if (!old) throw new Error("legacy fixture was not opened before migration");
      expect(old.machine.id).toBe(f.store.machine.id);
      const beforeGeneration = segmentBytes(f.store.dir, "log"), legacyId = old.note(input("old bound writer stays legacy"));
      expect(segmentBytes(f.store.dir, "log")).toEqual(beforeGeneration);
      const beforeLegacy = rootBytes(f.memoryDir), gen = f.store.note(input("new bound writer stays generation"));
      expect(rootBytes(f.memoryDir)).toEqual(beforeLegacy);
      expect(f.store.get(legacyId, PROJECT)?.text).toBe("old bound writer stays legacy");
      expect(f.store.get(gen, PROJECT)?.text).toBe("new bound writer stays generation");
      expect(old.get(gen, PROJECT)).toBeUndefined();
      expect(segmentBytes(f.memoryDir, "log")[`${old.machine.id}.jsonl`]).toContain(legacyId);
      expect(segmentBytes(f.store.dir, "log")[`${old.machine.id}.jsonl`]).toContain(gen);
    } finally { legacy.store?.close(); }
  });

  test(`C1 ${reader.label}: offline late note demote promotion and supersede enter the bridge without reversing prune`, async () => {
    const f = await fixture();
    f.clock(DEADLINE + 1); prune(f.store, f.seed, f.now());
    const offline = home(), old = new reader.Store({ home: offline, now: () => START + 100, ttlMs: 60_000 });
    let writes: ReturnType<typeof lateWrites>;
    try {
      // The offline author independently possesses the original immutable anchor, as a prior sync would provide.
      for (const [name, bytes] of Object.entries(segmentBytes(f.memoryDir, "log"))) appendFileSync(join(old.dir, "log", name), bytes);
      writes = lateWrites(old, f.anchor);
      const received = segmentBytes(old.dir, "log");
      const ownSegment = `${old.machine.id}.jsonl`;
      expect(received[ownSegment]).toBeDefined();
      // Synthetic explicit legacy exchange: transfer authored public bytes only, never local or index files.
      appendFileSync(join(f.memoryDir, "log", ownSegment), received[ownSegment]!);
    } finally { old.close(); }
    f.store.refresh();
    expect(f.store.get(f.seed, PROJECT)).toBeUndefined();
    expect(f.store.get(writes!.late, PROJECT)?.tier).toBe("short");
    expect(f.store.get(writes!.promoted, PROJECT)?.text).toBe("late v1 promoted note");
    expect(f.store.get(f.anchor, PROJECT)?.supersededBy).toBe(writes!.promoted);
    const output = childRead(reader.alias, f.parent, START + 200);
    expect(output.map(row => row.id)).toContain(writes!.promoted);
    expect(output.map(row => row.id)).toContain(f.seed);
  });

  test(`C1 ${reader.label}: a reader launched after migration sees late v1 ops but no generation rows`, async () => {
    const f = await fixture();
    f.clock(DEADLINE + 1); prune(f.store, f.seed, f.now());
    const gen = f.store.note(input("generation-only after compatibility check"));
    // No old reader existed at the selector cutover; launching now still selects only its fixed v1 paths.
    const old = new reader.Store({ home: f.parent, now: () => START + 100, ttlMs: 60_000 });
    let writes: ReturnType<typeof lateWrites>;
    try { writes = lateWrites(old, f.anchor); } finally { old.close(); }
    const visible = childRead(reader.alias, f.parent, START + 200).map(row => row.id);
    expect(visible).toContain(f.seed); expect(visible).toContain(writes!.promoted); expect(visible).not.toContain(gen);
    f.store.refresh(); expect(f.store.get(writes!.promoted, PROJECT)).toBeDefined(); expect(f.store.get(f.seed, PROJECT)).toBeUndefined();
    expect(allRows(f.memoryDir, "log").some(row => row.schema === "agent-mem.prune/v1")).toBe(false);
  });
}

test("C05 real generation prune survives backward clock and every derived-table rebuild without legacy changes", async () => {
  const f = await fixture(), legacyBefore = rootBytes(f.memoryDir);
  const authoredBefore = { log: segmentBytes(f.store.dir, "log"), local: segmentBytes(f.store.dir, "local") };
  expect(f.store.get(f.seed, PROJECT)).toBeDefined();
  f.clock(DEADLINE + 1);
  const plan = prune(f.store, f.seed, f.now());
  const authoredAfter = { log: segmentBytes(f.store.dir, "log"), local: segmentBytes(f.store.dir, "local") };
  const expectedAuthored = structuredClone(authoredBefore);
  for (const { payload, placement } of plan.rows) {
    const folder = placement === "local" ? "local" : "log", file = `${payload.machine}.jsonl`;
    expectedAuthored[folder][file] = (expectedAuthored[folder][file] ?? "") + canonicalJSON(payload) + "\n";
  }
  expect(authoredAfter).toEqual(expectedAuthored); // Every authored byte, not only prune row count.
  expect(plan.rows[0]?.payload.targets.map(target => target.id)).toEqual([f.seed]);
  expect(f.store.list({ project: PROJECT, q: "legacy finite" })).toEqual([]);
  expect(f.store.counts(PROJECT)).toMatchObject({ short: 0, long: 1 });
  const beforeRollback = derivedTables(f.store.dir);
  expect(Object.keys(beforeRollback)).toEqual(expect.arrayContaining(["entries", "ops", "edges", "goals", "heads", "segments", "generation_rows", "generation_prunes", "generation_targets", "generation_segments", "generation_state"]));
  f.clock(START - 1000);
  expect(f.store.get(f.seed, PROJECT)).toBeUndefined();
  expect(f.store.get(f.seed.slice(0, 8), PROJECT)).toBeUndefined();
  expect(f.store.list({ project: PROJECT, q: "legacy finite" })).toEqual([]);
  expect(f.store.counts(PROJECT)).toMatchObject({ short: 0, long: 1 });
  expect(f.store.related(PROJECT, ["path:src/public.ts"], 100).some(row => row.id === f.seed)).toBe(false);
  expect(f.store.graph(PROJECT, `mem:${f.seed}`, 2)).toEqual({ nodes: [], edges: [] });
  const graph = f.store.graph(PROJECT, "path:src/public.ts", 2);
  expect(graph.nodes.some(node => node.id === `mem:${f.seed}`)).toBe(false);
  expect(graph.edges.some(edge => edge.from === `mem:${f.seed}` || edge.to === `mem:${f.seed}`)).toBe(false);
  expect(derivedTables(f.store.dir)).toEqual(beforeRollback);
  f.store.rebuild(); expect(derivedTables(f.store.dir)).toEqual(beforeRollback);
  f.store.rebuild(); expect(derivedTables(f.store.dir)).toEqual(beforeRollback);
  expect(f.store.get(f.seed, PROJECT)).toBeUndefined();
  expect(rootBytes(f.memoryDir)).toEqual(legacyBefore);
  expect({ log: segmentBytes(f.store.dir, "log"), local: segmentBytes(f.store.dir, "local") }).toEqual(authoredAfter);
  expect(allRows(f.store.dir, "local").filter(row => row.op === "prune")).toHaveLength(1);
});

test("exact prune stops alias traversal while independent descendants and parentless promotions remain readable", async () => {
  const f = await fixture();
  const parent = f.store.note(input("promotion parent", { tier: "short", task: "agent-hub#2@2" }));
  const copy = f.store.promote(parent, "person", PROJECT)!;
  expect(copy).toBeDefined();
  f.store.demote(copy, "person", PROJECT);
  f.clock(START + 15 * 86_400_000);
  prune(f.store, copy, f.now());
  f.clock(START);
  expect(f.store.get(copy, PROJECT)).toBeUndefined();
  expect(f.store.get(parent, PROJECT)).toBeUndefined();
  expect(f.store.graph(PROJECT, `mem:${copy}`, 2)).toEqual({ nodes: [], edges: [] });
  // Replay the deterministic v1 promotion payload, preserving its original timestamp and ID.
  expect(f.store.note(input("promotion parent", { task: "agent-hub#2@2", promotedFrom: parent }))).toBe(copy);
  expect(f.store.get(copy, PROJECT)).toBeUndefined();
  const descendant = f.store.note(input("different-id descendant", { promotedFrom: copy }));
  const parentless = f.store.note(input("ordinary synced parentless promotion", { promotedFrom: "e".repeat(32) }));
  expect(f.store.get(descendant, PROJECT)?.text).toBe("different-id descendant");
  expect(f.store.get(parentless, PROJECT)?.text).toBe("ordinary synced parentless promotion");
  expect(f.store.get(parent, PROJECT)).toBeUndefined();
  const before = derivedTables(f.store.dir); f.store.rebuild(); expect(derivedTables(f.store.dir)).toEqual(before);
});

test("pruning an expired replacement permanently releases independent predecessor X across rollback", async () => {
  const f = await fixture(), replacement = f.store.note(input("expired replacement B"));
  expect(f.store.supersede(f.anchor, replacement, "person", PROJECT)).toBe(true);
  expect(f.store.list({ project: PROJECT }).some(row => row.id === f.anchor)).toBe(false);
  f.store.demote(replacement, "person", PROJECT); f.clock(START + 15 * 86_400_000);
  prune(f.store, replacement, f.now()); f.clock(START);
  expect(f.store.get(replacement, PROJECT)).toBeUndefined();
  expect(f.store.list({ project: PROJECT }).map(row => row.id)).toContain(f.anchor);
  const before = derivedTables(f.store.dir); f.store.rebuild(); expect(derivedTables(f.store.dir)).toEqual(before);
  expect(f.store.list({ project: PROJECT }).map(row => row.id)).toContain(f.anchor);
});

test("private local origin prune emits no public prune payload and does not quarantine a different promoted ID", async () => {
  const f = await fixture();
  const origin = f.store.note(input("PRIVATE local origin", { tier: "short", expires: new Date(DEADLINE).toISOString(), about: ["path:private/local.ts"] }));
  const copy = f.store.note(input("independently public promoted copy", { promotedFrom: origin }));
  const beforePublic = segmentBytes(f.store.dir, "log");
  f.clock(DEADLINE + 1); const plan = prune(f.store, origin, f.now());
  expect(plan.rows.every(row => row.placement === "local")).toBe(true);
  expect(segmentBytes(f.store.dir, "log")).toEqual(beforePublic);
  expect(allRows(f.store.dir, "log").some(row => row.op === "prune")).toBe(false);
  expect(f.store.get(origin, PROJECT)).toBeUndefined();
  expect(f.store.get(copy, PROJECT)?.text).toBe("independently public promoted copy");
  const before = derivedTables(f.store.dir); f.store.rebuild(); expect(derivedTables(f.store.dir)).toEqual(before);
});

test("C before B before pruned A stays readable when late intermediate promotion ancestry arrives", async () => {
  const f = await fixture(); f.clock(DEADLINE + 10); prune(f.store, f.seed, f.now());
  const bInput = input("late intermediate B", { promotedFrom: f.seed });
  const bAt = new Date(DEADLINE + 1).toISOString();
  const bId = entryId({ schema: "agent-hub.memory/v1", at: bAt, machine: f.machine, ...bInput });
  f.clock(DEADLINE + 2);
  const c = f.store.note(input("early descendant C", { promotedFrom: bId }));
  expect(f.store.get(c, PROJECT)).toBeDefined();
  f.clock(DEADLINE + 1);
  expect(f.store.note(bInput)).toBe(bId);
  expect(f.store.get(c, PROJECT)?.text).toBe("early descendant C");
  expect(f.store.get(f.seed, PROJECT)).toBeUndefined();
  const before = derivedTables(f.store.dir); f.store.rebuild(); expect(derivedTables(f.store.dir)).toEqual(before);
  expect(f.store.get(c, PROJECT)).toBeDefined();
});
