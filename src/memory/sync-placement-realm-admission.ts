/**
 * Preview a same-epoch realm admission (#448 AC2-AC3).
 *
 * A report only: this module reads the activation, the extension chain, the writer history, the journal anchors and the
 * target realm's own source facts, and answers whether the realm could be appended and with which proofs. It writes
 * nothing, takes no fence and claims no effect authority; apply re-reads every one of these facts under the fence.
 *
 * The record it would append is the same shape activation produced for these realms, so a later reader needs no new
 * verification: an appended realm is indistinguishable from an activated one.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { previewSyncPlacementSources } from "./sync-placement-capture.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementWriterJournalAnchors } from "./sync-placement-journal-storage.ts";
import { readWriterHistory } from "./sync-placement-writer-history.ts";
import { writerInventoryGenesis } from "./sync-placement-writer-revision-format.ts";
import { readRealmExtensionHistory, type RealmExtensionBinding } from "./sync-placement-realm-extension-storage.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { readShardDescriptor, shardDir } from "./shard.ts";
import type { SyncPlacementRealmBinding } from "./sync-placement-plan.ts";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const empty = digest("");

/** `not-local` is a state both 0.28.2 and the #450 driver already report: no curated shard, so nothing to admit yet. */
export type RealmAdmissionState = "admissible" | "already-admitted" | "not-local" | "unavailable";
/** Everything the intent and record would pin; identifiers and hashes only, never a project key or a row. */
export interface RealmAdmissionNext {
  sequence: number; previousHash: string; previousLogBytes: number; previousLogHash: string;
  writerHash: string; journal: { sequence: number; headHash: string };
  bindingHash: string; sourceHash: string; aliasesHash: string; policyHash: string;
}
export interface RealmAdmissionPreview { realm: string; state: RealmAdmissionState; next?: RealmAdmissionNext }

export function previewRealmAdmission(home: string, project: string): RealmAdmissionPreview {
  const realm = digest(project);
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!active) throw new Error("sync placement is not active in this home; there is no inventory to admit a realm into");
  const epochHash = active.profile.placementHead, activationHash = active.activation.seal;
  const initialProjectHashes = active.activation.realms.flatMap(item => item.scope === "project" ? [item.keyHash] : []);
  // An admitted realm is read through the chain, so a realm that is already in force is reported, never appended again.
  // A chain that cannot be read (torn tail, rewritten log) cannot be previewed over either.
  let inForce: readonly SyncPlacementRealmBinding[];
  try { inForce = readEffectiveRealmInventory(home, active).realms; } catch { return { realm, state: "unavailable" }; }
  if (inForce.some(item => item.scope === "project" && item.keyHash === realm)) return { realm, state: "already-admitted" };
  const descriptor = readShardDescriptor(home, realm.slice(0, 16));
  if (!descriptor || digest(descriptor.key) !== realm || !existsSync(join(shardDir(home, descriptor.key), "generation.json")))
    return { realm, state: "not-local" };
  const binding: RealmExtensionBinding = { epochHash, activationHash, homeHash: active.epoch.homeHash,
    generation: active.epoch.generation, initialProjectHashes };
  let history: ReturnType<typeof readRealmExtensionHistory>;
  // Strict: an unattributed or torn chain is not something a preview may append over.
  try { history = readRealmExtensionHistory(home, binding); } catch { return { realm, state: "unavailable" }; }
  const source = previewSyncPlacementSources(home);
  const captured = source.base.realms.find(item => item.scope === "project" && item.keyHash === realm);
  if (!captured) return { realm, state: "unavailable" };
  const journal = readPlacementWriterJournalAnchors(home, epochHash);
  if (journal.epoch.homeHash !== active.epoch.homeHash || journal.activation.seal !== activationHash) return { realm, state: "unavailable" };
  const writers = readWriterHistory(home, { epochHash, activationHash, homeHash: active.epoch.homeHash, generation: active.epoch.generation });
  const writerHash = writers.commits.at(-1)?.seal ?? writerInventoryGenesis(epochHash, activationHash);
  const headHash = journal.sequence ? journal.records[journal.sequence - 1]!.seal : epochHash;
  // The facts and the anchors must still hold when the report leaves this function.
  source.assertSourcesUnchanged(); history.assertCurrent(); writers.assertCurrent();
  return { realm, state: "admissible", next: { sequence: history.records.length + 1, previousHash: history.headHash,
    previousLogBytes: history.logBytes.length, previousLogHash: history.logBytes.length ? digest(history.logBytes) : empty,
    writerHash, journal: { sequence: journal.sequence, headHash }, bindingHash: captured.bindingHash,
    sourceHash: source.base.sourceHash, aliasesHash: source.base.aliasesHash, policyHash: source.base.policyHash } };
}
