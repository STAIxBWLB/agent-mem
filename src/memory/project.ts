import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { memoryGitEnv, memoryGitSync, realPath } from "./platform.ts";

/** Project names from the outermost superproject down to this repo; isolation binds native hook cwd over inherited Git routing. */
export function projectChain(cwd: string, options: { repositoryIsolation?: boolean } = {}): string[] {
  const env = memoryGitEnv(process.env, options);
  const git = (dir: string, arg: string) => memoryGitSync(["-C", dir, "rev-parse", arg], { encoding: "utf8", env }).stdout?.trim() ?? "";
  const top = git(cwd, "--show-toplevel");
  if (!top) return [basename(cwd)];
  return projectChainAtRoot(top, options);
}

/** Internal callers that have already resolved the working root do not repeat its git lookup. */
function projectChainAtRoot(top: string, options: { repositoryIsolation?: boolean }): string[] {
  const env = memoryGitEnv(process.env, options);
  const git = (dir: string, arg: string) => memoryGitSync(["-C", dir, "rev-parse", arg], { encoding: "utf8", env }).stdout?.trim() ?? "";
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
  } catch {
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
export function memoryProjectKey(cwd: string, options: { repositoryIsolation?: boolean } = {}): string {
  const env = memoryGitEnv(process.env, options);
  const url = memoryGitSync(["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", env }).stdout?.trim() ?? "";
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
  // Batch metadata for ordinary repositories; linked worktrees still inspect the common directory's bare state.
  const location = memoryGitSync(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--is-bare-repository"], { encoding: "utf8", env }).stdout?.trim().split("\n") ?? [];
  const ordinary = location.length === 3 && location[0] === location[1] && /^(true|false)$/.test(location[2]!);
  const common = location.length === 3 ? location[0]! : memoryGitSync(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", env }).stdout?.trim() ?? "";
  if (common) {
    let realCommon = common;
    try { realCommon = realPath(common); } catch { /* as given */ }
    const bare = ordinary ? location[2] === "true" : (memoryGitSync(["--git-dir", realCommon, "rev-parse", "--is-bare-repository"], { encoding: "utf8", env }).stdout?.trim() ?? "") === "true";
    let root = realCommon, knownWorkingRoot = false;
    if (!bare) {
      const configured = memoryGitSync(["--git-dir", realCommon, "config", "--path", "core.worktree"], { encoding: "utf8", env }).stdout?.trim() ?? "";
      // Only a separate git directory without core.worktree needs another root lookup.
      // Ordinary repositories already bind their root through the canonical .git directory.
      const top = !configured && basename(realCommon) !== ".git"
        ? memoryGitSync(["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", env }).stdout?.trim() ?? "" : "";
      // Only an actual `.git` directory makes its parent the working root. A separate git dir shares its parent
      // with unrelated repositories, so the real worktree root (or, as a last resort, the unique git dir) is safer.
      root = configured ? resolve(realCommon, configured) : basename(realCommon) === ".git" ? dirname(realCommon) : top || realCommon;
      knownWorkingRoot = !configured && basename(realCommon) === ".git";
    }
    let realRoot = root;
    try { realRoot = realPath(root); } catch { /* as given */ }
    const chain = knownWorkingRoot ? projectChainAtRoot(realRoot, options) : projectChain(realRoot, options);
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

