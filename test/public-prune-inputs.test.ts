import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { entryId, type Entry } from "../src/memory/store.ts";
import { persistPublicPruneInput, preparePublicPruneInput, reducePublicPruneInputs, validatePublicPruneInputSet,
  PUBLIC_PRUNE_GRAPH_MAX_OBJECTS, type PublicPruneBinding, type PublicPruneInputRegistration, type PublicPrunePersistPhase } from "../src/memory/public-prune-inputs.ts";
import { publicPruneGraph, rawGitObject } from "./fixtures/public-prune-graph.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amem-public-prune-inputs-")); chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const graph = publicPruneGraph();
  const state: { binding: PublicPruneBinding } = { binding: { realm: graph.manifest.realm, receivingGeneration: "7".repeat(32), selectorRevision: "8".repeat(64), inputSetHash: null } };
  const prepare = (input: typeof graph.input | null = graph.input) => preparePublicPruneInput({ dir, binding: structuredClone(state.binding), current: () => state.binding, input });
  const commit = (registration: PublicPruneInputRegistration) => {
    // Simulate the future caller's successful selector commit; this source API never writes it.
    state.binding = { ...state.binding, selectorRevision: hashJSON([state.binding.selectorRevision, registration.inputSetHash]), inputSetHash: registration.inputSetHash };
  };
  const register = (input: typeof graph.input | null = graph.input) => { const result = persistPublicPruneInput(prepare(input)); commit(result); return result; };
  const replay = (extra: { nativeTargets?: readonly string[]; ordinary?: readonly Entry[] } = {}) => {
    if (!state.binding.inputSetHash) throw new Error("fixture has no committed set");
    return reducePublicPruneInputs({ dir, ...state.binding, inputSetHash: state.binding.inputSetHash, ...extra });
  };
  return { dir, graph, state, prepare, commit, register, replay };
}
const archive = (dir: string, kind: "object" | "input" | "set", hash: string) => join(dir,
  kind === "object" ? "public-prune-objects" : kind === "input" ? "public-prune-inputs" : "public-prune-input-sets", `${hash}.${kind === "object" ? "git" : "json"}`);
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const stat = lstatSync(join(dir, name)); return stat.isDirectory() ? files(join(dir, name)).map(n => `${name}/${n}`) : [name]; }).sort();
}

test("R08/R09 persistence returns a candidate only; explicit caller membership selects the complete graph", () => {
  const f = fixture(), empty = f.register(null), registration = persistPublicPruneInput(f.prepare());
  expect(f.state.binding.inputSetHash).toBe(empty.inputSetHash);
  expect(f.replay().targets.size).toBe(0); expect(f.replay().inputs).toEqual([]);
  expect(registration.previous).toBe(empty.inputSetHash); expect(registration.inputHash).toBeDefined();
  const set = JSON.parse(readFileSync(archive(f.dir, "set", registration.inputSetHash), "utf8"));
  expect(validatePublicPruneInputSet(set)).toMatchObject({ previous: empty.inputSetHash, inputs: [registration.inputHash] });
  f.commit(registration);
  expect([...f.replay().targets]).toEqual([f.graph.note.id]); expect(f.replay().authoredPrunes).toBe(1);
  expect(f.replay().inputs).toEqual([registration.inputHash!]);
});

test("R08/R09 exact replay is idempotent; equivalent provenance adds evidence without duplicate authored prunes", () => {
  const f = fixture(), first = f.register();
  // A fresh descriptor records a later admission revision; the same bound plan itself is repeatable.
  const bound = f.prepare(), candidate = persistPublicPruneInput(bound), phases: PublicPrunePersistPhase[] = [];
  const again = persistPublicPruneInput(bound, { observe: phase => phases.push(phase) });
  expect(phases).toEqual([]); // Reuse complete content, never rewrite or restamp it.
  expect(again).toEqual(candidate); f.commit(candidate);
  const other = publicPruneGraph({ provenance: { remoteHash: "b".repeat(64) } }); f.register(other.input);
  expect(f.replay().authoredPrunes).toBe(1); expect([...f.replay().targets]).toEqual([f.graph.note.id]);
  expect(f.replay().inputs).toContain(first.inputHash!);
  const previous = f.state.binding.inputSetHash; f.register(null); expect(f.state.binding.inputSetHash).toBe(previous);
});

test("R09/R10 later exact ordinary import stays masked while equal text under a different ID stays independent", () => {
  const f = fixture(); f.register();
  const { id: _id, ...body } = { ...f.graph.note, at: "2026-10-01T01:00:00.000Z" }, other = { ...body, id: entryId(body) };
  expect(other.id).not.toBe(f.graph.note.id); expect(other.text).toBe(f.graph.note.text);
  const before = f.replay(), after = f.replay({ ordinary: [f.graph.note, other] });
  expect([...after.targets]).toEqual([...before.targets]); expect(after.targets.has(other.id)).toBe(false);
  const altered = { ...f.graph.note, text: "SAME-ID-ALTERED-CANARY" };
  expect(() => f.replay({ ordinary: [altered] })).toThrow("public prune input unavailable");
});

test("R08/R10 cumulative sets preserve both independently identified prunes without text-based merging", () => {
  const f = fixture(), first = f.register(), second = publicPruneGraph({ note: { at: "2026-10-01T01:00:00.000Z" } });
  expect(second.note.text).toBe(f.graph.note.text); expect(second.note.id).not.toBe(f.graph.note.id);
  const registration = f.register(second.input), projection = f.replay({ ordinary: [f.graph.note, second.note] });
  expect(registration.previous).toBe(first.inputSetHash); expect(projection.authoredPrunes).toBe(2);
  expect([...projection.targets].sort()).toEqual([f.graph.note.id, second.note.id].sort());
  expect(projection.inputs.sort()).toEqual([first.inputHash!, registration.inputHash!].sort());
});

test("R08 committed membership cannot drop a predecessor descriptor or invent a missing member", () => {
  const f = fixture(), registered = f.register();
  for (const inputs of [[], ["f".repeat(64)]]) {
    const set = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: f.state.binding.receivingGeneration, previous: registered.inputSetHash, inputs };
    const hash = hashJSON(set); writeFileSync(archive(f.dir, "set", hash), canonicalJSON(set) + "\n", { mode: 0o600 });
    const old = f.state.binding.inputSetHash; f.state.binding.inputSetHash = hash;
    expect(() => f.replay()).toThrow("public prune input unavailable"); f.state.binding.inputSetHash = old;
  }
});

for (const lost of ["set", "input", "tree", "blob"] as const) for (const damage of ["missing", "altered"] as const) test(`R15 ${damage} committed ${lost} remains unavailable after every SQLite cache is deleted`, () => {
  const f = fixture(), registration = f.register(); expect(f.replay().targets.has(f.graph.note.id)).toBe(true);
  const file = lost === "set" ? archive(f.dir, "set", registration.inputSetHash) : lost === "input" ? archive(f.dir, "input", registration.inputHash!)
    : archive(f.dir, "object", lost === "tree" ? f.graph.rootTree.oid : f.graph.input.source.manifestBlob);
  if (damage === "missing") unlinkSync(file); else writeFileSync(file, Buffer.from("ALTERED-REQUIRED-CONTENT\n"));
  for (const name of ["index.db", "index-v2.db"]) {
    const db = new Database(join(f.dir, name), { create: true });
    db.run("CREATE TABLE cached_projection(id TEXT PRIMARY KEY)"); db.query("INSERT INTO cached_projection VALUES (?)").run(f.graph.note.id); db.close();
    unlinkSync(join(f.dir, name));
  }
  unlinkSync(join(f.dir, "mutation-lock.db"));
  expect(() => f.replay()).toThrow("public prune input unavailable");
});

test("R14 unregistered complete inputs, arbitrary files and pending temporaries never activate a mask", () => {
  const f = fixture(); f.register(null);
  persistPublicPruneInput(f.prepare()); // Durable complete evidence without a caller commitment.
  writeFileSync(join(f.dir, "public-prune-inputs", ".pending-incomplete"), "PRIVATE-TEMP-CANARY", { mode: 0o600 });
  writeFileSync(archive(f.dir, "input", "f".repeat(64)), "not a descriptor\n", { mode: 0o600 });
  const projection = f.replay(); expect(projection.targets.size).toBe(0); expect(projection.inputs).toEqual([]);
});

for (const category of ["object", "input", "set"] as const) for (const step of ["temp", "fsync", "installed"] as const) {
  const phase: PublicPrunePersistPhase = `${category}-${step}`;
  test(`R16 ${phase} interruption leaves old membership authoritative and exact retry succeeds`, () => {
    const f = fixture(); f.register(null); const previous = f.state.binding.inputSetHash, plan = f.prepare(); let interrupted = false;
    expect(() => persistPublicPruneInput(plan, { observe: current => { if (current === phase) { interrupted = true; throw new Error("FAULT-CANARY"); } } })).toThrow("public prune input unavailable");
    expect(interrupted).toBe(true); expect(f.state.binding.inputSetHash).toBe(previous); expect(f.replay().targets.size).toBe(0);
    expect(files(f.dir).some(name => name.includes(".pending-"))).toBe(false);
    const completed = persistPublicPruneInput(plan); expect(completed.previous).toBe(previous); f.commit(completed);
    expect([...f.replay().targets]).toEqual([f.graph.note.id]); expect(f.replay().authoredPrunes).toBe(1);
  });
}

test("R16 binding drift refuses before effects and after a durable object, without committing a new view", () => {
  const f = fixture(); f.register(null); const before = files(f.dir), old = structuredClone(f.state.binding), plan = f.prepare();
  f.state.binding = { ...old, selectorRevision: "f".repeat(64) };
  expect(() => persistPublicPruneInput(plan)).toThrow("public prune input binding"); expect(files(f.dir)).toEqual(before);
  f.state.binding = old; let moved = false;
  expect(() => persistPublicPruneInput(plan, { observe: phase => {
    if (!moved && phase === "object-installed") { moved = true; f.state.binding = { ...old, selectorRevision: "f".repeat(64) }; }
  } })).toThrow("public prune input binding");
  expect(moved).toBe(true); expect(f.state.binding.inputSetHash).toBe(old.inputSetHash); expect(f.replay().targets.size).toBe(0);
  f.state.binding = old; f.commit(persistPublicPruneInput(plan)); expect(f.replay().targets.has(f.graph.note.id)).toBe(true);
});

test("R16 replacing the physical root after preparation refuses before writing replacement storage", () => {
  const f = fixture(), plan = f.prepare(), moved = f.dir + "-original";
  cleanups.push(() => rmSync(moved, { recursive: true, force: true }));
  renameSync(f.dir, moved); mkdirSync(f.dir, { mode: 0o700 });
  expect(() => persistPublicPruneInput(plan)).toThrow("public prune input binding");
  expect(readdirSync(f.dir)).toEqual([]);
});

for (const attack of ["symlink", "hardlink", "mode", "altered bytes"] as const) test(`R15 archive ${attack} fails closed even with a valid committed set`, () => {
  const f = fixture(); f.register(); const path = archive(f.dir, "object", f.graph.input.source.manifestBlob), bytes = readFileSync(path);
  if (attack === "mode") chmodSync(path, 0o644);
  else if (attack === "altered bytes") writeFileSync(path, Buffer.alloc(bytes.length, 65));
  else {
    const outside = join(f.dir, "outside-object"); writeFileSync(outside, bytes, { mode: 0o600 }); unlinkSync(path);
    if (attack === "symlink") symlinkSync(outside, path); else linkSync(outside, path);
  }
  expect(() => f.replay()).toThrow("public prune input unavailable");
});

test("R15 root and archive directories refuse symlinks or public permissions", () => {
  const f = fixture(); f.register(); const location = join(f.dir, "public-prune-inputs"), moved = join(f.dir, "original-inputs");
  mkdirSync(moved, { mode: 0o700 });
  for (const name of readdirSync(location)) { const data = readFileSync(join(location, name)); writeFileSync(join(moved, name), data, { mode: 0o600 }); }
  rmSync(location, { recursive: true }); symlinkSync(moved, location);
  expect(() => f.replay()).toThrow("public prune input unavailable");
  const g = fixture(); g.register(); chmodSync(g.dir, 0o755); expect(() => g.replay()).toThrow("public prune input unavailable");
});

test("R20 exact-target/native union yields equal incremental and full filtered-view harnesses", () => {
  const f = fixture(); f.register();
  const { id: _id, ...body } = { ...f.graph.note, at: "2026-10-01T01:00:00.000Z" }, other = { ...body, id: entryId(body) };
  const native = "d".repeat(32), corpus = [f.graph.note, other];
  const first = f.replay({ nativeTargets: [native], ordinary: corpus.slice(0, 1) });
  const incremental = f.replay({ nativeTargets: [native], ordinary: corpus });
  const full = reducePublicPruneInputs({ dir: f.dir, realm: f.state.binding.realm, receivingGeneration: f.state.binding.receivingGeneration,
    inputSetHash: f.state.binding.inputSetHash!, nativeTargets: [native], ordinary: [...corpus].reverse() });
  expect([...first.targets].sort()).toEqual([f.graph.note.id, native].sort());
  expect([...incremental.targets].sort()).toEqual([...full.targets].sort()); expect([...incremental.rowHashes]).toEqual([...full.rowHashes]);
  const view = (mask: Set<string>) => corpus.filter(row => !mask.has(row.id)).map(row => row.id);
  // Harness parity only: production read/FTS/brief activation belongs to Layer 3.
  expect(view(incremental.targets)).toEqual(view(full.targets)); expect(view(full.targets)).toEqual([other.id]);
});

test("R20/R21 offline archive replay performs no fetch or process work and writes no ordinary corpus/selector", () => {
  const f = fixture(), graph = publicPruneGraph({ sibling: true }); f.register(graph.input);
  const before = files(f.dir), spies = [spyOn(globalThis, "fetch"), spyOn(Bun, "spawn"), spyOn(Bun, "spawnSync")];
  try { expect(f.replay().targets.has(graph.note.id)).toBe(true); for (const spy of spies) expect(spy).not.toHaveBeenCalled(); }
  finally { for (const spy of spies) spy.mockRestore(); }
  expect(files(f.dir)).toEqual(before);
  expect(before.some(name => /(^|\/)(log|local|selector\.json|profile\.json|index\.db|index-v2\.db)(\/|$)/.test(name))).toBe(false);
  expect(existsSync(archive(f.dir, "object", graph.siblingBlob.oid))).toBe(false);
  expect(existsSync(archive(f.dir, "object", graph.siblingTree.oid))).toBe(false);
});

test("R21 extra sibling bodies, graph resource excess, invalid descriptors and tampered provenance refuse before archive effects", () => {
  const f = fixture(), before = files(f.dir), graph = publicPruneGraph({ sibling: true });
  const extra = { ...graph.input, objects: [...graph.input.objects, graph.siblingTree, graph.siblingBlob] };
  expect(() => f.prepare(extra)).toThrow("public prune input unavailable");
  const many = { ...graph.input, objects: Array.from({ length: PUBLIC_PRUNE_GRAPH_MAX_OBJECTS + 1 }, (_, n) => rawGitObject("blob", `excess-${n}`)) };
  expect(() => f.prepare(many)).toThrow("public prune input resource");
  const oversized = { ...graph.input, objects: [{ oid: "a".repeat(40), bytes: Buffer.alloc(1024 * 1024 + 65) }] };
  expect(() => f.prepare(oversized)).toThrow("public prune input resource");
  for (const bad of [publicPruneGraph({ descriptor: { schema: "agent-mem.shard-sync/v1", ...graph.manifest.realm } }),
    publicPruneGraph({ mode: "120000" }), publicPruneGraph({ mode: "100755" }),
    publicPruneGraph({ provenance: { manifestBlob: "f".repeat(40) } }), publicPruneGraph({ provenance: { commit: "f".repeat(40) } }),
    publicPruneGraph({ manifest: manifest => { manifest.prune.cutoff = "2026-10-04T00:00:00.000Z"; } })]) {
    expect(() => f.prepare(bad.input)).toThrow("public prune input unavailable");
  }
  expect(files(f.dir)).toEqual(before);
});

test("R15 all predecessor commitments remain required after a later registration", () => {
  const f = fixture(), first = f.register(), second = publicPruneGraph({ note: { at: "2026-10-01T01:00:00.000Z" } });
  f.register(second.input); expect(f.replay().authoredPrunes).toBe(2);
  unlinkSync(archive(f.dir, "set", first.inputSetHash));
  expect(() => f.replay()).toThrow("public prune input unavailable");
});

test("R08/R15 committed descriptors cannot be borrowed by another realm or receiving generation", () => {
  const f = fixture(); f.register();
  for (const change of [{ realm: { scope: "user" as const } }, { receivingGeneration: "9".repeat(32) }]) {
    expect(() => reducePublicPruneInputs({ dir: f.dir, ...f.state.binding, inputSetHash: f.state.binding.inputSetHash!, ...change })).toThrow("public prune input unavailable");
  }
});

for (const kind of ["object", "input", "set"] as const) test(`R16 crash-left ${kind} final/temp link pair recovers under the writer fence`, () => {
  const f = fixture(); f.register(null); const previous = f.state.binding.inputSetHash, plan = f.prepare();
  const candidate = persistPublicPruneInput(plan);
  const id = kind === "object" ? f.graph.input.source.manifestBlob : kind === "input" ? candidate.inputHash! : candidate.inputSetHash;
  const final = archive(f.dir, kind, id), temp = join(final.slice(0, final.lastIndexOf("/")), ".pending-" + "a".repeat(32));
  linkSync(final, temp); expect(lstatSync(final).nlink).toBe(2);
  // Actual crash residue, unlike the exception tests whose finally removes temp.
  expect(f.state.binding.inputSetHash).toBe(previous); expect(f.replay().targets.size).toBe(0);
  const recovered = persistPublicPruneInput(plan); expect(recovered).toEqual(candidate);
  expect(existsSync(temp)).toBe(false); expect(lstatSync(final).nlink).toBe(1);
  f.commit(recovered); expect(f.replay().targets.has(f.graph.note.id)).toBe(true);
});
