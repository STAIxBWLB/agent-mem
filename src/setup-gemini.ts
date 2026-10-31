import { isAbsolute, join, resolve } from "node:path";

// Gemini CLI 0.61.0 (google-gemini/gemini-cli v0.61.0; docs/gemini-cli.md).
// User settings: <GEMINI_CLI_HOME or HOME>/.gemini/settings.json (packages/core/src/utils/paths.ts homedir,
// packages/core/src/config/storage.ts getGlobalSettingsPath). The Antigravity file
// <home>/.gemini/config/mcp_config.json is a different client's and is never read or written here.
type Env = Readonly<Record<string, string | undefined>>;

/** GEMINI_CLI_HOME replaces the home directory for all Gemini CLI state; it must be absolute for setup. */
export function geminiSettingsPath(env: Env, home: string): string {
  const configured = env.GEMINI_CLI_HOME;
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) throw Error("setup requires an absolute GEMINI_CLI_HOME; unset it to use the home directory");
  return join(configured ? resolve(configured) : home, ".gemini", "settings.json");
}
/** Gemini CLI expands $VAR, ${VAR} and ${VAR:-default} inside settings strings (packages/cli/src/utils/envVarResolver.ts). */
export function assertGeminiRuntime(bun: string, entry: string): void {
  if ([bun, entry].some(value => value.includes("$"))) throw Error("Gemini CLI expands $VAR placeholders in settings strings; setup cannot register this runtime exactly");
}
/** Native registration: user scope, stdio, in the private staging HOME (setup.ts stagingEnvironment). */
export function geminiAddCommand(bun: string, entry: string): string[] {
  return ["gemini", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem", bun, "--", "--smol", entry, "mcp"];
}
export const GEMINI_REMOVE: readonly string[] = ["gemini", "mcp", "remove", "--scope", "user", "amem"];
