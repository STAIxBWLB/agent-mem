import { memoryGitArgv, memoryGitEnv } from "./memory/platform.ts";
import type { ProjectGitRead } from "./memory/project.ts";

/** Internal port for the owned hook worker. Keep Git hardening shared while avoiding the
 * Node process compatibility module on this Bun-only, short-lived path. The parent's deadline
 * reaps the whole worker group, including a blocked Git descendant; a per-Git leader-only
 * timeout would let a wrapper's descendants survive after the worker exits. */
export function hookGit(timeRemaining: () => number): ProjectGitRead {
  return (args, env) => {
    const remaining = timeRemaining();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Git project identity unavailable");
    const result = Bun.spawnSync(memoryGitArgv(args), {
      env: memoryGitEnv(env), stdin: "ignore", stdout: "pipe", stderr: "ignore", maxBuffer: 64 * 1024,
    });
    if (result.stdout.byteLength >= 64 * 1024) throw new Error("Git project identity unavailable");
    return { status: result.exitCode, signal: result.signalCode ? String(result.signalCode) : undefined,
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(result.stdout) };
  };
}
