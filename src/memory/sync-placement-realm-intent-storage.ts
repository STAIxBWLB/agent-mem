/** Frozen admission intent storage. The caller owns person authority, the profile lock and the home mutation fence. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { RealmExtensionFormatError } from "./sync-placement-realm-extension-format.ts";
import { REALM_INTENT_MAX_BYTES, validateRealmIntent, type RealmIntent } from "./sync-placement-realm-intent-format.ts";
import { REALM_INTENT_PREFIX } from "./sync-placement-realm-pending.ts";

export interface RealmIntentProof { mutation: MutationHandle; assertCurrent(): void }
const fail = (): never => { throw new RealmExtensionFormatError(); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const owned = (stat: BigIntStats): void => {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== 0o600n) fail();
};
export const realmIntentPath = (home: string, keyHash: string): string => join(home, `${REALM_INTENT_PREFIX}${keyHash}.json`);
/** The staging name carries the digest of the exact bytes, so a retained staging file is either ours or unknown. */
const stagingPath = (file: string, text: string): string => `${file}.pending-${digest(Buffer.from(text))}`;

function read(home: string, keyHash: string): { intent: RealmIntent; text: string; stat: BigIntStats } | undefined {
  const file = realmIntentPath(home, keyHash), before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before) return undefined;
  owned(before); if (before.size <= 0n || before.size > BigInt(REALM_INTENT_MAX_BYTES)) fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (stamp(opened) !== stamp(before)) fail();
    const data = Buffer.alloc(Number(opened.size) + 1); let at = 0;
    while (at < data.length) { const count = readSync(fd, data, at, data.length - at, at); if (!count) break; at += count; }
    if (at !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(lstatSync(file, { bigint: true })) !== stamp(opened)) fail();
    bytes = data.subarray(0, at);
  } finally { closeSync(fd); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), intent = validateRealmIntent(JSON.parse(text));
  if (canonicalJSON(intent) + "\n" !== text || intent.keyHash !== keyHash) fail();
  return { intent, text, stat: before };
}
/** Absent is absent; unsafe, torn or foreign evidence refuses instead of reading as no intent. */
export function readRealmIntent(home: string, keyHash: string): RealmIntent | undefined { return read(realPath(home), keyHash)?.intent; }
/** Attribution evidence: anything unreadable attributes nothing, so a tail cannot borrow another file's authority. */
export function realmIntentEvidence(home: string, keyHash: string): RealmIntent | null {
  try { return read(realPath(home), keyHash)?.intent ?? null; } catch { return null; }
}
function syncDirectory(dir: string): void { const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function proof(home: string, options: RealmIntentProof): void {
  try { assertMutationHandle(options.mutation, home); options.assertCurrent(); assertMutationHandle(options.mutation, home); } catch { fail(); }
}
/** Idempotent: identical retained bytes are kept, a different retained intent refuses rather than being replaced. */
export function writeRealmIntent(home: string, value: RealmIntent, options: RealmIntentProof): void {
  const intent = validateRealmIntent(value), expected = canonicalJSON(intent) + "\n";
  if (intent.home !== realPath(home)) fail();
  proof(home, options);
  const prior = read(home, intent.keyHash);
  if (prior) { if (prior.text !== expected) fail(); proof(home, options); return; }
  const file = realmIntentPath(home, intent.keyHash), staging = stagingPath(file, expected), retained = lstatSync(staging, { bigint: true, throwIfNoEntry: false });
  if (!retained) {
    const fd = openSync(staging, "wx", 0o600);
    try { writeFileSync(fd, expected); fsyncSync(fd); } finally { closeSync(fd); }
  } else if (retained.size !== BigInt(Buffer.byteLength(expected))) fail();
  proof(home, options);
  renameSync(staging, file); syncDirectory(home); proof(home, options);
  if (read(home, intent.keyHash)?.text !== expected) fail();
}
/** Removes only the exact owned bytes; an already clean home is left alone so a lost acknowledgement resumes. */
export function clearRealmIntent(home: string, value: RealmIntent, options: RealmIntentProof): void {
  const intent = validateRealmIntent(value);
  proof(home, options);
  const prior = read(home, intent.keyHash);
  if (prior) {
    if (prior.text !== canonicalJSON(intent) + "\n") fail();
    proof(home, options);
    if (stamp(prior.stat) !== stamp(lstatSync(realmIntentPath(home, intent.keyHash), { bigint: true }))) fail();
    unlinkSync(realmIntentPath(home, intent.keyHash));
  }
  syncDirectory(home); proof(home, options);
}
