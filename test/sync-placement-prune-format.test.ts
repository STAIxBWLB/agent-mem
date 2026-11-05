import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON } from "../src/memory/generation.ts";
import { PLACEMENT_FORMAT, PLACEMENT_DESCRIPTOR_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { decodeShardDescriptor, decodePlacementTransportDescriptor, SHARD_PACK_MAX_BYTES } from "../src/memory/shard-sync-format.ts";
import { collectPublicPruneGitGraph, type PublicPruneGitGraphOptions } from "../src/memory/shard-sync-graph.ts";
import { preparePublicPruneInput, persistPublicPruneInput, reducePublicPruneInputs, createPublicPruneReplayCache,
  PUBLIC_PRUNE_GRAPH_MAX_OBJECTS, PublicPruneInputError, type PublicPruneBinding, type PublicPruneInputOptions } from "../src/memory/public-prune-inputs.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function graph3(extra: Parameters<typeof publicPruneGraph>[0] = {}) {
  const base = publicPruneGraph();
  return publicPruneGraph({ descriptor: { schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...base.manifest.realm, publicationFormat: PLACEMENT_FORMAT }, ...extra });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amem-placement-prune-codec-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const graph = graph3(), base: PublicPruneBinding = { realm: graph.manifest.realm, receivingGeneration: "7".repeat(32), selectorRevision: "8".repeat(64), inputSetHash: null };
  return { dir, graph, base };
}
function collector(graph: ReturnType<typeof graph3>, publicationFormat?: typeof PLACEMENT_FORMAT): PublicPruneGitGraphOptions {
  const map = new Map(graph.input.objects.map(object => [object.oid, Buffer.from(object.bytes)]));
  return { commit: graph.input.source.commit, manifestPath: graph.input.source.manifestPath, manifestBlob: graph.input.source.manifestBlob,
    realm: graph.manifest.realm, ...(publicationFormat ? { publicationFormat } : {}),
    async readObject(oid) {
      const raw = map.get(oid); if (!raw) throw Error("synthetic object unavailable");
      const split = raw.indexOf(0), header = raw.subarray(0, split).toString("ascii"), match = /^(blob|tree|commit) ([0-9]+)$/.exec(header);
      if (!match || split < 0) throw Error("synthetic object header unavailable");
      return { type: match[1] as "blob" | "tree" | "commit", body: raw.subarray(split + 1) };
    } };
}
function prepare(f: ReturnType<typeof fixture>, binding: PublicPruneBinding, input: NonNullable<PublicPruneInputOptions["input"]> = f.graph.input) {
  return preparePublicPruneInput({ dir: f.dir, binding, current: () => binding, input });
}

test("legacy descriptor decoder still refuses closed v3 while the explicit transport codec recognizes it", () => {
  const f = fixture(), descriptor = Buffer.from(canonicalJSON({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...f.graph.manifest.realm, publicationFormat: PLACEMENT_FORMAT }) + "\n");
  expect(() => decodeShardDescriptor(descriptor, f.graph.manifest.realm)).toThrow();
  expect(decodePlacementTransportDescriptor(descriptor, f.graph.manifest.realm)).toBe("v3");
  const unknown = Buffer.from(canonicalJSON({ schema: "agent-mem.shard-sync/v4", ...f.graph.manifest.realm, publicationFormat: PLACEMENT_FORMAT }) + "\n");
  expect(() => decodePlacementTransportDescriptor(unknown, f.graph.manifest.realm)).toThrow();
  const incomplete = Buffer.from(canonicalJSON({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...f.graph.manifest.realm }) + "\n");
  expect(() => decodePlacementTransportDescriptor(incomplete, f.graph.manifest.realm)).toThrow();
});

test("complete v3 witness graph is rejected by default preparation and accepted only by explicit v3 binding", () => {
  const f = fixture(); expect(() => prepare(f, f.base)).toThrow(PublicPruneInputError); expect(readdirSync(f.dir)).toEqual([]);
  const binding: PublicPruneBinding = { ...f.base, publicationFormat: PLACEMENT_FORMAT };
  const registration = persistPublicPruneInput(prepare(f, binding));
  expect(registration.inputHash).toBeDefined();
  const descriptor = JSON.parse(readFileSync(join(f.dir, "public-prune-inputs", `${registration.inputHash!}.json`), "utf8"));
  expect(descriptor.schema).toBe("agent-mem.public-prune-input/v1"); expect(descriptor.publicationFormat).toBeUndefined();
  const set = JSON.parse(readFileSync(join(f.dir, "public-prune-input-sets", `${registration.inputSetHash}.json`), "utf8"));
  expect(set.schema).toBe("agent-mem.public-prune-input-set/v1"); expect(set.publicationFormat).toBeUndefined();
  const replay = { dir: f.dir, realm: binding.realm, receivingGeneration: binding.receivingGeneration, inputSetHash: registration.inputSetHash };
  expect(() => reducePublicPruneInputs(replay)).toThrow(PublicPruneInputError);
  expect(() => createPublicPruneReplayCache(replay)()).toThrow(PublicPruneInputError);
  const projection = reducePublicPruneInputs({ ...replay, publicationFormat: PLACEMENT_FORMAT });
  expect([...projection.targets]).toEqual([f.graph.note.id]); expect(projection.authoredPrunes).toBe(1);
  expect(createPublicPruneReplayCache({ ...replay, publicationFormat: PLACEMENT_FORMAT })().targets.has(f.graph.note.id)).toBe(true);
});

test("selected graph collector preserves default v2 refusal and permits only explicit v3 proof acquisition", async () => {
  const f = fixture(); await expect(collectPublicPruneGitGraph(collector(f.graph))).rejects.toBeInstanceOf(PublicPruneInputError);
  const objects = await collectPublicPruneGitGraph(collector(f.graph, PLACEMENT_FORMAT));
  expect(objects.map(object => object.oid).sort()).toEqual(f.graph.input.objects.map(object => object.oid).sort());
  // The v2 fixture remains accepted without any publication-format capability.
  const old = publicPruneGraph(); expect((await collectPublicPruneGitGraph(collector(old))).length).toBe(old.input.objects.length);
});

test("explicit v3 does not relax exact realm, generation, object hash or witness completeness", async () => {
  const f = fixture(), binding: PublicPruneBinding = { ...f.base, publicationFormat: PLACEMENT_FORMAT };
  expect(() => prepare(f, { ...binding, realm: { scope: "project", key: "other.example/realm" } })).toThrow(PublicPruneInputError);
  expect(() => prepare(f, { ...binding, receivingGeneration: "not-a-generation" })).toThrow(PublicPruneInputError);
  expect(() => prepare(f, binding, { ...f.graph.input, witnessHash: "0".repeat(64) })).toThrow(PublicPruneInputError);
  expect(() => prepare(f, binding, { ...f.graph.input, source: { ...f.graph.input.source, commit: "0".repeat(40) } })).toThrow(PublicPruneInputError);
  const missing = { ...f.graph.input, objects: f.graph.input.objects.filter(object => object.oid !== f.graph.manifest.witnesses[0]!.blob) };
  expect(() => prepare(f, binding, missing)).toThrow(PublicPruneInputError);
  const invalidWitness = graph3({ manifest(manifest) { manifest.witnesses = []; } });
  expect(() => prepare(f, binding, invalidWitness.input)).toThrow(PublicPruneInputError);
  await expect(collectPublicPruneGitGraph(collector(invalidWitness, PLACEMENT_FORMAT))).rejects.toBeInstanceOf(PublicPruneInputError);
  const mismatchedRealm = collector(f.graph, PLACEMENT_FORMAT); mismatchedRealm.realm = { scope: "project", key: "other.example/realm" };
  await expect(collectPublicPruneGitGraph(mismatchedRealm)).rejects.toBeInstanceOf(PublicPruneInputError);
});

test("explicit v3 retains the existing graph cardinality and per-object bounds", async () => {
  const f = fixture(), binding: PublicPruneBinding = { ...f.base, publicationFormat: PLACEMENT_FORMAT };
  expect(() => prepare(f, binding, { ...f.graph.input, objects: Array.from({ length: PUBLIC_PRUNE_GRAPH_MAX_OBJECTS + 1 }, () => f.graph.input.objects[0]!) })).toThrow(PublicPruneInputError);
  const oversized = collector(f.graph, PLACEMENT_FORMAT);
  oversized.readObject = async () => ({ type: "blob", body: Buffer.alloc(SHARD_PACK_MAX_BYTES + 1) });
  await expect(collectPublicPruneGitGraph(oversized)).rejects.toBeInstanceOf(PublicPruneInputError);
  expect(readdirSync(f.dir)).toEqual([]);
});
