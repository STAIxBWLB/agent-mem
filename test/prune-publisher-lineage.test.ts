import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON } from "../src/memory/generation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { assertPublisherBoundary, ensurePublisherBoundary, publisherPruneLineage } from "../src/memory/prune-publisher-lineage.ts";
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
