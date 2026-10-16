// Private core portability helpers. Keep behavior aligned with the hub originals through memory-parity.test.ts.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync, execFileSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";

const canonical = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
};

export function canonicalPath(path: string): string {
  return canonical(path);
}

/**
 * realpathSync, except that Bun (1.3.14, and 1.4.2 still: #121) throws ENOENT for an existing path containing a
 * backslash (issue #26). Such a path goes to the system realpath, which handles it and returns every component as
 * stored on disk: guardPath checks names, and on a case-insensitive disk `.GIT/config` or `id_rſa` would otherwise
 * pass for another file. A missing path or a dangling symlink still throws, which guardPath relies on. Other paths take
 * realpathSync's answer unchanged.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!resolve(path).includes("\\")) throw error; // a relative path can sit under a backslash directory too
    // The path as given: resolve() would fold a `..` after a symlink by text. GNU realpath accepts a dangling last
    // component unless told -e; the BSD one on macOS refuses it by default.
    const argv = process.platform === "darwin" ? ["/bin/realpath", "--", path] : ["realpath", "-e", "--", path];
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.endsWith("\n")) throw error;
    return r.stdout.slice(0, -1);
  }
}

export const DENY_SEGMENTS = [".maru/secrets", ".agenthub/state", ".agenthub/archive"];
/** Regex sources, matched against a file's basename. */
export const DENY_NAMES = ["^\\.env", "\\.pem$", "\\.key$", "^id_rsa", "^id_ed25519", "^credentials(\\.|$)", "^auth\\.json$", "^\\.netrc$", "^\\.npmrc$", "^\\.pypirc$"];

const hasSegment = (rel: string, seg: string) => `/${rel}/`.includes(`/${seg}/`);

/** True when a path names something the worker must never read, write or report. `extra`: substrings from `local.deny`. */
export function isDenied(path: string, extra: string[] = []): boolean {
  const norm = path.split(sep).join("/");
  return DENY_SEGMENTS.some((s) => hasSegment(norm, s)) || DENY_NAMES.some((re) => new RegExp(re).test(basename(norm))) || extra.some((e) => e && norm.includes(e));
}

const SAFE_CONFIG = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "credential.helper=", "core.askpass="];
/** Hub memory sync (#258) pushes to the person's own remote: their global credential helper stays, the rest does not. */
const CREDENTIAL_KEYS = new Set(["credential.helper=", "core.askpass="]);

/**
 * `["git", ...safe options, ...args]`: use instead of a literal "git" argv anywhere under src/. `credentials` keeps the
 * person's credential helper, for a repository the hub created itself (the memory store), never a project's.
 */
export const memoryGitArgv = (args: string[], opts: { credentials?: boolean } = {}): string[] =>
  ["git", "--no-pager", ...SAFE_CONFIG.filter((c) => !opts.credentials || !CREDENTIAL_KEYS.has(c)).flatMap((c) => ["-c", c]), ...args];

/** The caller's env plus the no-prompt switch; existing keys (childEnv, GIT_OPTIONAL_LOCKS=0) pass through. */
export const memoryGitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, GIT_TERMINAL_PROMPT: "0" });

/** spawnSync form of the same call: the env option is merged with memoryGitEnv, everything else passes through. */
export function memoryGitSync(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  const argv = memoryGitArgv(args);
  return spawnSync(argv[0]!, argv.slice(1), { ...options, env: memoryGitEnv(options.env ?? process.env) });
}

/**
 * The one process-identity contract behind the Pi owner claim, every later liveness
 * re-inspection, the terminal-recovery launcher signature and any other hub identity
 * hash: pid plus the `ps` rendering of its start time and command. `lstart` follows
 * the reader's TZ and locale, so the read pins LC_ALL=C and TZ=UTC, the same contract
 * as `processTable` in src/hub/child-process.ts. Without the pin a writer and a reader
 * in different environments hash different strings for the same process and the valid
 * owner is refused (#174, #177). Only the `ps` invocation is pinned; the user's own
 * environment is untouched. Node APIs only: the extension runs inside Pi, not Bun.
 */
export function processSignature(pid: number): string | undefined {
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    return text ? createHash("sha256").update(text).digest("hex") : undefined;
  } catch { return undefined; }
}

export type Liveness = "live" | "gone" | "unknown";

/**
 * #226: the one ownership check behind every recorded pid (hub manifest, registry claim, recovery runner, manager
 * owner, launcher records). With a recorded `signature` the identity decides: equal is live, different is gone (the
 * pid was reused, after a reboot for example, also by a process we may not signal), and a pid that exists but whose
 * identity cannot be read is unknown. Without one (records written by 0.12.20 and older) the pid probe answers as it
 * always did: live, gone on ESRCH, unknown otherwise. Unknown is never gone.
 */
// ponytail: `ps lstart` is derived from boot time plus the process's age; a wall-clock step on Linux can change it for a
// live process, which then reads as gone (a second hub could take its claim). Upgrade path: a boot-id or start-tick
// (Linux /proc/<pid>/stat field 22) component in the signature.
export function processLiveness(pid: unknown, signature?: string | null, identity: (pid: number) => string | undefined = processSignature): Liveness {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  if (signature) {
    let current: string | undefined;
    try { current = identity(pid); } catch { /* unreadable: the pid probe below decides between gone and unknown */ }
    if (current) return current === signature ? "live" : "gone";
  }
  try { process.kill(pid, 0); return signature ? "unknown" : "live"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
}
