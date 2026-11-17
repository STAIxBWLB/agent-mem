/** Attribute an incomplete extension append to a frozen admission intent; the tail itself is never folded into the chain. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { REALM_RECORD_MAX_BYTES } from "./sync-placement-realm-extension-format.ts";
import { REALM_INTENT_MAX_BYTES, validateRealmIntent, type RealmIntent } from "./sync-placement-realm-intent-format.ts";
import { pendingRealmInventory, REALM_INTENT_PREFIX } from "./sync-placement-realm-pending.ts";
import type { RealmExtensionBinding, RealmTornEvidence } from "./sync-placement-realm-extension-storage.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
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
/** Torn or unsafe intent content attributes nothing; absence of a fixable intent is reported as no evidence, never as a refusal to read. */
function readIntent(home: string, keyHash: string): RealmIntent | null {
  try {
    const file = join(home, `${REALM_INTENT_PREFIX}${keyHash}.json`), before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1)
      || (before.mode & 0o777n) !== 0o600n || before.size <= 0n || before.size > BigInt(REALM_INTENT_MAX_BYTES)) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || stamp(opened) !== stamp(before)) return null;
      const data = Buffer.alloc(Number(opened.size) + 1); let at = 0;
      while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (!n) break; at += n; }
      if (at !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened)) return null;
      bytes = data.subarray(0, at);
    } finally { closeSync(fd); }
    return validateRealmIntent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return null; }
}
/** True only when a pending admission of this epoch pins this exact prefix, position and head; anything else leaves the chain closed. */
export function attributeTornRealmAppend(home: string, binding: RealmExtensionBinding, evidence: RealmTornEvidence): boolean {
  try {
    const root = realPath(home), pending = pendingRealmInventory(root);
    if (pending.unknown) return false;
    return pending.hashes.some(keyHash => { const intent = readIntent(root, keyHash); return intent !== null && matches(intent, binding, evidence); });
  } catch { return false; }
}
