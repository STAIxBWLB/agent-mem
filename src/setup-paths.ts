import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalPath, realPath } from "./memory/platform.ts";
import { geminiSettingsPath } from "./setup-gemini.ts";
import type { SetupTarget } from "./setup.ts";

export type SetupEnvironment = Readonly<Record<string, string | undefined>>;
export interface SetupRedirect {
  target: "claude" | "codex";
  from: string;
  to: string;
  reason: string;
}
export interface SetupPaths {
  home: string;
  paths: Record<SetupTarget, string[]>;
  /** Pre-redirect targets, only for validating receipts made by an older setup version. */
  legacyPaths: Record<SetupTarget, string[]>;
  redirects: SetupRedirect[];
}

/** Same fallback as setup inventory; assertOpencodeLayout separately rejects relative XDG_CONFIG_HOME. */
export function opencodeConfigRoot(env: SetupEnvironment, home: string): string {
  const value = env.XDG_CONFIG_HOME;
  return value === undefined || value === "" || !isAbsolute(value) ? join(home, ".config") : value;
}

/** Path recognition only: no app import, probe, directory creation or config read. */
function orcaHome(root: string, kind: "claude" | "codex", env: SetupEnvironment, home: string): boolean {
  const userData = canonicalPath(resolve(env.ORCA_USER_DATA_PATH?.trim() || join(home, "Library", "Application Support", "orca")));
  const parts = relative(userData, canonicalPath(root)).split(sep);
  return kind === "claude"
    ? parts.length === 3 && parts[0] === "claude-profiles" && !!parts[1] && parts[2] === "home"
    : parts.length === 3 && parts[0] === "codex-accounts" && !!parts[1] && parts[2] === "home"
      || parts.length === 2 && parts[0] === "codex-runtime-home" && parts[1] === "home";
}

/** Shared setup/doctor resolution. Publication still applies setup's named-directory/link guards. */
export function resolveSetupPaths(env: SetupEnvironment = process.env, givenHome?: string, workspaceRoot?: string): SetupPaths {
  const home = givenHome ?? realPath(resolve(env.HOME?.trim() || homedir()));
  const root = (key: string, fallback: string) => {
    const setting = env[key];
    const present = key === "JCODE_HOME" ? setting !== undefined : key === "QWEN_HOME" ? !!setting : !!setting?.trim();
    if (!present) return join(home, fallback);
    const expanded = key === "QWEN_HOME" && /^~(?:[/\\]|$)/.test(setting!) ? join(home, ...setting!.slice(2).split(/[/\\]/)) : setting!;
    const given = resolve(expanded), withinHome = relative(resolve(env.HOME?.trim() || homedir()), given);
    return withinHome !== ".." && !withinHome.startsWith("../") && !isAbsolute(withinHome) ? join(home, withinHome) : given;
  };
  const claude = root("CLAUDE_CONFIG_DIR", ".claude"), codex = root("CODEX_HOME", ".codex"), kimi = root("KIMI_CODE_HOME", ".kimi-code");
  const pi = root("PI_CODING_AGENT_DIR", ".pi/agent"), qwen = root("QWEN_HOME", ".qwen");
  const paths: SetupPaths["paths"] = {
    claude: [env.CLAUDE_CONFIG_DIR?.trim() ? join(claude, ".claude.json") : join(home, ".claude.json"), join(claude, "settings.json")],
    codex: [join(codex, "config.toml"), join(codex, "hooks.json")],
    kimi: [join(kimi, "mcp.json"), join(kimi, "config.toml")],
    pi: [join(pi, "mcp.json"), join(pi, "extensions", "amem-session.ts")],
    qwen: [join(qwen, "settings.json")],
    jcode: [join(root("JCODE_HOME", ".jcode"), "mcp.json")],
    opencode: [join(opencodeConfigRoot(env, home), "opencode", "opencode.json")],
    gemini: [geminiSettingsPath(env, home)],
    agy: workspaceRoot ? [join(workspaceRoot, ".agents", "mcp_config.json")] : [],
  };
  const redirects: SetupRedirect[] = [];
  const legacyPaths = Object.fromEntries(Object.entries(paths).map(([target, files]) => [target, [...files]])) as SetupPaths["paths"];
  const redirect = (target: SetupRedirect["target"], index: number, to: string) => {
    const from = paths[target][index]!;
    paths[target][index] = to;
    redirects.push({ target, from, to, reason: "Orca re-syncs this managed file from the personal source" });
  };
  if (orcaHome(claude, "claude", env, home)) redirect("claude", 1, join(home, ".claude", "settings.json"));
  if (orcaHome(codex, "codex", env, home)) {
    redirect("codex", 0, join(home, ".codex", "config.toml"));
    redirect("codex", 1, join(home, ".codex", "hooks.json"));
  }
  return { home, paths, legacyPaths, redirects };
}
