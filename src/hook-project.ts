import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hookGit, hookGitBinary } from "./hook-git.ts";
import { hookCaptureScope } from "./hook-spool.ts";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { memoryProjectKey } from "./memory/project.ts";

// Bump the derived cache schema if the shared native project-key mapping changes.
const SCHEMA = "agent-mem.hook-project/v1", CACHE_BYTES = 4096, CACHE_CWDS = 128;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Binding { schema: typeof SCHEMA; cwd: string; scope: string; validity: string; binary: string; project: string }
function read(file: string): Binding | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > CACHE_BYTES || stat.mode & 0o077 || stat.uid !== process.getuid()) return undefined;
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
function publish(dir: string, file: string, value: Binding): void {
  let temporary: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(dir, 0o700);
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
/** Cache only a successful shared native resolver result, before alias resolution. The current
 * semantic scope and executable revision must still match; no filesystem guess replaces Git. */
export function resolveHookProject(options: { cwd: string; base: string; scope: string; timeRemaining: () => number }): string {
  const remaining = options.timeRemaining();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("project deadline");
  const cwd = realPath(options.cwd), base = canonicalPath(options.base), binary = hookGitBinary();
  if (!options.scope || hookCaptureScope(cwd, base) !== options.scope) throw new Error("project scope changed");
  const prefixConfig = join(dirname(dirname(binary.file)), "etc", "gitconfig");
  const validity = hookCaptureScope(cwd, base, true, prefixConfig);
  const dir = join(base, "hook-project"), named = lstatSync(dir, { throwIfNoEntry: false });
  const file = join(dir, `${hash(cwd)}.json`);
  const cached = !named || named.isDirectory() && !named.isSymbolicLink() && !(named.mode & 0o077) ? read(file) : undefined;
  if (cached?.cwd === cwd && cached.scope === options.scope && validity && cached.validity === validity && cached.binary === binary.revision && cacheableLocal(cwd, cached.project)) {
    if (hookCaptureScope(cwd, base) !== options.scope || hookCaptureScope(cwd, base, true, prefixConfig) !== validity) throw new Error("project scope changed");
    return cached.project;
  }
  const project = memoryProjectKey(cwd, { repositoryIsolation: true, strictGitErrors: true, gitRead: hookGit(options.timeRemaining, binary.file) });
  if (hookCaptureScope(cwd, base) !== options.scope) throw new Error("project scope changed");
  if (validity && hookCaptureScope(cwd, base, true, prefixConfig) === validity && cacheableLocal(cwd, project))
    publish(dir, file, { schema: SCHEMA, cwd, scope: options.scope, validity, binary: binary.revision, project });
  return project;
}

/** A local key's superproject chain depends on outer Git indexes. Cache only ordinary
 * standalone roots; linked/submodule/local nested layouts retain the native resolver. */
function cacheableLocal(cwd: string, project: string): boolean {
  if (!/.+@[a-f0-9]{8}$/.test(project)) return true;
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
