/** Root selector commitment only; this module never writes or activates a profile. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON, PROFILE_LOCK_TIMEOUT_MS } from "./generation.ts";
import { realPath } from "./platform.ts";

export const PUBLIC_PRUNE_INTENT = "public-prune-view.intent.json";
const MAX_BYTES = 65_536;
export interface PublicPruneViewV1 {
  schema: "agent-mem.public-prune-view/v1";
  receivingGeneration: string;
  realms: Record<string, string>;
}
const unavailable = (): never => { throw new Error("public prune view unavailable"); };
function guard(ok: unknown): asserts ok { if (!ok) unavailable(); }
function protectedCall<T>(work: () => T): T { try { return work(); } catch { return unavailable(); } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hex = (value: unknown, size: number): value is string => typeof value === "string" && value.length === size && /^[a-f0-9]+$/.test(value);
function realmKey(value: string): boolean {
  if (!value.isWellFormed()) return false;
  if (value === "user") return true;
  if (!value.startsWith("project:")) return false;
  const key = value.slice("project:".length);
  return key.length > 0 && key === key.trim() && !/\p{Cc}/u.test(key);
}
export function validatePublicPruneView(input: unknown): PublicPruneViewV1 {
  return protectedCall(() => {
    guard(object(input) && Reflect.ownKeys(input).length === 3 && ["schema", "receivingGeneration", "realms"].every(key => Object.hasOwn(input, key)));
    guard(input.schema === "agent-mem.public-prune-view/v1" && hex(input.receivingGeneration, 32) && object(input.realms));
    const keys = Object.keys(input.realms).sort();
    guard(Reflect.ownKeys(input.realms).length === keys.length && keys.length <= Math.floor(MAX_BYTES / 64));
    const realms: Record<string, string> = {}; let minimumBytes = 0;
    for (const key of keys) {
      minimumBytes += Buffer.byteLength(key, "utf8") + 64; guard(minimumBytes <= MAX_BYTES);
      const hash = input.realms[key]; guard(realmKey(key) && hex(hash, 64));
      Object.defineProperty(realms, key, { value: hash, enumerable: true, writable: true, configurable: true });
    }
    const value: PublicPruneViewV1 = { schema: input.schema, receivingGeneration: input.receivingGeneration, realms };
    guard(Buffer.byteLength(canonicalJSON(value), "utf8") <= MAX_BYTES);
    return value;
  });
}
export function publicPruneViewHash(view: PublicPruneViewV1): string { return hashJSON(validatePublicPruneView(view)); }
/** A v2 reader may wait for a short cooperating writer, never authorize or repair one.
 * No liveness helper, network call, PID exemption or mutation occurs on this path. */
export function waitForPublicPruneWriter(home: string): void {
  protectedCall(() => {
    const deadline = Date.now() + PROFILE_LOCK_TIMEOUT_MS;
    const intentFile = join(home, PUBLIC_PRUNE_INTENT), lockFile = join(home, "profile.lock");
    if (!lstatSync(intentFile, { throwIfNoEntry: false }) && !lstatSync(lockFile, { throwIfNoEntry: false })) return;
    const small = (file: string, limit: number): Record<string, unknown> => {
      const before = lstatSync(file); privateStat(before); guard(before.size > 0 && before.size <= limit);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd); privateStat(opened); guard(opened.size > 0 && opened.size <= limit);
        const bytes = Buffer.alloc(opened.size + 1); let count = 0;
        while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
        const after = fstatSync(fd); privateStat(after); guard(count === opened.size && same(opened, after));
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count))); guard(object(parsed)); return parsed;
      } finally { closeSync(fd); }
    };
    const profileFile = join(home, "profile.json");
    if (!lstatSync(profileFile, { throwIfNoEntry: false })) return; // Implicit shared-v1 has no selector marker.
    const profile = small(profileFile, MAX_BYTES);
    if (profile.schema !== "agent-mem.profile/v2") return; // v1 admission/intent behavior is unchanged.
    for (;;) {
      try {
        const intent = lstatSync(intentFile, { throwIfNoEntry: false }), lock = lstatSync(lockFile, { throwIfNoEntry: false });
        if (!intent && !lock) return;
        if (intent) {
          const pending = small(intentFile, 1024 * 1024);
          guard(pending.schema === "agent-mem.public-prune-advance/v1" && pending.home === realPath(home) && pending.generation === profile.generation);
        }
        if (lock) {
          privateStat(lock);
          if (lock.size) {
            const owner = small(lockFile, 4096);
            guard(Reflect.ownKeys(owner).length === 3 && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && hex(owner.signature, 64) && hex(owner.token, 32));
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // Publication disappeared normally; retry the bounded observation.
      }
      const remaining = deadline - Date.now(); guard(remaining > 0); Bun.sleepSync(Math.min(5, remaining));
    }
  });
}
/** Any unresolved intent blocks reads. Never remove it, including malformed bytes. */
export function assertNoPublicPruneIntent(home: string): void {
  protectedCall(() => { waitForPublicPruneWriter(home); guard(!lstatSync(join(home, PUBLIC_PRUNE_INTENT), { throwIfNoEntry: false })); });
}
function privateStat(stat: Stats, directory = false): void {
  guard(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1));
  guard(stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
}
function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
/** Trusted activation bootstrap reads the artifact while intent fences ordinary readers. */
export function readPublicPruneViewForActivation(home: string, hash: string, generation: string): PublicPruneViewV1 {
  return protectedCall(() => {
    guard(hex(hash, 64) && hex(generation, 32));
    const original = lstatSync(home); privateStat(original, true);
    const root = realPath(home), rootStat = lstatSync(root); privateStat(rootStat, true); guard(rootStat.dev === original.dev && rootStat.ino === original.ino);
    const directory = join(root, "public-prune-input-sets"), dirStat = lstatSync(directory); privateStat(dirStat, true);
    const file = join(directory, `${hash}.json`), before = lstatSync(file); privateStat(before); guard(before.size > 0 && before.size <= MAX_BYTES);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); privateStat(opened); guard(same(before, opened));
      const bytes = Buffer.alloc(before.size + 1); let count = 0;
      while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (read === 0) break; count += read; }
      guard(count === before.size);
      const after = fstatSync(fd), named = lstatSync(file); privateStat(after); privateStat(named); guard(same(before, after) && same(after, named));
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
      const view = validatePublicPruneView(JSON.parse(text)), canonical = canonicalJSON(view);
      guard(text === canonical || text === canonical + "\n");
      guard(view.receivingGeneration === generation && hashJSON(view) === hash);
      const currentRoot = lstatSync(root), currentDir = lstatSync(directory), currentHome = lstatSync(home);
      privateStat(currentRoot, true); privateStat(currentDir, true); privateStat(currentHome, true);
      guard(currentRoot.dev === rootStat.dev && currentRoot.ino === rootStat.ino && currentHome.dev === original.dev && currentHome.ino === original.ino
        && currentDir.dev === dirStat.dev && currentDir.ino === dirStat.ino);
      return view;
    } finally { closeSync(fd); }
  });
}

export function readPublicPruneView(home: string, hash: string, generation: string): PublicPruneViewV1 {
  assertNoPublicPruneIntent(home);
  const result = readPublicPruneViewForActivation(home, hash, generation);
  assertNoPublicPruneIntent(home); return result;
}
