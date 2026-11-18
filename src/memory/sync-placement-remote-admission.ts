/** Explicit remote realm adoption, staged before the existing same-epoch admission. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realPath } from "./platform.ts";
import { assertMutationHandle } from "./mutation.ts";
import { shardDir } from "./shard.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { readRealmIntent } from "./sync-placement-realm-intent-storage.ts";
import { pendingRealmInventory } from "./sync-placement-realm-pending.ts";
import { withPlacementActivationFences } from "./sync-placement-activation-locks.ts";
import { assertPlacementActivationOwner } from "./sync-placement-activation-proof.ts";
import { previewOwnedSyncPlacementSources } from "./sync-placement-capture.ts";
import { activePlacementWriterContext } from "../sync-placement-writer-context.ts";
import { applyRealmAdmission, planRealmAbandon, previewRealmAdmission } from "./sync-placement-realm-admission.ts";
import { assertRemoteAdoptionCurrent, prepareRemotePlacementRealm, recoverRemoteStagedPacks } from "./sync-placement-transport.ts";
import { clearRemoteAdoption, clearRemoteAdoptionPending, discardRemoteInstalledLog, inspectRemoteAdoptionPending, installRemoteAdoptionLog,
  pendingRemoteAdoptions, readRemoteAdoption, remoteAdoptionLogMayBeInstalled, stageRemoteAdoption, writeRemoteAdoption } from "./sync-placement-remote-stage.ts";
import type { RemoteAdoption } from "./sync-placement-remote-adoption-format.ts";
import type { SyncOptions } from "./sync.ts";

export type RemoteAdmissionMode = "dry-run" | "apply" | "resume" | "abandon";
export interface RemoteAdmissionOptions extends Pick<SyncOptions, "signal" | "visibility"> {
  mode: RemoteAdmissionMode; confirm?: boolean;
  /** Internal crash seam; never supplied by the CLI. */
  checkpoint?(stage: "after-companion" | "after-stage" | "after-install" | "after-admission"): void | Promise<void>;
}
export interface RemoteAdmissionResult {
  state: "preview" | "admitted" | "already-admitted" | "retained" | "abandoned";
  realm: string; remoteHead?: string; omitted?: number; staged?: number; nextStep?: string;
}
const unavailable = (): never => { throw new Error("Remote placement admission is unavailable or changed; retain its evidence and review the configured sync remote."); };
const keyOf = (project: string) => createHash("sha256").update(project).digest("hex");
function active(home: string, keyHash: string): boolean {
  const markers = readPlacementRuntimeMarkers(home), binding = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!binding) return unavailable();
  const inventory = readEffectiveRealmInventory(home, binding), present = inventory.realms.some(realm => realm.scope === "project" && realm.keyHash === keyHash);
  inventory.assertCurrent(); return present;
}
function dirs(home: string, project: string): string[] {
  const dir = shardDir(home, project); return lstatSync(dir, { throwIfNoEntry: false }) ? [dir] : [];
}
const nextSync = "amem sync";

/** Returns identifiers/counts only. A callback is used only for the existing remote visibility check. */
export async function remoteRealmAdmission(homeInput: string, project: string, options: RemoteAdmissionOptions): Promise<RemoteAdmissionResult> {
  const home = realPath(homeInput), realm = keyOf(project), transport = { ...(options.signal ? { signal: options.signal } : {}), ...(options.visibility ? { visibility: options.visibility } : {}) };
  if (options.mode !== "abandon") {
    const pending = pendingRemoteAdoptions(home); if (pending.unknown || pending.hashes.some(hash => hash !== realm)) return unavailable();
  }
  let plan = readRemoteAdoption(home, realm), staged = inspectRemoteAdoptionPending(home, realm);
  const admitted = () => active(home, realm);
  if (options.mode === "dry-run") {
    if (plan || staged.length) return { state: "retained", realm, staged: staged.length, nextStep: "resume or review abandon" };
    if (admitted()) return { state: "already-admitted", realm, nextStep: nextSync };
    if (previewRealmAdmission(home, project).state !== "not-local") return unavailable();
    const prepared = await prepareRemotePlacementRealm(home, project, transport);
    return { state: "preview", realm, remoteHead: prepared.plan.remoteHead, omitted: prepared.plan.omitted };
  }
  if (options.mode === "abandon" && staged.length) {
    if (!options.confirm) return { state: "retained", realm, staged: staged.length, nextStep: "confirm abandon" };
    await withPlacementActivationFences(home, dirs(home, project), async (mutation, owner) => {
      const proof = { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); } };
      clearRemoteAdoptionPending(home, realm, staged, proof);
    });
    return { state: "abandoned", realm, staged: staged.length, nextStep: plan ? "resume or review abandon" : "preview admission" };
  }
  if (options.mode === "abandon" && !plan) return { state: admitted() ? "already-admitted" : "abandoned", realm, nextStep: admitted() ? nextSync : "preview admission" };
  if (options.mode === "abandon" && plan && !options.confirm) return { state: "retained", realm, nextStep: "confirm abandon" };
  if (options.mode === "apply" && (plan || staged.length) && !admitted()) return unavailable();
  if (!plan && !staged.length && admitted()) return { state: "already-admitted", realm, nextStep: nextSync };
  if (options.mode === "resume" && !plan && !staged.length) return admitted() ? { state: "already-admitted", realm, nextStep: nextSync } : unavailable();

  let packs = plan ? await recoverRemoteStagedPacks(home, project, plan) : undefined;
  // A torn first companion can be completed only if the exact plan is reconstructed; a changed head refuses.
  if (!plan) {
    const prepared = await prepareRemotePlacementRealm(home, project, transport); plan = prepared.plan; packs = prepared.packs;
  }
  const frozen: RemoteAdoption = plan, files = packs!;
  if (options.mode === "abandon") {
    const oldIntent = readRealmIntent(home, realm);
    if (oldIntent && !admitted()) {
      if (planRealmAbandon(home, project).state !== "abandonable") return unavailable();
      await applyRealmAdmission(home, project, { mode: "abandon", confirm: true });
    }
    await withPlacementActivationFences(home, dirs(home, project), async (mutation, owner) => {
      const current = () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); };
      const proof = { mutation, assertCurrent: current };
      if (!admitted() && remoteAdoptionLogMayBeInstalled(home, project, frozen))
        discardRemoteInstalledLog(home, project, frozen, { mutation, assertCurrent: () => { current(); if (admitted()) unavailable(); } });
      clearRemoteAdoption(home, frozen, files, proof);
    });
    return { state: admitted() ? "already-admitted" : "abandoned", realm, nextStep: admitted() ? nextSync : "preview admission" };
  }
  if (admitted()) {
    if (readRealmIntent(home, realm)) await applyRealmAdmission(home, project, { mode: "resume" });
    await withPlacementActivationFences(home, dirs(home, project), async (mutation, owner) => {
      clearRemoteAdoption(home, frozen, files, { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); } });
    });
    return { state: "already-admitted", realm, nextStep: nextSync };
  }
  await withPlacementActivationFences(home, dirs(home, project), async (mutation, owner) => {
    if (admitted()) return;
    const remotePending = pendingRemoteAdoptions(home); if (remotePending.unknown || remotePending.hashes.some(hash => hash !== realm)) return unavailable();
    const pending = pendingRealmInventory(home); if (pending.unknown || pending.hashes.some(hash => hash !== realm)) return unavailable();
    const writer = activePlacementWriterContext(home, fileURLToPath(new URL("../..", import.meta.url)));
    const current = () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); writer.attest(); assertPlacementActivationOwner(owner, home); };
    current(); const source = previewOwnedSyncPlacementSources(home, owner), installed = remoteAdoptionLogMayBeInstalled(home, project, frozen);
    if (source.base.homeHash !== frozen.homeHash || source.base.policyHash !== frozen.policyHash || source.base.aliasesHash !== frozen.aliasesHash
      || !installed && source.base.sourceHash !== frozen.sourceHash) return unavailable();
    source.assertSourcesUnchanged(); await assertRemoteAdoptionCurrent(home, project, frozen, transport); source.assertSourcesUnchanged(); current();
    const proof = { mutation, assertCurrent: current };
    writeRemoteAdoption(home, frozen, proof); await options.checkpoint?.("after-companion");
    if (!installed) { stageRemoteAdoption(home, frozen, files, proof); await options.checkpoint?.("after-stage"); }
    const retained = readRealmIntent(home, realm);
    installRemoteAdoptionLog(home, project, frozen, proof, !!retained); await options.checkpoint?.("after-install");
  });
  if (admitted()) {
    await withPlacementActivationFences(home, dirs(home, project), async (mutation, owner) => {
      clearRemoteAdoption(home, frozen, files, { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); } });
    });
    return { state: "already-admitted", realm, nextStep: nextSync };
  }
  const existing = readRealmIntent(home, realm);
  const result = await applyRealmAdmission(home, project, { mode: existing ? "resume" : "apply" });
  await options.checkpoint?.("after-admission");
  await withPlacementActivationFences(home, dirs(home, project), async (mutation, owner) => {
    clearRemoteAdoption(home, frozen, files, { mutation, assertCurrent: () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); } });
  });
  return { state: result.state === "already-admitted" ? "already-admitted" : "admitted", realm, omitted: frozen.omitted, nextStep: nextSync };
}
