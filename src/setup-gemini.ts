import { isAbsolute, join, resolve } from "node:path";

// Gemini CLI 0.61.0 (google-gemini/gemini-cli v0.61.0; docs/gemini-cli.md).
// User settings: <GEMINI_CLI_HOME or HOME>/.gemini/settings.json (packages/core/src/utils/paths.ts homedir,
// packages/core/src/config/storage.ts getGlobalSettingsPath). The Antigravity file
// <home>/.gemini/config/mcp_config.json is a different client's and is never read or written here.
type Env = Readonly<Record<string, string | undefined>>;

/**
 * GEMINI_CLI_HOME replaces the home directory for all Gemini CLI state. Never throws: the shared setup context
 * computes every target's paths, so a relative value falls back to the home here and is refused only by
 * assertGeminiHome when gemini is actually selected.
 */
export function geminiSettingsPath(env: Env, home: string): string {
  const configured = env.GEMINI_CLI_HOME;
  return join(configured && isAbsolute(configured) ? resolve(configured) : home, ".gemini", "settings.json");
}
/** A relative GEMINI_CLI_HOME would resolve against Gemini CLI's own cwd, so setup refuses it rather than guess. */
export function assertGeminiHome(env: Env): void {
  const configured = env.GEMINI_CLI_HOME;
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) throw Error("setup requires an absolute GEMINI_CLI_HOME; unset it to use the home directory");
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
