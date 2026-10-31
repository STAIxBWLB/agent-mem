import { cliAttribution } from "./memory/cli-attribution.ts";
import { configuredPolicy } from "./memory/config.ts";
import { SETUP_CONFIG_BYTES, updateTomlArray } from "./setup-toml.ts";
import { managedAfter, mcpRecord, putMcpRecord, restoreOwned, sameImage, type ConfigImage } from "./setup-owned.ts";
import { opencodeServer } from "./setup-opencode.ts";
import { assertGeminiHome, assertGeminiRuntime, GEMINI_REMOVE, geminiAddCommand, geminiSettingsPath } from "./setup-gemini.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { HOOK_EVENTS } from "./hook-contract.ts";
import { memoryHome } from "./memory/home.ts";
import { label, PLAIN, singleLine, type Style } from "./memory/style.ts";
import { canonicalPath, memoryGitEnv, memoryGitSync, processLiveness, processSignature, realPath } from "./memory/platform.ts";

export const SETUP_TARGETS = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini", "agy"] as const;
/** Workspace-scoped Antigravity setup is always selected explicitly. */
export const SETUP_ALL_TARGETS = SETUP_TARGETS.filter(target => target !== "agy");
export type SetupTarget = typeof SETUP_TARGETS[number];
// Only recorded layout verification versions belong here; null means no version was recorded.
const SETUP_VERIFIED_VERSIONS: Readonly<Record<SetupTarget, string | null>> = {
  claude: null, codex: "0.165.0", kimi: null, pi: null, qwen: "0.26.1", jcode: "0.99.1", opencode: "1.18.35", gemini: "0.61.0", agy: null,
};
interface ClientVersion { output: string | null; verified: string | null; matches: boolean | null }
type Env = Readonly<Record<string, string | undefined>>;
type Image = ConfigImage;
interface PlannedHook { event: string; command: string; timeout: number }
interface Change { key: string; path: string; before: Image; after: Image; start?: Image }
interface DirectoryIdentity { dev: number; ino: number }
interface Receipt { createdDirectory?: DirectoryIdentity; version: 1; target: SetupTarget; intent: string; phase: "prepared" | "applied"; changes: Change[] }
export interface SetupContext {
  env?: Env; bun?: string; entry?: string; stdinTTY?: boolean; cwd?: string;
  /** @deprecated Retained for source compatibility; explicit apply/undo modes do not prompt. */
  confirm?: (plan: SetupPlan) => Promise<boolean>;
  /** Host-only race fixture, called after temporary-file fsync and before the final comparison/rename. */
  beforePublish?: (file: string) => void;
  /** Trusted test seam; production always runs the named native CLI in a private staging HOME. */
  native?: (argv: readonly string[], env: Env, cwd: string) => void;
}
export interface SetupPlan {
  targets: SetupTarget[]; mode: "preview" | "apply" | "undo";
  actions: { target: SetupTarget; version?: ClientVersion; files: string[]; receipt: string; cwd?: string; registration: string[] | null; lifecycle: string; available: boolean; hooks: PlannedHook[]; mcpChange: "add" | "replace" | "restore" | "unchanged"; commands: string[][]; state: string }[];
  notes: string[];
}
const MAX = SETUP_CONFIG_BYTES, JOURNAL_MAX = 12 * MAX;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("setup configuration must be an object");
  return value as Record<string, unknown>;
}
function json(image: Image): Record<string, unknown> {
  try { return image.bytes === null ? {} : record(JSON.parse(Buffer.from(image.bytes, "base64").toString("utf8"))); }
  catch { throw Error("setup configuration does not parse as a JSON object"); }
}
function toml(text: string): Record<string, unknown> {
  try { return record(Bun.TOML.parse(text)); } catch { throw Error("setup configuration does not parse as TOML"); }
}
function image(text: string, mode = 0o600): Image { return { bytes: Buffer.from(text).toString("base64"), mode }; }
function objectImage(value: unknown, before: Image): Image { return image(JSON.stringify(value, null, 2) + "\n", before.mode); }
function names(file: string): void {
  // Configuration files and their containing directories cannot redirect an apply/undo through a symlink.
  let cursor = file;
  while (true) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw Error("setup refuses symbolic-link configuration paths"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function read(file: string, max = MAX): Image {
  names(file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, mode: 0o600 }; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw Error("setup configuration unavailable or oversized");
    const data = Buffer.alloc(stat.size + 1), size = readSync(fd, data, 0, data.length, 0), after = fstatSync(fd);
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error("setup configuration changed while reading");
    return { bytes: data.subarray(0, size).toString("base64"), mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}
function write(file: string, value: Image, expected?: Image, beforePublish?: (file: string) => void): void {
  names(file);
  if (value.bytes === null) { beforePublish?.(file); if (expected && !sameImage(read(file), expected)) throw Error("setup configuration changed before removal"); rmSync(file, { force: true }); return; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); names(dirname(file));
  const temporary = join(dirname(file), `.amem-setup-${randomUUID()}`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, Buffer.from(value.bytes, "base64")); fchmodSync(fd, value.mode); fsyncSync(fd); }
    finally { closeSync(fd); }
    beforePublish?.(file);
    if (expected && !sameImage(read(file), expected)) throw Error("setup configuration changed before publication");
    // ponytail: an external CLI can still write between this comparison and rename; a shared CLI lock or native transactional API is needed to close that window.
    names(file); renameSync(temporary, file); const parent = openSync(dirname(file), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
}
interface WorkspaceBinding { root: string; ignored: boolean; assertCurrent(): void }
function workspaceBinding(options: SetupContext): WorkspaceBinding {
  const requestedCwd = resolve(options.cwd ?? process.cwd()), cwd = realPath(requestedCwd), env = memoryGitEnv({ ...process.env, ...options.env }, { repositoryIsolation: true });
  for (const key of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete env[key];
  const git = (args: string[]) => memoryGitSync(["-C", cwd, ...args], { env, encoding: "utf8", timeout: 5000, maxBuffer: MAX });
  const location = (args: string[]) => {
    const result = git(args);
    if (result.status !== 0 || result.error || !result.stdout.endsWith("\n")) throw Error("Antigravity setup needs an available Git repository");
    return realPath(result.stdout.slice(0, -1));
  };
  const root = location(["rev-parse", "--show-toplevel"]), gitDir = location(["rev-parse", "--absolute-git-dir"]), stat = lstatSync(root);
  const within = relative(root, cwd);
  if (!stat.isDirectory() || within === ".." || within.startsWith("../") || isAbsolute(within)) throw Error("Antigravity workspace must contain the calling directory");
  const tracked = () => {
    // Case aliases can name the same tracked file on macOS. Refuse them on every host.
    const result = git(["ls-files", "--error-unmatch", "--", ":(top,icase,literal).agents/mcp_config.json"]);
    if (result.status === 0) throw Error("Antigravity setup refuses Git-tracked .agents/mcp_config.json in every mode");
    if (result.status !== 1 || result.error) throw Error("Antigravity setup cannot verify configuration tracking");
  };
  const assertCurrent = () => {
    const current = lstatSync(root);
    if (realPath(requestedCwd) !== cwd || current.dev !== stat.dev || current.ino !== stat.ino || location(["rev-parse", "--show-toplevel"]) !== root || location(["rev-parse", "--absolute-git-dir"]) !== gitDir) throw Error("Antigravity workspace binding changed");
    tracked();
  };
  assertCurrent();
  const ignored = git(["check-ignore", "-q", "--", join(root, ".agents", "mcp_config.json")]);
  if (![0, 1].includes(ignored.status ?? -1) || ignored.error) throw Error("Antigravity setup cannot verify configuration ignore status");
  return { root, ignored: ignored.status === 0, assertCurrent };
}
function context(options: SetupContext, workspace?: WorkspaceBinding) {
  const env = options.env ?? process.env, home = realPath(resolve(env.HOME?.trim() || homedir()));
  const root = (key: string, fallback: string) => {
    const setting = env[key];
    const present = key === "JCODE_HOME" ? setting !== undefined : key === "QWEN_HOME" ? !!setting : !!setting?.trim();
    if (!present) return join(home, fallback);
    const expanded = key === "QWEN_HOME" && /^~(?:[/\\]|$)/.test(setting!) ? join(home, ...setting!.slice(2).split(/[/\\]/)) : setting!;
    const given = resolve(expanded), withinHome = relative(resolve(env.HOME?.trim() || homedir()), given);
    // Canonicalize the HOME alias only; named configuration-directory symlinks must still be refused.
    return withinHome !== ".." && !withinHome.startsWith("../") && !isAbsolute(withinHome) ? join(home, withinHome) : given;
  };
  const claude = root("CLAUDE_CONFIG_DIR", ".claude"), codex = root("CODEX_HOME", ".codex"), kimi = root("KIMI_CODE_HOME", ".kimi-code"), pi = root("PI_CODING_AGENT_DIR", ".pi/agent"), qwen = root("QWEN_HOME", ".qwen");
  const paths: Record<SetupTarget, string[]> = {
    claude: [env.CLAUDE_CONFIG_DIR?.trim() ? join(claude, ".claude.json") : join(home, ".claude.json"), join(claude, "settings.json")],
    codex: [join(codex, "config.toml"), join(codex, "hooks.json")],
    kimi: [join(kimi, "mcp.json"), join(kimi, "config.toml")],
    pi: [join(pi, "mcp.json"), join(pi, "extensions", "amem-session.ts")],
    qwen: [join(qwen, "settings.json")],
    // Absolute JCODE_HOME spellings stay literal; unset uses the platform-home default.
    jcode: [join(root("JCODE_HOME", ".jcode"), "mcp.json")],
    // xdg-basedir 5.1.0: XDG_CONFIG_HOME verbatim when set and non-empty, else ~/.config (OpenCode v1.18.35 packages/core/src/global.ts).
    opencode: [join(opencodeConfigRoot(env, home), "opencode", "opencode.json")],
    // Gemini CLI's own user settings, never Antigravity's <home>/.gemini/config/mcp_config.json.
    gemini: [geminiSettingsPath(env, home)],
    agy: workspace ? [join(workspace.root, ".agents", "mcp_config.json")] : [],
  };
  const requestedBun = options.bun ?? "bun", bun = requestedBun === "bun" ? Bun.which("bun", { PATH: env.PATH ?? process.env.PATH }) : requestedBun;
  const entry = options.entry ?? fileURLToPath(new URL("../bin/amem.js", import.meta.url));
  if (!bun || !isAbsolute(bun) || !isAbsolute(entry)) throw Error("setup needs a PATH-resolved absolute Bun runtime and an absolute installed entry");
  // The trusted native fixture may use a temporary package; ordinary CLI installation must outlive bunx's cache.
  if (!options.native) {
    const roots = [resolve(tmpdir()), realPath(tmpdir())], entries = [resolve(entry), realPath(entry)];
    if (roots.some(root => entries.some(file => { const part = relative(root, file); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); }))) throw Error("setup refuses a temporary package entry; install amem in a persistent location first");
  }
  return { env, home, paths, bun, entry, workspace, state: join(canonicalPath(memoryHome({ ...env, AGENTHUB_HOME: env.AGENTHUB_HOME?.trim() || join(home, ".agenthub") })), "setup") };
}
function command(target: SetupTarget, bun: string, entry: string): string[] | null {
  if (target === "kimi" || target === "jcode" || target === "opencode" || target === "agy") return null;
  if (target === "qwen") return [target, "mcp", "add", "--scope", "user", "--transport", "stdio", "amem", bun, "--", "--smol", entry, "mcp"];
  if (target === "gemini") return geminiAddCommand(bun, entry);
  return [target, "mcp", "add", ...(target === "claude" ? ["--scope", "user", "--transport", "stdio"] : []), "amem", "--", bun, "--smol", entry, "mcp"];
}
/**
 * OpenCode 1.18.35 resolves its config root with xdg-basedir 5.1.0, which uses XDG_CONFIG_HOME verbatim when set
 * (no trim) and falls back to ~/.config only when it is unset or empty. A relative value would resolve against
 * OpenCode's own cwd, so setup refuses it rather than guess. An absolute value keeps its literal spelling.
 */
function opencodeConfigRoot(env: Env, home: string): string {
  const value = env.XDG_CONFIG_HOME;
  // A relative value is refused in assertOpencodeLayout; the path here only has to be well-formed for inventory.
  return value === undefined || value === "" || !isAbsolute(value) ? join(home, ".config") : value;
}
function assertJcodeHome(env: Env): void {
  if (env.JCODE_HOME !== undefined && !isAbsolute(env.JCODE_HOME)) throw Error("setup requires an absolute JCODE_HOME; unset it to use the default");
}
function assertJcodeRuntime(c: ReturnType<typeof context>): void {
  assertJcodeHome(c.env);
  if ([c.bun, c.entry].some(value => value.includes("${"))) throw Error("Jcode interpolates environment placeholders in MCP command paths; setup cannot register this runtime exactly");
}
/** OpenCode merges config.json, opencode.json, then opencode.jsonc from its global directory, and env routes can replace it. */
function assertOpencodeLayout(c: ReturnType<typeof context>, mode: SetupPlan["mode"]): void {
  const xdg = c.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "" && !isAbsolute(xdg)) throw Error("OpenCode setup requires an absolute XDG_CONFIG_HOME; unset it to use ~/.config");
  if (mode !== "undo") for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]) if (c.env[key]?.trim()) throw Error(`OpenCode setup refuses ${key}: it routes configuration away from the global file this setup owns`);
  const dir = dirname(c.paths.opencode[0]!);
  for (const name of ["opencode.jsonc", "config.json"]) if (read(join(dir, name)).bytes !== null) throw Error(`OpenCode setup supports one strict-JSON global opencode.json; ${name} beside it is merged too and is not supported`);
  if ([c.bun, c.entry].some(value => /\{(?:env|file):/.test(value))) throw Error("OpenCode substitutes {env:} and {file:} in configuration; setup cannot register this runtime exactly");
}
function intent(c: ReturnType<typeof context>, target: SetupTarget): string { return digest([1, target, c.paths[target], c.bun, c.entry, ...(["codex", "kimi", "qwen"].includes(target) ? ["capture-json-v1"] : []), ...(target === "agy" ? [c.workspace!.root] : [])]); }
function journal(c: ReturnType<typeof context>, target: SetupTarget): string { return join(c.state, target === "agy" ? `agy-${digest(c.workspace!.root)}.json` : `${target}.json`); }
function receipt(c: ReturnType<typeof context>, target: SetupTarget, requireRuntime = false): Receipt | undefined {
  const raw = read(journal(c, target), JOURNAL_MAX); if (raw.bytes === null) return;
  const value = record(JSON.parse(Buffer.from(raw.bytes, "base64").toString("utf8")));
  if (value.version !== 1 || value.target !== target || typeof value.intent !== "string" || !/^[a-f0-9]{64}$/.test(value.intent) || requireRuntime && value.intent !== intent(c, target) || !["prepared", "applied"].includes(String(value.phase)) || !Array.isArray(value.changes) || value.changes.length !== c.paths[target].length) throw Error("setup receipt does not match this installation");
  for (let i = 0; i < value.changes.length; i++) {
    const change = record(value.changes[i]); if (change.path !== c.paths[target][i] || change.key !== `${target}:${i}`) throw Error("setup receipt target mismatch");
    for (const key of ["before", "after", ...(change.start !== undefined ? ["start"] : [])]) {
      const v = record(change[key]);
      if (!Number.isInteger(v.mode) || Number(v.mode) < 0 || Number(v.mode) > 0o777 || v.bytes !== null && (typeof v.bytes !== "string" || v.bytes.length > 2 * MAX || Buffer.from(v.bytes, "base64").toString("base64") !== v.bytes)) throw Error("setup receipt invalid");
    }
  }
  if (value.createdDirectory !== undefined) {
    const created = record(value.createdDirectory);
    if (target !== "agy" || Object.keys(created).sort().join() !== "dev,ino" || !Number.isSafeInteger(created.dev) || Number(created.dev) < 0 || !Number.isSafeInteger(created.ino) || Number(created.ino) <= 0) throw Error("setup receipt directory ownership invalid");
  }
  return value as unknown as Receipt;
}
function plannedHooks(c: ReturnType<typeof context>, target: SetupTarget): PlannedHook[] {
  if (target === "jcode" || target === "opencode" || target === "gemini" || target === "agy") return [];
  const launch = `${quote(c.bun)} --smol ${quote(c.entry)}`;
  return target === "claude" ? HOOK_EVENTS.map(event => ({ event, command: `${launch} hook ${event}`, timeout: 1 }))
    : [{ event: target === "pi" ? "session_shutdown" : "SessionEnd", command: `${launch} ingest ${target}${target === "pi" ? "" : " --json"}`, timeout: target === "pi" ? 2.5 : 3 }];
}
const lifecycle = (target: SetupTarget) => target === "jcode" || target === "opencode" || target === "gemini" || target === "agy" ? "MCP only; native capture unavailable" : target === "claude" ? "seven bounded native hooks" : target === "pi" ? "session_shutdown incremental ingest" : "SessionEnd incremental ingest";
export function planSetup(target: string, mode: SetupPlan["mode"] = "preview", options: SetupContext = {}): SetupPlan {
  if (target !== "all" && !SETUP_TARGETS.includes(target as SetupTarget)) throw Error("usage: amem setup claude|codex|kimi|pi|qwen|jcode|opencode|gemini|agy|all [--apply|--undo]");
  const targets: SetupTarget[] = target === "all" ? [...SETUP_ALL_TARGETS] : [target as SetupTarget];
  if (targets.includes("jcode")) assertJcodeHome(options.env ?? process.env);
  const c = context(options, targets.includes("agy") ? workspaceBinding(options) : undefined);
  if (mode !== "undo" && targets.includes("jcode")) assertJcodeRuntime(c);
  if (targets.includes("opencode") && (target === "opencode" || available(c, "opencode", options))) assertOpencodeLayout(c, mode);
  if (targets.includes("gemini") && (target === "gemini" || available(c, "gemini", options))) assertGeminiHome(c.env);
  if (mode !== "undo" && targets.includes("gemini")) assertGeminiRuntime(c.bun, c.entry);
  const pluginNotes: string[] = [];
  if (targets.includes("claude")) {
    const settings = json(read(c.paths.claude[1]!));
    // The settings-derived ids are computed outside the registry guard, so a broken installed_plugins.json cannot hide them.
    const ids = new Set<string>();
    try { for (const key of Object.keys(record(settings.enabledPlugins ?? {}))) ids.add(key); } catch { /* Optional plugin metadata must never prevent setup or recovery. */ }
    try { for (const key of Object.keys(record(json(read(join(dirname(c.paths.claude[1]!), "plugins", "installed_plugins.json"))).plugins ?? {}))) ids.add(key); } catch { /* Optional plugin metadata must never prevent setup or recovery; authoritative settings/receipts keep their guards. */ }
    for (const id of [...ids].filter(key => /^agent-mem(?:@[A-Za-z0-9._-]+)?$/.test(key))) pluginNotes.push(`Installed Claude plugin ${id} detected: if enabled, direct setup would duplicate its MCP server and seven hooks. Choose plugin installation or direct setup; disable/uninstall the plugin before applying direct setup.`);
  }
  if (targets.includes("qwen")) pluginNotes.push("Qwen capture supports the verified 0.26.1 native format. For custom advanced.runtimeOutputDir, export the matching QWEN_RUNTIME_DIR for manual and SessionEnd ingest.");
  if (targets.includes("jcode")) pluginNotes.push("Jcode setup registers MCP only. Native saved sessions do not prove per-message project scope, so capture and ingest hooks are unavailable; no hook or config.toml is installed.");
  if (targets.includes("gemini")) pluginNotes.push("Gemini CLI setup registers MCP only, at user scope in ~/.gemini/settings.json (GEMINI_CLI_HOME moves it), through the native gemini mcp add in a private staging HOME. Antigravity's ~/.gemini/config/mcp_config.json is never touched. A workspace .gemini/settings.json defining mcpServers.amem overrides this entry. No hook or ingest is installed: see docs/gemini-cli.md for why transcripts are not ingested.");
  if (targets.includes("opencode")) pluginNotes.push("OpenCode setup registers MCP only in the global strict-JSON opencode.json (mcp.amem, a local server started in the session's project directory). No plugin or ingest hook is installed: see docs/opencode.md for why transcripts are not ingested. A project opencode.json defining mcp.amem overrides this entry.");
  if (c.workspace) {
    pluginNotes.push(`Antigravity MCP is pinned to this repository only: ${c.workspace.root}. Restart the CLI/IDE and use one workspace; no global or plugin definitions are replaced, and same-name definitions elsewhere are unsupported. Native capture is unavailable; no hooks are installed. Only strict JSON is supported; JSONC is refused. Native TUI/IDE presence and live behavior are unverified; availability means this direct configuration operation is supported.`);
    if (!c.workspace.ignored) pluginNotes.push("WARNING: .agents/mcp_config.json is not Git-ignored; it contains absolute local paths. Setup will refuse it if it becomes tracked.");
  }
  if (target === "all") pluginNotes.push("Antigravity is repository-scoped and excluded from all; run amem setup agy explicitly inside its repository.");
  if (targets.includes("jcode")) pluginNotes.push("Launch Jcode with JCODE_DISABLE_CLAUDE_MCP=1 and without a same-name project override: imported Claude stdio entries can replace this private amem binding with a shared daemon-cwd server. Use a new workspace-bound session when changing projects.");
  return { targets, mode, actions: targets.map(target => {
    const prior = receipt(c, target, false); for (const file of c.paths[target]) read(file);
    const original = read(c.paths[target][0]!);
    const document: Record<string, unknown> = target === "agy" ? {} : target === "codex" ? toml(original.bytes === null ? "" : Buffer.from(original.bytes, "base64").toString("utf8")) : json(original);
    const hasAmem = target === "jcode" || target === "opencode" || target === "agy" ? mcpRecord(target, original) !== undefined : Object.hasOwn(record(document[target === "codex" ? "mcp_servers" : "mcpServers"] ?? {}), "amem");
    const unchanged = !!prior && prior.phase === "applied" && prior.intent === intent(c, target) && prior.changes.every((change, index) => { try { const live = read(change.path); restoreChange(prior, change, index, live); return managedAfter(target, index, change.before, change.after, live); } catch { return false; } });
    const add = command(target, c.bun, c.entry), remove = target === "gemini" ? [...GEMINI_REMOVE] : [target, "mcp", "remove", ...(target === "claude" || target === "qwen" ? ["--scope", "user"] : []), "amem"];
    const installed = available(c, target, options), version = installed && target !== "agy" && mode !== "undo" ? probeClientVersion(c, target, options) : undefined;
    if (version?.matches === false) pluginNotes.push(`WARNING: ${target} version ${version.output}; layout verified on ${version.verified}. Apply remains guarded by native configuration validation.`);
    return { target, available: installed, ...(version ? { version } : {}), files: c.paths[target], receipt: journal(c, target), ...(target === "agy" ? { cwd: c.workspace!.root } : {}), registration: mode === "undo" ? null : add, lifecycle: mode === "undo" ? "restore original MCP/hook files" : lifecycle(target), hooks: mode === "undo" || unchanged ? [] : plannedHooks(c, target), mcpChange: mode === "undo" ? prior ? "restore" : "unchanged" : unchanged ? "unchanged" : hasAmem ? "replace" : "add", commands: mode === "undo" || prior?.intent === intent(c, target) || !add || !installed ? [] : [...(hasAmem ? [remove] : []), add], state: prior && prior.intent !== intent(c, target) ? "runtime changed; managed entries will update" : prior?.phase ?? "not installed" };
  }), notes: [...pluginNotes, ...(/\/[^/]*\d+\.\d+[^/]*\/(?:bin\/)?bun$/.test(c.bun) ? ["this bun path is version-specific; rerun setup --apply after changing Bun"] : []), "Preview only unless --apply or --undo is passed; explicit modes apply without a prompt.", "Native registration commands run in a private staging HOME; only the listed configuration files are published.", "Original file bytes restore exactly when untouched; otherwise undo preserves CLI-owned changes and restores only managed entries, refusing edits to those entries.", "No AGENTS.md, CLAUDE.md or rule files are edited.", `A private ${join(c.state, "setup.lock")} serializes mutations; temporary ${join(realPath(tmpdir()), "amem-setup-*")} staging homes are removed.`, "Codex requires its native /hooks review before newly registered hooks run; setup does not grant hook trust. Runtime registrations use the PATH-resolved absolute Bun path without resolving its stable symlink; setup all reports and skips missing clients."] };
}
/** Native probes and registration share one private HOME, cwd and configuration layout. */
function stagingEnvironment(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext, staging: string) {
  const env: Record<string, string | undefined> = { ...c.env, HOME: staging, AMEM_HOME: join(staging, "memory"), AGENTHUB_HOME: join(staging, "hub"), CODEX_HOME: join(staging, ".codex"), KIMI_CODE_HOME: join(staging, ".kimi-code"), PI_CODING_AGENT_DIR: join(staging, ".pi", "agent"), QWEN_HOME: join(staging, ".qwen"), JCODE_HOME: join(staging, ".jcode") };
  Object.assign(env, { XDG_CONFIG_HOME: join(staging, ".config"), XDG_DATA_HOME: join(staging, ".local", "share"), XDG_CACHE_HOME: join(staging, ".cache"), XDG_STATE_HOME: join(staging, ".local", "state"), TMPDIR: join(staging, "tmp"), TMP: join(staging, "tmp"), TEMP: join(staging, "tmp") });
  env.QWEN_RUNTIME_DIR = join(staging, "qwen-runtime");
  env.QWEN_CODE_SYSTEM_SETTINGS_PATH = join(staging, "qwen-system-settings.json");
  env.QWEN_CODE_SYSTEM_DEFAULTS_PATH = join(staging, "qwen-system-defaults.json");
  // Gemini CLI: GEMINI_CLI_HOME overrides HOME for all its state; system settings paths are isolated too.
  env.GEMINI_CLI_HOME = staging;
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(staging, "gemini-system-settings.json");
  env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = join(staging, "gemini-system-defaults.json");
  mkdirSync(env.TMPDIR!, { mode: 0o700 });
  if (c.env.CLAUDE_CONFIG_DIR?.trim()) env.CLAUDE_CONFIG_DIR = join(staging, ".claude"); else delete env.CLAUDE_CONFIG_DIR;
  // The staging workspace is a trusted private binding, not a Git repository or the real caller cwd.
  const staged = context({ ...options, env, cwd: staging }, target === "agy" ? { root: staging, ignored: true, assertCurrent() {} } : undefined);
  // Codex refuses an explicit CODEX_HOME that does not exist, even for mcp add.
  mkdirSync(dirname(staged.paths[target][0]!), { recursive: true, mode: 0o700 });
  return { env, staged };
}
/** Advisory only: never queried by apply/undo or persisted in the ownership receipt. */
function probeClientVersion(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext): ClientVersion {
  const verified = SETUP_VERIFIED_VERSIONS[target];
  let output: string | null = null;
  // Like the help probe, trusted native fixtures do not invoke installed executables.
  if (!options.native) {
    let staging: string | undefined;
    try {
      staging = mkdtempSync(join(realPath(tmpdir()), "amem-setup-"));
      const { env } = stagingEnvironment(c, target, options, staging);
      const result = spawnSync(target, ["--version"], { cwd: staging, env: { ...env }, encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0 && !result.error) output = Array.from(singleLine(result.stdout).trim()).slice(0, 256).join("") || null;
    } catch { /* An absent, failed or timed-out native version never prevents setup. */ }
    finally { if (staging) try { rmSync(staging, { recursive: true, force: true }); } catch { output = null; } }
  }
  const observed = output?.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1];
  return { output, verified, matches: observed === undefined || verified === null ? null : observed === verified };
}
function verifyNativeMcp(target: SetupTarget, env: Env, cwd: string): void {
  // In older free-form Pi CLIs, an unknown subcommand can be treated as a model prompt.
  const help = spawnSync(target, ["--help"], { cwd, env: { ...env }, encoding: "utf8", timeout: 5000, maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"] });
  if (help.status !== 0 || !/^\s+(?:(?:pi|qwen|gemini)\s+)?mcp(?:\s|$)/m.test(help.stdout)) throw Error(`installed ${target} CLI does not expose MCP registration; no registration command was run`);
}
function native(argv: readonly string[], env: Env, cwd: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: { ...env }, encoding: "utf8", timeout: 10_000, maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const argumentsRejected = argv[0] === "qwen" && `${result.stderr ?? ""}\n${result.stdout ?? ""}`.includes("Not enough non-option arguments:");
    const reason = timedOut ? "timed out" : argumentsRejected ? "rejected command arguments" : "failed";
    throw Error(`${argv[0]} MCP registration ${reason} in staging; no native output disclosed`);
  }
}
function hookDocument(before: Image, events: readonly string[], commandFor: (event: string) => string, timeout = 1): Image {
  const document = json(before), hooks = document.hooks === undefined ? {} : record(document.hooks);
  for (const event of events) {
    const rows = hooks[event] ?? []; if (!Array.isArray(rows)) throw Error("setup hook groups must be arrays");
    const command = commandFor(event);
    if (!rows.some(row => [undefined, "", "*"].includes(row?.matcher) && Array.isArray(row?.hooks) && row.hooks.some((h: unknown) => { const value = record(h); return value.type === "command" && value.command === command && value.timeout === timeout; }))) rows.push({ hooks: [{ type: "command", command, timeout }] });
    hooks[event] = rows;
  }
  document.hooks = hooks; return objectImage(document, before);
}
function piExtension(bun: string, entry: string): string {
  return `// amem setup managed session-end ingest; no resident worker or instruction injection.\nimport { spawnSync } from 'node:child_process';\nexport default function (pi) {\n  pi.on('session_shutdown', (_event, ctx) => {\n    try { spawnSync(${JSON.stringify(bun)}, ['--smol', ${JSON.stringify(entry)}, 'ingest', 'pi'], { cwd: ctx.cwd, stdio: 'ignore', timeout: 2500 }); } catch {}\n  });\n}\n`;
}
interface Prepared { value: Receipt; expected: Image[]; unchanged: boolean }
function restoreChange(value: Receipt, change: Change, index: number, live: Image): Image {
  const start = value.phase === "prepared" && change.start && !sameImage(change.start, change.before) ? change.start : undefined;
  if (start) {
    const newest = managedAfter(value.target, index, change.before, change.after, live), previous = managedAfter(value.target, index, change.before, start, live);
    if (newest && previous) return restoreOwned(value.target, index, change.before, start, restoreOwned(value.target, index, change.before, change.after, live));
    if (previous) return restoreOwned(value.target, index, change.before, start, live);
    if (newest) return restoreOwned(value.target, index, change.before, change.after, live);
  }
  return restoreOwned(value.target, index, change.before, change.after, live);
}
function prepare(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext): Prepared {
  if (target === "jcode") assertJcodeRuntime(c);
  if (target === "opencode") assertOpencodeLayout(c, "apply");
  if (target === "gemini") assertGeminiHome(c.env);
  const prior = receipt(c, target, false), expected = c.paths[target].map(path => read(path));
  const restored = prior ? prior.changes.map((change, index) => restoreChange(prior, change, index, expected[index]!)) : expected;
  if (prior?.phase === "applied" && prior.intent === intent(c, target) && prior.changes.every((change, index) => managedAfter(target, index, change.before, change.after, expected[index]!))) return { value: prior, expected, unchanged: true };
  const changes: Change[] = c.paths[target].map((path, i) => ({ key: `${target}:${i}`, path, before: restored[i]!, after: restored[i]!, start: expected[i]! }));
  const staging = mkdtempSync(join(realPath(tmpdir()), "amem-setup-"));
  try {
    const { env, staged } = stagingEnvironment(c, target, options, staging);
    for (let i = 0; i < changes.length; i++) if (expected[i]!.bytes !== null) write(staged.paths[target][i]!, expected[i]!);
    const argv = command(target, c.bun, c.entry);
    if (argv && prior?.intent === intent(c, target)) {
      changes[0]!.after = putMcpRecord(target, changes[0]!.before, mcpRecord(target, prior.changes[0]!.after));
    } else if (argv) {
      if (!options.native) verifyNativeMcp(target, env, staging);
      const text = expected[0]!.bytes === null ? "" : Buffer.from(expected[0]!.bytes!, "base64").toString("utf8");
      const document = target === "codex" ? toml(text) : json(expected[0]!);
      const servers = document[target === "codex" ? "mcp_servers" : "mcpServers"];
      if (servers && Object.hasOwn(record(servers), "amem")) (options.native ?? native)(target === "gemini" ? [...GEMINI_REMOVE] : [target, "mcp", "remove", ...(target === "claude" || target === "qwen" ? ["--scope", "user"] : []), "amem"], env, staging);
      (options.native ?? native)(argv, env, staging);
      changes[0]!.after = { ...read(staged.paths[target][0]!), mode: changes[0]!.before.mode };
      if (changes[0]!.after.bytes === null) throw Error(`${target} native registration produced no configuration`);
      const installedText = Buffer.from(changes[0]!.after.bytes!, "base64").toString("utf8");
      let installed: Record<string, unknown>, installedServer: Record<string, unknown>;
      try {
        installed = target === "codex" ? toml(installedText) : json(changes[0]!.after);
        installedServer = record(record(installed[target === "codex" ? "mcp_servers" : "mcpServers"]).amem);
      } catch { throw Error(`${target} native registration produced invalid configuration; no configuration published`); }
      if (installedServer.command !== c.bun || JSON.stringify(installedServer.args) !== JSON.stringify(["--smol", c.entry, "mcp"]) || installedServer.enabled === false) throw Error(`${target} native registration did not produce the planned amem server`);
      const serverKey = target === "codex" ? "mcp_servers" : "mcpServers";
      const withoutAmem = (value: Record<string, unknown>) => { const copy = { ...value }, servers = { ...record(value[serverKey] ?? {}) }; delete servers.amem; copy[serverKey] = servers; return copy; };
      const originalUnrelated = withoutAmem(document), installedUnrelated = withoutAmem(installed);
      if (target === "codex") {
        // Restore the omitted default only in this detached comparison, never in native output.
        const originalServers = record(originalUnrelated[serverKey]), installedServers = record(installedUnrelated[serverKey]);
        for (const [name, value] of Object.entries(originalServers)) {
          if (!Object.hasOwn(installedServers, name)) continue;
          const before = record(value), after = installedServers[name];
          if (typeof before.command === "string" && Object.hasOwn(before, "args") && Array.isArray(before.args) && before.args.length === 0
              && after && typeof after === "object" && !Array.isArray(after) && !Object.hasOwn(after, "args")) {
            installedServers[name] = { ...after, args: [] };
          }
        }
      }
      if (!isDeepStrictEqual(originalUnrelated[serverKey], installedUnrelated[serverKey])) throw Error(`${target} native registration changed unrelated MCP servers; no configuration published`);
      if (target === "codex") {
        if (!isDeepStrictEqual(originalUnrelated, installedUnrelated)) throw Error("codex native registration changed unrelated settings; no configuration published");
        changes[0]!.after = putMcpRecord(target, changes[0]!.before, installedServer);
      } else {
        // Keep all unrelated JSON settings from the original; use only the CLI-generated server record.
        // Qwen's restored image also retires its previous managed hook on a runtime upgrade.
        const kept = target === "qwen" ? json(changes[0]!.before) : document;
        kept.mcpServers = { ...record(kept.mcpServers ?? {}), amem: installedServer };
        changes[0]!.after = objectImage(kept, changes[0]!.before);
      }
    } else if (target === "agy") {
      changes[0]!.after = putMcpRecord(target, changes[0]!.before, { command: c.bun, args: ["--smol", c.entry, "mcp"], cwd: c.workspace!.root });
    } else if (target === "jcode") {
      // Shared native pools use the daemon cwd; amem must bind the calling session's project.
      changes[0]!.after = putMcpRecord(target, changes[0]!.before, { command: c.bun, args: ["--smol", c.entry, "mcp"], shared: false });
    } else if (target === "opencode") {
      // `opencode mcp add` is interactive for local servers and has no remove; edit the owned entry directly.
      changes[0]!.after = putMcpRecord(target, changes[0]!.before, opencodeServer(c.bun, c.entry));
    } else {
      const document = json(changes[0]!.before), servers = document.mcpServers === undefined ? {} : record(document.mcpServers);
      servers.amem = { command: c.bun, args: ["--smol", c.entry, "mcp"] }; document.mcpServers = servers;
      changes[0]!.after = objectImage(document, changes[0]!.before);
    }
    const capture = (kind: string) => `${quote(c.bun)} --smol ${quote(c.entry)} ingest ${kind} --json`;
    if (target === "claude") changes[1]!.after = hookDocument(changes[1]!.before, HOOK_EVENTS, event => `${quote(c.bun)} --smol ${quote(c.entry)} hook ${event}`);
    if (target === "codex") changes[1]!.after = hookDocument(changes[1]!.before, ["SessionEnd"], () => capture("codex"), 3);
    // Qwen's user MCP and hooks share settings.json: publish and journal one combined image.
    if (target === "qwen") changes[0]!.after = hookDocument(changes[0]!.after, ["SessionEnd"], () => capture("qwen"), 3);
    if (target === "kimi") {
      const old = changes[1]!.before.bytes === null ? "" : Buffer.from(changes[1]!.before.bytes!, "base64").toString("utf8");
      const parsed = toml(old), hooks = parsed.hooks ?? [];
      if (!Array.isArray(hooks)) throw Error("Kimi hooks must be an array");
      if (!hooks.some(h => record(h).event === "SessionEnd" && record(h).command === capture("kimi"))) hooks.push({ event: "SessionEnd", command: capture("kimi"), timeout: 3 });
      changes[1]!.after = image(updateTomlArray(old, ["hooks"], hooks), changes[1]!.before.mode);
    }
    if (target === "pi") {
      const content = piExtension(c.bun, c.entry);
      if (!prior && changes[1]!.before.bytes !== null && changes[1]!.before.bytes !== image(content).bytes) throw Error("Pi amem-session extension already exists and is not this setup's file");
      changes[1]!.after = image(content, changes[1]!.before.mode);
    }
    // Never publish an image that this installer's own read/undo boundary cannot reopen.
    if (changes.some(change => change.after.bytes !== null && Buffer.from(change.after.bytes, "base64").byteLength > MAX)) throw Error("planned setup configuration exceeds the size bound; no configuration published");
    return { value: { version: 1, target, intent: intent(c, target), phase: "prepared", changes, ...(prior?.createdDirectory ? { createdDirectory: prior.createdDirectory } : {}) }, expected, unchanged: false };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function save(c: ReturnType<typeof context>, value: Receipt): void { write(journal(c, value.target), image(JSON.stringify(value) + "\n")); }
function available(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext): boolean { return target === "agy" || !!options.native || Bun.which(target, { PATH: c.env.PATH ?? process.env.PATH }) !== null; }
export interface SetupApplyResult { applied: SetupTarget[]; unchanged: SetupTarget[]; skipped?: { target: SetupTarget; reason: string }[] }
/** Claim only a directory this invocation actually created, never one merely absent at preview. */
function prepareCreatedDirectory(c: ReturnType<typeof context>, value: Receipt): void {
  if (value.target !== "agy") return;
  const dir = dirname(c.paths.agy[0]!); names(dir);
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  // ponytail: mkdir/lstat and lstat/rmdir below cannot exclude external namespace swaps.
  // Descriptor-relative conditional removal or a shared writer lock is the upgrade.
  const stat = lstatSync(dir); value.createdDirectory = { dev: stat.dev, ino: stat.ino };
  // ponytail: a crash between mkdir and this save can leave an empty directory unclaimed.
  // A durable filesystem intent protocol is the upgrade; never guess ownership during undo.
  save(c, value);
}
function removeCreatedDirectory(c: ReturnType<typeof context>, value: Receipt): void {
  if (value.target !== "agy" || !value.createdDirectory) return; // Legacy receipts prove no directory ownership.
  const dir = dirname(c.paths.agy[0]!), stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== value.createdDirectory.dev || stat.ino !== value.createdDirectory.ino) return;
  try { rmdirSync(dir); } // Atomic empty-only removal also preserves files added after the identity check.
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}
function contextForPlan(plan: SetupPlan, options: SetupContext) {
  const c = context(options, plan.targets.includes("agy") ? workspaceBinding(options) : undefined);
  if (c.workspace) {
    const action = plan.actions.find(action => action.target === "agy");
    if (!action || action.cwd !== c.workspace.root || !isDeepStrictEqual(action.files, c.paths.agy)) throw Error("Antigravity workspace changed since preview");
  }
  return c;
}
function publishGuard(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext) {
  return target === "agy" ? (file: string) => { options.beforePublish?.(file); c.workspace!.assertCurrent(); } : options.beforePublish;
}
/** CLI-owned unrelated fields remain live. */
function applyUnlocked(plan: SetupPlan, options: SetupContext = {}): SetupApplyResult {
  const c = contextForPlan(plan, options), skipped: { target: SetupTarget; reason: string }[] = [];
  const targets = plan.targets.filter(target => { if (available(c, target, options)) return true; if (plan.targets.length === 1) throw Error(`${target} CLI is not installed`); skipped.push({ target, reason: "CLI not installed" }); return false; });
  const prepared = targets.map(target => prepare(c, target, options));
  for (const item of prepared) if (!item.unchanged) for (let i = 0; i < item.value.changes.length; i++) if (!sameImage(read(item.value.changes[i]!.path), item.expected[i]!)) throw Error("setup configuration changed during preparation");
  const applied: SetupTarget[] = [], unchanged: SetupTarget[] = [];
  for (const item of prepared) {
    const value = item.value;
    if (value.target === "agy") c.workspace!.assertCurrent();
    if (item.unchanged) { unchanged.push(value.target); continue; }
    save(c, value);
    prepareCreatedDirectory(c, value);
    for (let i = 0; i < value.changes.length; i++) { const change = value.changes[i]!; if (!sameImage(item.expected[i]!, change.after)) write(change.path, change.after, item.expected[i]!, publishGuard(c, value.target, options)); }
    value.phase = "applied"; save(c, value); applied.push(value.target);
  }
  return { applied, unchanged, ...(skipped.length ? { skipped } : {}) };
}
/** Byte-exact for untouched files, otherwise remove/restore only this installer's owned entries. */
function undoUnlocked(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[] } {
  const c = contextForPlan(plan, options), receipts = plan.targets.map(target => receipt(c, target, false)).filter((value): value is Receipt => !!value);
  const pending = receipts.map(value => ({ value, files: value.changes.map((change, index) => { const expected = read(change.path); return { change, expected, restored: restoreChange(value, change, index, expected) }; }) }));
  for (const item of pending) for (const file of item.files) if (!sameImage(read(file.change.path), file.expected)) throw Error("setup configuration changed during undo preparation");
  for (const item of pending) { if (item.value.target === "agy") c.workspace!.assertCurrent(); for (const file of item.files) if (!sameImage(file.expected, file.restored)) write(file.change.path, file.restored, file.expected, publishGuard(c, item.value.target, options)); removeCreatedDirectory(c, item.value); rmSync(journal(c, item.value.target)); }
  return { restored: receipts.map(value => value.target) };
}

function withSetupLock<T>(options: SetupContext, run: () => T): T {
  const c = context(options); names(c.state); mkdirSync(c.state, { recursive: true, mode: 0o700 });
  if (lstatSync(c.state).mode & 0o077) throw Error("setup backup directory must be private");
  const file = join(c.state, "setup.lock"), signature = processSignature(process.pid);
  if (!signature) throw Error("setup process identity unavailable");
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const original = read(file), owner = original.bytes && record(JSON.parse(Buffer.from(original.bytes, "base64").toString("utf8")));
    if (!owner || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.signature !== "string") throw Error("setup is busy or its lock is unreadable");
    const live = processLiveness(Number(owner.pid)), actual = live === "live" ? processSignature(Number(owner.pid)) : undefined;
    const stale = live === "gone" || live === "live" && actual !== undefined && actual !== owner.signature;
    if (!stale || digest(read(file)) !== digest(original)) throw Error("setup is busy; retry after the active setup exits");
    rmSync(file); fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  }
  const token = JSON.stringify({ pid: process.pid, signature, nonce: randomUUID() });
  try { writeFileSync(fd, token); fsyncSync(fd); return run(); }
  finally { closeSync(fd); if (read(file).bytes === Buffer.from(token).toString("base64")) rmSync(file); }
}
export function applySetup(plan: SetupPlan, options: SetupContext = {}): SetupApplyResult {
  if (plan.targets.includes("jcode")) assertJcodeHome(options.env ?? process.env);
  if (plan.targets.includes("agy")) contextForPlan(plan, options);
  return withSetupLock(options, () => applyUnlocked(plan, options));
}
export function undoSetup(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[] } {
  if (plan.targets.includes("jcode")) assertJcodeHome(options.env ?? process.env);
  if (plan.targets.includes("agy")) contextForPlan(plan, options);
  return withSetupLock(options, () => undoUnlocked(plan, options));
}

/** Person-facing setup plan (#125): each target once, with its effective files, MCP and hook changes, then skipped clients and notes. `--json` keeps the raw plan. */
export function setupPlanText(plan: SetupPlan, s: Style = PLAIN): string {
  const verb = plan.mode === "undo" ? "undo" : plan.mode === "apply" ? "apply" : "preview";
  // Undo restores every target with a receipt whether or not its CLI is still installed (undoUnlocked), so undo never collapses an action.
  const full = (action: SetupPlan["actions"][number]) => plan.mode === "undo" || action.available;
  const skipped = plan.actions.filter(action => !full(action)), changing = plan.actions.filter(action => full(action) && action.mcpChange !== "unchanged");
  const lines = [`${s.bold(`amem setup ${verb}:`)} ${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}, ${changing.length} with ${plan.mode === "undo" ? "restores" : "MCP changes"}${skipped.length ? `, ${skipped.length} skipped` : ""}`, ""];
  for (const action of plan.actions) {
    if (!full(action)) { lines.push(`${label(s, "skipped")} ${s.bold(action.target)}: CLI not installed`); continue; }
    const state = action.mcpChange === "unchanged" ? "ok" : "attention";
    const what = action.mcpChange === "unchanged" ? plan.mode === "undo" ? "no setup receipt; nothing to restore" : "already set up; no change" : action.mcpChange === "restore" ? `restore original MCP/hook files${action.available ? "" : " (CLI not installed)"}` : `MCP ${action.mcpChange}`;
    lines.push(`${label(s, state)} ${s.bold(action.target)}: ${what} ${s.dim(`(${action.state})`)}`);
    if (action.version) {
      const reported = action.version.output === null ? "unknown" : action.version.verified && action.version.matches === null ? `unrecognised (${action.version.output})` : action.version.output;
      lines.push(`            version ${reported}; ${action.version.verified ? `verified ${action.version.verified}` : "unverified (no verified version recorded)"}`);
    }
    for (const file of action.files) lines.push(`            file     ${file}`);
    if (action.cwd) lines.push(`            cwd      ${action.cwd}`);
    lines.push(`            receipt  ${action.receipt}`);
    if (action.available && action.registration) lines.push(`            command  ${action.registration.map(quote).join(" ")}`);
    for (const hook of action.hooks) lines.push(`            hook     ${hook.event}: ${hook.command} (timeout ${hook.timeout})`);
    if (action.available && !action.hooks.length && plan.mode !== "undo") lines.push(`            hook     ${s.dim("none")}`);
    lines.push(`            ${s.dim(action.lifecycle)}`);
  }
  const warnings = plan.notes.filter(note => /^WARNING|detected|version-specific/.test(note)), notes = plan.notes.filter(note => !warnings.includes(note));
  if (skipped.length) lines.push("", `Skipped clients: ${skipped.map(action => action.target).join(", ")} (not installed)`);
  if (warnings.length) lines.push("", "Warnings:", ...warnings.map(note => `  - ${s.attention(note)}`));
  lines.push("", "Notes:", ...notes.map(note => `  - ${note}`));
  if (plan.mode === "preview") lines.push("", `Next: amem setup ${plan.targets.length === 1 ? plan.targets[0] : "all"} --apply writes without a prompt; --json prints the full plan`);
  return lines.join("\n");
}

function setupResultText(result: SetupApplyResult | { restored: SetupTarget[] }, s: Style): string {
  if ("restored" in result) return `${label(s, "ok")} restored: ${result.restored.join(", ") || "none"}`;
  return [`${label(s, "ok")} applied: ${result.applied.join(", ") || "none"}`, `${label(s, "ok")} unchanged: ${result.unchanged.join(", ") || "none"}`,
    ...(result.skipped ?? []).map(item => `${label(s, "skipped")} ${item.target}: ${item.reason}`)].join("\n");
}

/** Compatibility formatter for confirmation-style callers: the raw plan under `--json`, the readable plan otherwise. */
export function setupConfirmationText(plan: SetupPlan, json: boolean, s: Style = PLAIN): string { return json ? JSON.stringify(plan, null, 2) : setupPlanText(plan, s); }

export async function runSetup(target: string, mode: SetupPlan["mode"], options: SetupContext & { json?: boolean; style?: Style } = {}): Promise<string> {
  const plan = planSetup(target, mode, options), s = options.json ? PLAIN : options.style ?? PLAIN;
  if (cliAttribution()?.actor === "agent" && !configuredPolicy(memoryHome(options.env ?? process.env), options.cwd ?? process.cwd()).screenStandalone(JSON.parse(JSON.stringify(plan)))) throw Error("Memory operation unavailable or refused; no partial result is shown.");
  if (mode === "preview") return options.json ? JSON.stringify(plan, null, 2) : setupPlanText(plan, s);
  const result = mode === "apply" ? applySetup(plan, options) : undoSetup(plan, options);
  return options.json ? JSON.stringify(result, null, 2) : setupResultText(result, s);
}
