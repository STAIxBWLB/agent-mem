/** Initial activation metadata only. Caller owns person authority, profile lock, writer inventory and source fences. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { validatePlacementBaseV2, validatePlacementShards, validatePlacementMarkerTransition, PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "./sync-placement-format.ts";
import { validatePlacementPlan, type SyncPlacementActivationPlan } from "./sync-placement-plan.ts";
import { validatePlacementEpoch, placementEpochHash, SyncPlacementJournalError, type PlacementEpoch, type SyncPlacementJournalErrorCode } from "./sync-placement-journal-format.ts";
import { writeImmutableActivationMetadata } from "./public-prune-activation.ts";
import { PLACEMENT_ACTIVATION_INTENT } from "./sync-placement-activation-path.ts";

export const PLACEMENT_ACTIVATION_INTENT_SCHEMA = "agent-mem.sync-placement-activation/v1";
export const PLACEMENT_ACTIVATION_INTENT_FILE = PLACEMENT_ACTIVATION_INTENT;
const MAX_BYTES = 1024 * 1024, ROOTS_MAX = 256;
export type PlacementActivationMarkerStamp = [string, string, string, string, string];
export interface PlacementActivationIntent {
  schema: typeof PLACEMENT_ACTIVATION_INTENT_SCHEMA; home: string; epoch: PlacementEpoch; plan: SyncPlacementActivationPlan; roots: string[];
  previousProfile: string; previousShards: string; profileStamp: PlacementActivationMarkerStamp; shardsStamp: PlacementActivationMarkerStamp; floorHash: string; seal: string;
}
export type PlacementActivationIntentBody = Omit<PlacementActivationIntent, "seal">;
export interface PlacementActivationStorageProof { mutation: MutationHandle; assertCurrent(): void }
function fail(code: SyncPlacementJournalErrorCode = "corrupt"): never { throw new SyncPlacementJournalError(code); }
const bytes = (value: unknown) => Buffer.from(canonicalJSON(value) + "\n");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown, length = 64): value is string => typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail("invalid");
  const fields = Object.getOwnPropertyDescriptors(value); if (Object.keys(fields).length !== keys.length) fail("invalid");
  const copied: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const field = fields[key]; if (!field || !("value" in field) || !field.enumerable) fail("invalid"); copied[key] = field.value; }
  return copied;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail("invalid");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail("bound");
  if (Object.getOwnPropertyNames(value).length !== length + 1) fail("invalid");
  const output: unknown[] = [];
  for (let i = 0; i < length; i++) { const field = Object.getOwnPropertyDescriptor(value, String(i)); if (!field || !("value" in field) || !field.enumerable) fail("invalid"); output.push(field.value); }
  return output;
}
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || Buffer.byteLength(value) > 4096 || value.includes("\0") || resolve(value) !== value) fail("invalid"); return value;
}
function markerStamp(value: unknown, text: string): PlacementActivationMarkerStamp {
  const fields = array(value, 5);
  if (fields.length !== 5 || fields.some((value, index) => typeof value !== "string" || value.length > 32 || !/^-?(?:0|[1-9][0-9]*)$/.test(value) || /[\r\n]/.test(value) || index < 3 && value.startsWith("-"))) fail("invalid");
  if (fields[2] !== String(Buffer.byteLength(text))) fail("invalid"); return fields as PlacementActivationMarkerStamp;
}
function baseMarkers(profile: unknown, shards: unknown) {
  if (typeof profile !== "string" || typeof shards !== "string" || Buffer.byteLength(profile) > 262144 || Buffer.byteLength(shards) > 262144) fail("bound");
  // Preserve original UTF-8 text/stamps, including whitespace/BOM; only the containing intent and final v3 pair
  // are canonical. Match the existing fatal UTF-8 marker decoder's BOM behavior without rewriting the source.
  const decode = (text: string) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text)));
  return validatePlacementBaseV2(decode(profile), decode(shards));
}
function validate(value: unknown, sealed: boolean): PlacementActivationIntent {
  const v = object(value, ["schema", "home", "epoch", "plan", "roots", "previousProfile", "previousShards", "profileStamp", "shardsStamp", "floorHash", ...(sealed ? ["seal"] : [])]);
  if (v.schema !== PLACEMENT_ACTIVATION_INTENT_SCHEMA || !hex(v.floorHash) || sealed && !hex(v.seal)) fail("invalid");
  const home = path(v.home), epoch = validatePlacementEpoch(v.epoch), plan = validatePlacementPlan(v.plan), base = baseMarkers(v.previousProfile, v.previousShards);
  const roots = array(v.roots, ROOTS_MAX).map(path); if (new Set(roots).size !== roots.length || canonicalJSON([...roots].sort()) !== canonicalJSON(roots)) fail("invalid");
  if (epoch.contextHash !== plan.contextHash || epoch.generation !== plan.generation || base.profile.generation !== epoch.generation || placementEpochHash(epoch) !== plan.targetProfile.placementHead
    || hashJSON(base.profile) !== plan.previousProfileHash || hashJSON(base.shards) !== plan.previousShardsHash) fail("invalid");
  const final = validatePlacementShards({ ...base.shards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(plan.targetProfile), publicationFormat: PLACEMENT_FORMAT, placementHead: plan.targetProfile.placementHead }, plan.targetProfile);
  validatePlacementMarkerTransition(base.profile, base.shards, plan.targetProfile, final); if (hashJSON(final) !== plan.targetShardsHash) fail("invalid");
  const body: PlacementActivationIntentBody = { schema: PLACEMENT_ACTIVATION_INTENT_SCHEMA, home, epoch, plan, roots, previousProfile: v.previousProfile as string, previousShards: v.previousShards as string,
    profileStamp: markerStamp(v.profileStamp, v.previousProfile as string), shardsStamp: markerStamp(v.shardsStamp, v.previousShards as string), floorHash: v.floorHash };
  const intent = { ...body, seal: hashJSON(body) }; if (sealed && intent.seal !== v.seal) fail("corrupt"); if (bytes(intent).length > MAX_BYTES) fail("bound"); return intent;
}
function safe<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SyncPlacementJournalError) {
      const field = Object.getOwnPropertyDescriptor(error, "code");
      if (field && "value" in field && ["invalid", "corrupt", "bound", "conflict", "pending", "changed", "authorization", "policy", "local", "busy"].includes(field.value)) fail(field.value);
    }
    return fail();
  }
}
export function sealPlacementActivationIntent(body: PlacementActivationIntentBody): PlacementActivationIntent { return safe(() => validate(body, false)); }
/** Detached data validation uses intent bounds, never policy-payload string limits. */
export function validatePlacementActivationIntent(value: unknown): PlacementActivationIntent { return safe(() => validate(value, true)); }
export function placementActivationFinalMarkers(value: PlacementActivationIntent): { profile: string; shards: string } {
  return safe(() => {
    const intent = validate(value, true), old = baseMarkers(intent.previousProfile, intent.previousShards);
    const shards = validatePlacementShards({ ...old.shards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(intent.plan.targetProfile), publicationFormat: PLACEMENT_FORMAT, placementHead: intent.plan.targetProfile.placementHead }, intent.plan.targetProfile);
    return { profile: canonicalJSON(intent.plan.targetProfile) + "\n", shards: canonicalJSON(shards) + "\n" };
  });
}
function owned(stat: BigIntStats, directory = false, links: readonly bigint[] = [1n]): void {
  if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (directory ? !stat.isDirectory() || (stat.mode & 0o077n) !== 0n : !stat.isFile() || (stat.mode & 0o777n) !== 0o600n || !links.includes(stat.nlink))) fail();
}
function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function root(home: string): { home: string; stat: BigIntStats; file: string } {
  const stat = lstatSync(home, { bigint: true }); owned(stat, true); const canonical = realPath(home), current = lstatSync(canonical, { bigint: true }); owned(current, true);
  if (stat.dev !== current.dev || stat.ino !== current.ino) fail("changed"); return { home: canonical, stat, file: join(canonical, PLACEMENT_ACTIVATION_INTENT_FILE) };
}
function bindHome(intent: PlacementActivationIntent, current: ReturnType<typeof root>): void {
  if (intent.home !== current.home || intent.epoch.homeHash !== hashJSON([current.home, String(current.stat.dev), String(current.stat.ino), String(current.stat.uid)])) fail("changed");
}
interface Read { intent: PlacementActivationIntent; text: string; stat: BigIntStats }
function read(current: ReturnType<typeof root>): Read | undefined {
  const before = lstatSync(current.file, { bigint: true, throwIfNoEntry: false }); if (!before) return undefined;
  owned(before, false, [1n, 2n]); if (before.size < 1n || before.size > BigInt(MAX_BYTES)) fail("bound");
  const fd = openSync(current.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened, false, [1n, 2n]); if (!same(before, opened)) fail("changed");
    const data = Buffer.alloc(Number(opened.size) + 1); let at = 0;
    while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (!n) break; at += n; }
    if (at !== Number(opened.size) || !same(opened, fstatSync(fd, { bigint: true })) || !same(opened, lstatSync(current.file, { bigint: true }))) fail("changed");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, at)), intent = validate(JSON.parse(text), true);
    if (canonicalJSON(intent) + "\n" !== text) fail(); bindHome(intent, current);
    if (opened.nlink === 2n) {
      const companion = lstatSync(current.file + ".pending-" + digest(Buffer.from(text)), { bigint: true }); owned(companion, false, [2n]);
      if (!same(opened, companion) || !same(opened, lstatSync(current.file, { bigint: true }))) fail("changed");
    }
    const finalRoot = root(current.home); if (finalRoot.stat.dev !== current.stat.dev || finalRoot.stat.ino !== current.stat.ino) fail("changed");
    return { intent, text, stat: opened };
  } finally { closeSync(fd); }
}
export function readPlacementActivationIntent(home: string): PlacementActivationIntent | undefined { return safe(() => read(root(home))?.intent); }
function proof(current: ReturnType<typeof root>, options: PlacementActivationStorageProof): void {
  try { assertMutationHandle(options.mutation, current.home); } catch { fail("busy"); }
  try { options.assertCurrent(); } catch { fail("changed"); }
  try { assertMutationHandle(options.mutation, current.home); } catch { fail("busy"); }
  const now = root(current.home); if (now.stat.dev !== current.stat.dev || now.stat.ino !== current.stat.ino) fail("changed");
}
function syncHome(current: ReturnType<typeof root>, options: PlacementActivationStorageProof): void {
  proof(current, options); const fd = openSync(current.home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd, { bigint: true }); owned(stat, true); if (stat.dev !== current.stat.dev || stat.ino !== current.stat.ino) fail("changed"); proof(current, options); fsyncSync(fd); }
  finally { closeSync(fd); } proof(current, options);
}
export function writePlacementActivationIntent(home: string, value: PlacementActivationIntent, options: PlacementActivationStorageProof): void {
  safe(() => {
    const current = root(home), intent = validate(value, true); bindHome(intent, current); const expected = canonicalJSON(intent) + "\n";
    proof(current, options); const prior = read(current); if (prior && prior.text !== expected) fail("conflict");
    proof(current, options);
    // The shared helper intentionally keeps its old algorithm; bound its unregistered staging read here first.
    const temp = lstatSync(current.file + ".pending-" + digest(Buffer.from(expected)), { bigint: true, throwIfNoEntry: false });
    if (temp) { owned(temp, false, prior?.stat.nlink === 2n ? [2n] : [1n]); if (temp.size > BigInt(MAX_BYTES)) fail("bound"); }
    writeImmutableActivationMetadata(current.file, expected); proof(current, options);
    const installed = read(current); if (!installed || installed.stat.nlink !== 1n || installed.text !== expected) fail("changed");
    const fd = openSync(current.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!same(installed.stat, fstatSync(fd, { bigint: true }))) fail("changed"); proof(current, options); if (!same(installed.stat, lstatSync(current.file, { bigint: true }))) fail("changed"); fsyncSync(fd); }
    finally { closeSync(fd); } syncHome(current, options); proof(current, options);
    if (read(current)?.text !== expected) fail("changed");
  });
}
export function clearPlacementActivationIntent(home: string, value: PlacementActivationIntent, options: PlacementActivationStorageProof): void {
  safe(() => {
    const current = root(home), intent = validate(value, true); bindHome(intent, current); proof(current, options);
    const prior = read(current);
    if (prior) {
      if (prior.text !== canonicalJSON(intent) + "\n") fail("conflict"); if (prior.stat.nlink !== 1n) fail("pending");
      proof(current, options); if (!same(prior.stat, lstatSync(current.file, { bigint: true }))) fail("changed"); unlinkSync(current.file);
    }
    syncHome(current, options); proof(current, options); if (lstatSync(current.file, { throwIfNoEntry: false })) fail("changed");
  });
}
