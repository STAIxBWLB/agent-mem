import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { types } from "node:util";
/** Closed activation metadata admits v3 readers; publication still requires full journal/source/policy proof. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { LOCAL_METADATA_MAX_BYTES, legacyProfileMarkerShape, type BoundProfile } from "./generation.ts";
import { legacyShardMarkerShape } from "./shard.ts";
import { PLACEMENT_PROFILE_SCHEMA, PLACEMENT_SHARDS_SCHEMA, validatePlacementProfile, validatePlacementShards } from "./sync-placement-format.ts";
import { PLACEMENT_ACTIVATION_INTENT } from "./sync-placement-activation-path.ts";

export const PLACEMENT_STAGE1_REFUSAL = "sync placement v3 requires matching durable activation metadata; keep the current compatible profile active until person-authorized activation is complete";
export const PLACEMENT_MARKER_REFUSAL = "sync placement metadata is invalid or unsupported; person inspection and a compatible reader are required before continuing";
export const PLACEMENT_ACTIVATION_PENDING = "sync placement activation is pending or incomplete; have the person inspect retained evidence and run amem migrate --sync-placement --resume";
export class SyncPlacementRuntimeError extends Error {
  readonly code: "sync_placement_not_enabled" | "sync_placement_unavailable";
  constructor(reason: string) { super(reason); this.name = "SyncPlacementRuntimeError"; this.code = reason === PLACEMENT_STAGE1_REFUSAL ? "sync_placement_not_enabled" : "sync_placement_unavailable"; }
}
class MarkerChanged extends Error {}
const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
function readMarker(file: string): unknown | undefined {
  for (let attempt = 0; attempt < 6; attempt++) {
    let fd: number | undefined;
    try {
      const before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (!before) return undefined;
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(LOCAL_METADATA_MAX_BYTES)) throw new SyncPlacementRuntimeError(PLACEMENT_MARKER_REFUSAL);
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd, { bigint: true });
      if (!same(before, opened)) throw new MarkerChanged();
      const bytes = Buffer.alloc(Number(opened.size) + 1); let count = 0;
      while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
      const after = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (count !== Number(opened.size) || !same(opened, after) || !named || named.isSymbolicLink() || !same(opened, named)) throw new MarkerChanged();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)));
    } catch (error) { if (error instanceof MarkerChanged && attempt < 5) continue; throw new SyncPlacementRuntimeError(PLACEMENT_MARKER_REFUSAL); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  throw new SyncPlacementRuntimeError(PLACEMENT_MARKER_REFUSAL);
}
export function readPlacementRuntimeMarkers(home: string): { profile: unknown | undefined; shards: unknown | undefined } {
  return { profile: readMarker(join(home, "profile.json")), shards: readMarker(join(home, "shards.json")) };
}
function schema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, "schema")?.value;
}
function plainMarker(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getOwnPropertySymbols(value).length) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(field => "value" in field && field.enumerable);
}
/** Pure dispatch, so generation's active selector reader need not recursively call readSelector. */
export function placementMarkerRefusal(profile: unknown, shards: unknown): string | undefined {
  if (!plainMarker(profile) || !plainMarker(shards)) return PLACEMENT_MARKER_REFUSAL;
  if (schema(profile) === PLACEMENT_PROFILE_SCHEMA || schema(shards) === PLACEMENT_SHARDS_SCHEMA) {
    try { validatePlacementShards(shards, validatePlacementProfile(profile)); }
    catch { return PLACEMENT_MARKER_REFUSAL; }
    return PLACEMENT_STAGE1_REFUSAL;
  }
  if (!legacyProfileMarkerShape(profile) || !legacyShardMarkerShape(shards)) return PLACEMENT_MARKER_REFUSAL;
  return undefined;
}
/** Selector preflight only recognizes v3. Legacy malformed/split metadata must retain its existing reader/recovery path. */
// This narrow probe is not a data/transport gate; effects must still use the full runtime guard.
export function placementSelectorRefusal(home: string): string | undefined {
  // A durable placement fence forbids falling back to raw legacy sync after marker rollback.
  const fenced = placementFencePresent(home);
  const pending = placementActivationPending(home);
  let profile: unknown, shards: unknown;
  try { profile = readMarker(join(home, "profile.json")); } catch { /* The original selector reader reports this legacy failure. */ }
  try { shards = readMarker(join(home, "shards.json")); } catch { /* Ordinary migration still owns malformed split-state recovery. */ }
  if (schema(profile) !== PLACEMENT_PROFILE_SCHEMA && schema(shards) !== PLACEMENT_SHARDS_SCHEMA) return pending ? PLACEMENT_ACTIVATION_PENDING : fenced ? PLACEMENT_MARKER_REFUSAL : undefined;
  const refusal = placementMarkerRefusal(profile, shards);
  if (refusal !== PLACEMENT_STAGE1_REFUSAL) return pending ? PLACEMENT_ACTIVATION_PENDING : refusal;
  try { return readActivePlacementBinding(home, profile, shards) ? undefined : pending ? PLACEMENT_ACTIVATION_PENDING : refusal; } catch { return PLACEMENT_MARKER_REFUSAL; }
}
function placementActivationPending(home: string): boolean {
  return lstatSync(join(home,PLACEMENT_ACTIVATION_INTENT),{throwIfNoEntry:false}) !== undefined;
}
function placementFencePresent(home: string): boolean {
  const root = lstatSync(join(home, "sync-placement"), { throwIfNoEntry: false });
  if (!root) return false;
  if (root.isSymbolicLink() || !root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) return true;
  return lstatSync(join(home, "sync-placement", "active.json"), { throwIfNoEntry: false }) !== undefined;
}
/** Bounded activation/view metadata only; no data/index open, cache mutation, lock or child/network call.
 * The v3 publication coordinator separately proves the complete journal, selected sources and policy. */
export function placementRuntimeRefusal(home: string, bound?: Pick<BoundProfile,"kind"|"sharded"|"generation"|"publicationFormat"|"placementHead">): string | undefined {
  try { const fenced = placementFencePresent(home), pending = placementActivationPending(home), markers = readPlacementRuntimeMarkers(home);
    const refusal = placementMarkerRefusal(markers.profile, markers.shards);
    if (refusal === PLACEMENT_STAGE1_REFUSAL) {
      const active=readActivePlacementBinding(home,markers.profile,markers.shards);
      if(!active)return pending ? PLACEMENT_ACTIVATION_PENDING : refusal;
      if(bound && (bound.kind!=="generation"||bound.sharded!==true||bound.generation!==active.profile.generation||bound.publicationFormat!==active.profile.publicationFormat||bound.placementHead!==active.profile.placementHead)) return PLACEMENT_MARKER_REFUSAL;
      return undefined;
    }
    return refusal ?? (pending ? PLACEMENT_ACTIVATION_PENDING : fenced ? PLACEMENT_MARKER_REFUSAL : undefined); }
  catch { return PLACEMENT_MARKER_REFUSAL; }
}
export function assertPlacementRuntime(home: string): void {
  const refusal = placementRuntimeRefusal(home); if (refusal) throw new SyncPlacementRuntimeError(refusal);
}
