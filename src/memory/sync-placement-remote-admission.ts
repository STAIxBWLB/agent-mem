/** Explicit remote realm adoption, staged before the existing same-epoch admission. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realPath } from "./platform.ts";
import { assertMutationHandle } from "./mutation.ts";
import { shardDir } from "./shard.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { PLACEMENT_PROFILE_SCHEMA, SyncPlacementFormatError } from "./sync-placement-format.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { readRealmIntent } from "./sync-placement-realm-intent-storage.ts";
import { readPlacementWriterJournalAnchors, placementWriterJournalToken } from "./sync-placement-journal-storage.ts";
import { resolvePlacementWindow } from "./sync-placement-checkpoint-storage.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";
import { readEffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { pendingRealmInventory } from "./sync-placement-realm-pending.ts";
import { placementFenceDirectories } from "./sync-placement-writer-renewal.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
import { PlacementInventoryFenceError, withPlacementMutationFences } from "./sync-placement-activation-locks.ts";
import { assertPlacementActivationOwner } from "./sync-placement-activation-proof.ts";
import { previewOwnedSyncPlacementSources } from "./sync-placement-capture.ts";
import { activePlacementWriterContext } from "../sync-placement-writer-context.ts";
import { applyRealmAdmission, planRealmAbandon, previewRealmAdmission, RealmAdmissionError } from "./sync-placement-realm-admission.ts";
import { SharedWriterRevisionError } from "./sync-placement-writer-revision-format.ts";
import { assertRemoteAdoptionCurrent, prepareRemotePlacementRealm, recoverRemoteStagedPacks } from "./sync-placement-transport.ts";
import { assertRemoteAdoptionStageOwnership, clearRemoteAdoption, clearRemoteAdoptionPending, discardRemoteInstalledLog, inspectRemoteAdoptionPending, installRemoteAdoptionLog,
  pendingRemoteAdoptions, readRemoteAdoption, remoteAdoptionLogMayBeInstalled, stageRemoteAdoption, writeRemoteAdoption } from "./sync-placement-remote-stage.ts";
import type { RemoteAdoption } from "./sync-placement-remote-adoption-format.ts";
import type { SyncOptions } from "./sync.ts";
import { RemoteRealmRefusal, type RemoteRealmCause } from "./sync-placement-remote-refusal.ts";

export type RemoteAdmissionMode = "dry-run" | "apply" | "resume" | "abandon";
export interface RemoteAdmissionOptions extends Pick<SyncOptions, "signal" | "visibility"> {
  mode: RemoteAdmissionMode; confirm?: boolean;
  /** Internal crash seam; never supplied by the CLI. */
  checkpoint?(stage: "after-preview" | "after-companion" | "after-stage" | "after-install" | "after-intent" | "after-metadata" | "after-proof" | "after-append" | "after-admission"): void | Promise<void>;
}
export interface RemoteAdmissionResult {
  state: "preview" | "admitted" | "already-admitted" | "retained" | "abandoned";
  realm: string; remoteHead?: string; omitted?: number; staged?: number; nextStep?: string;
}
const unavailable = (cause: RemoteRealmCause = "other"): never => { throw new RemoteRealmRefusal(cause); };
const keyOf = (project: string) => createHash("sha256").update(project).digest("hex");
function active(home: string, keyHash: string): boolean {
  const markers = readPlacementRuntimeMarkers(home);
  if (!markers.profile || typeof markers.profile !== "object" || Object.getOwnPropertyDescriptor(markers.profile, "schema")?.value !== PLACEMENT_PROFILE_SCHEMA) return unavailable("epoch");
  const binding = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!binding) return unavailable("epoch");
  const inventory = readEffectiveRealmInventory(home, binding), present = inventory.realms.some(realm => realm.scope === "project" && realm.keyHash === keyHash);
  inventory.assertCurrent(); return present;
}
function assertCheckpointClear(home: string): void {
  const markers = readPlacementRuntimeMarkers(home), binding = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!binding) return;
  try { if (resolvePlacementWindow(home, binding.profile.placementHead).pending) throw new SyncPlacementJournalError("checkpoint-pending"); }
  catch (error) { if (error instanceof SyncPlacementJournalError && error.code === "pending") throw new SyncPlacementJournalError("checkpoint-pending"); throw error; }
}
function dirs(home: string, project: string): string[] {
  const markers = readPlacementRuntimeMarkers(home);
  const binding = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!binding) return unavailable("epoch");
  const directories = placementFenceDirectories(home, binding);
  const target = shardDir(home, project);
  if (lstatSync(target, { throwIfNoEntry: false })) directories.push(target);
  return directories;
}
const nextSync = "amem sync";

/** Returns identifiers/counts only. A callback is used only for the existing remote visibility check. */
async function remoteRealmAdmissionInner(homeInput: string, project: string, options: RemoteAdmissionOptions): Promise<RemoteAdmissionResult> {
  const home = realPath(homeInput), realm = keyOf(project), transport = { ...(options.signal ? { signal: options.signal } : {}), ...(options.visibility ? { visibility: options.visibility } : {}) };
  if (options.mode !== "dry-run") assertCheckpointClear(home);
  const pending = pendingRemoteAdoptions(home);
  if (pending.unknown) return unavailable("staging");
  if (options.mode !== "abandon" && pending.hashes.some(hash => hash !== realm)) return unavailable("pending");
  let plan = readRemoteAdoption(home, realm), staged = inspectRemoteAdoptionPending(home, realm);
  if (plan) assertRemoteAdoptionStageOwnership(home, plan);
  // A private stage without any companion cannot be attributed to this operation or silently abandoned.
  if (!plan && !staged.length && pending.hashes.includes(realm)) return unavailable("staging");
  const admitted = () => active(home, realm);
  const assertTargetIdle = () => {
    if (admitted()) return;
    const target = shardDir(home, project);
    if (!lstatSync(target, { throwIfNoEntry: false })) return;
    try { assertNoLiveReaders(target, { includeShards: true }); }
    catch { unavailable("lock"); }
  };
  if (options.mode === "dry-run") {
    if (plan || staged.length) return { state: "retained", realm, staged: staged.length, nextStep: "resume or review abandon" };
    if (admitted()) return { state: "already-admitted", realm, nextStep: nextSync };
    if (previewRealmAdmission(home, project).state !== "not-local") return unavailable();
    const prepared = await prepareRemotePlacementRealm(home, project, transport);
    return { state: "preview", realm, remoteHead: prepared.plan.remoteHead, omitted: prepared.plan.omitted };
  }
  if (options.mode === "abandon" && staged.length) {
    if (!options.confirm) return { state: "retained", realm, staged: staged.length, nextStep: "confirm abandon" };
    await withPlacementMutationFences(home, dirs(home, project), async (mutation, owner) => {
      const proof = { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); assertCheckpointClear(home); } };
      clearRemoteAdoptionPending(home, realm, staged, proof);
    }, { surface: "admit" });
    return { state: "abandoned", realm, staged: staged.length, nextStep: plan ? "resume or review abandon" : "preview admission" };
  }
  if (options.mode === "abandon" && !plan) return { state: admitted() ? "already-admitted" : "abandoned", realm, nextStep: admitted() ? nextSync : "preview admission" };
  if (options.mode === "abandon" && plan && !options.confirm) return { state: "retained", realm, nextStep: "confirm abandon" };
  if (options.mode === "apply" && (plan || staged.length) && !admitted()) return unavailable("pending");
  if (!plan && admitted()) {
    if (staged.length) await withPlacementMutationFences(home, dirs(home, project), async (mutation, owner) => {
      clearRemoteAdoptionPending(home, realm, staged, { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); assertCheckpointClear(home); } });
    }, { surface: "admit" });
    return { state: "already-admitted", realm, nextStep: nextSync };
  }
  if (options.mode === "resume" && !plan && !staged.length) return admitted() ? { state: "already-admitted", realm, nextStep: nextSync } : unavailable();

  let packs = plan ? await recoverRemoteStagedPacks(home, project, plan) : undefined;
  // A torn first companion can be completed only if the exact plan is reconstructed; a changed head refuses.
  if (!plan) {
    const prepared = await prepareRemotePlacementRealm(home, project, transport); plan = prepared.plan; packs = prepared.packs; await options.checkpoint?.("after-preview");
  }
  const frozen: RemoteAdoption = plan, files = packs!;
  const clearOwn = async () => {
    await withPlacementMutationFences(home, dirs(home, project), async (mutation, owner) => {
      const current = readRemoteAdoption(home, realm); if (!current) return;
      if (current.seal !== frozen.seal) return unavailable("staging");
      clearRemoteAdoption(home, frozen, files, { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); assertCheckpointClear(home); } });
    }, { surface: "admit" });
  };
  if (options.mode === "abandon") {
    const oldIntent = readRealmIntent(home, realm);
    if (oldIntent) {
      if (admitted()) await applyRealmAdmission(home, project, { mode: "resume" });
      else {
        if (planRealmAbandon(home, project).state !== "abandonable") return unavailable("staging");
        await applyRealmAdmission(home, project, { mode: "abandon", confirm: true });
      }
    }
    await withPlacementMutationFences(home, dirs(home, project), async (mutation, owner) => {
      const current = () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); assertCheckpointClear(home); };
      const proof = { mutation, assertCurrent: current };
      if (!admitted() && remoteAdoptionLogMayBeInstalled(home, project, frozen)) {
        assertTargetIdle();
        discardRemoteInstalledLog(home, project, frozen, { mutation, assertCurrent: () => { current(); if (admitted()) unavailable(); } });
      }
      clearRemoteAdoption(home, frozen, files, proof);
    }, { surface: "admit" });
    return { state: admitted() ? "already-admitted" : "abandoned", realm, nextStep: admitted() ? nextSync : "preview admission" };
  }
  if (admitted()) {
    if (readRealmIntent(home, realm)) await applyRealmAdmission(home, project, { mode: "resume" });
    await clearOwn();
    return { state: "already-admitted", realm, nextStep: nextSync };
  }
  await withPlacementMutationFences(home, dirs(home, project), async (mutation, owner) => {
    if (admitted()) return;
    assertTargetIdle();
    const remotePending = pendingRemoteAdoptions(home); if (remotePending.unknown) return unavailable("staging"); if (remotePending.hashes.some(hash => hash !== realm)) return unavailable("pending");
    const pending = pendingRealmInventory(home); if (pending.unknown) return unavailable("staging"); if (pending.hashes.some(hash => hash !== realm)) return unavailable("pending");
    const markers = readPlacementRuntimeMarkers(home), binding = readActivePlacementBinding(home, markers.profile, markers.shards);
    if (!binding) return unavailable("epoch");
    const inventory = readEffectiveRealmInventory(home, binding), expectedWriters = readEffectiveSyncPlacementWriters(home);
    const journalToken = placementWriterJournalToken(home, frozen.epochHash), journal = readPlacementWriterJournalAnchors(home, frozen.epochHash);
    const journalHead = journal.sequence ? journal.records[journal.sequence - 1]!.seal : frozen.epochHash;
    if (inventory.extensionHead !== frozen.inventoryHead || expectedWriters.revisionHash !== frozen.writerHash
      || journal.sequence !== frozen.journalSequence || journalHead !== frozen.journalHead) return unavailable("drift");
    const writer = activePlacementWriterContext(home, fileURLToPath(new URL("../..", import.meta.url)));
    const current = () => { try { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); assertCheckpointClear(home); writer.attest(); expectedWriters.assertCurrent(); inventory.assertCurrent();
      if (placementWriterJournalToken(home, frozen.epochHash) !== journalToken) unavailable("drift"); assertPlacementActivationOwner(owner, home); } catch (error) { if (error instanceof SyncPlacementJournalError && error.code === "checkpoint-pending") throw error; return unavailable("drift"); } };
    current(); const source = previewOwnedSyncPlacementSources(home, owner), installed = remoteAdoptionLogMayBeInstalled(home, project, frozen);
    if (source.base.homeHash !== frozen.homeHash || source.base.policyHash !== frozen.policyHash || source.base.aliasesHash !== frozen.aliasesHash
      || !installed && source.base.sourceHash !== frozen.sourceHash) return unavailable("drift");
    try { source.assertSourcesUnchanged(); } catch { return unavailable("drift"); }
    await assertRemoteAdoptionCurrent(home, project, frozen, transport);
    try { source.assertSourcesUnchanged(); } catch { return unavailable("drift"); }
    current();
    const proof = { mutation, assertCurrent: current };
    assertRemoteAdoptionStageOwnership(home, frozen);
    writeRemoteAdoption(home, frozen, proof); await options.checkpoint?.("after-companion");
    if (!installed) { stageRemoteAdoption(home, frozen, files, proof); await options.checkpoint?.("after-stage"); }
    const retained = readRealmIntent(home, realm);
    const completeMetadata = source.base.realms.some(item => item.scope === "project" && item.keyHash === realm);
    installRemoteAdoptionLog(home, project, frozen, proof, !!retained || completeMetadata); await options.checkpoint?.("after-install");
  }, { surface: "admit" });
  if (admitted()) {
    await clearOwn();
    return { state: "already-admitted", realm, nextStep: nextSync };
  }
  const existing = readRealmIntent(home, realm);
  const result = await applyRealmAdmission(home, project, { mode: existing ? "resume" : "apply",
    expectedRemoteAnchors: { writerHash: frozen.writerHash, inventoryHead: frozen.inventoryHead, journalSequence: frozen.journalSequence, journalHead: frozen.journalHead },
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) });
  await options.checkpoint?.("after-admission");
  await clearOwn();
  return { state: result.state === "already-admitted" ? "already-admitted" : "admitted", realm, omitted: frozen.omitted, nextStep: nextSync };
}

export async function remoteRealmAdmission(homeInput: string, project: string, options: RemoteAdmissionOptions): Promise<RemoteAdmissionResult> {
  try { return await remoteRealmAdmissionInner(homeInput, project, options); }
  catch (error) {
    if (error instanceof SyncPlacementJournalError && error.code === "checkpoint-pending") throw error;
    if (error instanceof RemoteRealmRefusal) throw error;
    if (error instanceof SyncPlacementFormatError || error instanceof Error && error.message === "sync placement activation metadata unavailable or changed; inspect the retained activation before continuing") return unavailable("epoch");
    if (error instanceof PlacementInventoryFenceError || error instanceof Error && error.message === "profile lock held by a live or unknown owner") return unavailable("lock");
    if (error instanceof RealmAdmissionError) return unavailable(error.causeClass === "busy" || error.causeClass === "readers" ? "lock" : error.causeClass === "pending" ? "pending" : error.causeClass === "changed" ? "drift" : "staging");
    if (error instanceof SharedWriterRevisionError) return unavailable("drift");
    return unavailable();
  }
}
