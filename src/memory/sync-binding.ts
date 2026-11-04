import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import type { MemoryStore } from "./store.ts";

/** Metadata-only sharded sync epoch. Hash complete source bytes, never notes or unopened shards. */
export function shardSyncBinding(store: MemoryStore): string { return captureShardSyncBinding(store, true); }
/** Selection bytes may change only after this sync commits; source/policy identity remains pinned across that commit. */
export function shardSyncSourceBinding(store: MemoryStore): string { return captureShardSyncBinding(store, false); }
function captureShardSyncBinding(store: MemoryStore, selection: boolean): string {
  const unavailable = (): never => { throw new Error("sharded sync binding unavailable"); };
  if (!store.profile.sharded) return unavailable();
  const uid = process.getuid?.(); if (uid === undefined) return unavailable();
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const owned = (stat: BigIntStats, directory: boolean, privateMode = true) => {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      || stat.uid !== BigInt(uid) || privateMode && (stat.mode & 0o077n) !== 0n) unavailable();
  };
  const home = store.profile.home, digest = createHash("sha256"), directories = new Map<string, BigIntStats>(), checks: (() => void)[] = [];
  const emit = (value: unknown) => { digest.update(JSON.stringify(value) + "\n"); };
  const directory = (dir: string): void => {
    if (directories.has(dir)) return;
    const rel = relative(home, dir); if (rel === ".." || rel.startsWith(".." + sep)) unavailable();
    if (dir !== home) directory(dirname(dir));
    const before = lstatSync(dir, { bigint: true }); owned(before, true); directories.set(dir, before);
    emit(["directory", dir, String(before.dev), String(before.ino)]);
    checks.push(() => { const now = lstatSync(dir, { bigint: true }); owned(now, true); if (!same(before, now)) unavailable(); });
  };
  // Policy config keeps its established file modes inside this already-private owned home. Its complete bytes/inode still bind the epoch.
  const source = (file: string, privateMode = true): void => {
    directory(dirname(file));
    let before: BigIntStats;
    try { before = lstatSync(file, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      emit(["source", file, "absent"]);
      checks.push(() => { if (lstatSync(file, { bigint: true, throwIfNoEntry: false }) !== undefined) unavailable(); }); return;
    }
    owned(before, false, privateMode);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true }); owned(opened, false, privateMode); if (!same(before, opened)) unavailable();
      const content = createHash("sha256"), buffer = Buffer.allocUnsafe(65_536); let bytes = 0n;
      for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; content.update(buffer.subarray(0, n)); bytes += BigInt(n); }
      const after = fstatSync(fd, { bigint: true }); owned(after, false, privateMode);
      if (bytes !== before.size || !same(before, after) || !same(before, lstatSync(file, { bigint: true }))) unavailable();
      emit(["source", file, "present", String(before.dev), String(before.ino), String(before.size), String(before.mtimeNs), String(before.ctimeNs), content.digest("hex")]);
    } finally { closeSync(fd); }
    checks.push(() => { const now = lstatSync(file, { bigint: true }); owned(now, false, privateMode); if (!same(before, now)) unavailable(); });
  };
  try {
    directory(home);
    for (const name of [...(selection ? ["profile.json", "shards.json"] : []), "aliases.jsonl", "amem.config.json", "machine.json"]) source(join(home, name), name !== "amem.config.json");
    const targets = [...store.openedSyncTargets()].sort((a, b) => a.dir.localeCompare(b.dir));
    for (const target of targets) {
      directory(target.dir);
      emit(["target", target.dir, target.profile.generation ?? null, target.machine.id, target.profile.shardUser ?? false, target.profile.shardKey ?? null]);
      for (const name of ["project.json", "generation.json", "generation-seal.json", "machine.json"]) source(join(target.dir, name));
    }
    for (const check of checks) check();
    return digest.digest("hex");
  } catch { return unavailable(); }
}

