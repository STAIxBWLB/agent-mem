/** Data-only verification of an incomplete append against frozen admission evidence. */
import { createHash } from "node:crypto";
import { canonicalJSON } from "./generation.ts";
import { RealmExtensionFormatError, validateRealmExtension, type RealmExtension } from "./sync-placement-realm-extension-format.ts";
import { validateRealmIntent, type RealmIntent } from "./sync-placement-realm-intent-format.ts";

/** The caller must establish the provenance and freshness of both inputs under its mutation fence. */
export function verifyTornRealmAppend(bytes: Uint8Array, frozenIntent: RealmIntent, frozenRecord: RealmExtension): Buffer {
  const intent = validateRealmIntent(frozenIntent), record = validateRealmExtension(frozenRecord);
  const fail = (): never => { throw new RealmExtensionFormatError(); };
  if (record.epochHash !== intent.epochHash || record.activationHash !== intent.activationHash
    || record.homeHash !== intent.homeHash || record.generation !== intent.generation
    || record.sequence !== intent.sequence || record.previousHash !== intent.previousHash
    || record.realm.keyHash !== intent.keyHash || record.aliasesHash !== intent.aliasesHash
    || record.policyHash !== intent.policyHash || record.writerHash !== intent.writerHash
    || record.journal.sequence !== intent.journal.sequence || record.journal.headHash !== intent.journal.headHash
    || intent.sourceHash !== null && record.sourceHash !== intent.sourceHash) return fail();
  const input = Buffer.from(bytes), offset = intent.previousLogBytes;
  if (input.length <= offset || offset > input.length) return fail();
  const prefix = input.subarray(0, offset), tail = input.subarray(offset);
  const line = Buffer.from(canonicalJSON(record) + "\n");
  if (createHash("sha256").update(prefix).digest("hex") !== intent.previousLogHash
    || offset > 0 && prefix[offset - 1] !== 10 || tail.length >= line.length
    || !tail.equals(line.subarray(0, tail.length))) return fail();
  return Buffer.from(prefix);
}
