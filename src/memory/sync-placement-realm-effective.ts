/** Effective same-epoch realm inventory; serialized evidence is not fresh writer or policy authority. */
import { canonicalJSON } from "./generation.ts";
import { readPlacementWriterJournalAnchors, placementWriterJournalToken } from "./sync-placement-journal-storage.ts";
import { readWriterHistory } from "./sync-placement-writer-history.ts";
import { writerInventoryGenesis } from "./sync-placement-writer-revision-format.ts";
import { readRealmExtensionHistory } from "./sync-placement-realm-extension-storage.ts";
import { attributeTornRealmAppend } from "./sync-placement-realm-attribution.ts";
import { pendingRealmInventory } from "./sync-placement-realm-pending.ts";
import { realmIntentEvidence } from "./sync-placement-realm-intent-storage.ts";
import { RealmExtensionFormatError, realmExtensionGenesis } from "./sync-placement-realm-extension-format.ts";
import type { ActivePlacementBinding } from "./sync-placement-active.ts";
import type { SyncPlacementRealmBinding } from "./sync-placement-plan.ts";

export interface EffectiveRealmInventory { realms: readonly SyncPlacementRealmBinding[]; extensionHead: string; assertCurrent(): void }
const fail = (): never => { throw new RealmExtensionFormatError(); };
/** The immutable epoch facts the chain is verified against. A caller holding a validated journal supplies them directly,
 * so the chain is verified by the same code with or without the activation marker files on hand. */
export interface EffectiveRealmBinding { epochHash: string; activationHash: string; homeHash: string; generation: string; realms: readonly SyncPlacementRealmBinding[] }
/** A zero-byte extension log is this epoch's pre-write state only while an intent for the same epoch and activation is
 * retained; unknown evidence never authorizes the recovery. */
export function retainedAdmissionCoversEmptyLog(home: string, epochHash: string, activationHash: string): boolean {
  const pending = pendingRealmInventory(home);
  if (pending.unknown) return false;
  return pending.hashes.some(keyHash => {
    const intent = realmIntentEvidence(home, keyHash);
    return !!intent && intent.epochHash === epochHash && intent.activationHash === activationHash;
  });
}
/** Validate the complete extension chain against both immutable activation and committed historical prefixes. */
export function readEffectiveRealmInventory(home: string, active: ActivePlacementBinding): EffectiveRealmInventory {
  return readEffectiveRealmInventoryFor(home, { epochHash: active.profile.placementHead, activationHash: active.activation.seal,
    homeHash: active.epoch.homeHash, generation: active.epoch.generation, realms: active.activation.realms });
}
export function readEffectiveRealmInventoryFor(home: string, binding: EffectiveRealmBinding): EffectiveRealmInventory {
  try {
    const { epochHash, activationHash, homeHash, generation, realms: activated } = binding;
    const initialProjectHashes = activated.flatMap(realm => realm.scope === "project" ? [realm.keyHash] : []);
    // A stop between creating the extension log and its first append leaves a zero-byte file: recover it as the
    // pre-write state while the admission that authorized the append is retained.
    const allowEmptyLog = retainedAdmissionCoversEmptyLog(home, epochHash, activationHash);
    const extensions = readRealmExtensionHistory(home, { epochHash, activationHash, homeHash,
      generation, initialProjectHashes }, { allowEmptyLog, attributeTorn: evidence => attributeTornRealmAppend(home, {
        epochHash, activationHash, homeHash, generation, initialProjectHashes }, evidence) });
    if (!extensions.records.length) return { realms: activated, extensionHead: realmExtensionGenesis(epochHash, activationHash), assertCurrent: extensions.assertCurrent };
    const token = placementWriterJournalToken(home, epochHash), journal = readPlacementWriterJournalAnchors(home, epochHash);
    if (journal.epoch.homeHash !== homeHash || journal.activation.seal !== activationHash) return fail();
    const writers = readWriterHistory(home, { epochHash, activationHash, homeHash, generation });
    const writerHeads = [writerInventoryGenesis(epochHash, activationHash), ...writers.commits.map(commit => commit.seal)];
    let priorWriter = 0;
    for (const record of extensions.records) {
      const writerIndex = writerHeads.indexOf(record.writerHash);
      if (writerIndex < priorWriter || writerIndex < 0 || record.journal.sequence > journal.sequence
        || (record.journal.sequence ? journal.records[record.journal.sequence - 1]?.seal : epochHash) !== record.journal.headHash) return fail();
      if (writerIndex > 0 && writers.anchors[writerIndex - 1]!.sequence > record.journal.sequence) return fail();
      priorWriter = writerIndex;
    }
    const realms = [...activated, ...extensions.records.map(record => record.realm)];
    if (realms.length > 256) return fail();
    realms.sort((a, b) => a.scope === "user" ? b.scope === "user" ? 0 : -1 : b.scope === "user" ? 1 : a.keyHash.localeCompare(b.keyHash));
    for (const realm of realms) Object.freeze(realm);
    Object.freeze(realms);
    const snapshot = canonicalJSON(realms);
    const assertCurrent = () => {
      try {
        extensions.assertCurrent(); writers.assertCurrent();
        if (placementWriterJournalToken(home, epochHash) !== token || canonicalJSON(realms) !== snapshot) fail();
      } catch { fail(); }
    };
    assertCurrent(); return { realms, extensionHead: extensions.headHash, assertCurrent };
  } catch { return fail(); }
}
