import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as lineageFs from "node:fs";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON } from "../src/memory/generation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { assertPublisherBoundary, ensurePublisherBoundary, publisherPruneLineage, publisherPruneLineages } from "../src/memory/prune-publisher-lineage.ts";
import { pruneId, type PruneRow } from "../src/memory/prune.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-publisher-lineage-")); chmodSync(home, 0o700);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const generation = "a".repeat(32), machine = "b".repeat(16), dir = join(home, "user"), write = (file: string, value: unknown) => writeFileSync(file, canonicalJSON(value) + "\n", { mode: 0o600 });
  for (const folder of [dir, join(dir, "log"), join(dir, "local"), join(home, "public-prune-input-sets")]) mkdirSync(folder, { mode: 0o700 });
  const view = { schema: "agent-mem.public-prune-view/v1", receivingGeneration: generation, realms: {} }, viewHash = hashJSON(view);
  write(join(home, "public-prune-input-sets", viewHash + ".json"), view);
  const selector = { schema: "agent-mem.profile/v2", kind: "generation", generation, foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: viewHash };
  write(join(home, "profile.json"), selector); write(join(home, "shards.json"), { schema: "agent-mem.shards/v2", generation, phase: "active", selectorRevision: hashJSON(selector) });
  for (const base of [home, dir]) write(join(base, "machine.json"), { id: machine, label: "fixture" });
  write(join(dir, "generation.json"), generationDescriptor(generation));
  write(join(dir, "migration-sources.json"), { schema: "agent-mem.migration-sources/v1", sources: [] });
  const seal = join(dir, "generation-seal.json"); write(seal, { schema: "agent-mem.generation-seal/v1", generation, descriptorHash: hashJSON(generationDescriptor(generation)), sourceDigest: hashJSON({ sources: [] }) });
  const profile = resolveShardProfile(home, { user: true }), mutation = acquireMutation(dir)!; cleanup.push(mutation);
  const row = (at = "2026-10-31T00:00:00.000Z"): PruneRow => {
    const { id: _id, ...body } = { ...publicPruneGraph().manifest.prune, generation, machine, at };
    return { ...body, id: pruneId(body) };
  };
  const log = join(dir, "log", machine + ".jsonl"), boundary = join(dir, "local", `publisher-boundary-${machine}.json`);
  const append = (value: unknown) => appendFileSync(log, canonicalJSON(value) + "\n", { mode: 0o600 });
  return { home, dir, machine, profile, mutation, log, seal, boundary, append, row, write };
}
test("explicit create-once boundary excludes old originals and proves only complete post-seal own occurrences", () => {
  const f = fixture(), old = f.row(), next = f.row("2026-10-31T01:00:00.000Z"); f.append(old);
  expect(() => assertPublisherBoundary(f.profile, f.mutation)).toThrow();
  const boundary = ensurePublisherBoundary(f.profile, f.mutation), original = readFileSync(f.boundary);
  expect(publisherPruneLineage(f.profile, f.mutation, old)).toBeUndefined();
  f.append(next);
  expect(publisherPruneLineage(f.profile, f.mutation, next)).toEqual({ kind: "post-seal", seal: boundary.sealHash, end: boundary.end });
  expect(ensurePublisherBoundary(f.profile, f.mutation)).toEqual(boundary); expect(readFileSync(f.boundary)).toEqual(original);
  expect(publisherPruneLineage(f.profile, f.mutation, { ...next, machine: "c".repeat(16) })).toBeUndefined();
});
test("missing own log binds an empty prefix and first later row is eligible", () => {
  const f = fixture(), boundary = ensurePublisherBoundary(f.profile, f.mutation), row = f.row();
  expect(boundary.end).toBe(0); f.append(row);
  expect(publisherPruneLineage(f.profile, f.mutation, row)?.kind).toBe("post-seal");
});
for (const damage of ["seal", "prefix", "truncated", "tail", "mode", "hardlink", "symlink", "machine", "sources", "profile"] as const) {
  test(`publisher refuses ${damage} drift without rewriting original sources`, () => {
    const f = fixture(), old = f.row(); f.append(old); ensurePublisherBoundary(f.profile, f.mutation);
    const row = f.row("2026-10-31T01:00:00.000Z"); f.append(row);
    if (damage === "seal") appendFileSync(f.seal, " ");
    if (damage === "prefix") writeFileSync(f.log, readFileSync(f.log, "utf8").replace(old.at, "2026-10-30T00:00:00.000Z"));
    if (damage === "truncated") writeFileSync(f.log, "");
    if (damage === "tail") appendFileSync(f.log, "partial");
    if (damage === "mode") chmodSync(f.boundary, 0o644);
    if (damage === "hardlink") linkSync(f.boundary, join(f.dir, "external-link"));
    if (damage === "symlink") { const moved = f.boundary + ".other"; renameSync(f.boundary, moved); symlinkSync(moved, f.boundary); }
    if (damage === "machine") f.write(join(f.home, "machine.json"), { id: "c".repeat(16), label: "changed" });
    if (damage === "sources") f.write(join(f.dir, "migration-sources.json"), { schema: "agent-mem.migration-sources/v1", sources: [{ changed: true }] });
    if (damage === "profile") f.write(join(f.home, "profile.json"), { schema: "agent-mem.profile/v1", kind: "generation", generation: f.profile.generation });
    expect(() => publisherPruneLineage(f.profile, f.mutation, row)).toThrow();
  });
}
test("crash-linked boundary retries recover only an exact owned temp alias", () => {
  const f = fixture(), first = ensurePublisherBoundary(f.profile, f.mutation);
  const temp = join(f.dir, "local", `.publisher-boundary-${"d".repeat(32)}.tmp`); linkSync(f.boundary, temp);
  expect(ensurePublisherBoundary(f.profile, f.mutation)).toEqual(first);
  expect(() => readFileSync(temp)).toThrow();
  const external = join(f.dir, "outside.tmp"); linkSync(f.boundary, external);
  expect(() => ensurePublisherBoundary(f.profile, f.mutation)).toThrow(); unlinkSync(external);
});
test("partial line cannot establish a boundary or a post-seal claim", () => {
  const f = fixture(); appendFileSync(f.log, "partial", { mode: 0o600 });
  expect(() => ensurePublisherBoundary(f.profile, f.mutation)).toThrow();
});

test("replaying an older original after the boundary never upgrades its lineage", () => {
  const f = fixture(), old = f.row(); f.append(old); ensurePublisherBoundary(f.profile, f.mutation); f.append(old);
  expect(publisherPruneLineage(f.profile, f.mutation, old)).toBeUndefined();
});


test("batch lineage agrees with per-row calls and independently excludes pre-boundary, absent and mismatched originals", () => {
  const f = fixture(), old = f.row(), fresh = f.row("2026-10-31T01:00:00.000Z"), next = f.row("2026-10-31T02:00:00.000Z"), missing = f.row("2026-10-31T03:00:00.000Z");
  f.append(old); const boundary = ensurePublisherBoundary(f.profile, f.mutation);
  f.append(old); f.append(fresh); f.append(fresh); f.append(next);
  const changed = (fields: Partial<PruneRow>): PruneRow => { const { id: _id, ...body } = { ...fresh, ...fields }; return { ...body, id: pruneId(body) }; };
  const otherMachine = changed({ machine: "c".repeat(16) }), otherGeneration = changed({ generation: "d".repeat(32) }), local = changed({ placement: "local" });
  const rows = [old, fresh, fresh, next, missing, otherMachine, otherGeneration, local];
  const expected = { kind: "post-seal", seal: boundary.sealHash, end: boundary.end };
  const actual = publisherPruneLineages(f.profile, f.mutation, rows);
  expect([...actual.keys()].sort()).toEqual([fresh.id, next.id].sort());
  expect(actual.get(fresh.id)).toEqual(expected); expect(actual.get(next.id)).toEqual(expected);
  for (const row of rows) {
    const eligible = row === fresh || row === next;
    expect(publisherPruneLineage(f.profile, f.mutation, row)).toEqual(eligible ? expected : undefined);
    expect(actual.get(row.id)).toEqual(eligible ? expected : undefined);
  }
  expect(actual.has(old.id)).toBe(false); expect(actual.has(missing.id)).toBe(false);
  expect(publisherPruneLineages(f.profile, f.mutation, [])).toEqual(new Map());
});

test("batch parses each complete own-log line once and keeps streaming reads independent of candidate count", () => {
  const f = fixture(), old = f.row(), candidates = Array.from({ length: 12 }, (_, index) => f.row(`2026-10-31T${String(index + 1).padStart(2, "0")}:00:00.000Z`));
  f.append(old); ensurePublisherBoundary(f.profile, f.mutation); f.append(old);
  for (const row of candidates) f.append(row);
  const lines = new Set([old, ...candidates].map(row => canonicalJSON(row))), open = lineageFs.openSync, read = lineageFs.readSync, close = lineageFs.closeSync, parse = JSON.parse;
  const measure = (selected: PruneRow[]) => {
    let opens = 0, reads = 0, parses = 0; const logDescriptors = new Set<number>();
    const openSpy = spyOn(lineageFs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
      const fd = Reflect.apply(open, lineageFs, args); if (args[0] === f.log) { opens++; logDescriptors.add(fd); } return fd;
    }) as typeof open);
    const closeSpy = spyOn(lineageFs, "closeSync").mockImplementation(fd => { logDescriptors.delete(fd); return close(fd); });
    const readSpy = spyOn(lineageFs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => {
      if (logDescriptors.has(args[0])) reads++; return Reflect.apply(read, lineageFs, args);
    }) as typeof read);
    const parseSpy = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (lines.has(text)) parses++; return Reflect.apply(parse, JSON, [text, reviver]);
    });
    try { const result = publisherPruneLineages(f.profile, f.mutation, selected); expect(result.size).toBe(selected.length); return { opens, reads, parses }; }
    finally { parseSpy.mockRestore(); readSpy.mockRestore(); closeSpy.mockRestore(); openSpy.mockRestore(); }
  };
  const single = measure([candidates[0]!]), batch = measure(candidates);
  expect(single.parses).toBe(candidates.length + 2); expect(batch.parses).toBe(single.parses);
  expect(single.opens).toBeGreaterThan(0); expect(batch.opens).toBe(single.opens); expect(batch.reads).toBe(single.reads);
});

test("batch refuses incomplete tails and malformed eligible candidates without accepting partial evidence", () => {
  const f = fixture(), row = f.row(); ensurePublisherBoundary(f.profile, f.mutation); f.append(row);
  expect(() => publisherPruneLineages(f.profile, f.mutation, [{ ...row, id: "0".repeat(32) }])).toThrow();
  appendFileSync(f.log, "partial");
  expect(() => publisherPruneLineages(f.profile, f.mutation, [row])).toThrow();
});
