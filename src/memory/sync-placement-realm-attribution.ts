/** Attribute an incomplete extension append to a frozen admission intent; the tail itself is never folded into the chain. */
import { realPath } from "./platform.ts";
import { pendingRealmInventory } from "./sync-placement-realm-pending.ts";
import { realmIntentEvidence } from "./sync-placement-realm-intent-storage.ts";
import { readRealmProof } from "./sync-placement-realm-proof.ts";
import { verifyTornRealmAppend } from "./sync-placement-realm-torn.ts";
import type { RealmExtensionBinding, RealmTornEvidence } from "./sync-placement-realm-extension-storage.ts";
/** True only when a pending admission of this epoch pins this exact prefix, position and head; anything else leaves the chain closed. */
export function attributeTornRealmAppend(home: string, binding: RealmExtensionBinding, evidence: RealmTornEvidence): boolean {
  try {
    const root = realPath(home), pending = pendingRealmInventory(root);
    if (pending.unknown) return false;
    return pending.hashes.some(keyHash => {
      try {
        const intent = realmIntentEvidence(root, keyHash); if (!intent) return false;
        if (intent.epochHash !== binding.epochHash || intent.activationHash !== binding.activationHash || intent.homeHash !== binding.homeHash
          || intent.generation !== binding.generation || intent.sequence !== evidence.sequence || intent.previousHash !== evidence.headHash) return false;
        const record = readRealmProof(root, intent); if (!record) return false;
        return verifyTornRealmAppend(Buffer.concat([evidence.prefix, evidence.tail]), intent, record).equals(evidence.prefix);
      } catch { return false; }
    });
  } catch { return false; }
}
