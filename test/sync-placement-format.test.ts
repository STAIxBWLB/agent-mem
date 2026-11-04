import { expect, test } from "bun:test";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import {
  PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA, PLACEMENT_SHARDS_SCHEMA, PLACEMENT_DESCRIPTOR_SCHEMA, SyncPlacementFormatError,
  validatePlacementProfile, validatePlacementShards, validatePlacementDescriptor, validatePlacementBaseV2, validatePlacementMarkerTransition,
  validatePlacementVersionTransition, decodePlacementProfile, decodePlacementShards, decodePlacementDescriptor,
} from "../src/memory/sync-placement-format.ts";

const generation = "1".repeat(32), view = "2".repeat(64), head = "3".repeat(64), hash = "4".repeat(64), commit = "5".repeat(40);
function fixture() {
  const profile2 = { schema: "agent-mem.profile/v2", kind: "generation", generation, foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: view };
  const shards2 = { schema: "agent-mem.shards/v2", generation, phase: "active", selectorRevision: hashJSON(profile2), sourceGeneration: generation,
    sources: [
      { source: "legacy-local", path: "log/a.jsonl", offset: 100, hash, tailBytes: 0, stamp: '["1","2","100","3","4"]' },
      { source: "legacy-main", path: "log/b.jsonl", offset: 200, hash, tailBytes: 0, commit },
      { source: "generation", path: "local/c.jsonl", offset: 300, hash, tailBytes: 0 },
    ], machine: { id: "6".repeat(16), label: "기기" }, legacyCommit: commit,
    deadLeasesRemoved: [{ lease: `42-${hash}.json`, at: "2026-11-05T00:00:00.000Z" }] };
  const profile = { ...profile2, schema: PLACEMENT_PROFILE_SCHEMA, publicationFormat: PLACEMENT_FORMAT, placementHead: head };
  const shards = { ...shards2, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: head };
  return { profile2, shards2, profile, shards };
}
const encode = (value: unknown) => Buffer.from(canonicalJSON(value) + "\n");
function refused(work: () => unknown): void {
  expect(work).toThrow(SyncPlacementFormatError);
  try { work(); } catch (error) { expect((error as SyncPlacementFormatError).code).toBe("sync_placement_format"); expect((error as Error).message).not.toContain("private-canary"); }
}

test("closed placement marker pair and descriptors round-trip canonical UTF8 and return detached data", () => {
  const f = fixture(), profile = validatePlacementProfile(f.profile), shards = validatePlacementShards(f.shards, profile);
  expect(profile).toEqual(f.profile); expect(shards).toEqual(f.shards);
  expect(decodePlacementProfile(encode(profile))).toEqual(profile); expect(decodePlacementShards(encode(shards), profile)).toEqual(shards);
  shards.machine.label = "changed"; shards.sources[0]!.offset = 9; shards.deadLeasesRemoved![0]!.lease = "changed";
  expect(f.shards.machine.label).toBe("기기"); expect(f.shards.sources[0]!.offset).toBe(100); expect(f.shards.deadLeasesRemoved[0]!.lease).not.toBe("changed");
  for (const realm of [{ scope: "user" as const }, { scope: "project" as const, key: "example.test/team/project" }]) {
    const descriptor = { schema: PLACEMENT_DESCRIPTOR_SCHEMA, publicationFormat: PLACEMENT_FORMAT, ...realm };
    expect(validatePlacementDescriptor(descriptor, realm)).toEqual(descriptor);
    expect(decodePlacementDescriptor(encode(descriptor), realm)).toEqual(descriptor);
  }
});

test("profile fields, shard commitments and realm key shape are closed and exact", () => {
  const f = fixture();
  for (const value of [ { ...f.profile, extra: "private-canary" }, { ...f.profile, kind: "shared-v1" }, { ...f.profile, generation: "a".repeat(31) },
    { ...f.profile, foreignPruneFormat: "future" }, { ...f.profile, pruneInputSetHash: "A".repeat(64) }, { ...f.profile, publicationFormat: "future" }, { ...f.profile, placementHead: "a".repeat(63) } ]) refused(() => validatePlacementProfile(value));
  for (const value of [ { ...f.shards, extra: true }, { ...f.shards, phase: "captured" }, { ...f.shards, generation: "a".repeat(32) },
    { ...f.shards, placementHead: "a".repeat(64) }, { ...f.shards, selectorRevision: hashJSON(f.profile2) }, { ...f.shards, publicationFormat: "future" } ]) refused(() => validatePlacementShards(value, f.profile));
  const descriptor = { schema: PLACEMENT_DESCRIPTOR_SCHEMA, publicationFormat: PLACEMENT_FORMAT, scope: "user" };
  refused(() => validatePlacementDescriptor({ ...descriptor, key: "private-canary" }));
  refused(() => validatePlacementDescriptor({ ...descriptor, scope: "project" }));
  refused(() => validatePlacementDescriptor({ ...descriptor, scope: "project", key: "" }));
  refused(() => validatePlacementDescriptor(descriptor, { scope: "project", key: "different" }));
  refused(() => validatePlacementDescriptor({ ...descriptor, extra: true }));
});

test("source receipts retain existing path, commit, offset, tail, stamp and uniqueness constraints", () => {
  const f = fixture(), first = f.shards.sources[0]!;
  const invalid = [
    { ...first, source: "future" }, { ...first, path: "../private-canary" }, { ...first, path: "log/a/../b.jsonl" },
    { ...first, offset: -1 }, { ...first, offset: Number.MAX_SAFE_INTEGER + 1 }, { ...first, tailBytes: -1 }, { ...first, hash: "broken" },
    { ...first, stamp: "x".repeat(1025) }, { ...first, commit }, { ...first, source: "generation", commit },
    { ...first, source: "legacy-main" }, { ...first, source: "legacy-main", path: "local/a.jsonl", commit }, { ...first, unknown: true },
  ];
  for (const source of invalid) refused(() => validatePlacementShards({ ...f.shards, sources: [source] }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, sources: [first, first] }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, sourceGeneration: "a".repeat(32) }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, legacyCommit: "a".repeat(39) }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, machine: { ...f.shards.machine, extra: "private-canary" } }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, deadLeasesRemoved: [{ lease: `0-${hash}.json`, at: "not-time" }] }, f.profile));
});

test("metadata and wire bounds refuse before returning a partial normalized value", () => {
  const f = fixture();
  refused(() => validatePlacementShards({ ...f.shards, sources: Array.from({ length: 20_001 }, () => f.shards.sources[0]) }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, machine: { ...f.shards.machine, label: "x".repeat(256 * 1024) } }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, deadLeasesRemoved: Array.from({ length: 129 }, () => f.shards.deadLeasesRemoved[0]) }, f.profile));
  refused(() => validatePlacementDescriptor({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, scope: "project", key: "x".repeat(64 * 1024), publicationFormat: PLACEMENT_FORMAT }));
  refused(() => decodePlacementProfile(Buffer.alloc(256 * 1024 + 1, 32)));
  refused(() => decodePlacementDescriptor(Buffer.alloc(64 * 1024 + 1, 32)));
});

test("canonical decoders require valid UTF8, sorted exact JSON and exactly one complete newline", () => {
  const f = fixture(), canonical = encode(f.profile);
  for (const bytes of [ Buffer.from(canonical.subarray(0, -1)), Buffer.concat([canonical, Buffer.from("\n")]), Buffer.concat([Buffer.from(" "), canonical]),
    Buffer.from(JSON.stringify(f.profile) + "\n"), Buffer.from([255]), Buffer.from("null\n"), Buffer.from("{}\n") ]) refused(() => decodePlacementProfile(bytes));
  let getters = 0;
  const bytes = Buffer.from(canonical);
  Object.defineProperty(bytes, "byteLength", { get() { getters++; throw Error("private-canary"); } });
  expect(decodePlacementProfile(bytes)).toEqual(f.profile); expect(getters).toBe(0);
});

test("input accessors, proxies, exotic prototypes, symbols and array tricks never execute code", () => {
  const f = fixture(); let calls = 0;
  const getter = Object.defineProperty({ ...f.profile }, "generation", { enumerable: true, get() { calls++; return generation; } });
  const proxy = new Proxy(f.profile, { ownKeys() { calls++; throw Error("private-canary"); }, getPrototypeOf() { calls++; return null; } });
  refused(() => validatePlacementProfile(getter)); refused(() => validatePlacementProfile(proxy));
  refused(() => validatePlacementProfile(Object.assign(Object.create({ inherited: true }), f.profile)));
  refused(() => validatePlacementProfile({ ...f.profile, [Symbol("hidden")]: true }));
  refused(() => validatePlacementProfile(Object.defineProperty({ ...f.profile }, "generation", { value: generation, enumerable: false })));
  const sources = [...f.shards.sources]; Object.defineProperty(sources, "0", { enumerable: true, get() { calls++; return f.shards.sources[0]; } });
  refused(() => validatePlacementShards({ ...f.shards, sources }, f.profile));
  const unsafe = { toString() { calls++; return "legacy-local"; } };
  refused(() => validatePlacementShards({ ...f.shards, sources: [{ ...f.shards.sources[0], source: unsafe }] }, f.profile));
  expect(calls).toBe(0);
});

test("activation transition is only the exact v2 base plus the new format/head and recomputed selector", () => {
  const f = fixture();
  expect(validatePlacementBaseV2(f.profile2, f.shards2)).toEqual({ profile: f.profile2, shards: f.shards2 });
  expect(validatePlacementMarkerTransition(f.profile2, f.shards2, f.profile, f.shards)).toEqual({ profile: f.profile, shards: f.shards });
  refused(() => validatePlacementBaseV2({ ...f.profile2, schema: "agent-mem.profile/v1" }, { ...f.shards2, schema: "agent-mem.shards/v1" }));
  refused(() => validatePlacementMarkerTransition(f.profile, f.shards, f.profile, f.shards));
  const changed = { ...f.profile, pruneInputSetHash: "a".repeat(64) };
  refused(() => validatePlacementMarkerTransition(f.profile2, f.shards2, changed, { ...f.shards, selectorRevision: hashJSON(changed) }));
  refused(() => validatePlacementMarkerTransition(f.profile2, f.shards2, f.profile, { ...f.shards, machine: { ...f.shards.machine, label: "private-canary" } }));
  refused(() => validatePlacementMarkerTransition(f.profile2, f.shards2, f.profile, { ...f.shards, sources: f.shards.sources.slice(1) }));
  const minimal2 = { schema: "agent-mem.shards/v2", generation, phase: "active", selectorRevision: hashJSON(f.profile2), sources: [], machine: f.shards2.machine };
  const minimal3 = { ...minimal2, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(f.profile), publicationFormat: PLACEMENT_FORMAT, placementHead: head };
  expect(validatePlacementMarkerTransition(f.profile2, minimal2, f.profile, minimal3).shards.sources).toEqual([]);
});

test("placement upgrade version helper supports each known family and rejects unknown/cross-family/downgrade", () => {
  for (const family of ["agent-mem.profile", "agent-mem.shards", "agent-mem.shard-sync"]) {
    for (const version of [1, 2, 3]) expect(() => validatePlacementVersionTransition(`${family}/v${version}`, `${family}/v3`)).not.toThrow();
    for (const pair of [[`${family}/v3`, `${family}/v2`], [`${family}/v1`, `${family}/v2`], [`${family}/v9`, `${family}/v3`]]) refused(() => validatePlacementVersionTransition(...pair as [string, string]));
  }
  refused(() => validatePlacementVersionTransition("agent-mem.profile/v2", "agent-mem.shards/v3"));
});


test("fixed-width generation, commitments and machine IDs reject trailing LF", () => {
  const f = fixture();
  refused(() => validatePlacementProfile({ ...f.profile, generation: generation + "\n" }));
  refused(() => validatePlacementProfile({ ...f.profile, pruneInputSetHash: view + "\n" }));
  refused(() => validatePlacementProfile({ ...f.profile, placementHead: head + "\n" }));
  refused(() => validatePlacementShards({ ...f.shards, machine: { ...f.shards.machine, id: f.shards.machine.id + "\n" } }, f.profile));
});


test("source paths and removed-lease basenames require complete regex matches", () => {
  const f = fixture(), source = f.shards.sources[0]!, audit = f.shards.deadLeasesRemoved[0]!;
  refused(() => validatePlacementShards({ ...f.shards, sources: [{ ...source, path: source.path + "\n" }] }, f.profile));
  refused(() => validatePlacementShards({ ...f.shards, deadLeasesRemoved: [{ ...audit, lease: audit.lease + "\n" }] }, f.profile));
});
