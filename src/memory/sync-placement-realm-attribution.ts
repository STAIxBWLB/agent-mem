/** Attribute an incomplete extension append to a frozen admission intent; the tail itself is never folded into the chain. */
import { createHash } from "node:crypto";
import { canonicalJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { REALM_RECORD_MAX_BYTES } from "./sync-placement-realm-extension-format.ts";
import { type RealmIntent } from "./sync-placement-realm-intent-format.ts";
import { pendingRealmInventory } from "./sync-placement-realm-pending.ts";
import { realmIntentEvidence } from "./sync-placement-realm-intent-storage.ts";
import type { RealmExtensionBinding, RealmTornEvidence } from "./sync-placement-realm-extension-storage.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** The fields an intent fixes are the head of the canonical record; a record cannot be rebuilt from an intent because it omits the realm binding. */
function recordPrefix(intent: RealmIntent): Buffer {
  const head = canonicalJSON({ activationHash: intent.activationHash, aliasesHash: intent.aliasesHash, epochHash: intent.epochHash,
    generation: intent.generation, homeHash: intent.homeHash, journal: intent.journal, policyHash: intent.policyHash,
    previousHash: intent.previousHash, realm: { bindingHash: "" } });
  return Buffer.from(head.slice(0, -3));
}
function matches(intent: RealmIntent, binding: RealmExtensionBinding, evidence: RealmTornEvidence): boolean {
  if (intent.epochHash !== binding.epochHash || intent.activationHash !== binding.activationHash
    || intent.homeHash !== binding.homeHash || intent.generation !== binding.generation
    || intent.sequence !== evidence.sequence || intent.previousHash !== evidence.headHash
    || intent.previousLogBytes !== evidence.prefix.length || intent.previousLogHash !== sha256(evidence.prefix)) return false;
  const expected = recordPrefix(intent), { tail } = evidence;
  if (!tail.length || tail.length >= REALM_RECORD_MAX_BYTES) return false;
  const overlap = Math.min(tail.length, expected.length);
  return tail.subarray(0, overlap).equals(expected.subarray(0, overlap));
}
/** True only when a pending admission of this epoch pins this exact prefix, position and head; anything else leaves the chain closed. */
export function attributeTornRealmAppend(home: string, binding: RealmExtensionBinding, evidence: RealmTornEvidence): boolean {
  try {
    const root = realPath(home), pending = pendingRealmInventory(root);
    if (pending.unknown) return false;
    return pending.hashes.some(keyHash => { const intent = realmIntentEvidence(root, keyHash); return intent !== null && matches(intent, binding, evidence); });
  } catch { return false; }
}
