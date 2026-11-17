/** Effective same-epoch realm inventory; serialized evidence is not fresh writer or policy authority. */
import { canonicalJSON } from "./generation.ts";
import { readPlacementWriterJournalAnchors, placementWriterJournalToken } from "./sync-placement-journal-storage.ts";
import { readWriterHistory } from "./sync-placement-writer-history.ts";
import { writerInventoryGenesis } from "./sync-placement-writer-revision-format.ts";
import { readRealmExtensionHistory } from "./sync-placement-realm-extension-storage.ts";
import { RealmExtensionFormatError, realmExtensionGenesis } from "./sync-placement-realm-extension-format.ts";
import type { ActivePlacementBinding } from "./sync-placement-active.ts";
import type { SyncPlacementRealmBinding } from "./sync-placement-plan.ts";

export interface EffectiveRealmInventory { realms: readonly SyncPlacementRealmBinding[]; extensionHead: string; assertCurrent(): void }
const fail = (): never => { throw new RealmExtensionFormatError(); };
/** Validate the complete extension chain against both immutable activation and committed historical prefixes. */
export function readEffectiveRealmInventory(home: string, active: ActivePlacementBinding): EffectiveRealmInventory {
  try {
    const epochHash = active.profile.placementHead, activationHash = active.activation.seal;
    const initialProjectHashes = active.activation.realms.flatMap(realm => realm.scope === "project" ? [realm.keyHash] : []);
    const extensions = readRealmExtensionHistory(home, { epochHash, activationHash, homeHash: active.epoch.homeHash,
      generation: active.epoch.generation, initialProjectHashes });
    if (!extensions.records.length) return { realms: active.activation.realms, extensionHead: realmExtensionGenesis(epochHash, activationHash), assertCurrent: extensions.assertCurrent };
    const token = placementWriterJournalToken(home, epochHash), journal = readPlacementWriterJournalAnchors(home, epochHash);
    if (journal.epoch.homeHash !== active.epoch.homeHash || journal.activation.seal !== activationHash) return fail();
    const writers = readWriterHistory(home, { epochHash, activationHash, homeHash: active.epoch.homeHash, generation: active.epoch.generation });
    const writerHeads = [writerInventoryGenesis(epochHash, activationHash), ...writers.commits.map(commit => commit.seal)];
    let priorWriter = 0;
    for (const record of extensions.records) {
      const writerIndex = writerHeads.indexOf(record.writerHash);
      if (writerIndex < priorWriter || writerIndex < 0 || record.journal.sequence > journal.sequence
        || (record.journal.sequence ? journal.records[record.journal.sequence - 1]?.seal : epochHash) !== record.journal.headHash) return fail();
      if (writerIndex > 0 && writers.anchors[writerIndex - 1]!.sequence > record.journal.sequence) return fail();
      priorWriter = writerIndex;
    }
    const realms = [...active.activation.realms, ...extensions.records.map(record => record.realm)];
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
