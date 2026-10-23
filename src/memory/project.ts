import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { memoryGitEnv, memoryGitSync, realPath } from "./platform.ts";

/** Host-owned read-only Git transport. Arguments are the existing Git operation, before platform argv hardening. */
export type ProjectGitRead = (args: string[], env: NodeJS.ProcessEnv) => {
  stdout: string; status: number | null; error?: unknown; signal?: string | null;
};

interface ProjectIdentityOptions {
  repositoryIsolation?: boolean;
  /** Host-only: native intake must not rebind a failed Git identity to a local fallback. */
  strictGitErrors?: boolean;
  /** Host-only transport seam; callers retain the same strict status and shape checks. */
  gitRead?: ProjectGitRead;
}
class GitIdentityUnavailable extends Error { constructor() { super("Git project identity unavailable"); } }
const unavailable = (): never => { throw new GitIdentityUnavailable(); };
function canonicalCwd(cwd: string, strict: boolean | undefined): string {
  if (!strict) return cwd;
  try { const canonical = realPath(cwd); if (!lstatSync(canonical).isDirectory()) unavailable(); return canonical; }
  catch { return unavailable(); }
}
/** Filesystem evidence only; unknown ancestry never certifies an ordinary non-Git directory. */
function physicalGit(cwd: string): boolean {
  const present = (file: string) => {
    try { return !!lstatSync(file, { throwIfNoEntry: false }); }
    catch { return unavailable(); }
  };
  for (let dir = cwd, depth = 0; depth < 32; dir = dirname(dir), depth++) {
    if (present(resolve(dir, ".git")) || present(resolve(dir, "HEAD")) && present(resolve(dir, "objects"))) return true;
    if (dir === dirname(dir)) return false;
  }
  return unavailable();
}
function checkedGit(args: string[], env: NodeJS.ProcessEnv, strict: boolean, gitRead?: ProjectGitRead, statuses = [0]) {
  const result = gitRead ? gitRead(args, env) : memoryGitSync(args, { encoding: "utf8", env });
  if (strict && (result.error || result.signal || !statuses.includes(result.status ?? -1) || typeof result.stdout !== "string"
    || result.stdout.length > 64 * 1024 || result.stdout.includes("\0"))) unavailable();
  return result;
}
function pathText(text: string, strict: boolean, empty = false): string {
  if (strict && (text ? !isAbsolute(text) || /[\r\n]/.test(text) : !empty)) unavailable();
  return text;
}

/** Project names from the outermost superproject down to this repo; isolation binds native hook cwd over inherited Git routing. */
export function projectChain(cwd: string, options: ProjectIdentityOptions = {}): string[] {
  cwd = canonicalCwd(cwd, options.strictGitErrors);
  const strict = options.strictGitErrors === true && physicalGit(cwd);
  const env = memoryGitEnv(process.env, options);
  const git = (dir: string, arg: string) => pathText(checkedGit(["-C", dir, "rev-parse", arg], env, strict, options.gitRead).stdout?.trim() ?? "", strict, arg === "--show-superproject-working-tree");
  const top = git(cwd, "--show-toplevel");
  if (!top) return [basename(cwd)];
  return projectChainAtRoot(top, options);
}

/** Internal callers that have already resolved the working root do not repeat its git lookup. */
function projectChainAtRoot(top: string, options: ProjectIdentityOptions): string[] {
  const strict = options.strictGitErrors === true;
  const env = memoryGitEnv(process.env, options);
  const git = (dir: string, arg: string) => pathText(checkedGit(["-C", dir, "rev-parse", arg], env, strict, options.gitRead).stdout?.trim() ?? "", strict, true);
  // claude-mem's native identity for a worktree is [parent, parent/worktree].
  // The worktree's .git file points into <parent>/.git/worktrees/<name>; the
  // ordinary superproject walk below remains unchanged for repos and submodules.
  const gitFile = resolve(top, ".git");
  try {
    const match = readFileSync(gitFile, "utf8").trim().match(/^gitdir:\s*(.+)$/i);
    if (match) {
      const gitDir = resolve(top, match[1]!);
      if (/[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.test(gitDir)) {
        const parentRoot = dirname(dirname(dirname(gitDir)));
        const parent = projectChain(parentRoot, options);
        const parentName = basename(parentRoot);
        return [...parent, `${parentName}/${basename(top)}`];
      }
    }
  } catch (error) {
    if (error instanceof GitIdentityUnavailable) throw error;
    // A missing or unreadable .git file falls through to git's normal chain.
  }

  const chain: string[] = [];
  for (let dir = top; dir && chain.length < 8; dir = git(dir, "--show-superproject-working-tree")) {
    chain.unshift(basename(dir));
  }
  return chain.length ? chain : [basename(top)];
}

/**
 * #258: the name hub memory files a project's entries under. The project's `origin` remote, normalized to host and
 * path (`github.com/owner/repo`), is the same on every machine and unique; without one, the git chain plus a hash of
 * the main working root keeps two unrelated repositories that share a name apart while the main checkout, a
 * subdirectory and a worktree resolve to one key (that key is this machine's only, and root-invoked keys stay stable).
 */
export function memoryProjectKey(cwd: string, options: ProjectIdentityOptions = {}): string {
  cwd = canonicalCwd(cwd, options.strictGitErrors);
  const strict = options.strictGitErrors === true && physicalGit(cwd);
  const env = memoryGitEnv(process.env, options);
  const origin = checkedGit(["-C", cwd, "remote", "get-url", "origin"], env, strict, options.gitRead, [0, 2]);
  const url = origin.stdout?.trim() ?? "";
  if (strict && (origin.status === 0 ? !url || /[\r\n]/.test(url) : !!url)) unavailable();
  // A URL's default port is not part of the repository (`ssh://git@github.com:22/o/r` is `github.com/o/r`); any other
  // port is, since another service may run there. An scp-style `host:path` has no port.
  const u = /^([a-z+]+):\/\/(?:[^@/]+@)?(\[[^\]/]+\]|[^/:]+)(?::(\d*))?\/(.+?)(?:\.git)?\/?$/i.exec(url); // an IPv6 host is bracketed
  const defaults: Record<string, string> = { ssh: "22", "git+ssh": "22", "ssh+git": "22", https: "443", http: "80", git: "9418" };
  // A URL's path is absolute (`ssh://h/team/r` is /team/r) unless it starts with `~`; an scp-style path is relative to the
  // remote home (`h:team/r` is ~/team/r) unless it starts with `/`. Two different repositories on a self-hosted server.
  const scp = u || url.includes("://") ? null : /^(?:[^@/]+@)?(\[[^\]/]+\]|[^/:]+):(.+?)(?:\.git)?\/?$/.exec(url); // a file:// remote has no host; an IPv6 host is bracketed
  const m = u ? [!u[3] || u[3] === defaults[u[1]!.toLowerCase()] ? u[2]! : `${u[2]}:${u[3]}`, u[4]!] as const
    : scp ? [scp[1]!, scp[2]!.startsWith("/") ? scp[2]!.replace(/^\/+/, "") : scp[2]!.startsWith("~") ? scp[2]! : `~/${scp[2]}`] as const : undefined;
  if (m && m[1]) {
    const host = m[0].toLowerCase();
    // GitHub serves one repository under every form, and its owner and repository names ignore case.
    return host === "github.com" ? `${host}/${m[1].replace(/^~\/?/, "").toLowerCase()}` : `${host}/${m[1]}`;
  }
  // No usable remote: hash the main working root, not the cwd or git dir. Root-invoked keys therefore keep their
  // pre-#15 value while the main checkout, a subdirectory and a worktree resolve to ONE key (#15 D2/AC2). A bare
  // repository has no working root: its own directory is the stable identity for it and its worktrees.
  // The bounded native hook port reads all ordinary-repository metadata in its second Git call. Git itself
  // resolves core.worktree for --show-toplevel; no config interpretation or root guess replaces that result.
  let location: string[];
  if (strict && options.gitRead) {
    const metadata = checkedGit(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--is-bare-repository", "--show-toplevel", "--show-superproject-working-tree"], env, true, options.gitRead, [0, 128]);
    const fields = metadata.stdout.trim().split("\n");
    if (fields.length < 3 || !isAbsolute(fields[0]!) || !isAbsolute(fields[1]!) || !/^(true|false)$/.test(fields[2]!)) unavailable();
    location = fields.slice(0, 3);
    if (metadata.status === 128) {
      // A bare repository emits exactly the three proven metadata rows before show-toplevel refuses.
      // Any other failed/partial shape stays unknown; stderr never participates in an identity decision.
      if (fields.length !== 3 || fields[2] !== "true") unavailable();
      if (fields[0] === fields[1]) {
        const root = canonicalCwd(fields[0]!, true);
        return `${basename(root)}@${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
      }
    } else {
      if ((fields.length !== 4 && fields.length !== 5) || fields[2] !== "false") unavailable();
      pathText(fields[3]!, true);
      if (fields.length === 5) pathText(fields[4]!, true);
      if (fields[0] === fields[1]) {
        const root = canonicalCwd(fields[3]!, true), realCommon = canonicalCwd(fields[0]!, true);
        // A separate/symlinked directory literally named .git can carry a historical parent-root key.
        // Only the established config/root path below can distinguish an explicit core.worktree there.
        if (basename(realCommon) !== ".git" || dirname(realCommon) === root) {
          const chain = [basename(root)];
          // Match the existing outermost-superproject walk, without reinterpreting a parent's worktree label.
          for (let parent = fields[4] ?? ""; parent && chain.length < 8;) {
            chain.unshift(basename(parent));
            parent = pathText(checkedGit(["-C", parent, "rev-parse", "--show-superproject-working-tree"], env, true, options.gitRead).stdout.trim(), true, true);
          }
          return `${chain.join("/")}@${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
        }
      }
    }
    // Linked worktrees and ambiguous .git directory roots retain the established resolution below.
  } else {
    location = checkedGit(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--is-bare-repository"], env, strict, options.gitRead).stdout?.trim().split("\n") ?? [];
  }
  if (strict && (location.length !== 3 || !isAbsolute(location[0]!) || !isAbsolute(location[1]!) || !/^(true|false)$/.test(location[2]!))) unavailable();
  const ordinary = location.length === 3 && location[0] === location[1] && /^(true|false)$/.test(location[2]!);
  const common = location.length === 3 ? location[0]! : checkedGit(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], env, strict, options.gitRead).stdout?.trim() ?? "";
  if (common) {
    let realCommon = common;
    try { realCommon = realPath(common); } catch { if (strict) unavailable(); /* as given */ }
    const bareText = ordinary ? location[2]! : checkedGit(["--git-dir", realCommon, "rev-parse", "--is-bare-repository"], env, strict, options.gitRead).stdout?.trim() ?? "";
    if (strict && !/^(true|false)$/.test(bareText)) unavailable();
    const bare = bareText === "true";
    let root = realCommon, knownWorkingRoot = false;
    if (!bare) {
      const config = checkedGit(["--git-dir", realCommon, "config", "--path", "core.worktree"], env, strict, options.gitRead, [0, 1]);
      const configured = config.stdout?.trim() ?? "";
      if (strict && (config.status === 0 ? !configured || /[\r\n]/.test(configured) : !!configured)) unavailable();
      // Only a separate git directory without core.worktree needs another root lookup.
      // Ordinary repositories already bind their root through the canonical .git directory.
      const top = !configured && basename(realCommon) !== ".git"
        ? checkedGit(["-C", cwd, "rev-parse", "--show-toplevel"], env, strict, options.gitRead).stdout?.trim() ?? "" : "";
      // Only an actual `.git` directory makes its parent the working root. A separate git dir shares its parent
      // with unrelated repositories, so the real worktree root (or, as a last resort, the unique git dir) is safer.
      if (strict && !configured && basename(realCommon) !== ".git") pathText(top, true);
      root = configured ? resolve(realCommon, configured) : basename(realCommon) === ".git" ? dirname(realCommon) : top || realCommon;
      knownWorkingRoot = !configured && basename(realCommon) === ".git";
    }
    let realRoot = root;
    try { realRoot = realPath(root); } catch { if (strict) unavailable(); /* as given */ }
    const chain = strict && bare ? [basename(realRoot)] : knownWorkingRoot ? projectChainAtRoot(realRoot, options) : projectChain(realRoot, options);
    return `${chain.join("/")}@${createHash("sha256").update(realRoot).digest("hex").slice(0, 8)}`;
  }
  let real = cwd;
  try { real = realPath(cwd); } catch { /* as given */ }
  return `${projectChain(cwd, options).join("/")}@${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
}

/**
 * Every path-like word of a text (`dir/file`, `file.ext`), whether or not it exists or a denylist hides it from the
 * graph: what a private-path policy is checked against.
 */
export const pathCandidates = (text: string): string[] => [...new Set(text.normalize("NFC").match(/\/?[\p{L}\p{M}\p{N}_.~-]+(?:\/[\p{L}\p{M}\p{N}_.~-]+)+|[\p{L}\p{M}\p{N}_-]+\.\p{L}[\p{L}\p{M}\p{N}_]{0,9}/gu) ?? [])]; // any script, combining marks included; an absolute path keeps its slash

/** The file a graph node names: `path:<p>` and `symbol:<name>@<p>`; nothing for other nodes. */
export const nodePath = (n: string): string | undefined => n.startsWith("path:") ? n.slice(5) : n.startsWith("symbol:") && n.includes("@") ? n.slice(n.lastIndexOf("@") + 1) : undefined;

