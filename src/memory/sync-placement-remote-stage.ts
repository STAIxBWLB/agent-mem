/** Private, fenced staging for remote placement adoption; never rewrites an existing curated log. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, fsyncDirectory } from "./generation.ts";
import { assertMutationHandle } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { assertCuratedShardLayout, ensureShardDescriptor, shardDir } from "./shard.ts";
import type { RealmIntentProof } from "./sync-placement-realm-intent-storage.ts";
import { REMOTE_ADOPTION_MAX_BYTES, validateRemoteAdoption, type RemoteAdoption } from "./sync-placement-remote-adoption-format.ts";
import type { RemoteStagedPack } from "./sync-placement-remote-materialization.ts";

const fail = (): never => { throw new Error("Remote placement adoption staging is unavailable or changed; retain it for inspection."); };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
const companion = (home: string, plan: RemoteAdoption) => join(home, `placement-remote-adoption-${plan.keyHash}.json`);
const staging = (home: string, plan: RemoteAdoption) => join(home, `.placement-remote-adoption-${plan.keyHash}-${plan.seal}.stage`);
function ownedFile(s: BigIntStats): void {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.uid !== BigInt(process.getuid?.() ?? -1) || (s.mode & 0o777n) !== 0o600n) fail();
}
function ownedDir(dir: string): BigIntStats {
  const s = lstatSync(dir, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid?.() ?? -1) || (s.mode & 0o077n) !== 0n) fail();
  return s;
}
function check(home: string, proof: RealmIntentProof): void {
  assertMutationHandle(proof.mutation, home); proof.assertCurrent(); assertMutationHandle(proof.mutation, home);
}
function readOwned(file: string, max: number): Buffer | undefined {
  const before = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (!before) return undefined;
  ownedFile(before); if (before.size > BigInt(max)) return fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); ownedFile(opened); if (stamp(opened) !== stamp(before)) fail();
    const bytes = Buffer.alloc(Number(opened.size)); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) fail(); at += n; }
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(lstatSync(file, { bigint: true })) !== stamp(opened)) fail();
    return bytes;
  } finally { closeSync(fd); }
}
/** Complete only an existing exact prefix or a file created exclusively by this operation. */
function complete(home: string, file: string, expected: Buffer, proof: RealmIntentProof): void {
  check(home, proof);
  let fd: number;
  try { fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  try {
    const before = fstatSync(fd, { bigint: true }); ownedFile(before); if (before.size > BigInt(expected.length)) fail();
    const saved = Buffer.alloc(Number(before.size)); let at = 0;
    while (at < saved.length) { const n = readSync(fd, saved, at, saved.length - at, at); if (!n) fail(); at += n; }
    if (!saved.equals(expected.subarray(0, saved.length)) || stamp(lstatSync(file, { bigint: true })) !== stamp(before)) fail();
    check(home, proof);
    for (let pos = saved.length; pos < expected.length;) { const n = writeSync(fd, expected, pos, expected.length - pos, pos); if (n <= 0) fail(); pos += n; }
    fsyncSync(fd); const after = fstatSync(fd, { bigint: true }); ownedFile(after);
    if (after.size !== BigInt(expected.length) || stamp(lstatSync(file, { bigint: true })) !== stamp(after)) fail();
  } finally { closeSync(fd); }
  check(home, proof);
  if (!readOwned(file, expected.length)?.equals(expected)) fail();
}
function ensureDir(home: string, dir: string, parent: string, proof: RealmIntentProof): void {
  check(home, proof); if (!lstatSync(dir, { throwIfNoEntry: false })) { mkdirSync(dir, { mode: 0o700 }); fsyncDirectory(parent); }
  ownedDir(dir); check(home, proof);
}
export function readRemoteAdoption(homeInput: string, keyHash: string): RemoteAdoption | undefined {
  const home = realPath(homeInput);
  if (!/^[a-f0-9]{64}$/.test(keyHash)) return fail();
  const bytes = readOwned(join(home, `placement-remote-adoption-${keyHash}.json`), REMOTE_ADOPTION_MAX_BYTES); if (!bytes) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), plan = validateRemoteAdoption(JSON.parse(text));
    if (plan.keyHash !== keyHash || canonicalJSON(plan) + "\n" !== text) return fail(); return plan;
  } catch { return fail(); }
}
/** Record reviewed metadata before creating any staged content. */
export function writeRemoteAdoption(homeInput: string, value: RemoteAdoption, proof: RealmIntentProof): void {
  const home = realPath(homeInput), plan = validateRemoteAdoption(value), expected = Buffer.from(canonicalJSON(plan) + "\n"), file = companion(home, plan);
  check(home, proof); ownedDir(home);
  const prior = readRemoteAdoption(home, plan.keyHash);
  if (prior) { if (canonicalJSON(prior) !== canonicalJSON(plan)) fail(); return; }
  const pending = `${file}.${plan.seal}.pending`;
  complete(home, pending, expected, proof); check(home, proof);
  if (lstatSync(file, { throwIfNoEntry: false })) fail();
  renameSync(pending, file); fsyncDirectory(home); check(home, proof);
  if (canonicalJSON(readRemoteAdoption(home, plan.keyHash)) !== canonicalJSON(plan)) fail();
}
/** Stage exact content-addressed packs in a private directory no old realm reader opens. */
export function stageRemoteAdoption(homeInput: string, value: RemoteAdoption, packs: readonly RemoteStagedPack[], proof: RealmIntentProof): void {
  const home = realPath(homeInput), plan = validateRemoteAdoption(value); check(home, proof);
  if (canonicalJSON(readRemoteAdoption(home, plan.keyHash)) !== canonicalJSON(plan) || packs.length !== plan.packs.length) fail();
  for (let i = 0; i < packs.length; i++) {
    const expected = plan.packs[i], pack = packs[i];
    if (!expected || !pack || expected.name !== pack.name || expected.bytes !== pack.bytes.length || `sync-${sha(pack.bytes)}.jsonl` !== pack.name) fail();
  }
  const root = staging(home, plan), log = join(root, "log"); ensureDir(home, root, home, proof); ensureDir(home, log, root, proof);
  const names = new Set(plan.packs.map(pack => pack.name));
  if (readdirSync(root).some(name => name !== "log") || readdirSync(log).some(name => !names.has(name))) fail();
  for (const pack of packs) complete(home, join(log, pack.name), pack.bytes, proof);
  fsyncDirectory(log); fsyncDirectory(root); check(home, proof);
}
/** Install the complete staged log as one same-filesystem rename; work and machine data stay in place. */
export function installRemoteAdoptionLog(homeInput: string, project: string, value: RemoteAdoption, proof: RealmIntentProof): void {
  const home = realPath(homeInput), plan = validateRemoteAdoption(value);
  if (!project || sha(project) !== plan.keyHash) fail();
  check(home, proof); if (canonicalJSON(readRemoteAdoption(home, plan.keyHash)) !== canonicalJSON(plan)) fail();
  const root = staging(home, plan), log = join(root, "log"), projectDir = shardDir(home, project), destination = join(projectDir, "log");
  ownedDir(root);
  const verifyLog = (dir: string) => {
    ownedDir(dir); if (canonicalJSON(readdirSync(dir).sort()) !== canonicalJSON(plan.packs.map(pack => pack.name))) fail();
    for (const pack of plan.packs) { const data = readOwned(join(dir, pack.name), pack.bytes); if (!data || data.length !== pack.bytes || `sync-${sha(data)}.jsonl` !== pack.name) fail(); }
  };
  // A crash after rename leaves the exact destination and an empty owned stage; never rename or truncate it again.
  if (!lstatSync(log, { throwIfNoEntry: false })) {
    if (readdirSync(root).length || lstatSync(join(projectDir, "generation.json"), { throwIfNoEntry: false })) fail();
    assertCuratedShardLayout(home, { project }); ownedDir(projectDir); verifyLog(destination); check(home, proof); return;
  }
  const source = ownedDir(log);
  if (readdirSync(root).some(name => name !== "log")) fail();
  verifyLog(log);
  check(home, proof); assertCuratedShardLayout(home, { project });
  const projects = join(home, "projects"); ownedDir(projects);
  if (!lstatSync(projectDir, { throwIfNoEntry: false })) { mkdirSync(projectDir, { mode: 0o700 }); fsyncDirectory(projects); }
  const target = ownedDir(projectDir);
  for (const name of ["log", "local", "legacy", "legacy-main", "generation.json", "generation-seal.json", "migration-sources.json", "machine.json"])
    if (lstatSync(join(projectDir, name), { throwIfNoEntry: false })) throw new Error(`Remote placement adoption cannot replace existing curated subpath: ${name}.`);
  ensureShardDescriptor(home, project); check(home, proof);
  if (source.dev !== target.dev || lstatSync(destination, { throwIfNoEntry: false })) fail();
  const currentTarget = ownedDir(projectDir);
  if (stamp(ownedDir(log)) !== stamp(source) || currentTarget.dev !== target.dev || currentTarget.ino !== target.ino) fail();
  renameSync(log, destination); fsyncDirectory(root); fsyncDirectory(projectDir); check(home, proof);
  const installed = ownedDir(destination); if (installed.dev !== source.dev || installed.ino !== source.ino) fail();
}

/** Remove only this plan's attributable private staging; an installed curated log is never removed. */
export function clearRemoteAdoption(homeInput: string, value: RemoteAdoption, packs: readonly RemoteStagedPack[], proof: RealmIntentProof): void {
  const home = realPath(homeInput), plan = validateRemoteAdoption(value); check(home, proof);
  if (canonicalJSON(readRemoteAdoption(home, plan.keyHash)) !== canonicalJSON(plan) || packs.length !== plan.packs.length) fail();
  for (let i = 0; i < packs.length; i++) {
    const expected = plan.packs[i], pack = packs[i];
    if (!expected || !pack || expected.name !== pack.name || expected.bytes !== pack.bytes.length || `sync-${sha(pack.bytes)}.jsonl` !== pack.name) fail();
  }
  const root = staging(home, plan), log = join(root, "log"), stage = lstatSync(root, { bigint: true, throwIfNoEntry: false });
  if (stage) {
    ownedDir(root); if (readdirSync(root).some(name => name !== "log")) fail();
    if (lstatSync(log, { throwIfNoEntry: false })) {
      ownedDir(log); const byName = new Map(packs.map(pack => [pack.name, pack.bytes]));
      const names = readdirSync(log); if (names.some(name => !byName.has(name))) fail();
      // First prove every remaining prefix, then recheck each one immediately before removal.
      const saved = names.map(name => {
        const file = join(log, name), expected = byName.get(name)!, bytes = readOwned(file, expected.length), stat = lstatSync(file, { bigint: true });
        if (!bytes || !bytes.equals(expected.subarray(0, bytes.length))) return fail();
        return { file, expected, bytes, stamp: stamp(stat) };
      });
      for (const item of saved) {
        check(home, proof); if (stamp(lstatSync(item.file, { bigint: true })) !== item.stamp || !readOwned(item.file, item.expected.length)?.equals(item.bytes)) fail();
        unlinkSync(item.file);
      }
      fsyncDirectory(log); check(home, proof); rmdirSync(log); fsyncDirectory(root);
    }
    check(home, proof); if (readdirSync(root).length) fail(); rmdirSync(root); fsyncDirectory(home);
  }
  const file = companion(home, plan), expected = Buffer.from(canonicalJSON(plan) + "\n"), before = lstatSync(file, { bigint: true });
  check(home, proof); if (!readOwned(file, REMOTE_ADOPTION_MAX_BYTES)?.equals(expected) || stamp(lstatSync(file, { bigint: true })) !== stamp(before)) fail();
  unlinkSync(file); fsyncDirectory(home); check(home, proof);
}
