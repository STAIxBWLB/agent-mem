import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { realPath } from "./memory/platform.ts";
import { memoryGitArgv, memoryGitEnv } from "./memory/platform.ts";
import type { ProjectGitRead } from "./memory/project.ts";

/** Internal port for the owned hook worker. Keep Git hardening shared while avoiding the
 * Node process compatibility module on this Bun-only, short-lived path. The parent's deadline
 * reaps the whole worker group, including a blocked Git descendant; a per-Git leader-only
 * timeout would let a wrapper's descendants survive after the worker exits. */
export function hookGit(timeRemaining: () => number, binary = hookGitBinary().file): ProjectGitRead {
  return (args, env) => {
    const remaining = timeRemaining();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Git project identity unavailable");
    const argv = memoryGitArgv(args); argv[0] = binary;
    const result = Bun.spawnSync(argv, {
      env: memoryGitEnv(env), stdin: "ignore", stdout: "pipe", stderr: "ignore", maxBuffer: 64 * 1024,
    });
    if (result.stdout.byteLength >= 64 * 1024) throw new Error("Git project identity unavailable");
    return { status: result.exitCode, signal: result.signalCode ? String(result.signalCode) : undefined,
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(result.stdout) };
  };
}

/** Only bypass Apple's selected /usr/bin/git shim, never a caller's custom PATH binary.
 * Resolve the root-owned developer selection on disk, without launching xcrun on the hook deadline. */
export function hookGitBinary(): { file: string; revision: string } {
  let file = realPath(Bun.which("git") ?? (() => { throw new Error("Git unavailable"); })());
  if (process.platform === "darwin" && file === "/usr/bin/git") {
    try {
      const selected = "/var/db/xcode_select_link", link = lstatSync(selected);
      if (link.isSymbolicLink() && link.uid === 0) {
        const candidate = realPath(join(realPath(selected), "usr", "bin", "git")), stat = lstatSync(candidate);
        if (stat.isFile() && stat.uid === 0 && (stat.mode & 0o111)) file = candidate;
      }
    } catch { /* A missing/unproven selection keeps the PATH-selected Git and its normal refusal. */ }
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error("Git unavailable");
  return { file, revision: createHash("sha256").update(`${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`).digest("hex") };
}
