/** The two fenced writes of a person-reviewed realm admission: empty curated metadata, then the extension record. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory, generationDescriptor, hashJSON, readProfileJSON, writeProfileJSON } from "./generation.ts";
import { ensureShardDescriptor, shardDir } from "./shard.ts";
import { attributeTornRealmAppend } from "./sync-placement-realm-attribution.ts";
import { REALM_EXTENSION_LIMIT, REALM_EXTENSION_LOG_MAX_BYTES, RealmExtensionFormatError, type RealmExtension } from "./sync-placement-realm-extension-format.ts";
import { readRealmExtensionHistory, REALM_EXTENSION_LOG, type RealmExtensionBinding } from "./sync-placement-realm-extension-storage.ts";
import type { RealmIntent } from "./sync-placement-realm-intent-format.ts";
import type { RealmIntentProof } from "./sync-placement-realm-intent-storage.ts";
import { verifyTornRealmAppend } from "./sync-placement-realm-torn.ts";

const fail = (): never => { throw new RealmExtensionFormatError(); };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
const owned = (stat: BigIntStats): void => {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== 0o600n) fail();
};

/**
 * Empty curated metadata at the fixed shard path, written so that every interruption leaves the realm `not-local`.
 * `generation.json` is last: capture, 0.28.2 and the #450 inventory all read a project without it as a scaffold, so a
 * crash after any earlier file creates nothing anyone acts on. The immutable source-proof companion (empty
 * `migration-sources.json` plus `generation-seal.json`) precedes it for the same reason: a realm is never visible
 * with `generation.json` but without the provenance capture revalidates.
 */
export function ensureCuratedRealmMetadata(home: string, project: string, generation: string, machine: { id: string; label?: string }): { created: boolean } {
  const dir = shardDir(home, project);
  if (readProfileJSON(join(dir, "generation.json")) !== undefined) return { created: false };
  ensureShardDescriptor(home, project);
  for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
  const identity = { id: machine.id, label: typeof machine.label === "string" ? machine.label : machine.id };
  for (const path of ["machine.json", "legacy/machine.json", "legacy-main/machine.json"]) {
    const file = join(dir, path), prior = readProfileJSON(file) as { id?: unknown } | undefined;
    if (prior === undefined) writeProfileJSON(file, identity);
    else if (prior?.id !== identity.id) fail();
  }
  const sources: unknown[] = [], sourceFile = join(dir, "migration-sources.json"), sourceValue = { schema: "agent-mem.migration-sources/v1", sources };
  const sourcePrior = readProfileJSON(sourceFile);
  if (sourcePrior === undefined) writeProfileJSON(sourceFile, sourceValue);
  else if (canonicalJSON(sourcePrior) !== canonicalJSON(sourceValue)) fail();
  const descriptor = generationDescriptor(generation), sealFile = join(dir, "generation-seal.json");
  const sealValue = { schema: "agent-mem.generation-seal/v1", generation, descriptorHash: hashJSON(descriptor), sourceDigest: hashJSON({ sources, legacyCommit: undefined }) };
  const sealPrior = readProfileJSON(sealFile);
  if (sealPrior === undefined) writeProfileJSON(sealFile, sealValue);
  else if (canonicalJSON(sealPrior) !== canonicalJSON(sealValue)) fail();
  writeProfileJSON(join(dir, "generation.json"), descriptor);
  fsyncDirectory(dir); fsyncDirectory(join(dir, ".."));
  return { created: true };
}

/**
 * Append the frozen record, completing an interrupted byte prefix of itself when one is attributed to `intent`.
 * Nothing else may occupy the next position: the prefix hash and length are the intent's own independent evidence.
 */
export function appendRealmExtension(home: string, binding: RealmExtensionBinding, intent: RealmIntent, record: RealmExtension, options: RealmIntentProof): void {
  const file = join(home, REALM_EXTENSION_LOG), history = readRealmExtensionHistory(home, binding, { attributeTorn: () => true });
  const bytes = Buffer.concat([history.logBytes, history.torn]);
  if (history.records.length + 1 !== intent.sequence || history.headHash !== intent.previousHash) fail();
  let remainder: Buffer;
  const line = Buffer.from(canonicalJSON(record) + "\n");
  if (history.torn.length) {
    // verifyTornRealmAppend re-derives the prefix from the intent itself, so it never trusts the tail it completes.
    if (!verifyTornRealmAppend(bytes, intent, record).equals(history.logBytes)) fail();
    remainder = line.subarray(history.torn.length);
  } else {
    if (history.logBytes.length !== intent.previousLogBytes || digest(history.logBytes) !== intent.previousLogHash) fail();
    remainder = line;
  }
  if (bytes.length + remainder.length > REALM_EXTENSION_LOG_MAX_BYTES || history.records.length + 1 > REALM_EXTENSION_LIMIT) fail();
  history.assertCurrent(); options.assertCurrent();
  const before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (before) { owned(before); if (Number(before.size) !== bytes.length) fail(); }
  const fd = before ? openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
    : openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened);
    if (before ? stamp(opened) !== stamp(before) : Number(opened.size) !== 0) fail();
    for (let at = 0; at < remainder.length;) at += writeSync(fd, remainder, at, remainder.length - at);
    fsyncSync(fd);
    if (Number(fstatSync(fd, { bigint: true }).size) !== bytes.length + remainder.length) fail();
  } finally { closeSync(fd); }
  fsyncDirectory(home); options.assertCurrent();
  const installed = readRealmExtensionHistory(home, binding);
  if (installed.torn.length || installed.records.length !== intent.sequence || installed.records.at(-1)?.seal !== record.seal) fail();
}

/**
 * Cut back only an incomplete append this intent authorized, when a person abandons before it committed.
 * The retained evidence names the exact prefix and the incomplete bytes are no line any reader folds; a tail that
 * cannot be attributed to this intent refuses instead of being removed.
 */
export function discardRealmExtensionTail(home: string, binding: RealmExtensionBinding, intent: RealmIntent, options: RealmIntentProof): { discarded: number } {
  const file = join(home, REALM_EXTENSION_LOG), history = readRealmExtensionHistory(home, binding, { attributeTorn: () => true });
  if (history.records.length + 1 !== intent.sequence || history.headHash !== intent.previousHash
    || history.logBytes.length !== intent.previousLogBytes || digest(history.logBytes) !== intent.previousLogHash) fail();
  if (!history.torn.length) return { discarded: 0 };
  if (!attributeTornRealmAppend(home, binding, { prefix: history.logBytes, tail: history.torn, sequence: intent.sequence, headHash: history.headHash })) fail();
  options.assertCurrent();
  const before = lstatSync(file, { bigint: true }); owned(before);
  if (Number(before.size) !== history.logBytes.length + history.torn.length) fail();
  const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (stamp(opened) !== stamp(before)) fail();
    // A zero-length log file is itself a refusal, so an emptied chain keeps no file instead of an empty one.
    if (intent.previousLogBytes === 0) unlinkSync(file); else ftruncateSync(fd, intent.previousLogBytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(home); options.assertCurrent();
  const after = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (intent.previousLogBytes === 0 ? after !== undefined : !after || Number(after.size) !== intent.previousLogBytes) fail();
  const installed = readRealmExtensionHistory(home, binding);
  if (installed.torn.length || installed.records.length + 1 !== intent.sequence) fail();
  return { discarded: history.torn.length };
}
