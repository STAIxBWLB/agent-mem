import { types } from "node:util";
import { canonicalJSON, hashJSON, LOCAL_METADATA_MAX_BYTES } from "./generation.ts";
import {
  PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA, PLACEMENT_SHARDS_SCHEMA,
  validatePlacementBaseV2, validatePlacementProfile, validatePlacementShards, validatePlacementMarkerTransition,
  type PlacementProfile,
} from "./sync-placement-format.ts";

// ponytail: each preview inventory caps writers/realms at 256; larger inventories need a reviewed chunked-plan format before this ceiling is raised.
const INVENTORY_MAX = 256;
export const PLACEMENT_ACTIVATION_PLAN_SCHEMA = "agent-mem.sync-placement-activation-plan/v1";
export interface SyncPlacementWriterAttestation {
  writerId: string; version: string; pin: string; publicationFormat: typeof PLACEMENT_FORMAT; compatible: true;
}
export type SyncPlacementRealmBinding = { scope: "user"; bindingHash: string }
  | { scope: "project"; keyHash: string; bindingHash: string };
/** Data-only capture port. Stage 2 must obtain these facts from authoritative inputs again before any effect. */
export interface SyncPlacementActivationContext {
  profile: unknown; shards: unknown;
  homeHash: string; sourceHash: string; aliasesHash: string; policyHash: string;
  realms: readonly SyncPlacementRealmBinding[];
  writers: readonly SyncPlacementWriterAttestation[];
  legacySyncQuiesced: true;
}
export interface SyncPlacementActivationPlan {
  schema: typeof PLACEMENT_ACTIVATION_PLAN_SCHEMA; generation: string; contextHash: string;
  previousProfileHash: string; previousShardsHash: string; targetProfile: PlacementProfile; targetShardsHash: string;
  realms: SyncPlacementRealmBinding[]; writers: SyncPlacementWriterAttestation[]; legacySyncQuiesced: true; seal: string;
}
export interface SyncPlacementPersonAuthorization {
  current(): SyncPlacementActivationContext;
  /** The host authenticates person intent. Neither this callback's binding nor an actor/session string authenticates a caller. */
  authorize(binding: Readonly<{ seal: string; generation: string; homeHash: string }>): boolean;
}
export type SyncPlacementPlanErrorCode = "invalid" | "bound" | "base" | "attestation" | "authorization" | "changed";
const messages: Record<SyncPlacementPlanErrorCode, string> = {
  invalid: "sync placement plan is invalid; create and review a new complete plan before continuing",
  bound: "sync placement plan exceeds supported metadata bounds; use a supported bounded migration before continuing",
  base: "sync placement activation requires an active v2 public-prune shard base; run the person-authorized migrations first",
  attestation: "sync placement activation requires compatible exact-pinned writers and quiesced legacy sync; upgrade and attest every sharing writer first",
  authorization: "sync placement activation validation requires explicit person authorization; review the plan through an authenticated person port",
  changed: "sync placement activation bindings changed or are unavailable; capture and review a fresh plan before continuing",
};
export class SyncPlacementPlanError extends Error {
  constructor(readonly code: SyncPlacementPlanErrorCode) { super(messages[code]); this.name = "SyncPlacementPlanError"; }
}
const fail = (code: SyncPlacementPlanErrorCode = "invalid"): never => { throw new SyncPlacementPlanError(code); };
const hex = (value: unknown, length = 64): value is string => typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== keys.length || keys.some(key => !Object.hasOwn(fields, key))) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key]!;
    if (!("value" in field) || !field.enumerable) return fail();
    result[key] = field.value;
  }
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > INVENTORY_MAX || Object.getOwnPropertySymbols(value).length) return fail("bound");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== value.length + 1) return fail();
  const result: unknown[] = [];
  for (let at = 0; at < value.length; at++) {
    const field = fields[String(at)];
    if (!field || !("value" in field) || !field.enumerable) return fail();
    result.push(field.value);
  }
  return result;
}
function bounded(value: unknown): void { if (Buffer.byteLength(canonicalJSON(value)) > LOCAL_METADATA_MAX_BYTES) fail("bound"); }
function realms(value: unknown): SyncPlacementRealmBinding[] {
  const result = list(value).map(item => {
    // Inspect scope without invoking a getter before selecting its closed shape.
    if (!item || typeof item !== "object" || types.isProxy(item)) return fail();
    const scope = Object.getOwnPropertyDescriptor(item, "scope")?.value;
    const row = object(item, scope === "user" ? ["scope", "bindingHash"] : ["scope", "keyHash", "bindingHash"]);
    if (!hex(row.bindingHash)) return fail();
    if (row.scope === "user") return { scope: "user" as const, bindingHash: row.bindingHash };
    if (row.scope !== "project" || !hex(row.keyHash)) return fail();
    return { scope: "project" as const, keyHash: row.keyHash, bindingHash: row.bindingHash };
  });
  const key = (row: SyncPlacementRealmBinding) => row.scope === "user" ? "user" : `project:${row.keyHash}`;
  result.sort((a,b) => key(a).localeCompare(key(b)));
  if (new Set(result.map(key)).size !== result.length) return fail();
  return result;
}
function writers(value: unknown): SyncPlacementWriterAttestation[] {
  const result = list(value).map(item => {
    const row = object(item, ["writerId", "version", "pin", "publicationFormat", "compatible"]);
    if (!hex(row.writerId) || !hex(row.pin) || typeof row.version !== "string" || row.version.length > 64
      || /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(row.version)?.[0] !== row.version
      || row.publicationFormat !== PLACEMENT_FORMAT || row.compatible !== true) return fail("attestation");
    return { writerId: row.writerId, version: row.version, pin: row.pin, publicationFormat: PLACEMENT_FORMAT as typeof PLACEMENT_FORMAT, compatible: true as const };
  }).sort((a,b) => a.writerId.localeCompare(b.writerId));
  if (!result.length || new Set(result.map(row => row.writerId)).size !== result.length) return fail("attestation");
  return result;
}
function context(value: unknown) {
  const row = object(value, ["profile", "shards", "homeHash", "sourceHash", "aliasesHash", "policyHash", "realms", "writers", "legacySyncQuiesced"]);
  let base: ReturnType<typeof validatePlacementBaseV2>;
  try { base = validatePlacementBaseV2(row.profile, row.shards); } catch { return fail("base"); }
  if (![row.homeHash, row.sourceHash, row.aliasesHash, row.policyHash].every(value => hex(value))) return fail();
  if (row.legacySyncQuiesced !== true) return fail("attestation");
  const result = { profile: base.profile, shards: base.shards, homeHash: row.homeHash as string, sourceHash: row.sourceHash as string,
    aliasesHash: row.aliasesHash as string, policyHash: row.policyHash as string, realms: realms(row.realms), writers: writers(row.writers), legacySyncQuiesced: true as const };
  bounded(result); return result;
}
/** Pure preview builder. A sealed data plan is not a bearer capability and performs no activation. */
export function planSyncPlacementActivation(input: SyncPlacementActivationContext, placementHead: string): SyncPlacementActivationPlan {
  const before = context(input);
  if (!hex(placementHead)) return fail();
  const targetProfile = validatePlacementProfile({ ...before.profile, schema: PLACEMENT_PROFILE_SCHEMA, publicationFormat: PLACEMENT_FORMAT, placementHead });
  const targetShards = validatePlacementShards({ ...before.shards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(targetProfile), publicationFormat: PLACEMENT_FORMAT, placementHead }, targetProfile);
  validatePlacementMarkerTransition(before.profile, before.shards, targetProfile, targetShards);
  const body: Omit<SyncPlacementActivationPlan, "seal"> = { schema: PLACEMENT_ACTIVATION_PLAN_SCHEMA, generation: targetProfile.generation, contextHash: hashJSON(before),
    previousProfileHash: hashJSON(before.profile), previousShardsHash: hashJSON(before.shards), targetProfile, targetShardsHash: hashJSON(targetShards),
    realms: before.realms, writers: before.writers, legacySyncQuiesced: true as const };
  const plan = { ...body, seal: hashJSON(body) }; bounded(plan); return plan;
}
/** Validate only the closed plan/seal. Source/authentication facts must be re-proved through the port below. */
export function validatePlacementPlan(value: unknown): SyncPlacementActivationPlan {
  const row = object(value, ["schema", "generation", "contextHash", "previousProfileHash", "previousShardsHash", "targetProfile", "targetShardsHash", "realms", "writers", "legacySyncQuiesced", "seal"]);
  if (row.schema !== PLACEMENT_ACTIVATION_PLAN_SCHEMA || !hex(row.generation, 32)
    || ![row.contextHash, row.previousProfileHash, row.previousShardsHash, row.targetShardsHash, row.seal].every(value => hex(value)) || row.legacySyncQuiesced !== true) return fail();
  let targetProfile: PlacementProfile;
  try { targetProfile = validatePlacementProfile(row.targetProfile); } catch { return fail(); }
  if (targetProfile.generation !== row.generation) return fail();
  const body: Omit<SyncPlacementActivationPlan, "seal"> = { schema: PLACEMENT_ACTIVATION_PLAN_SCHEMA, generation: row.generation, contextHash: row.contextHash as string,
    previousProfileHash: row.previousProfileHash as string, previousShardsHash: row.previousShardsHash as string, targetProfile,
    targetShardsHash: row.targetShardsHash as string, realms: realms(row.realms), writers: writers(row.writers), legacySyncQuiesced: true as const };
  if (hashJSON(body) !== row.seal) return fail();
  const plan = { ...body, seal: row.seal as string }; bounded(plan); return plan;
}
/** Person-port validation only: activated:false is intentional. No marker, journal, transport or filesystem effect exists in stage 1. */
export function validateSyncPlacementActivation(value: unknown, port: SyncPlacementPersonAuthorization): { validated: true; activated: false; plan: SyncPlacementActivationPlan } {
  const plan = validatePlacementPlan(value);
  let callbacks: Record<string, unknown>;
  try { callbacks = object(port, ["current", "authorize"]); } catch { return fail("authorization"); }
  if (typeof callbacks.current !== "function" || typeof callbacks.authorize !== "function") return fail("authorization");
  const current = () => { try { return context((callbacks.current as () => unknown)()); } catch { return fail("changed"); } };
  const before = current(), expected = planSyncPlacementActivation(before, plan.targetProfile.placementHead);
  if (canonicalJSON(expected) !== canonicalJSON(plan)) return fail("changed");
  const binding = Object.freeze({ seal: plan.seal, generation: plan.generation, homeHash: before.homeHash });
  let authorized = false;
  try { authorized = (callbacks.authorize as (scope: typeof binding) => unknown)(binding) === true; } catch { return fail("authorization"); }
  if (!authorized) return fail("authorization");
  if (canonicalJSON(current()) !== canonicalJSON(before)) return fail("changed");
  return { validated: true, activated: false, plan };
}
/** Byte-bound and canonical framing precede parsing; the result still grants no effect authority. */
export function decodePlacementPlan(bytes: Uint8Array): SyncPlacementActivationPlan {
  try {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes)) return fail();
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const intrinsic = (key: string) => Object.getOwnPropertyDescriptor(prototype, key)!.get!.call(bytes);
    const size = intrinsic("byteLength") as number;
    if (size > LOCAL_METADATA_MAX_BYTES) return fail("bound");
    const view = new Uint8Array(intrinsic("buffer") as ArrayBuffer, intrinsic("byteOffset") as number, size);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(view);
    const plan = validatePlacementPlan(JSON.parse(text));
    if (canonicalJSON(plan) + "\n" !== text) return fail();
    return plan;
  } catch (error) {
    if (error instanceof SyncPlacementPlanError) throw error;
    return fail();
  }
}
