/** Person coordinator's precommit-only metadata cleanup. No rollback, source rewrite, renewal or package measurement. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync, readSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { types } from "node:util";
import { canonicalJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { placementEpochHash, SyncPlacementJournalError, type SyncPlacementJournalErrorCode } from "./sync-placement-journal-format.ts";
import { validatePlacementActivationIntent, readPlacementActivationIntent, clearPlacementActivationIntent, PLACEMENT_ACTIVATION_INTENT_FILE, type PlacementActivationIntent } from "./sync-placement-activation-storage.ts";
import { planSyncPlacementWriterRoots, SYNC_PLACEMENT_WRITER_ROOTS_FILE } from "./sync-placement-writer-roots.ts";
import { syncPlacementWriterId } from "./sync-placement-writers.ts";
import { SYNC_SCREEN_MAX_BYTES, SYNC_SCREEN_MAX_ROWS } from "./sync-screen.ts";

export interface PlacementAbandonOptions { mutation: MutationHandle; assertCurrent(): void }
export class PlacementActivationAbandonError extends Error {
  readonly code: "forward" | "metadata" | "bound";
  constructor(code: "forward" | "metadata" | "bound" = "metadata") {
    super(code === "forward"
      ? "activation markers or active fence changed; use forward --resume with a compatible recovery release"
      : code === "bound" ? "activation cleanup metadata exceeds the supported bound; inspect it with a compatible recovery release"
      : "activation cleanup metadata is unsafe, changed or unknown; inspect it with a compatible recovery release before deleting anything");
    this.name = "PlacementActivationAbandonError"; this.code = code;
  }
}
function fail(code: SyncPlacementJournalErrorCode = "corrupt"): never { throw new SyncPlacementJournalError(code); }
const bytes = (value: unknown) => Buffer.from(canonicalJSON(value) + "\n");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const identity = (s: BigIntStats) => [s.dev, s.ino, s.uid, s.mode].map(String).join(":");
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
function owned(s: BigIntStats, directory = false, links: readonly bigint[] = [1n], marker = false): void {
  if (s.isSymbolicLink() || s.uid !== BigInt(process.getuid?.() ?? -1)
    || (directory ? !s.isDirectory() || (s.mode & 0o077n) !== 0n : !s.isFile() || !links.includes(s.nlink) || (marker ? (s.mode & 0o022n) !== 0n : (s.mode & 0o777n) !== 0o600n))) fail();
}
interface Member { stat: BigIntStats; expected: Buffer }
interface State { files: Map<string, Member>; dirs: Map<string, BigIntStats> }
function readMember(file: string, expected: Buffer, prefix = false, links: readonly bigint[] = [1n], marker = false): Member | undefined {
  const before = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (!before) return undefined;
  owned(before, false, links, marker); if (before.size > BigInt(expected.length)) fail("bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); if (stamp(opened) !== stamp(before)) fail("changed");
    const data = Buffer.alloc(Number(opened.size) + 1); let at = 0;
    while (at < data.length) { const n = readSync(fd, data, at, data.length - at, at); if (!n) break; at += n; }
    if (at !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(lstatSync(file, { bigint: true })) !== stamp(opened)) fail("changed");
    if ((!prefix && at !== expected.length) || !data.subarray(0, at).equals(expected.subarray(0, at))) fail("conflict");
    return { stat: opened, expected };
  } finally { closeSync(fd); }
}
function directory(path: string): BigIntStats | undefined {
  const value = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (value) owned(value, true); return value;
}
function names(path: string, maximum: number): string[] {
  const result: string[] = [], iterator = opendirSync(path); let size = 2;
  try { for (;;) { const entry = iterator.readSync(); if (!entry) break; if (result.length >= maximum) fail("bound");
    size += Buffer.byteLength(JSON.stringify(entry.name)) + 1; if (size > SYNC_SCREEN_MAX_BYTES) fail("bound"); result.push(entry.name);
  } } finally { iterator.closeSync(); } return result.sort();
}
/** Called only after person approval and under activation's existing live profile/readers/sync/mutation fences. */
export function abandonPlacementActivation(homeInput: string, input: PlacementActivationIntent, options: PlacementAbandonOptions): void {
  try {
    const intent = validatePlacementActivationIntent(input), initialHome = lstatSync(homeInput, { bigint: true }); owned(initialHome, true);
    const home = realPath(homeInput); if (home !== intent.home || identity(directory(home)!) !== identity(initialHome)) fail("changed");
    const epochHash = placementEpochHash(intent.epoch), storage = join(home, "sync-placement"), epochs = join(storage, "epochs"), epochDir = join(epochs, epochHash);
    const intentFile = join(home, PLACEMENT_ACTIVATION_INTENT_FILE), intentBytes = bytes(intent), intentTemp = intentFile + ".pending-" + hash(intentBytes);
    const roots = intent.roots.map(root => {
      const writerId = syncPlacementWriterId(root), writer = intent.plan.writers.find(value => value.writerId === writerId); if (!writer) fail("conflict");
      return { root, writerId, version: writer.version, pin: writer.pin };
    });
    const locatorBytes = bytes(planSyncPlacementWriterRoots({ epochHash, homeHash: intent.epoch.homeHash, activationHash: intent.plan.seal, roots },
      { epochHash, homeHash: intent.epoch.homeHash, activationHash: intent.plan.seal, writers: intent.plan.writers }));
    const locator = join(home, SYNC_PLACEMENT_WRITER_ROOTS_FILE), locatorTemp = locator + ".pending-" + hash(locatorBytes);
    const expectedEpoch = new Map([["epoch.json", bytes(intent.epoch)], ["activation.json", bytes(intent.plan)]]);
    let clearing = false;
    const proof = () => {
      assertMutationHandle(options.mutation, home); options.assertCurrent(); assertMutationHandle(options.mutation, home);
      if (identity(directory(home)!) !== identity(initialHome)) fail("changed");
      try {
        if (!readMember(join(home, "profile.json"), Buffer.from(intent.previousProfile), false, [1n], true)
          || !readMember(join(home, "shards.json"), Buffer.from(intent.previousShards), false, [1n], true)) throw new PlacementActivationAbandonError("forward");
      } catch { throw new PlacementActivationAbandonError("forward"); }
      if (directory(storage) && lstatSync(join(storage, "active.json"), { throwIfNoEntry: false })) throw new PlacementActivationAbandonError("forward");
      const actual = readPlacementActivationIntent(home);
      if (actual ? canonicalJSON(actual) !== canonicalJSON(intent) : !clearing) fail("changed");
    };
    const scan = (): State => {
      const files = new Map<string, Member>(), dirs = new Map<string, BigIntStats>([[home, directory(home)!]]);
      for (const path of [storage, epochs, epochDir]) { const stat = directory(path); if (stat) dirs.set(path, stat); }
      if (dirs.has(storage)) for (const name of names(storage, 2)) if (name !== "epochs") fail("corrupt");
      const knownTemps = new Set([intentTemp, locatorTemp]);
      for (const name of names(home, SYNC_SCREEN_MAX_ROWS)) if (name.startsWith(PLACEMENT_ACTIVATION_INTENT_FILE + ".pending-") || name.startsWith(SYNC_PLACEMENT_WRITER_ROOTS_FILE + ".pending-"))
        if (!knownTemps.has(join(home, name))) fail("corrupt");
      const add = (path: string, expected: Buffer, prefix = false, links: readonly bigint[] = [1n]) => { const value = readMember(path, expected, prefix, links); if (value) files.set(path, value); return value; };
      const final = add(locator, locatorBytes, false, [1n, 2n]), temp = add(locatorTemp, locatorBytes, true, [1n, 2n]);
      if (final?.stat.nlink === 2n || temp?.stat.nlink === 2n) {
        if (!final || !temp || final.stat.size !== BigInt(locatorBytes.length) || temp.stat.size !== BigInt(locatorBytes.length) || stamp(final.stat) !== stamp(temp.stat)) fail("corrupt");
      }
      if (dirs.has(epochDir)) for (const name of names(epochDir, 3)) { const expected = expectedEpoch.get(name); if (!expected) fail("corrupt"); add(join(epochDir, name), expected, true); }
      const current = add(intentFile, intentBytes, false, [1n, 2n]), companion = add(intentTemp, intentBytes, false, [1n, 2n]);
      if (current?.stat.nlink === 2n || companion) {
        if (!current || !companion || current.stat.nlink !== 2n || companion.stat.nlink !== 2n || stamp(current.stat) !== stamp(companion.stat)) fail("corrupt");
      }
      if (!current && !clearing) fail("changed"); return { files, dirs };
    };
    proof(); let state = scan();
    const check = () => {
      proof(); const next = scan();
      const expectedFiles = [...state.files.keys()].filter(path => !clearing || path !== intentFile).sort(), foundFiles = [...next.files.keys()].filter(path => !clearing || path !== intentFile).sort();
      if (canonicalJSON(expectedFiles) !== canonicalJSON(foundFiles) || canonicalJSON([...state.dirs.keys()].sort()) !== canonicalJSON([...next.dirs.keys()].sort())) fail("changed");
      for (const [path, before] of state.files) { const after = next.files.get(path); if (clearing && path === intentFile && !after) continue; if (!after || stamp(before.stat) !== stamp(after.stat)) fail("changed"); }
      for (const [path, before] of state.dirs) if (identity(before) !== identity(next.dirs.get(path)!)) fail("changed");
    };
    const sync = (path: string) => {
      check(); const expected = state.dirs.get(path); if (!expected) fail("changed"); const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { if (identity(fstatSync(fd, { bigint: true })) !== identity(expected)) fail("changed"); fsyncSync(fd); } finally { closeSync(fd); } check();
    };
    const remove = (path: string) => {
      if (!state.files.has(path)) return; check(); const before = state.files.get(path)!; unlinkSync(path); state.files.delete(path);
      for (const [peer, item] of state.files) if (item.stat.dev === before.stat.dev && item.stat.ino === before.stat.ino) {
        const now = lstatSync(peer, { bigint: true }); owned(now);
        if (before.stat.nlink !== 2n || now.nlink !== 1n || now.dev !== item.stat.dev || now.ino !== item.stat.ino || now.uid !== item.stat.uid || now.mode !== item.stat.mode || now.size !== item.stat.size || now.mtimeNs !== item.stat.mtimeNs) fail("changed");
        item.stat = now;
      }
      sync(dirname(path));
    };
    remove(locatorTemp); remove(locator);
    for (const name of ["activation.json", "epoch.json"]) remove(join(epochDir, name));
    if (state.dirs.has(epochDir)) { check(); if (names(epochDir, 1).length) fail("changed"); rmdirSync(epochDir); state.dirs.delete(epochDir); sync(epochs); }
    remove(intentTemp);
    // A prior owner may have unlinked a member or removed this epoch before its directory fsync.
    // Reassert every retained parent before the intent can acknowledge that cleanup as complete.
    for (const path of [epochs, storage, home]) if (state.dirs.has(path)) sync(path);
    check(); clearing = true;
    clearPlacementActivationIntent(home, intent, { mutation: options.mutation, assertCurrent: check }); state.files.delete(intentFile); check();
  } catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error) && error instanceof PlacementActivationAbandonError) throw error;
    if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SyncPlacementJournalError) {
      const value = Object.getOwnPropertyDescriptor(error, "code"); if (value && "value" in value && ["invalid", "corrupt", "bound", "conflict", "pending", "changed", "authorization", "policy", "local", "busy"].includes(value.value)) throw new PlacementActivationAbandonError(value.value === "bound" ? "bound" : "metadata");
    }
    throw new PlacementActivationAbandonError();
  }
}
