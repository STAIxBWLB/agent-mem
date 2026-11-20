import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { ownedUnwritableDirectory, realPath } from "./platform.ts";

export type NativeRootKind = "sessions" | "archived_sessions";
export type NativeRootStatus = { state: "ready"; path: string } | { state: "unsafe" | "unavailable" };

/** Only a symlink at the named root receives this exception; callers still refuse links beneath it. */
export function inspectNativeRoot(folder: string, home = process.env.HOME?.trim() || homedir()): NativeRootStatus {
  let link = false;
  try {
    link = lstatSync(folder).isSymbolicLink();
    const physical = realPath(folder);
    if (link) {
      const root = realPath(home), rel = relative(root, physical);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !ownedUnwritableDirectory(physical)) return { state: "unsafe" };
    }
    return { state: "ready", path: physical };
  } catch { return { state: link ? "unsafe" : "unavailable" }; }
}

export function nativeRoots(kind: "codex" | "kimi" | "pi", env: NodeJS.ProcessEnv = process.env, home = env.HOME?.trim() || homedir()): { kind: NativeRootKind; folder: string }[] {
  const root = kind === "codex" ? env.CODEX_HOME?.trim() || join(home, ".codex")
    : kind === "kimi" ? env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code")
      : env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  return [{ kind: "sessions", folder: join(root, "sessions") }, ...(kind === "codex" ? [{ kind: "archived_sessions" as const, folder: join(root, "archived_sessions") }] : [])];
}
