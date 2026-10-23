import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hookGit, hookGitBinary } from "./hook-git.ts";
import { hookCaptureScope } from "./hook-spool.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { memoryProjectKey, type ProjectGitRead } from "./memory/project.ts";
import { memoryGitArgv, memoryGitEnv } from "./memory/platform.ts";
import { hookNative, type HookNativeUsage } from "./hook-native.ts";

// Bump the derived cache schema if the shared native project-key mapping changes.
const SCHEMA = "agent-mem.hook-project/v1", CACHE_BYTES = 4096, CACHE_CWDS = 128;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Binding { schema: typeof SCHEMA; cwd: string; scope: string; validity: string; binary: string; project: string }
function read(file: string): Binding | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > CACHE_BYTES || stat.mode & 0o077 || stat.uid !== process.getuid?.()) return undefined;
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return undefined;
    const after = lstatSync(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return undefined;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "binary,cwd,project,schema,scope,validity"
      || value.schema !== SCHEMA || typeof value.cwd !== "string" || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope)
      || typeof value.validity !== "string" || !/^[a-f0-9]{64}$/.test(value.validity) || typeof value.binary !== "string" || !/^[a-f0-9]{64}$/.test(value.binary) || typeof value.project !== "string" || !value.project || value.project.length > 2048 || /[\x00-\x1f\x7f]/.test(value.project)) return undefined;
    return value;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function publish(dir: string, file: string, value: Binding, maintain: boolean): void {
  let temporary: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(dir, 0o700);
    // Only old, owned publication names are eligible; a recent writer keeps its temp.
    if (maintain) {
      const scan = opendirSync(dir);
      try {
        for (let count = 0; count < CACHE_CWDS * 2; count++) {
          const entry = scan.readSync(); if (!entry) break;
          if (!/^\.[a-f0-9]{64}-[a-f0-9]{24}$/.test(entry.name)) continue;
          const stale = join(dir, entry.name), before = lstatSync(stale, { throwIfNoEntry: false });
          if (!before?.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || Date.now() - before.mtimeMs < 60_000) continue;
          const after = lstatSync(stale, { throwIfNoEntry: false });
          if (after?.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs) rmSync(stale);
        }
      } finally { scan.closeSync(); }
    }
    // ponytail: 128 cached cwd identities, one bounded derived value each. New cwd misses
    // still resolve natively; a future cache policy may retire old entries without touching capture.
    if (!lstatSync(file, { throwIfNoEntry: false })) {
      const entries = opendirSync(dir);
      try { for (let count = 0; count <= CACHE_CWDS; count++) { if (!entries.readSync()) break; if (count === CACHE_CWDS - 1) return; } }
      finally { entries.closeSync(); }
    }
    const text = JSON.stringify(value); if (Buffer.byteLength(text) > CACHE_BYTES) return;
    temporary = join(dir, `.${hash(value.cwd)}-${randomBytes(12).toString("hex")}`);
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, file);
  } catch { /* Derived cache I/O never changes a successfully resolved identity. */ }
  finally { if (temporary) try { rmSync(temporary, { force: true }); } catch { /* Cache cleanup stays advisory too. */ } }
}
interface ResolverOptions { cwd: string; base: string; scope?: string; timeRemaining: () => number; maintainCache?: boolean; gitRead?: ProjectGitRead; assertComplete?: () => void; env?: NodeJS.ProcessEnv }

/** Prepare filesystem/cache binding once; suspended native reads replay only the shared resolver. */
function prepareHookProject(options: ResolverOptions) {
  const checkDeadline = () => {
    const remaining = options.timeRemaining();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("project deadline");
  };
  checkDeadline();
  const cwd = realPath(options.cwd), base = canonicalPath(options.base), binary = hookGitBinary(options.env);
  const scope = options.scope;
  if (scope !== undefined && (!scope || hookCaptureScope(cwd, base) !== scope)) throw new Error("project scope changed");
  const cwdStat = lstatSync(cwd);
  const prefixConfig = join(dirname(dirname(binary.file)), "etc", "gitconfig");
  // Unknown semantic scope cannot certify a reusable identity, but native Git can still
  // resolve the current project for a read-only brief. Never read or publish cache in this case.
  const validity = scope === undefined ? undefined : hookCaptureScope(cwd, base, true, prefixConfig);
  const dir = join(base, "hook-project"), named = lstatSync(dir, { throwIfNoEntry: false });
  const file = join(dir, `${hash(cwd)}.json`);
  const cached = scope !== undefined && (!named || named.isDirectory() && !named.isSymbolicLink() && !(named.mode & 0o077)) ? read(file) : undefined;
  const hit = cached?.cwd === cwd && cached.scope === scope && validity && cached.validity === validity && cached.binary === binary.revision && cacheableLocal(cwd, cached.project);
  const verifyBinary = () => {
    checkDeadline();
    const currentBinary = hookGitBinary(options.env);
    if (currentBinary.file !== binary.file || currentBinary.revision !== binary.revision) throw new Error("project binary changed");
    checkDeadline();
  };
  const verify = () => {
    verifyBinary();
    // A known strong binding includes every semantic field. Only the uncached,
    // unknown-validity case also needs its independent semantic scope check.
    if (scope === undefined) {
      const currentCwd = lstatSync(cwd);
      if (realPath(options.cwd) !== cwd || currentCwd.dev !== cwdStat.dev || currentCwd.ino !== cwdStat.ino) throw new Error("project cwd changed");
    } else {
      const currentValidity = hookCaptureScope(cwd, base, true, prefixConfig);
      if (currentValidity !== validity || !validity && hookCaptureScope(cwd, base) !== scope) throw new Error("project scope changed");
    }
    checkDeadline();
  };
  return { binary, verifyBinary, resolve(gitRead: ProjectGitRead, assertComplete?: () => void): string {
    checkDeadline();
    if (hit && cached) {
      assertComplete?.(); verify();
      return cached.project;
    }
    const project = memoryProjectKey(cwd, { repositoryIsolation: true, strictGitErrors: true, gitRead });
    // The synchronous resolver can catch an unknown native read internally. Fence that
    // suspended pass before any completion checks, cache publication or returned key.
    assertComplete?.(); verify();
    if (scope !== undefined && validity && cacheableLocal(cwd, project)) {
      checkDeadline();
      publish(dir, file, { schema: SCHEMA, cwd, scope, validity, binary: binary.revision, project }, options.maintainCache === true);
    }
    checkDeadline();
    return project;
  } };
}

/** Cache only a successful shared native resolver result, before alias resolution. */
export function resolveHookProject(options: ResolverOptions): string {
  const prepared = prepareHookProject(options);
  return prepared.resolve(options.gitRead ?? hookGit(options.timeRemaining, prepared.binary.file), options.assertComplete);
}

/** A local key's superproject chain depends on outer Git indexes. Cache only ordinary
 * standalone roots; linked/submodule/local nested layouts retain the native resolver. */
function cacheableLocal(cwd: string, project: string): boolean {
  if (!/.+@[a-f0-9]{8}$/.test(project)) return true;
  if (!project.endsWith(`@${hash(cwd).slice(0, 8)}`)) return false;
  try {
    const git = lstatSync(join(cwd, ".git"));
    if (!git.isDirectory() || git.isSymbolicLink()) return false;
    for (let folder = dirname(cwd), depth = 0; depth < 32; folder = dirname(folder), depth++) {
      if (lstatSync(join(folder, ".git"), { throwIfNoEntry: false })) return false;
      if (folder === dirname(folder)) return true;
    }
  } catch { /* Unprovable ancestry keeps native resolution. */ }
  return false;
}

/** Replay the shared synchronous resolver only after every requested native read is known.
 * A suspended/partially resolved pass can never publish a cache entry or return a guessed key. */
export async function resolveHookProjectAsync(options: { cwd: string; base: string; scope?: string; timeRemaining: () => number; maintainCache?: boolean; prefetch?: boolean }, usage: HookNativeUsage): Promise<string> {
  const reads = new Map<string, ReturnType<ProjectGitRead>>();
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AMEM_HOME: options.base };
  const prepared = prepareHookProject({ ...options, env });
  const suspended = new Error("native identity suspended");
  const pending = new Map<string, { abort: AbortController; result: Promise<ReturnType<ProjectGitRead>>; usage: HookNativeUsage }>();
  const active = new Set<string>(), overlaps: string[][] = [];
  let prefetched = false;
  const query = (args: string[]) => {
    const key = JSON.stringify(args), existing = pending.get(key); if (existing) return existing.result;
    if (pending.size >= 64) throw new Error("native identity query bound");
    prepared.verifyBinary(); // No awaited native read may execute a replaced binary.
    const argv = memoryGitArgv(args); argv[0] = prepared.binary.file;
    const abort = new AbortController(), own = { rssKB: 0, rawRssKB: 0 };
    active.add(key); overlaps.push([...active]);
    const result = hookNative(argv, memoryGitEnv(env, { repositoryIsolation: true }), options.timeRemaining, own, abort.signal)
      .finally(() => { active.delete(key); });
    // Speculative failures have no authority until the shared resolver requests that read.
    void result.catch(() => {});
    pending.set(key, { abort, result, usage: own }); return result;
  };
  try {
    for (let count = 0; count < 64; count++) {
      let needed: { key: string; args: string[] } | undefined;
      let result: string | undefined, failure: unknown;
      try {
        result = prepared.resolve((args) => {
          const key = JSON.stringify(args);
          const value = reads.get(key); if (value) return value;
          needed ??= { key, args }; throw suspended;
        }, () => { if (needed) throw suspended; });
      } catch (error) { failure = error; }
      if (!needed) { if (failure) throw failure; if (result !== undefined) return result; throw suspended; }
      const request = needed as { key: string; args: string[] };
      const demanded = query(request.args);
      // A native read is requested only on a real cache miss. Prefetch the portable
      // resolver's ordinary-repository metadata alongside origin, never an alternate
      // identity algorithm. Only memoryProjectKey decides which replies it consumes.
      if (options.prefetch === true && !prefetched && request.args.length === 5 && request.args[0] === "-C" && request.args.slice(2).join(" ") === "remote get-url origin") {
        prefetched = true;
        void query(["-C", request.args[1]!, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--is-bare-repository", "--show-toplevel", "--show-superproject-working-tree"]);
      }
      reads.set(request.key, await demanded);
    }
    throw new Error("native identity query bound");
  } finally {
    // Never leave an unused prefetch or its descendants behind, even if origin alone
    // resolved the key or a requested read failed. Abort still uses the owned reaper.
    for (const child of pending.values()) child.abort.abort();
    await Promise.allSettled([...pending.values()].map(child => child.result));
    // Per-call peaks arrive at reap. Conservatively sum all calls whose owned
    // lifetimes overlapped, rather than hiding concurrent helpers behind max().
    for (const group of overlaps) {
      usage.rssKB = Math.max(usage.rssKB, group.reduce((sum, key) => sum + pending.get(key)!.usage.rssKB, 0));
      usage.rawRssKB = Math.max(usage.rawRssKB, group.reduce((sum, key) => sum + pending.get(key)!.usage.rawRssKB, 0));
    }
  }
}
