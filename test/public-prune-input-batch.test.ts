import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "../src/memory/mutation.ts";
import { persistPublicPruneInputBatch, preparePublicPruneInputBatch, readPublicPruneInputDescriptor, readPublicPruneInputSetChain,
  reducePublicPruneInputs, PUBLIC_PRUNE_REPLAY_MAX_BYTES, type PublicPruneBinding, type PublicPruneInputBatch, type PublicPruneInputOptions } from "../src/memory/public-prune-inputs.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amem-prune-input-batch-")); chmodSync(dir, 0o700);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const mutation = acquireMutation(dir)!; cleanup.push(mutation);
  const first = publicPruneGraph(), second = publicPruneGraph({ note: { at: "2026-10-01T01:00:00.000Z" } });
  const state: { binding: PublicPruneBinding } = { binding: { realm: first.manifest.realm, receivingGeneration: "a".repeat(32), selectorRevision: "b".repeat(64), inputSetHash: null } };
  const prepare = (inputs: NonNullable<PublicPruneInputOptions["input"]>[] = [first.input, second.input]) => preparePublicPruneInputBatch({ dir, binding: state.binding, current: () => state.binding, inputs }, mutation);
  const replay = (hash: string) => reducePublicPruneInputs({ dir, ...state.binding, inputSetHash: hash });
  return { dir, mutation, first, second, state, prepare, replay };
}
function files(dir: string, prefix = ""): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name), stat = statSync(file), key = prefix + name;
    if (stat.isDirectory()) Object.assign(result, files(file, key + "/")); else result[key] = stat.size;
  }
  return result;
}
test("batch preflights without files, chains all candidates and leaves committed binding unchanged", () => {
  const f = fixture(), before = files(f.dir), binding = structuredClone(f.state.binding), batch = f.prepare();
  expect(files(f.dir)).toEqual(before);
  const result = persistPublicPruneInputBatch(batch, { mutation: f.mutation });
  expect(f.state.binding).toEqual(binding); expect(existsSync(join(f.dir, "profile.json"))).toBe(false);
  const chain = readPublicPruneInputSetChain({ dir: f.dir, receivingGeneration: binding.receivingGeneration, inputSetHash: result.inputSetHash });
  expect(chain.commitments.length).toBe(2); expect(chain.inputs.length).toBe(2); expect(result.previous).toBeNull();
  for (const hash of chain.inputs) expect(readPublicPruneInputDescriptor({ dir: f.dir, hash }).selectorRevision).toBe(binding.selectorRevision);
  expect(f.replay(result.inputSetHash).authoredPrunes).toBe(2);
  const complete = files(f.dir), phases: string[] = [];
  expect(persistPublicPruneInputBatch(batch, { mutation: f.mutation, observe: phase => phases.push(phase) })).toEqual(result);
  expect(phases).toEqual([]); expect(files(f.dir)).toEqual(complete); expect(() => assertMutationHandle(f.mutation, f.dir)).not.toThrow();
});
test("batch deduplicates shared graph objects and exact duplicate descriptors", () => {
  const f = fixture(), batch = f.prepare([f.first.input, f.first.input, f.second.input]), result = persistPublicPruneInputBatch(batch);
  const objectIds = new Set([...f.first.input.objects, ...f.second.input.objects].map(value => value.oid));
  expect(readdirSync(join(f.dir, "public-prune-objects")).length).toBe(objectIds.size);
  expect(readdirSync(join(f.dir, "public-prune-inputs")).length).toBe(2);
  expect(readdirSync(join(f.dir, "public-prune-input-sets")).length).toBe(2);
  expect(f.replay(result.inputSetHash).authoredPrunes).toBe(2);
});
test("aggregate archive budget refuses the combined future view before evidence writes", () => {
  const f = fixture(), descriptor = (input: NonNullable<PublicPruneInputOptions["input"]>) => ({ schema: "agent-mem.public-prune-input/v1", realm: f.state.binding.realm,
    receivingGeneration: f.state.binding.receivingGeneration, selectorRevision: f.state.binding.selectorRevision, witnessHash: input.witnessHash, source: input.source });
  const cost = (input: NonNullable<PublicPruneInputOptions["input"]>) => {
    const value = descriptor(input), set = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: f.state.binding.receivingGeneration, previous: null, inputs: [hashJSON(value)] };
    return input.objects.reduce((sum, item) => sum + item.bytes.byteLength, 0) + Buffer.byteLength(canonicalJSON(value) + "\n") + Buffer.byteLength(canonicalJSON(set) + "\n");
  };
  const archive = join(f.dir, "public-prune-objects"); mkdirSync(archive, { mode: 0o700 });
  const orphan = join(archive, "unregistered-capacity-fixture"), fd = openSync(orphan, "wx", 0o600); closeSync(fd);
  // Sparse orphan consumes accounting capacity without allocating a huge resident fixture.
  truncateSync(orphan, PUBLIC_PRUNE_REPLAY_MAX_BYTES - Math.max(cost(f.first.input), cost(f.second.input)));
  const before = files(f.dir);
  expect(() => f.prepare([f.first.input])).not.toThrow(); expect(() => f.prepare([f.second.input])).not.toThrow();
  expect(() => f.prepare()).toThrow("public prune input resource"); expect(files(f.dir)).toEqual(before);
});
test("binding drift, opaque token forgery and released/wrong-directory fences refuse before effects", () => {
  const f = fixture(), batch = f.prepare(), before = files(f.dir);
  f.state.binding = { ...f.state.binding, selectorRevision: "c".repeat(64) };
  expect(() => persistPublicPruneInputBatch(batch)).toThrow("binding"); expect(files(f.dir)).toEqual(before);
  f.state.binding = { ...f.state.binding, selectorRevision: "b".repeat(64) };
  expect(() => persistPublicPruneInputBatch({} as PublicPruneInputBatch, { mutation: f.mutation })).toThrow();
  const other = fixture(); expect(() => persistPublicPruneInputBatch(batch, { mutation: other.mutation })).toThrow();
  expect(() => preparePublicPruneInputBatch({ dir: f.dir, binding: f.state.binding, current: () => f.state.binding, inputs: [] }, (() => {}) as MutationHandle)).toThrow();
  f.mutation(); const released = files(f.dir); expect(() => persistPublicPruneInputBatch(batch)).toThrow(); expect(files(f.dir)).toEqual(released);
});
test("persist rechecks aggregate capacity and retained input integrity after preparation", () => {
  const f = fixture(), batch = f.prepare(), archive = join(f.dir, "public-prune-objects"); mkdirSync(archive, { mode: 0o700 });
  const orphan = join(archive, "late-capacity-fixture"), fd = openSync(orphan, "wx", 0o600); closeSync(fd); truncateSync(orphan, PUBLIC_PRUNE_REPLAY_MAX_BYTES);
  const before = files(f.dir); expect(() => persistPublicPruneInputBatch(batch)).toThrow("resource"); expect(files(f.dir)).toEqual(before);
});
test("interrupted installation retries the identical complete batch without selector registration", () => {
  const f = fixture(), batch = f.prepare(); let interrupted = false;
  expect(() => persistPublicPruneInputBatch(batch, { mutation: f.mutation, observe: phase => {
    if (!interrupted && phase === "input-installed") { interrupted = true; throw new Error("synthetic interruption"); }
  } })).toThrow();
  expect(interrupted).toBe(true); expect(f.state.binding.inputSetHash).toBeNull();
  const result = persistPublicPruneInputBatch(batch); expect(f.replay(result.inputSetHash).authoredPrunes).toBe(2);
  expect(persistPublicPruneInputBatch(batch)).toEqual(result);
});
test("empty batch returns an existing commitment or a single explicit empty candidate", () => {
  const f = fixture(), empty = persistPublicPruneInputBatch(f.prepare([]));
  expect(readPublicPruneInputSetChain({ dir: f.dir, receivingGeneration: f.state.binding.receivingGeneration, inputSetHash: empty.inputSetHash }).inputs).toEqual([]);
  f.state.binding = { ...f.state.binding, inputSetHash: empty.inputSetHash };
  const before = files(f.dir), batch = f.prepare([]); expect(persistPublicPruneInputBatch(batch).inputSetHash).toBe(empty.inputSetHash); expect(files(f.dir)).toEqual(before);
});
test("descriptor helper reads strict declared canonical hashes without archive scanning", () => {
  const f = fixture(), result = persistPublicPruneInputBatch(f.prepare([f.first.input])), hash = result.inputHash!;
  expect(readPublicPruneInputDescriptor({ dir: f.dir, hash }).witnessHash).toBe(f.first.input.witnessHash);
  const file = join(f.dir, "public-prune-inputs", hash + ".json"), original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace('"selectorRevision":', '"extra":true,"selectorRevision":'));
  expect(() => readPublicPruneInputDescriptor({ dir: f.dir, hash })).toThrow();
  expect(() => readPublicPruneInputDescriptor({ dir: f.dir, hash: "../escape" })).toThrow();
});
