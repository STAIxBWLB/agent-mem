/** Metadata-only v3 admission. Publication still requires the complete journal/source/policy proof. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { validatePlacementProfile, validatePlacementShards, type PlacementProfile, type PlacementShards } from "./sync-placement-format.ts";
import { validatePlacementPlan, type SyncPlacementActivationPlan } from "./sync-placement-plan.ts";
import { placementEpochHash, validatePlacementEpoch, validatePlacementActiveFence, type PlacementEpoch } from "./sync-placement-journal-format.ts";
import { readPublicPruneViewForActivation } from "./public-prune-view.ts";
import { readPublicPruneInputSetChain } from "./public-prune-input-chain.ts";
import { shardDir, userShardDir } from "./shard.ts";

export interface ActivePlacementBinding { profile: PlacementProfile; shards: PlacementShards; epoch: PlacementEpoch; activation: SyncPlacementActivationPlan }
function fail(): never { throw new Error("sync placement activation metadata unavailable or changed; inspect the retained activation before continuing"); }
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function owned(s: BigIntStats, directory = false): void {
  if (s.uid !== BigInt(process.getuid?.() ?? -1) || (s.mode & 0o077n) !== 0n || s.isSymbolicLink()
    || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n)) fail();
}
/** Initial activation commitments remain authoritative; maintenance may only grow the same-generation prune view. */
export function assertPlacementViewAdvance(home: string, activation: SyncPlacementActivationPlan, profile: PlacementProfile, shards: PlacementShards): void {
  const initial = activation.targetProfile;
  const { pruneInputSetHash: _old, ...before } = initial, { pruneInputSetHash: _next, ...after } = profile;
  if (canonicalJSON(before) !== canonicalJSON(after)) fail();
  const initialShards = { ...shards, selectorRevision: hashJSON(initial) };
  if (hashJSON(initialShards) !== activation.targetShardsHash) fail();
  if (initial.pruneInputSetHash === profile.pruneInputSetHash) return;
  const oldView = readPublicPruneViewForActivation(home, initial.pruneInputSetHash, profile.generation);
  const nextView = readPublicPruneViewForActivation(home, profile.pruneInputSetHash, profile.generation);
  if (!Object.keys(oldView.realms).every(key => Object.hasOwn(nextView.realms, key))) fail();
  for (const [key, hash] of Object.entries(nextView.realms)) {
    const old = oldView.realms[key]; if (old === hash) continue;
    const dir = key === "user" ? userShardDir(home) : shardDir(home, key.slice(8));
    const chain = readPublicPruneInputSetChain({ dir, receivingGeneration: profile.generation, inputSetHash: hash });
    if (old !== undefined && !chain.commitments.includes(old)) fail();
  }
}
/** No mutation/reader registration/index open. Missing preparation is distinct from malformed retained evidence. */
export function readActivePlacementBinding(homeInput: string, profileInput: unknown, shardsInput: unknown): ActivePlacementBinding | undefined {
  const profile = validatePlacementProfile(profileInput), shards = validatePlacementShards(shardsInput, profile);
  const home = realPath(homeInput), root = lstatSync(home, { bigint: true }); owned(root, true);
  const checks: (() => void)[] = [() => { const now = lstatSync(home, { bigint: true }); owned(now, true); if (now.dev !== root.dev || now.ino !== root.ino) fail(); }];
  const directory = (dir: string): boolean => {
    const s = lstatSync(dir, { bigint: true, throwIfNoEntry: false }); if (!s) return false; owned(s, true);
    checks.push(() => { const now = lstatSync(dir, { bigint: true }); owned(now, true); if (s.dev !== now.dev || s.ino !== now.ino) fail(); }); return true;
  };
  const read = (file: string): { value: unknown; text: string } | undefined => {
    const before = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (!before) return undefined;
    owned(before); if (before.size <= 0n || before.size > 262144n) fail();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd, { bigint: true }); owned(s); if (!same(before, s)) fail();
      const bytes = Buffer.alloc(Number(s.size) + 1); let at = 0;
      while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) break; at += n; }
      if (at !== Number(s.size) || !same(s, fstatSync(fd, { bigint: true })) || !same(s, lstatSync(file, { bigint: true }))) fail();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, at)), value: unknown = JSON.parse(text);
      if (canonicalJSON(value) + "\n" !== text) fail();
      checks.push(() => { const now = lstatSync(file, { bigint: true }); owned(now); if (!same(s, now)) fail(); }); return { value, text };
    } finally { closeSync(fd); }
  };
  if (!directory(join(home, "sync-placement")) || !directory(join(home, "sync-placement", "epochs"))) return undefined;
  const dir = join(home, "sync-placement", "epochs", profile.placementHead);
  if (!directory(dir)) return undefined;
  const epochFile = read(join(dir, "epoch.json")), activationFile = read(join(dir, "activation.json")), fenceFile = read(join(home, "sync-placement", "active.json"));
  if (!epochFile || !activationFile || !fenceFile) return undefined;
  const epoch = validatePlacementEpoch(epochFile.value), activation = validatePlacementPlan(activationFile.value), fence = validatePlacementActiveFence(fenceFile.value);
  const homeHash = hashJSON([home, String(root.dev), String(root.ino), String(root.uid)]);
  if (epoch.homeHash !== homeHash || epoch.generation !== profile.generation || placementEpochHash(epoch) !== profile.placementHead
    || activation.contextHash !== epoch.contextHash || activation.generation !== epoch.generation || activation.targetProfile.placementHead !== profile.placementHead
    || fence.epochHash !== profile.placementHead || fence.homeHash !== homeHash || fence.generation !== profile.generation) fail();
  if (read(join(home, "profile.json"))?.text !== canonicalJSON(profile) + "\n" || read(join(home, "shards.json"))?.text !== canonicalJSON(shards) + "\n") fail();
  assertPlacementViewAdvance(home, activation, profile, shards);
  for (const check of checks) check();
  return { profile, shards, epoch, activation };
}
