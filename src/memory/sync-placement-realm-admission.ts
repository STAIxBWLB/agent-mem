/**
 * Preview and apply a same-epoch realm admission (#448 AC2-AC4).
 *
 * A curated realm that appeared after activation is admitted by a person command: a dry-run report first, then one
 * explicit apply. The report reads the activation, the extension chain, the writer history, the journal anchors and the
 * target realm's own source facts and writes nothing. Apply re-reads every one of those facts under the live profile and
 * mutation fences, retains a frozen intent, completes the realm's empty curated metadata and appends one extension
 * record carrying the same proofs activation used for the realms it named.
 *
 * The record is the shape activation produced, so a later reader needs no new verification: an admitted realm is
 * indistinguishable from an activated one. Retained activation metadata is never rewritten, nothing is appended twice,
 * and a chain that no longer matches the frozen intent fails closed with the cause and the recovery command.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashJSON, readProfileJSON } from "./generation.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { readShardDescriptor, shardDir } from "./shard.ts";
import { assertPlacementActivationOwner, type PlacementActivationOwner } from "./sync-placement-activation-proof.ts";
import { withPlacementActivationFences, PlacementInventoryFenceError } from "./sync-placement-activation-locks.ts";
import { readActivePlacementBinding, type ActivePlacementBinding } from "./sync-placement-active.ts";
import { previewOwnedSyncPlacementSources, previewSyncPlacementSources } from "./sync-placement-capture.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readPlacementWriterJournalAnchors } from "./sync-placement-journal-storage.ts";
import { createRealmExtension, REALM_EXTENSION_SCHEMA, RealmExtensionFormatError, type RealmExtension } from "./sync-placement-realm-extension-format.ts";
import { readRealmExtensionHistory, type RealmExtensionBinding, type RealmExtensionHistory } from "./sync-placement-realm-extension-storage.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { createRealmIntent, REALM_INTENT_SCHEMA, type RealmIntent } from "./sync-placement-realm-intent-format.ts";
import { clearRealmIntent, readRealmIntent, writeRealmIntent } from "./sync-placement-realm-intent-storage.ts";
import { appendRealmExtension, discardRealmExtensionTail, ensureCuratedRealmMetadata } from "./sync-placement-realm-admission-storage.ts";
import { readWriterHistory } from "./sync-placement-writer-history.ts";
import { writerInventoryGenesis } from "./sync-placement-writer-revision-format.ts";
import type { SyncPlacementRealmBinding } from "./sync-placement-plan.ts";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const empty = digest("");
const MACHINE_ID = /^[0-9a-f]{16}$/;

/** `not-local` is a state both 0.28.2 and the #450 driver already report: no curated shard yet, so nothing to admit yet. */
export type RealmAdmissionState = "admissible" | "already-admitted" | "not-local" | "unavailable";
/** Everything the intent and record would pin; identifiers and hashes only, never a project key or a row. */
export interface RealmAdmissionNext {
  mode: "new" | "existing";
  sequence: number; previousHash: string; previousLogBytes: number; previousLogHash: string;
  writerHash: string; journal: { sequence: number; headHash: string };
  bindingHash?: string; descriptorHash?: string; sourceHash?: string;
  aliasesHash: string; policyHash: string;
}
export interface RealmAdmissionPreview { realm: string; state: RealmAdmissionState; next?: RealmAdmissionNext }
export interface RealmAbandonPlan { realm: string; state: "abandonable" | "committed" | "none" | "unavailable"; sequence?: number; discards?: number; nextStep?: string }
export type RealmAdmissionMode = "apply" | "resume" | "abandon";
export type RealmAdmissionStage = "after-intent" | "after-metadata" | "after-append";
export interface RealmAdmissionOptions {
  mode: RealmAdmissionMode; confirm?: boolean;
  /** Internal fault seam between durable steps; the CLI never supplies it. */
  checkpoint?(stage: RealmAdmissionStage): void | Promise<void>;
}
export interface RealmAdmissionResult {
  mode: RealmAdmissionMode; state: "admitted" | "already-admitted" | "abandoned" | "retained";
  realm: string; sequence?: number; headHash?: string; created?: boolean; discarded?: number; nextStep?: string;
}
export class RealmAdmissionError extends Error {
  constructor(readonly causeClass: "readers" | "busy" | "changed" | "pending" | "committed" | "metadata") {
    super(`Sync placement realm admission is ${causeClass}; the existing activated realms keep syncing. ${action(causeClass)}`);
    this.name = "RealmAdmissionError";
  }
}
function action(causeClass: RealmAdmissionError["causeClass"]): string {
  if (causeClass === "pending") return "An admission intent is retained: run amem migrate --sync-placement --admit <project> --resume, or review amem migrate --sync-placement --admit <project> --abandon before confirming it.";
  if (causeClass === "committed") return "The extension chain no longer matches the frozen intent: run amem migrate --sync-placement --admit <project> --resume to complete or clean up the retained attempt, and keep --abandon --confirm for an append that never committed.";
  if (causeClass === "changed") return "Re-read the home with amem migrate --sync-placement --admit <project> --dry-run and apply the reviewed append.";
  if (causeClass === "metadata") return "Inspect the local placement and curated metadata it names, then run amem migrate --sync-placement --admit <project> --dry-run.";
  return "Close cooperating readers and writers, then run amem migrate --sync-placement --admit <project> --dry-run.";
}
function fail(causeClass: RealmAdmissionError["causeClass"]): never { throw new RealmAdmissionError(causeClass); }
function rethrow(error: unknown): never {
  if (error instanceof RealmAdmissionError || error instanceof RealmExtensionFormatError) throw error;
  if (error instanceof PlacementInventoryFenceError) fail(error.causeClass);
  return fail("metadata");
}

function realmBinding(active: ActivePlacementBinding): RealmExtensionBinding {
  return { epochHash: active.profile.placementHead, activationHash: active.activation.seal, homeHash: active.epoch.homeHash,
    generation: active.epoch.generation,
    initialProjectHashes: active.activation.realms.flatMap(realm => realm.scope === "project" ? [realm.keyHash] : []) };
}
/** The writer history reads exactly four identity fields; an extension binding carries one more. */
function writerBinding(binding: RealmExtensionBinding): { epochHash: string; activationHash: string; homeHash: string; generation: string } {
  return { epochHash: binding.epochHash, activationHash: binding.activationHash, homeHash: binding.homeHash, generation: binding.generation };
}
function activeBinding(home: string): ActivePlacementBinding {
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!active) throw Error("sync placement is not active in this home; there is no inventory to admit a realm into");
  return active;
}
function machineIdentity(home: string): { id: string; label: string } {
  const machine = readProfileJSON(join(home, "machine.json")) as { id?: unknown; label?: unknown } | undefined;
  const id = machine?.id, label = machine?.label;
  if (typeof id !== "string" || !MACHINE_ID.test(id)) fail("metadata");
  return { id, label: typeof label === "string" ? label : id };
}
function inForce(home: string, realm: string): boolean {
  try { return readEffectiveRealmInventory(home, activeBinding(home)).realms.some(item => item.scope === "project" && item.keyHash === realm); }
  catch { return false; }
}

/** Every realm identity is a hash here, so only identifiers leave this module. */
function inspectRealmAdmission(home: string, project: string, owner?: PlacementActivationOwner): RealmAdmissionPreview {
  const realm = digest(project), active = activeBinding(home), binding = realmBinding(active);
  let effective: readonly SyncPlacementRealmBinding[];
  try { effective = readEffectiveRealmInventory(home, active).realms; } catch { return { realm, state: "unavailable" }; }
  if (effective.some(item => item.scope === "project" && item.keyHash === realm)) return { realm, state: "already-admitted" };
  const descriptor = readShardDescriptor(home, realm.slice(0, 16));
  if (descriptor && digest(descriptor.key) !== realm) return { realm, state: "unavailable" };
  const curated = descriptor !== undefined && existsSync(join(shardDir(home, descriptor.key), "generation.json"));
  // Strict: an unattributed or torn chain is not something a preview or an intent may append over.
  let history: RealmExtensionHistory;
  try { history = readRealmExtensionHistory(home, binding); } catch { return { realm, state: "unavailable" }; }
  const source = owner ? previewOwnedSyncPlacementSources(home, owner) : previewSyncPlacementSources(home);
  const captured = source.base.realms.find(item => item.scope === "project" && item.keyHash === realm);
  if (curated !== (captured !== undefined)) return { realm, state: "unavailable" };
  const journal = readPlacementWriterJournalAnchors(home, binding.epochHash);
  if (journal.epoch.homeHash !== binding.homeHash || journal.activation.seal !== binding.activationHash) return { realm, state: "unavailable" };
  const writers = readWriterHistory(home, writerBinding(binding));
  const writerHash = writers.commits.at(-1)?.seal ?? writerInventoryGenesis(binding.epochHash, binding.activationHash);
  const headHash = journal.sequence ? journal.records[journal.sequence - 1]!.seal : binding.epochHash;
  // The facts and the anchors must still hold when the report leaves this function.
  source.assertSourcesUnchanged(); history.assertCurrent(); writers.assertCurrent();
  const next: RealmAdmissionNext = { mode: curated ? "existing" : "new",
    sequence: history.records.length + 1, previousHash: history.headHash,
    previousLogBytes: history.logBytes.length, previousLogHash: history.logBytes.length ? digest(history.logBytes) : empty,
    writerHash, journal: { sequence: journal.sequence, headHash },
    aliasesHash: source.base.aliasesHash, policyHash: source.base.policyHash,
    ...(captured ? { bindingHash: captured.bindingHash, descriptorHash: hashJSON(descriptor), sourceHash: source.base.sourceHash } : {}) };
  return { realm, state: curated ? "admissible" : "not-local", next };
}
/** A dry-run report only: no fence, no intent, no curated metadata and no appended byte. */
export function previewRealmAdmission(homeInput: string, project: string): RealmAdmissionPreview {
  const home = realPath(homeInput);
  activeBinding(home); // a home without active placement keeps its own message instead of a metadata class
  try { return inspectRealmAdmission(home, project); } catch (error) { return rethrow(error); }
}
/** Person abandon preview: what a confirmed abandon would remove, and whether the append already committed. */
export function planRealmAbandon(homeInput: string, project: string): RealmAbandonPlan {
  const realm = digest(project);
  try {
    const home = realPath(homeInput), binding = realmBinding(activeBinding(home)), intent = readRealmIntent(home, realm);
    if (!intent) return { realm, state: "none", nextStep: "no admission intent is retained for this realm" };
    const history = readRealmExtensionHistory(home, binding, { attributeTorn: () => true });
    if (history.records.length + 1 > intent.sequence) return { realm, state: "committed", sequence: intent.sequence, nextStep: "amem migrate --sync-placement --admit <project> --resume" };
    if (history.records.length + 1 < intent.sequence || history.headHash !== intent.previousHash
      || history.logBytes.length !== intent.previousLogBytes || digest(history.logBytes) !== intent.previousLogHash)
      return { realm, state: "unavailable", sequence: intent.sequence };
    return { realm, state: "abandonable", sequence: intent.sequence, discards: history.torn.length };
  } catch (error) { return rethrow(error); }
}

/** The intent is the frozen review: position, anchors and proofs, plus the target the person named. */
function intentFor(home: string, project: string, next: RealmAdmissionNext, binding: RealmExtensionBinding): RealmIntent {
  const machine = machineIdentity(home), existing = next.mode === "existing";
  return createRealmIntent({ schema: REALM_INTENT_SCHEMA, home, project, keyHash: digest(project), machine: machine.id,
    epochHash: binding.epochHash, activationHash: binding.activationHash, homeHash: binding.homeHash, generation: binding.generation,
    sequence: next.sequence, previousHash: next.previousHash, previousLogBytes: next.previousLogBytes, previousLogHash: next.previousLogHash,
    mode: next.mode, descriptorHash: existing ? next.descriptorHash! : null, sourceHash: existing ? next.sourceHash! : null,
    aliasesHash: next.aliasesHash, policyHash: next.policyHash, writerHash: next.writerHash, journal: next.journal });
}
/** `realm.bindingHash` is the one field the intent omits, so a record can never be rebuilt from an intent alone. */
function recordFor(intent: RealmIntent, capturedBinding: string, sourceHash: string): RealmExtension {
  return createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: intent.epochHash, activationHash: intent.activationHash,
    homeHash: intent.homeHash, generation: intent.generation, sequence: intent.sequence, previousHash: intent.previousHash,
    realm: { scope: "project", keyHash: intent.keyHash, bindingHash: capturedBinding },
    sourceHash: intent.sourceHash ?? sourceHash, aliasesHash: intent.aliasesHash, policyHash: intent.policyHash,
    writerHash: intent.writerHash, journal: intent.journal });
}
/** The seal already occupying the intent's position, or undefined while that position is still free. */
function installedSeal(home: string, binding: RealmExtensionBinding, intent: RealmIntent): string | undefined {
  let history: RealmExtensionHistory;
  try { history = readRealmExtensionHistory(home, binding); } catch { return undefined; }
  const existing = history.records[intent.sequence - 1];
  if (!existing) return undefined;
  if (existing.previousHash !== intent.previousHash || existing.realm.keyHash !== intent.keyHash) fail("committed");
  return existing.seal;
}
/** Anchors frozen by the intent must still be ancestors of the live history, or the record could never be folded. */
function assertAnchors(home: string, binding: RealmExtensionBinding, intent: RealmIntent): void {
  const journal = readPlacementWriterJournalAnchors(home, binding.epochHash);
  if (journal.epoch.homeHash !== binding.homeHash || journal.activation.seal !== binding.activationHash
    || journal.sequence < intent.journal.sequence
    || (intent.journal.sequence ? journal.records[intent.journal.sequence - 1]?.seal : binding.epochHash) !== intent.journal.headHash) fail("committed");
  const heads = [writerInventoryGenesis(binding.epochHash, binding.activationHash), ...readWriterHistory(home, writerBinding(binding)).commits.map(commit => commit.seal)];
  if (!heads.includes(intent.writerHash)) fail("committed");
}

export async function applyRealmAdmission(homeInput: string, project: string, options: RealmAdmissionOptions): Promise<RealmAdmissionResult> {
  let home: string;
  try { home = realPath(homeInput); } catch { throw Error("Sync placement memory home is unavailable; select an existing private home and run amem migrate --sync-placement --admit <project> --dry-run."); }
  const realm = digest(project), projectPrefix = realm.slice(0, 16);
  if (options.mode === "abandon") {
    const plan = planRealmAbandon(home, project);
    if (plan.state === "none") return { mode: "abandon", state: "already-admitted", realm, nextStep: plan.nextStep };
    if (plan.state !== "abandonable") fail(plan.state === "committed" ? "committed" : "metadata");
    if (options.confirm !== true) return { mode: "abandon", state: "retained", realm, sequence: plan.sequence, discarded: plan.discards,
      nextStep: `confirm amem migrate --sync-placement --admit ${project} --abandon --confirm` };
    return withPlacementActivationFences(home, directories(home, projectPrefix), async (mutation, owner) => {
      try {
        const binding = realmBinding(activeBinding(home)), intent = readRealmIntent(home, realm);
        if (!intent) throw Error("No admission intent is retained for this realm; run amem migrate --sync-placement --admit <project> --dry-run.");
        const check = () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); }, proof = { mutation, assertCurrent: check };
        const { discarded } = discardRealmExtensionTail(home, binding, intent, proof);
        clearRealmIntent(home, intent, proof);
        return { mode: "abandon" as const, state: "abandoned" as const, realm, sequence: intent.sequence, discarded,
          nextStep: `amem migrate --sync-placement --admit ${project} --dry-run` };
      } catch (error) { return rethrow(error); }
    });
  }
  const planned = options.mode === "apply" ? inspectRealmAdmission(home, project) : undefined;
  if (planned?.state === "already-admitted") return { mode: options.mode, state: "already-admitted", realm };
  if (planned?.state === "unavailable") fail("metadata");
  if (options.mode === "resume" && !readRealmIntent(home, realm)) {
    if (inForce(home, realm)) return { mode: options.mode, state: "already-admitted", realm };
    throw Error("No retained admission intent exists for this realm; run amem migrate --sync-placement --admit <project> --dry-run.");
  }
  return withPlacementActivationFences(home, directories(home, projectPrefix), async (mutation, owner) => {
    try {
      const binding = realmBinding(activeBinding(home));
      const check = () => { assertPlacementActivationOwner(owner, home); assertMutationHandle(mutation, home); }, proof = { mutation, assertCurrent: check };
      let intent = readRealmIntent(home, realm);
      if (intent && options.mode === "apply") fail("pending");
      if (!intent) {
        // Apply re-reads every fact it acts on under this fence; the earlier report only named the state.
        const fixed = inspectRealmAdmission(home, project, owner);
        if (fixed.state === "already-admitted") return { mode: options.mode, state: "already-admitted" as const, realm };
        if (!fixed.next) fail("metadata");
        intent = intentFor(home, project, fixed.next, binding);
        writeRealmIntent(home, intent, proof);
        await options.checkpoint?.("after-intent");
      } else assertAnchors(home, binding, intent);
      const frozen = intent, created = ensureCuratedRealmMetadata(home, project, binding.generation, machineIdentity(home)).created;
      await options.checkpoint?.("after-metadata");
      const source = previewOwnedSyncPlacementSources(home, owner);
      const captured = source.base.realms.find(item => item.scope === "project" && item.keyHash === realm);
      if (!captured) fail("changed");
      // A frozen curated descriptor or source proof that moved since the review re-reads, never appends.
      const descriptor = readShardDescriptor(home, realm.slice(0, 16));
      if (frozen.descriptorHash !== null && (!descriptor || hashJSON(descriptor) !== frozen.descriptorHash)) fail("changed");
      if (frozen.mode === "existing" && source.base.sourceHash !== frozen.sourceHash) fail("changed");
      const record = recordFor(frozen, captured.bindingHash, source.base.sourceHash);
      const installed = installedSeal(home, binding, frozen);
      if (installed !== undefined) {
        if (installed !== record.seal) fail("committed");
        clearRealmIntent(home, frozen, proof);
        return { mode: options.mode, state: "admitted" as const, realm, sequence: frozen.sequence, headHash: installed, created };
      }
      source.assertSourcesUnchanged();
      appendRealmExtension(home, binding, frozen, record, proof);
      await options.checkpoint?.("after-append");
      clearRealmIntent(home, frozen, proof);
      return { mode: options.mode, state: "admitted" as const, realm, sequence: frozen.sequence, headHash: record.seal, created };
    } catch (error) { return rethrow(error); }
  });
}
function directories(home: string, projectPrefix: string): string[] {
  const realmDir = join(home, "projects", projectPrefix);
  return existsSync(realmDir) ? [realmDir] : [];
}
