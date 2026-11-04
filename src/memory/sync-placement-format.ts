import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { SHARDED_V2_FIELDS } from "./shard.ts";
import type { SourcePrefix } from "./migrate.ts";
import type { ShardSyncRealm } from "./shard-sync-format.ts";

export const PLACEMENT_FORMAT = "agent-mem.sync-placement/v1";
export const PLACEMENT_PROFILE_SCHEMA = "agent-mem.profile/v3";
export const PLACEMENT_SHARDS_SCHEMA = "agent-mem.shards/v3";
export const PLACEMENT_DESCRIPTOR_SCHEMA = "agent-mem.shard-sync/v3";
const FOREIGN_FORMAT = "agent-mem.public-prune-witness/v1", METADATA_MAX = 256 * 1024, WIRE_MAX = 64 * 1024, SOURCES_MAX = 20_000;

export class SyncPlacementFormatError extends Error {
  readonly code = "sync_placement_format";
  constructor() {
    super("Sync placement metadata is invalid, unsupported or exceeds its bound. Inspect the saved activation plan and use compatible writers before retrying.");
    this.name = "SyncPlacementFormatError";
  }
}
export interface PlacementProfile {
  schema: typeof PLACEMENT_PROFILE_SCHEMA; kind: "generation"; generation: string;
  foreignPruneFormat: typeof FOREIGN_FORMAT; pruneInputSetHash: string;
  publicationFormat: typeof PLACEMENT_FORMAT; placementHead: string;
}
export interface PlacementShardsFields {
  generation: string; phase: "active"; selectorRevision: string;
  sourceGeneration?: string; sources: SourcePrefix[]; machine: { id: string; label: string };
  legacyCommit?: string; deadLeasesRemoved?: { lease: string; at: string }[];
}
export interface PlacementShards extends PlacementShardsFields {
  schema: typeof PLACEMENT_SHARDS_SCHEMA; publicationFormat: typeof PLACEMENT_FORMAT; placementHead: string;
}
export interface PlacementBaseV2 {
  profile: { schema: "agent-mem.profile/v2"; kind: "generation"; generation: string; foreignPruneFormat: typeof FOREIGN_FORMAT; pruneInputSetHash: string };
  shards: PlacementShardsFields & { schema: "agent-mem.shards/v2" };
}
export type PlacementDescriptor = { schema: typeof PLACEMENT_DESCRIPTOR_SCHEMA; publicationFormat: typeof PLACEMENT_FORMAT }
  & ({ scope: "user" } | { scope: "project"; key: string });
export interface PlacementMarkers { profile: PlacementProfile; shards: PlacementShards }
const fail = (): never => { throw new SyncPlacementFormatError(); };
const hex = (value: unknown, width: number): value is string => typeof value === "string" && value.length === width && new RegExp(`^[a-f0-9]{${width}}$`).test(value);
const has = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return fail();
  const keys = Object.getOwnPropertyNames(value), allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size || required.some(key => !Object.hasOwn(value, key))) return fail();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.has(key) || !descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
    copy[key] = descriptor.value;
  }
  return copy;
}
function text(value: unknown, maximum = METADATA_MAX): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) return fail();
  return value;
}
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(); return value; }
function bounded<T>(value: T, maximum = METADATA_MAX): T { if (Buffer.byteLength(canonicalJSON(value) + "\n") > maximum) return fail(); return value; }
function list(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return fail();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Object.getOwnPropertyNames(value).length !== length + 1) return fail();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
    result.push(descriptor.value);
  }
  return result;
}
function sourcePrefixes(value: unknown): SourcePrefix[] {
  const result: SourcePrefix[] = [], seen = new Set<string>(); let bytes = 2;
  for (const input of list(value, SOURCES_MAX)) {
    const row = record(input, ["source", "path", "offset", "hash", "tailBytes"], ["commit", "stamp"]);
    if (typeof row.source !== "string" || !["legacy-local", "legacy-main", "generation"].includes(row.source)) return fail();
    const path = text(row.path);
    if (/^(log|local)\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.exec(path)?.[0] !== path || row.source === "legacy-main" && !path.startsWith("log/")) return fail();
    if (!hex(row.hash, 64) || (row.source === "legacy-main" ? !hex(row.commit, 40) : has(row, "commit"))) return fail();
    const source: SourcePrefix = { source: row.source, path, offset: integer(row.offset), hash: row.hash as string, tailBytes: integer(row.tailBytes) };
    if (has(row, "commit")) source.commit = row.commit as string;
    if (has(row, "stamp")) { source.stamp = text(row.stamp); if (source.stamp.length > 1024) return fail(); }
    const key = `${source.source}:${source.path}`; if (seen.has(key)) return fail(); seen.add(key);
    bytes += Buffer.byteLength(canonicalJSON(source)) + 1; if (bytes > METADATA_MAX) return fail(); result.push(source);
  }
  return result;
}
function shardFields(value: Record<string, unknown>, profile: { generation: string }): PlacementShardsFields {
  if (value.phase !== "active" || value.generation !== profile.generation || !hex(value.selectorRevision, 64)) return fail();
  const machine = record(value.machine, ["id", "label"]); if (!hex(machine.id, 16)) return fail();
  const result: PlacementShardsFields = { generation: profile.generation, phase: "active", selectorRevision: value.selectorRevision,
    sources: sourcePrefixes(value.sources), machine: { id: machine.id, label: text(machine.label) } };
  if (has(value, "sourceGeneration")) { if (value.sourceGeneration !== profile.generation) return fail(); result.sourceGeneration = profile.generation; }
  if (has(value, "legacyCommit")) { if (!hex(value.legacyCommit, 40)) return fail(); result.legacyCommit = value.legacyCommit; }
  if (has(value, "deadLeasesRemoved")) {
    const audits: { lease: string; at: string }[] = []; let bytes = 2;
    for (const input of list(value.deadLeasesRemoved, 128)) {
      const audit = record(input, ["lease", "at"]), lease = text(audit.lease), at = text(audit.at);
      if (/^[1-9][0-9]*-[a-f0-9]{64}\.json$/.exec(lease)?.[0] !== lease || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) return fail();
      const row = { lease, at }; bytes += Buffer.byteLength(canonicalJSON(row)) + 1; if (bytes > METADATA_MAX) return fail(); audits.push(row);
    }
    result.deadLeasesRemoved = audits;
  }
  return result;
}
function checked<T>(work: () => T): T { try { return work(); } catch { return fail(); } }
export function validatePlacementProfile(value: unknown): PlacementProfile {
  return checked<PlacementProfile>(() => {
    const row = record(value, ["schema", "kind", "generation", "foreignPruneFormat", "pruneInputSetHash", "publicationFormat", "placementHead"]);
    if (row.schema !== PLACEMENT_PROFILE_SCHEMA || row.kind !== "generation" || !hex(row.generation, 32) || row.foreignPruneFormat !== FOREIGN_FORMAT || !hex(row.pruneInputSetHash, 64) || row.publicationFormat !== PLACEMENT_FORMAT || !hex(row.placementHead, 64)) return fail();
    return bounded({ schema: PLACEMENT_PROFILE_SCHEMA, kind: "generation", generation: row.generation, foreignPruneFormat: FOREIGN_FORMAT,
      pruneInputSetHash: row.pruneInputSetHash, publicationFormat: PLACEMENT_FORMAT, placementHead: row.placementHead });
  });
}
export function validatePlacementShards(value: unknown, profile: PlacementProfile): PlacementShards {
  return checked<PlacementShards>(() => {
    const bound = validatePlacementProfile(profile), row = record(value, ["schema", "generation", "phase", "selectorRevision", "sources", "machine", "publicationFormat", "placementHead"], ["sourceGeneration", "legacyCommit", "deadLeasesRemoved"]);
    if (row.schema !== PLACEMENT_SHARDS_SCHEMA || row.publicationFormat !== PLACEMENT_FORMAT || row.placementHead !== bound.placementHead || row.selectorRevision !== hashJSON(bound)) return fail();
    return bounded({ ...shardFields(row, bound), schema: PLACEMENT_SHARDS_SCHEMA, publicationFormat: PLACEMENT_FORMAT, placementHead: bound.placementHead });
  });
}
export function validatePlacementDescriptor(value: unknown, expectedRealm?: ShardSyncRealm): PlacementDescriptor {
  return checked<PlacementDescriptor>(() => {
    const row = record(value, ["schema", "scope", "publicationFormat"], ["key"]);
    if (row.schema !== PLACEMENT_DESCRIPTOR_SCHEMA || row.publicationFormat !== PLACEMENT_FORMAT) return fail();
    let result: PlacementDescriptor;
    if (row.scope === "user" && !has(row, "key")) result = { schema: PLACEMENT_DESCRIPTOR_SCHEMA, scope: "user", publicationFormat: PLACEMENT_FORMAT };
    else if (row.scope === "project" && typeof row.key === "string" && row.key.length) result = { schema: PLACEMENT_DESCRIPTOR_SCHEMA, scope: "project", key: text(row.key, WIRE_MAX), publicationFormat: PLACEMENT_FORMAT };
    else return fail();
    if (expectedRealm !== undefined) {
      const expected = record(expectedRealm, ["scope"], ["key"]);
      if (expected.scope !== result.scope || result.scope === "user" && has(expected, "key") || result.scope === "project" && expected.key !== result.key) return fail();
    }
    return bounded(result, WIRE_MAX);
  });
}
export function validatePlacementBaseV2(profile: unknown, shards: unknown): PlacementBaseV2 {
  return checked<PlacementBaseV2>(() => {
    const p = record(profile, ["schema", "kind", "generation", "foreignPruneFormat", "pruneInputSetHash"]);
    if (p.schema !== "agent-mem.profile/v2" || p.kind !== "generation" || !hex(p.generation, 32) || p.foreignPruneFormat !== FOREIGN_FORMAT || !hex(p.pruneInputSetHash, 64)) return fail();
    const normalized: PlacementBaseV2["profile"] = { schema: "agent-mem.profile/v2", kind: "generation", generation: p.generation, foreignPruneFormat: FOREIGN_FORMAT, pruneInputSetHash: p.pruneInputSetHash };
    // Read imported constants inside the function: generation/shard guard imports may form a module cycle.
    const s = record(shards, ["schema", "generation", "phase", "selectorRevision", "sources", "machine"], SHARDED_V2_FIELDS.filter(key => !["schema", "generation", "phase", "selectorRevision", "sources", "machine"].includes(key)));
    if (s.schema !== "agent-mem.shards/v2" || s.selectorRevision !== hashJSON(normalized)) return fail();
    return { profile: bounded(normalized), shards: bounded({ ...shardFields(s, normalized), schema: "agent-mem.shards/v2" }) };
  });
}
/** Placement upgrade only. Shape/authority checks remain the responsibility of the exact marker-pair validator. */
export function validatePlacementVersionTransition(fromSchema: unknown, toSchema: unknown): void {
  const families = ["agent-mem.profile", "agent-mem.shards", "agent-mem.shard-sync"];
  for (const family of families) if (toSchema === `${family}/v3` && [1, 2, 3].some(version => fromSchema === `${family}/v${version}`)) return;
  fail();
}
export function validatePlacementMarkerTransition(oldProfile: unknown, oldShards: unknown, newProfile: unknown, newShards: unknown): PlacementMarkers {
  return checked<PlacementMarkers>(() => {
    const base = validatePlacementBaseV2(oldProfile, oldShards), profile = validatePlacementProfile(newProfile), shards = validatePlacementShards(newShards, profile);
    const { schema: _p, publicationFormat: _pf, placementHead: _ph, ...profileRest } = profile;
    const { schema: _bp, ...baseProfileRest } = base.profile;
    const { schema: _s, selectorRevision: _sr, publicationFormat: _sf, placementHead: _sh, ...shardsRest } = shards;
    const { schema: _bs, selectorRevision: _bsr, ...baseShardsRest } = base.shards;
    if (canonicalJSON(profileRest) !== canonicalJSON(baseProfileRest) || canonicalJSON(shardsRest) !== canonicalJSON(baseShardsRest)) return fail();
    return { profile, shards };
  });
}
function decode<T>(bytes: Uint8Array, maximum: number, validate: (value: unknown) => T): T {
  return checked(() => {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes)) return fail();
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const intrinsic = (key: string) => Object.getOwnPropertyDescriptor(prototype, key)!.get!.call(bytes);
    const size = intrinsic("byteLength") as number;
    if (!size || size > maximum) return fail();
    const view = new Uint8Array(intrinsic("buffer") as ArrayBuffer, intrinsic("byteOffset") as number, size);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(view), result = validate(JSON.parse(text));
    if (canonicalJSON(result) + "\n" !== text) return fail(); return result;
  });
}
export const decodePlacementProfile = (bytes: Uint8Array): PlacementProfile => decode(bytes, METADATA_MAX, validatePlacementProfile);
export const decodePlacementShards = (bytes: Uint8Array, profile: PlacementProfile): PlacementShards => decode(bytes, METADATA_MAX, value => validatePlacementShards(value, profile));
export const decodePlacementDescriptor = (bytes: Uint8Array, expectedRealm?: ShardSyncRealm): PlacementDescriptor => decode(bytes, WIRE_MAX, value => validatePlacementDescriptor(value, expectedRealm));
