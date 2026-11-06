/** Internal activation-owner proof. No serialized object or boolean grants lock bypass authority. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { processSignature, realPath } from "./platform.ts";
import type { PlacementActivationMarkerSnapshot } from "./sync-placement-capture.ts";
import { readPlacementActivationIntent, validatePlacementActivationIntent, placementActivationFinalMarkers, type PlacementActivationIntent } from "./sync-placement-activation-storage.ts";

declare const ownerBrand: unique symbol, captureBrand: unique symbol;
export interface PlacementActivationOwner { readonly [ownerBrand]: true }
export interface PlacementActivationCaptureProof { readonly [captureBrand]: true }
interface Owner { home: string; mutation: MutationHandle; root: BigIntStats; lock: string; lockStamp: string }
const owners = new WeakMap<PlacementActivationOwner, Owner>();
const captures = new WeakMap<PlacementActivationCaptureProof, { owner: PlacementActivationOwner; intent: PlacementActivationIntent }>();
const stamp = (s: BigIntStats) => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
function fail(): never { throw Error("Sync placement activation ownership or retained evidence changed; close cooperating writers and run amem migrate --sync-placement --resume after person inspection."); }
function lockBytes(home: string): { text: string; stamp: string } {
  const file = join(home,"profile.lock"), before = lstatSync(file,{bigint:true});
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o077n) !== 0n || before.nlink !== 1n || before.size < 1n || before.size > 4096n) fail();
  const fd = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd,{bigint:true}); if (stamp(opened) !== stamp(before)) fail();
    const out = Buffer.alloc(Number(opened.size)); let at = 0;
    while (at < out.length) { const n = readSync(fd,out,at,out.length-at,at); if (!n) fail(); at += n; }
    if (stamp(fstatSync(fd,{bigint:true})) !== stamp(opened) || stamp(lstatSync(file,{bigint:true})) !== stamp(opened)) fail();
    return { text: new TextDecoder("utf-8",{fatal:true}).decode(out), stamp: stamp(opened) };
  } finally { closeSync(fd); }
}
export function createPlacementActivationOwner(homeInput: string, mutation: MutationHandle): PlacementActivationOwner {
  try {
    const home = realPath(homeInput); assertMutationHandle(mutation,home);
    const root = lstatSync(home,{bigint:true}), lock = lockBytes(home), value = JSON.parse(lock.text) as Record<string,unknown>;
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== BigInt(process.getuid?.() ?? -1) || (root.mode & 0o077n) !== 0n
      || Object.keys(value).sort().join() !== "pid,signature,token" || value.pid !== process.pid || value.signature !== processSignature(process.pid)
      || typeof value.signature !== "string" || !value.signature || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token)) fail();
    const token = Object.freeze({}) as PlacementActivationOwner;
    owners.set(token,{home,mutation,root,lock:lock.text,lockStamp:lock.stamp}); return token;
  } catch { return fail(); }
}
export function assertPlacementActivationOwner(token: PlacementActivationOwner): void {
  try {
    const owner = owners.get(token); if (!owner) fail(); assertMutationHandle(owner.mutation,owner.home);
    const root = lstatSync(owner.home,{bigint:true}), lock = lockBytes(owner.home);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== owner.root.dev || root.ino !== owner.root.ino || root.uid !== owner.root.uid || (root.mode & 0o077n) !== 0n
      || lock.text !== owner.lock || lock.stamp !== owner.lockStamp) fail();
    assertMutationHandle(owner.mutation,owner.home);
  } catch { fail(); }
}
export function createPlacementActivationCaptureProof(owner: PlacementActivationOwner, input: PlacementActivationIntent): PlacementActivationCaptureProof {
  assertPlacementActivationOwner(owner);
  const state = owners.get(owner)!;
  const intent = validatePlacementActivationIntent(input), actual = readPlacementActivationIntent(state.home);
  if (!intent || !actual || canonicalJSON(intent) !== canonicalJSON(actual)
    || actual.home !== state.home || actual.epoch.homeHash !== hashJSON([state.home,String(state.root.dev),String(state.root.ino),String(state.root.uid)])) fail();
  const token = Object.freeze({}) as PlacementActivationCaptureProof; captures.set(token,{owner,intent:actual}); return token;
}
export function activationSourceMarkers(token: PlacementActivationCaptureProof, home: string, markers: { profileText: string; shardsText: string; profileStamp: readonly string[]; shardsStamp: readonly string[] }): PlacementActivationMarkerSnapshot {
  const scope = captures.get(token); if (!scope) fail(); assertPlacementActivationOwner(scope.owner);
  const state = owners.get(scope.owner)!, actual = readPlacementActivationIntent(home), intent = scope.intent;
  if (home !== state.home || !actual || canonicalJSON(actual) !== canonicalJSON(intent)) fail();
  const { profileText, shardsText } = markers;
  const final = placementActivationFinalMarkers(intent), oldProfile = profileText === intent.previousProfile, oldShards = shardsText === intent.previousShards;
  if ((!oldProfile && profileText !== final.profile) || (!oldShards && shardsText !== final.shards) || !oldProfile && shardsText !== final.shards) fail();
  if (oldProfile && canonicalJSON(markers.profileStamp) !== canonicalJSON(intent.profileStamp) || oldShards && canonicalJSON(markers.shardsStamp) !== canonicalJSON(intent.shardsStamp)) fail();
  return { profileText:intent.previousProfile,shardsText:intent.previousShards,profileStamp:[...intent.profileStamp],shardsStamp:[...intent.shardsStamp] };
}
