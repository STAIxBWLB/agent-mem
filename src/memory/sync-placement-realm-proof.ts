/** Frozen record evidence for recovery of an interrupted realm extension. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory, hashJSON } from "./generation.ts";
import { assertMutationHandle } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { RealmExtensionFormatError, validateRealmExtension, type RealmExtension } from "./sync-placement-realm-extension-format.ts";
import { validateRealmIntent, type RealmIntent } from "./sync-placement-realm-intent-format.ts";
import type { RealmIntentProof } from "./sync-placement-realm-intent-storage.ts";

const SCHEMA = "agent-mem.sync-placement-realm-proof/v1", LIMIT = 8192;
const fail = (): never => { throw new RealmExtensionFormatError(); };
const pathOf = (home: string, intent: RealmIntent) => join(home, `placement-realm-proof-${intent.seal}.json`);
const stamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
function owned(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== 0o600n) fail();
}
function checkIntentRecord(intent: RealmIntent, record: RealmExtension): void {
  if (record.epochHash !== intent.epochHash || record.activationHash !== intent.activationHash || record.homeHash !== intent.homeHash
    || record.generation !== intent.generation || record.sequence !== intent.sequence || record.previousHash !== intent.previousHash
    || record.realm.keyHash !== intent.keyHash || record.aliasesHash !== intent.aliasesHash || record.policyHash !== intent.policyHash
    || record.writerHash !== intent.writerHash || record.journal.sequence !== intent.journal.sequence || record.journal.headHash !== intent.journal.headHash
    || intent.sourceHash !== null && record.sourceHash !== intent.sourceHash) fail();
}
function bytesOf(intent: RealmIntent, record: RealmExtension): string {
  checkIntentRecord(intent, record);
  const body = { schema: SCHEMA, intent: intent.seal, record }, result = { ...body, seal: hashJSON(body) };
  const text = canonicalJSON(result) + "\n";
  if (Buffer.byteLength(text) > LIMIT) fail();
  return text;
}
/** Reads only stable private regular bytes and refuses any malformed or differently bound proof. */
function readProof(homeInput: string, raw: RealmIntent): { record: RealmExtension; stat: BigIntStats } | undefined {
  const home = realPath(homeInput), intent = validateRealmIntent(raw), file = pathOf(home, intent);
  if (intent.home !== home) fail();
  const before = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (!before) return undefined;
  owned(before); if (before.size <= 0n || before.size > BigInt(LIMIT)) fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content: Buffer;
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (stamp(opened) !== stamp(before)) fail();
    const data = Buffer.alloc(Number(opened.size) + 1); let offset = 0;
    while (offset < data.length) { const n = readSync(fd, data, offset, data.length - offset, offset); if (!n) break; offset += n; }
    if (offset !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(lstatSync(file, { bigint: true })) !== stamp(opened)) fail();
    content = data.subarray(0, offset);
  } finally { closeSync(fd); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content), value = JSON.parse(text) as Record<string, unknown>;
  if (!value || Object.keys(value).sort().join(",") !== "intent,record,schema,seal" || value.schema !== SCHEMA || value.intent !== intent.seal) return fail();
  const record = validateRealmExtension(value.record);
  if (bytesOf(intent, record) !== text) fail();
  return { record, stat: before };
}
export function readRealmProof(homeInput: string, raw: RealmIntent): RealmExtension | undefined { return readProof(homeInput, raw)?.record; }
/** Under the home fence, finish an attributable staging prefix and atomically install the frozen proof. */
export function writeRealmProof(homeInput: string, raw: RealmIntent, input: RealmExtension, proof: RealmIntentProof): void {
  const home = realPath(homeInput), intent = validateRealmIntent(raw), record = validateRealmExtension(input);
  if (intent.home !== home) fail();
  const check = () => { assertMutationHandle(proof.mutation, home); proof.assertCurrent(); assertMutationHandle(proof.mutation, home); };
  const text = bytesOf(intent, record), expected = Buffer.from(text), file = pathOf(home, intent), staged = `${file}.pending`;
  check(); const prior = readRealmProof(home, intent);
  if (prior) { if (canonicalJSON(prior) !== canonicalJSON(record)) fail(); return; }
  let fd: number;
  try { fd = openSync(staged, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; fd = openSync(staged, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  let stagedStamp: string;
  try {
    const stat = fstatSync(fd, { bigint: true }); owned(stat);
    if (stat.size > BigInt(expected.length)) fail();
    const present = Buffer.alloc(Number(stat.size)); let at = 0;
    while (at < present.length) { const n = readSync(fd, present, at, present.length - at, at); if (!n) fail(); at += n; }
    if (!present.equals(expected.subarray(0, present.length)) || stamp(lstatSync(staged, { bigint: true })) !== stamp(stat)) fail();
    check(); for (let at = present.length; at < expected.length;) { const n = writeSync(fd, expected, at, expected.length - at, at); if (n <= 0) fail(); at += n; }
    fsyncSync(fd);
    const finished = fstatSync(fd, { bigint: true }); owned(finished);
    if (finished.size !== BigInt(expected.length) || stamp(lstatSync(staged, { bigint: true })) !== stamp(finished)) fail();
    stagedStamp = stamp(finished);
  } finally { closeSync(fd); }
  check(); if (lstatSync(file, { throwIfNoEntry: false })) fail();
  if (stamp(lstatSync(staged, { bigint: true })) !== stagedStamp!) fail();
  renameSync(staged, file); fsyncDirectory(home); check();
  if (canonicalJSON(readRealmProof(home, intent)) !== canonicalJSON(record)) fail();
}

export function hasRealmProofStage(homeInput: string, raw: RealmIntent): boolean {
  const home = realPath(homeInput), intent = validateRealmIntent(raw);
  if (intent.home !== home) fail();
  return !!lstatSync(`${pathOf(home, intent)}.pending`, { throwIfNoEntry: false });
}

function readStage(home: string, intent: RealmIntent, candidate: RealmExtension): BigIntStats | undefined {
  const staged = `${pathOf(home, intent)}.pending`, before = lstatSync(staged, { bigint: true, throwIfNoEntry: false });
  if (!before) return undefined;
  const expected = Buffer.from(bytesOf(intent, validateRealmExtension(candidate)));
  owned(before); if (before.size > BigInt(expected.length)) fail();
  const fd = openSync(staged, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (stamp(opened) !== stamp(before)) fail();
    const data = Buffer.alloc(Number(opened.size)); let at = 0;
    while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (!n) fail(); at += n; }
    if (!data.equals(expected.subarray(0, data.length)) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened)
      || stamp(lstatSync(staged, { bigint: true })) !== stamp(opened)) fail();
    return before;
  } finally { closeSync(fd); }
}
/** Preview an owned exact proof prefix without changing it. */
export function inspectRealmProofStage(homeInput: string, raw: RealmIntent, candidate: RealmExtension): boolean {
  const home = realPath(homeInput), intent = validateRealmIntent(raw); if (intent.home !== home) fail();
  return !!readStage(home, intent, candidate);
}

/** Abandon removes only validated proof bytes, after any attributable log tail has been removed. */
export function clearRealmProof(homeInput: string, raw: RealmIntent, proof: RealmIntentProof, candidate?: RealmExtension): void {
  const home = realPath(homeInput), intent = validateRealmIntent(raw), file = pathOf(home, intent);
  assertMutationHandle(proof.mutation, home); proof.assertCurrent();
  const staged = `${file}.pending`, beforeStage = lstatSync(staged, { bigint: true, throwIfNoEntry: false });
  if (beforeStage) {
    const selected = candidate ?? fail();
    const inspected = readStage(home, intent, selected); if (!inspected || stamp(inspected) !== stamp(beforeStage)) fail();
    proof.assertCurrent(); assertMutationHandle(proof.mutation, home);
    if (stamp(lstatSync(staged, { bigint: true })) !== stamp(beforeStage)) fail();
    unlinkSync(staged); fsyncDirectory(home); proof.assertCurrent();
  }
  const prior = readProof(home, intent); if (!prior) return;
  const before = prior.stat; owned(before);
  proof.assertCurrent(); assertMutationHandle(proof.mutation, home);
  if (stamp(lstatSync(file, { bigint: true })) !== stamp(before)) fail();
  unlinkSync(file); fsyncDirectory(home); proof.assertCurrent();
}
