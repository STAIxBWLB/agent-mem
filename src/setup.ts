import { installSkills, skillRoot, type SkillInstallReport } from "./skills-install.ts";
import { Report, cellWidth } from "@staix/cli-output";
import { cliAttribution } from "./memory/cli-attribution.ts";
import { configuredPolicy } from "./memory/config.ts";
import { SETUP_CONFIG_BYTES, updateTomlArray } from "./setup-toml.ts";
import { amemCaptureCommand, amemCaptureHooks, managedAfter, mcpLauncher, mcpRecord, putMcpRecord, restoreOwned, retiresOriginalHook, sameImage, type ConfigImage } from "./setup-owned.ts";
import { opencodeServer } from "./setup-opencode.ts";
import { assertGeminiHome, assertGeminiRuntime, GEMINI_REMOVE, geminiAddCommand } from "./setup-gemini.ts";
import { resolveSetupPaths, opencodeConfigRoot } from "./setup-paths.ts";
import { JCODE_CAPTURE_EVENTS, putJcodeHooks } from "./setup-jcode.ts";
/** jcode parses hook command lines shell-style and runs them directly (no shell), so single quotes group each path. */
const jcodeHookCommand = (bun: string, entry: string) => `${quote(bun)} --smol ${quote(entry)} hook jcode`;
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, types } from "node:util";
import { HOOK_EVENTS } from "./hook-contract.ts";
import { decodeReceipt, JOURNAL_MAX, readSetupWriterRoots, setupReceiptRemedy, SetupWriterRootsError, SETUP_TARGETS, type Receipt, type SetupTarget } from "./setup-writer-roots.ts";
export { readSetupWriterRoots, setupReceiptRemedy, SetupWriterRootsError, SETUP_TARGETS, type SetupTarget };
import { readEffectiveSyncPlacementWriters } from "./memory/sync-placement-effective-writers.ts";
import { placementMarkerState } from "./memory/sync-placement-guard.ts";
import { memoryHome } from "./memory/home.ts";
import { PLAIN, singleLine, type Style } from "./memory/style.ts";
import { canonicalPath, memoryGitEnv, memoryGitSync, processLiveness, processSignature, realPath } from "./memory/platform.ts";

/** Workspace-scoped Antigravity setup is always selected explicitly. */
export const SETUP_ALL_TARGETS = SETUP_TARGETS.filter(target => target !== "agy");
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
export interface SetupContext {
  env?: Env; bun?: string; entry?: string; stdinTTY?: boolean; cwd?: string;
  /** `--root`: an absolute amem install root to register instead of the running one (#199). Ignored when `entry` is given. */
  root?: string;
  /** `--adopt-current` (#241): with apply, set a stale receipt aside and adopt the live wiring as the new baseline. A receipt that is not stale is kept. */
  adoptCurrent?: boolean;
  /** @deprecated Retained for source compatibility; explicit apply/undo modes do not prompt. */
  confirm?: (plan: SetupPlan) => Promise<boolean>;
  /** Host-only race fixture, called after temporary-file fsync and before the final comparison/rename. */
  beforePublish?: (file: string) => void;
  /** Trusted test seam; production always runs the named native CLI in a private staging HOME. */
  native?: (argv: readonly string[], env: Env, cwd: string) => void;
}
export type SetupSkillResult = { target: SetupTarget; report?: SkillInstallReport; reason?: string; refused?: boolean };
export interface SetupPlan {
  skills?: SetupSkillResult[];
  targets: SetupTarget[]; mode: "preview" | "apply" | "undo"; root?: InstallRoot;
  actions: { target: SetupTarget; version?: ClientVersion; files: string[]; receipt: string; cwd?: string; registration: string[] | null; lifecycle: string; available: boolean; hooks: PlannedHook[]; removes?: { file: string; event: string; command: string }[]; mcpChange: "add" | "replace" | "restore" | "unchanged"; commands: string[][]; state: string }[];
  notes: string[];
  /** #551, additive: the placement-inventory warning, repeated on the apply receipt so `--apply` shows it too. */
  placementWriter?: string;
}
const MAX = SETUP_CONFIG_BYTES;
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
  const { paths, legacyPaths, redirects } = resolveSetupPaths(env, home, workspace?.root);
  const requestedBun = options.bun ?? "bun", bun = requestedBun === "bun" ? Bun.which("bun", { PATH: env.PATH ?? process.env.PATH }) : requestedBun;
  const install = options.entry === undefined && options.root !== undefined ? installRoot(options.root) : undefined;
  const entry = options.entry ?? (install ? join(install.path, "bin", "amem.js") : fileURLToPath(new URL("../bin/amem.js", import.meta.url)));
  if (!bun || !isAbsolute(bun) || !isAbsolute(entry)) throw Error("setup needs a PATH-resolved absolute Bun runtime and an absolute installed entry");
  // The trusted native fixture may use a temporary package; ordinary CLI installation must outlive bunx's cache.
  if (!options.native) {
    const roots = [resolve(tmpdir()), realPath(tmpdir())], entries = [resolve(entry), realPath(entry)];
    if (roots.some(root => entries.some(file => { const part = relative(root, file); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); }))) throw Error("setup refuses a temporary package entry; install amem in a persistent location first");
  }
  return { env, home, paths, legacyPaths, redirects, bun, entry, root: install, workspace, state: join(canonicalPath(memoryHome({ ...env, AGENTHUB_HOME: env.AGENTHUB_HOME?.trim() || join(home, ".agenthub") })), "setup") };
}
export interface InstallRoot { path: string; version: string }
const PACKAGE_JSON_MAX = 64 * 1024;
/**
 * An amem install root to register, such as `<install>/releases/<version>/` (#199). It is resolved to its real path, so a `current` link
 * registers the release it names, and replacing another install never changes what the registered hooks and MCP server load. The root must
 * hold a regular `package.json` named `@staix/agent-mem` (read on one non-following, non-blocking descriptor, at most 64 KiB) and a regular
 * `bin/amem.js`.
 */
export function installRoot(root: string): InstallRoot {
  if (!isAbsolute(root)) throw Error("setup --root must be an absolute path");
  const refused = (why: string) => Error(`setup --root ${root}: ${why}`);
  let path: string;
  try { path = realPath(root); } catch { throw refused("not found"); }
  let fd: number;
  try { fd = openSync(join(path, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw refused("no readable package.json"); }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PACKAGE_JSON_MAX) throw refused("package.json is not a regular file of at most 64 KiB");
    const data = Buffer.alloc(PACKAGE_JSON_MAX + 1); let size = 0, n: number;
    while (size < data.length && (n = readSync(fd, data, size, data.length - size, null)) > 0) size += n;
    if (size > PACKAGE_JSON_MAX) throw refused("package.json is not a regular file of at most 64 KiB");
    text = data.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
  let pkg: unknown;
  try { pkg = JSON.parse(text); } catch { throw refused("package.json is not JSON"); }
  const { name, version } = (pkg && typeof pkg === "object" ? pkg : {}) as { name?: unknown; version?: unknown };
  if (name !== "@staix/agent-mem" || typeof version !== "string") throw refused("not an @staix/agent-mem install root");
  if (!lstatSync(join(path, "bin", "amem.js"), { throwIfNoEntry: false })?.isFile()) throw refused("no regular bin/amem.js");
  return { path, version };
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
function intent(c: ReturnType<typeof context>, target: SetupTarget): string { return digest([1, target, c.paths[target], c.bun, c.entry, ...(["codex", "kimi", "qwen"].includes(target) ? ["capture-json-v1"] : []), ...(target === "jcode" ? ["jcode-hooks-v1"] : []), ...(["claude", "codex", "kimi", "pi", "qwen", "jcode"].includes(target) ? ["root-hooks-v2"] : []), ...(target === "agy" ? [c.workspace!.root] : [])]); }
function journal(c: ReturnType<typeof context>, target: SetupTarget): string { return join(c.state, target === "agy" ? `agy-${digest(c.workspace!.root)}.json` : `${target}.json`); }
function receipt(c: ReturnType<typeof context>, target: SetupTarget, requireRuntime = false): Receipt | undefined {
  const raw = read(journal(c, target), JOURNAL_MAX); if (raw.bytes === null) return;
  const value = decodeReceipt(record(JSON.parse(Buffer.from(raw.bytes, "base64").toString("utf8"))), target, c.paths[target].length);
  if (requireRuntime && value.intent !== intent(c, target)) throw Error("setup receipt does not match this installation");
  for (let i = 0; i < value.changes.length; i++) {
    const change = value.changes[i]!, currentPath = c.paths[target][i], legacyRedirect = c.redirects.some(row => row.target === target && row.from === change.path && row.to === currentPath);
    if (target === "claude" && i === 0 && typeof change.path === "string" && change.path !== currentPath && !legacyRedirect
      && resolveSetupPaths({ ...c.env, CLAUDE_CONFIG_DIR: dirname(change.path) }, c.home).redirects.some(row => row.from === change.path && row.to === currentPath))
      throw Error("setup receipt was written from an Orca Claude profile; rerun setup from that Orca profile");
    if (change.path !== currentPath && !legacyRedirect) throw Error("setup receipt target mismatch");
  }
  return value;
}
function plannedHooks(c: ReturnType<typeof context>, target: SetupTarget): PlannedHook[] {
  if (target === "jcode") return JCODE_CAPTURE_EVENTS.map(event => ({ event, command: jcodeHookCommand(c.bun, c.entry), timeout: 1 }));
  if (target === "opencode" || target === "gemini" || target === "agy") return [];
  const launch = `${quote(c.bun)} --smol ${quote(c.entry)}`;
  return target === "claude" ? HOOK_EVENTS.map(event => ({ event, command: `${launch} hook ${event}`, timeout: 1 }))
    : [{ event: target === "pi" ? "session_shutdown" : "SessionEnd", command: `${launch} ingest ${target}${target === "pi" ? "" : " --json"}`, timeout: target === "pi" ? 2.5 : 3 }];
}
/** The file index of a target's capture hook surface (#512): Qwen keeps hooks in its MCP settings file. */
const HOOK_SURFACE: Partial<Record<SetupTarget, number>> = { codex: 1, kimi: 1, qwen: 0, pi: 1 };
/** #512: amem capture entries of this target in the live surface that are not the current one: what apply removes, whatever their install root. */
function strayCaptures(target: SetupTarget, image: Image, current: string): { event: string; command: string }[] {
  if (HOOK_SURFACE[target] === undefined) return [];
  try {
    const rows = amemCaptureHooks(target, image);
    // Pi: only an extension that is byte-for-byte setup's own output for some install root is amem's; customized content is never replaced.
    if (target === "pi" && !rows.every(row => { const launch = amemCaptureCommand(row.command); return !!launch && image.bytes === Buffer.from(piExtension(launch.bun, launch.entry)).toString("base64"); })) return [];
    // Identical duplicates of the current entry are strays too (AC1: exactly one remains); apply removes every copy and adds one back.
    return rows.filter(row => row.command !== current || rows.filter(other => other.command === current).length > 1);
  } catch { return []; }
}
const lifecycle = (target: SetupTarget) => target === "opencode" || target === "gemini" || target === "agy" ? "MCP only; native capture unavailable" : target === "jcode" ? "post_tool and turn_end capture hooks" : target === "claude" ? "seven bounded native hooks" : target === "pi" ? "session_shutdown incremental ingest" : "SessionEnd incremental ingest";
/**
 * #551 AC2: the placement writer inventory this home's sync will verify. A root the inventory provably does not hold is named
 * as such with the renewal step to take first; an inventory that cannot be read is reported as unverified, never as a missing
 * entry. It writes nothing, refuses nothing and returns undefined on a home that is not activated for placement sync.
 */
function placementWriterInventoryNote(root: string, home: string): string | undefined {
  // #551 AC2: only a proven non-placement home stays silent. Markers that cannot be read or parsed prove nothing either way,
  // so they fall through to the inventory read below, which reports the state as unverified instead of as a missing root.
  if (placementMarkerState(home) === "not placement") return undefined;
  let roots: readonly string[] | undefined;
  try { roots = readEffectiveSyncPlacementWriters(home).roots; } catch { roots = undefined; }
  if (roots === undefined) return "WARNING: the active placement writer inventory could not be verified here, so this root is neither confirmed nor refused. Setup registers it exactly as previewed and changes no inventory entry; check the inventory with the person before relying on placement sync.";
  let canonical: string;
  try { canonical = realPath(root); } catch { return undefined; }
  if (roots.includes(canonical)) return undefined;
  // #551 AC2: the suggested argument is shell-quoted, so a root with a space, a quote or a shell metacharacter stays one argument.
  return `WARNING: this install root is outside the active placement writer inventory, so placement sync stops in writer verification once setup registers it. Renew the inventory first with the person, through the checkpoint while sessions keep running - preview amem migrate --sync-placement --checkpoint --writer-root ${quote(canonical)} with every other install root, then amem migrate --sync-placement --checkpoint --confirm --plan <saved preview JSON> with the same --writer-root list; only if the checkpoint preview refuses, close every amem session and run amem migrate --sync-placement --dry-run --writer-root ${quote(canonical)}, then --apply - and rerun setup after that. Setup writes no inventory entry and never refuses on this alone.`;
}
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
  for (const row of c.redirects.filter(row => targets.includes(row.target))) {
    pluginNotes.push(`${row.target}: ${row.from} -> ${row.to}. ${row.reason}; start a new Orca session to receive the change.`);
  }
  if (targets.includes("claude")) {
    const settingsPath = mode === "undo" ? receipt(c, "claude", false)?.changes[1]?.path ?? c.paths.claude[1]! : c.paths.claude[1]!;
    const settings = json(read(settingsPath));
    // The settings-derived ids are computed outside the registry guard, so a broken installed_plugins.json cannot hide them.
    const ids = new Set<string>();
    try { for (const key of Object.keys(record(settings.enabledPlugins ?? {}))) ids.add(key); } catch { /* Optional plugin metadata must never prevent setup or recovery. */ }
    try { for (const key of Object.keys(record(json(read(join(dirname(settingsPath), "plugins", "installed_plugins.json"))).plugins ?? {}))) ids.add(key); } catch { /* Optional plugin metadata must never prevent setup or recovery; authoritative settings/receipts keep their guards. */ }
    for (const id of [...ids].filter(key => /^agent-mem(?:@[A-Za-z0-9._-]+)?$/.test(key))) pluginNotes.push(`Installed Claude plugin ${id} detected: if enabled, direct setup would duplicate its MCP server and seven hooks. Choose plugin installation or direct setup; disable/uninstall the plugin before applying direct setup.`);
  }
  if (targets.includes("qwen")) pluginNotes.push("Qwen capture supports the verified 0.26.1 native format. For custom advanced.runtimeOutputDir, export the matching QWEN_RUNTIME_DIR for manual and SessionEnd ingest.");
  if (targets.includes("jcode")) pluginNotes.push("Jcode setup registers MCP and adds `amem hook jcode` to the post_tool and turn_end lifecycle hooks in JCODE_HOME/config.toml, keeping any existing command for those events (array form). Each event is scoped by its own JCODE_HOOK_CWD; events with no cwd, or outside a project, are skipped. Saved sessions and journals are still not ingested (no per-message origin), and user prompts are not captured.");
  if (targets.includes("gemini")) pluginNotes.push("Gemini CLI setup registers MCP only, at user scope in ~/.gemini/settings.json (GEMINI_CLI_HOME moves it), through the native gemini mcp add in a private staging HOME. Antigravity's ~/.gemini/config/mcp_config.json is never touched. A workspace .gemini/settings.json defining mcpServers.amem overrides this entry. No hook or ingest is installed: see docs/gemini-cli.md for why transcripts are not ingested.");
  if (targets.includes("opencode")) pluginNotes.push("OpenCode setup registers MCP only in the global strict-JSON opencode.json (mcp.amem, a local server started in the session's project directory). No plugin or ingest hook is installed: see docs/opencode.md for why transcripts are not ingested. A project opencode.json defining mcp.amem overrides this entry.");
  if (c.workspace) {
    pluginNotes.push(`Antigravity MCP is pinned to this repository only: ${c.workspace.root}. Restart the CLI/IDE and use one workspace; no global or plugin definitions are replaced, and same-name definitions elsewhere are unsupported. Native capture is unavailable; no hooks are installed. Only strict JSON is supported; JSONC is refused. Native TUI/IDE presence and live behavior are unverified; availability means this direct configuration operation is supported.`);
    if (!c.workspace.ignored) pluginNotes.push("WARNING: .agents/mcp_config.json is not Git-ignored; it contains absolute local paths. Setup will refuse it if it becomes tracked.");
  }
  if (c.root) pluginNotes.push(`Registers the install root ${c.root.path} (amem ${c.root.version}) for hooks and MCP; current registrations change only on --apply.`);
  // #551: the root this plan registers may not be in the home's active placement inventory, which stops sync in writer verification.
  const placementWriter = placementWriterInventoryNote(c.root?.path ?? fileURLToPath(new URL("..", import.meta.url)), dirname(c.state));
  if (placementWriter) pluginNotes.push(placementWriter);
  if (target === "all") pluginNotes.push("Antigravity is repository-scoped and excluded from all; run amem setup agy explicitly inside its repository.");
  if (targets.includes("jcode")) pluginNotes.push("Launch Jcode with JCODE_DISABLE_CLAUDE_MCP=1 and without a same-name project override: imported Claude stdio entries can replace this private amem binding with a shared daemon-cwd server. Use a new workspace-bound session when changing projects.");
  const skills = mode === "undo" ? [] : skillResults(c, targets.filter(target => available(c, target, options)), "preview", mode);
  return { targets, mode, ...(skills.length ? { skills } : {}), ...(c.root ? { root: c.root } : {}), ...(placementWriter ? { placementWriter } : {}), actions: targets.map(target => {
    const receipted = receipt(c, target, false), files = mode === "undo" && receipted ? receipted.changes.map(change => change.path) : c.paths[target];
    for (const file of files) read(file);
    const stale = mode !== "undo" && !!receipted && staleReceipt(target, receipted);
    if (stale) pluginNotes.push(options.adoptCurrent
      ? `${target}: the setup receipt is stale (its managed entries were replaced at another amem install root outside setup). Apply keeps it as ${journal(c, target)}.stale-<UTC time> and adopts the current wiring; --undo then restores that wiring.`
      : `${target}: the setup receipt is stale (its managed entries were replaced at another amem install root outside setup). Apply refuses; rerun with --apply --adopt-current to keep the receipt aside and adopt the current wiring, which --undo then restores.`);
    // An adopted stale receipt plans like the receipt-less path that apply takes.
    const prior = stale && options.adoptCurrent ? undefined : receipted;
    if (mode === "undo" && prior?.changes.some((change, index) => change.path !== c.paths[target][index])) {
      pluginNotes.push(`${target}: undo restores the historical receipt files, not the new personal source: ${prior.changes.map(change => change.path).join(", ")}`);
    }
    const original = read(files[0]!);
    const document: Record<string, unknown> = target === "agy" ? {} : target === "codex" ? toml(original.bytes === null ? "" : Buffer.from(original.bytes, "base64").toString("utf8")) : json(original);
    const hasAmem = target === "jcode" || target === "opencode" || target === "agy" ? mcpRecord(target, original) !== undefined : Object.hasOwn(record(document[target === "codex" ? "mcp_servers" : "mcpServers"] ?? {}), "amem");
    if (!prior && mode !== "undo" && (target === "claude" || target === "codex")) {
      try {
        const server = mcpRecord(target, original);
        const sameBinding = server && typeof server === "object" && !Array.isArray(server)
          && (server as Record<string, unknown>).command === c.bun
          && isDeepStrictEqual((server as Record<string, unknown>).args, ["--smol", c.entry, "mcp"])
          && (server as Record<string, unknown>).enabled !== false;
        const hookFile = json(read(c.paths[target][1]!)), groups = record(hookFile.hooks ?? {});
        const sameHook = plannedHooks(c, target).some(row => Array.isArray(groups[row.event]) && hasHook(groups[row.event] as unknown[], row.command, row.timeout));
        if (sameBinding || sameHook) pluginNotes.push(`${target}: matching amem entries are already present without a setup receipt; apply will not duplicate matching hook commands, and undo preserves the original entries.`);
      } catch { /* Advisory only: preparing the real change retains the existing configuration validation. */ }
    }
    const surface = HOOK_SURFACE[target], planned = plannedHooks(c, target)[0];
    const removes = mode === "undo" || surface === undefined || !planned ? [] : strayCaptures(target, read(c.paths[target][surface]!), planned.command).filter((row, index, all) => row.command !== planned.command || all.findIndex(other => other.command === planned.command) !== index).map(row => ({ file: c.paths[target][surface]!, ...row }));
    const unchanged = !!prior && prior.phase === "applied" && prior.intent === intent(c, target) && prior.changes.every((change, index) => { try { const live = read(change.path); restoreChange(prior, change, index, live); return managedAfter(target, index, change.before, change.after, live); } catch { return false; } }) && !removes.length;
    const add = command(target, c.bun, c.entry), remove = target === "gemini" ? [...GEMINI_REMOVE] : [target, "mcp", "remove", ...(target === "claude" || target === "qwen" ? ["--scope", "user"] : []), "amem"];
    const installed = available(c, target, options), version = installed && target !== "agy" && mode !== "undo" ? probeClientVersion(c, target, options) : undefined;
    if (version?.matches === false) pluginNotes.push(`WARNING: ${target} version ${version.output}; layout verified on ${version.verified}. Apply remains guarded by native configuration validation.`);
    return { target, available: installed, ...(version ? { version } : {}), files, receipt: journal(c, target), ...(target === "agy" ? { cwd: c.workspace!.root } : {}), registration: mode === "undo" ? null : add, lifecycle: mode === "undo" ? "restore original MCP/hook files" : lifecycle(target), hooks: mode === "undo" || unchanged ? [] : plannedHooks(c, target), ...(removes.length ? { removes } : {}), mcpChange: mode === "undo" ? prior ? "restore" : "unchanged" : unchanged ? "unchanged" : hasAmem ? "replace" : "add", commands: mode === "undo" || prior?.intent === intent(c, target) || !add || !installed ? [] : [...(hasAmem ? [remove] : []), add], state: stale ? options.adoptCurrent ? "stale receipt; current wiring will be adopted" : "stale receipt; apply needs --adopt-current" : prior && prior.intent !== intent(c, target) ? "runtime changed; managed entries will update" : prior?.phase ?? "not installed" };
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
function hasHook(rows: readonly unknown[], command: string, timeout: number): boolean {
  return rows.some(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const group = record(row);
    return [undefined, "", "*"].some(value => value === group.matcher) && Array.isArray(group.hooks)
      && group.hooks.some((h: unknown) => { const value = record(h); return value.type === "command" && value.command === command && value.timeout === timeout; });
  });
}
function hookDocument(before: Image, events: readonly string[], commandFor: (event: string) => string, timeout = 1, previousFor?: (event: string) => readonly string[]): Image {
  const document = json(before), hooks = document.hooks === undefined ? {} : record(document.hooks);
  for (const event of events) {
    const rawRows = hooks[event] ?? []; if (!Array.isArray(rawRows)) throw Error("setup hook groups must be arrays");
    let rows: unknown[] = rawRows;
    const previous = previousFor?.(event);
    if (previous?.length) rows = rows.flatMap(value => {
      const group = record(value); if (!Array.isArray(group.hooks)) throw Error("setup hook handlers must be arrays");
      let removed = false;
      const kept = group.hooks.filter(h => {
        const handler = record(h);
        if (handler.type !== "command" || !previous.includes(String(handler.command))) return true;
        // ponytail: upgrade generated shapes only; customized controls require review.
        // Upgrade path: lexical command-only migration with native control validation.
        if (![undefined, "", "*"].includes(group.matcher as string | undefined) || handler.timeout !== timeout
          || Object.keys(group).some(key => !["matcher", "hooks", "trusted_hash", "trustedHash"].includes(key))
          || Object.keys(handler).some(key => !["type", "command", "timeout", "trusted_hash", "trustedHash"].includes(key)))
          throw Error("previous-runtime hook settings are customized; review hook configuration before retrying setup");
        removed = true; return false;
      });
      return removed ? kept.length ? [{ ...group, hooks: kept }] : [] : [value];
    });
    const command = commandFor(event);
    if (!hasHook(rows, command, timeout)) rows.push({ hooks: [{ type: "command", command, timeout }] });
    hooks[event] = rows;
  }
  document.hooks = hooks; return objectImage(document, before);
}
function piExtension(bun: string, entry: string): string {
  return `// amem setup managed session-end ingest; no resident worker or instruction injection.\nimport { spawnSync } from 'node:child_process';\nexport default function (pi) {\n  pi.on('session_shutdown', (_event, ctx) => {\n    try { spawnSync(${JSON.stringify(bun)}, ['--smol', ${JSON.stringify(entry)}, 'ingest', 'pi'], { cwd: ctx.cwd, stdio: 'ignore', timeout: 2500 }); } catch {}\n  });\n}\n`;
}
/** Bind old hooks to exact current/receipted MCP launchers, including an adopted baseline.
 * The feature intent tag forces one repair of receipts from the old add-only installer. */
function previousRuntimes(target: SetupTarget, images: readonly Image[], bun: string, entry: string): { bun: string; entry: string }[] {
  const found = new Map<string, { bun: string; entry: string }>();
  for (const image of images) {
    const runtime = mcpLauncher(mcpRecord(target, image));
    if (runtime && (runtime.bun !== bun || runtime.entry !== entry)) found.set(JSON.stringify([runtime.bun, runtime.entry]), runtime);
  }
  return [...found.values()];
}
/** Generated capture commands of a prior runtime, current and pre-#145 (no `--json`) forms. */
const priorCaptures = (launches: readonly string[], kind: string) => launches.flatMap(launch => [`${launch} ingest ${kind} --json`, `${launch} ingest ${kind}`]);
const STALE_RECEIPT = "setup receipt is stale: its managed entries were replaced at another amem install root; rerun with --adopt-current to adopt the current wiring";
/**
 * #241: the receipt cannot restore, none of its runtime's entries remain in its files, and the live MCP entry launches another install root.
 * The wiring was moved outside setup, so the receipt no longer owns anything live. Any trace of the receipt's runtime keeps it authoritative.
 */
function staleReceipt(target: SetupTarget, prior: Receipt): boolean {
  let files: Image[];
  try {
    files = prior.changes.map(change => read(change.path));
    const owned = mcpLauncher(mcpRecord(target, prior.changes[0]!.after)), live = mcpLauncher(mcpRecord(target, files[0]!));
    if (!owned || !live || live.entry === owned.entry) return false;
    // Raw and shell-quoted entry, searched in the raw text (with JSON escaping, for the Pi extension source)
    // and in every decoded JSON/TOML string value, so escapes such as `\/` cannot hide a live entry.
    const traces = [owned.entry, quote(owned.entry)], escaped = traces.map(value => JSON.stringify(value).slice(1, -1));
    if (files.some(file => file.bytes !== null && decodedTexts(Buffer.from(file.bytes, "base64").toString("utf8"))
      .some((value, index) => (index === 0 ? [...traces, ...escaped] : traces).some(trace => value.includes(trace))))) return false;
  } catch { return false; }
  try { prior.changes.forEach((change, index) => restoreChange(prior, change, index, files[index]!)); return false; } catch { return true; }
}
/** The raw text first, then every string value it decodes to as JSON, else as TOML. */
function decodedTexts(raw: string): string[] {
  const out = [raw], walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
  };
  try { walk(JSON.parse(raw)); } catch { try { walk(Bun.TOML.parse(raw)); } catch { /* Not JSON or TOML (the Pi extension): the raw text alone. */ } }
  return out;
}
/** Keep a stale receipt beside the new one instead of deleting it; the person can inspect or restore it. */
function setReceiptAside(file: string): void {
  const aside = `${file}.stale-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`;
  names(aside);
  if (lstatSync(aside, { throwIfNoEntry: false })) throw Error("setup is busy; retry after the active setup exits");
  renameSync(file, aside); const parent = openSync(dirname(file), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
}
interface Prepared { value: Receipt; expected: Image[]; unchanged: boolean; setAside?: string }
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
  let prior = receipt(c, target, false), setAside: string | undefined;
  if (prior && staleReceipt(target, prior)) {
    if (!options.adoptCurrent) throw Error(STALE_RECEIPT);
    // Adopt the live wiring through the receipt-less path (#238); the receipt is set aside only when this target publishes.
    setAside = journal(c, target); prior = undefined;
  }
  const expected = c.paths[target].map(path => read(path));
  // Only a same-file before-image can restore a target. A newly authoritative personal source owns its current bytes.
  // Mapped per current path: a pre-#203 jcode receipt covers mcp.json only, so config.toml starts from its live image.
  const restored = c.paths[target].map((path, index) => { const change = prior?.changes[index];
    // Validate ownership at the historical path before adopting a new source, without publishing to the copy.
    if (prior && change && change.path !== path) restoreChange(prior, change, index, read(change.path));
    return prior && change && change.path === path ? restoreChange(prior, change, index, expected[index]!) : expected[index]!; });
  const surface = HOOK_SURFACE[target], currentCapture = plannedHooks(c, target)[0]?.command ?? "";
  // The restored baseline can carry an orphan back from the prior receipt's before-image: retire strays from both images (#512).
  const strays = surface === undefined ? [] : [...new Set([...strayCaptures(target, expected[surface]!, currentCapture), ...strayCaptures(target, restored[surface]!, currentCapture)].map(row => row.command))];
  if (!strays.length && prior?.phase === "applied" && prior.intent === intent(c, target) && prior.changes.every((change, index) => managedAfter(target, index, change.before, change.after, expected[index]!))) return { value: prior, expected, unchanged: true };
  const changes: Change[] = c.paths[target].map((path, i) => ({ key: `${target}:${i}`, path, before: restored[i]!, after: restored[i]!, start: expected[i]! }));
  const previousMcp = prior?.changes[0];
  const previous = previousRuntimes(target, [expected[0]!, ...(previousMcp && previousMcp.path === c.paths[target][0] ? [previousMcp.before, previousMcp.after, ...(previousMcp.start ? [previousMcp.start] : [])] : [])], c.bun, c.entry);
  const oldLaunches = previous.map(runtime => `${quote(runtime.bun)} --smol ${quote(runtime.entry)}`);
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
      changes[1]!.after = putJcodeHooks(changes[1]!.before, jcodeHookCommand(c.bun, c.entry), previous.map(runtime => jcodeHookCommand(runtime.bun, runtime.entry)));
    } else if (target === "opencode") {
      // `opencode mcp add` is interactive for local servers and has no remove; edit the owned entry directly.
      changes[0]!.after = putMcpRecord(target, changes[0]!.before, opencodeServer(c.bun, c.entry));
    } else {
      const document = json(changes[0]!.before), servers = document.mcpServers === undefined ? {} : record(document.mcpServers);
      servers.amem = { command: c.bun, args: ["--smol", c.entry, "mcp"] }; document.mcpServers = servers;
      changes[0]!.after = objectImage(document, changes[0]!.before);
    }
    const capture = (kind: string) => `${quote(c.bun)} --smol ${quote(c.entry)} ingest ${kind} --json`;
    if (target === "claude") changes[1]!.after = hookDocument(changes[1]!.before, HOOK_EVENTS, event => `${quote(c.bun)} --smol ${quote(c.entry)} hook ${event}`, 1, event => oldLaunches.map(launch => `${launch} hook ${event}`));
    if (target === "codex") changes[1]!.after = hookDocument(changes[1]!.before, ["SessionEnd"], () => capture("codex"), 3, () => [...priorCaptures(oldLaunches, "codex"), ...strays]);
    // Qwen's user MCP and hooks share settings.json: publish and journal one combined image.
    if (target === "qwen") changes[0]!.after = hookDocument(changes[0]!.after, ["SessionEnd"], () => capture("qwen"), 3, () => [...priorCaptures(oldLaunches, "qwen"), ...strays]);
    if (target === "kimi") {
      const old = changes[1]!.before.bytes === null ? "" : Buffer.from(changes[1]!.before.bytes!, "base64").toString("utf8");
      const parsed = toml(old), rawHooks = parsed.hooks ?? [];
      if (!Array.isArray(rawHooks)) throw Error("Kimi hooks must be an array");
      let hooks: unknown[] = rawHooks;
      const retire = [...priorCaptures(oldLaunches, "kimi"), ...strays];
      if (retire.length) hooks = hooks.filter(h => {
        const row = record(h);
        if (row.event !== "SessionEnd" || !retire.includes(String(row.command))) return true;
        if (![undefined, "", "*"].includes(row.matcher as string | undefined) || row.timeout !== 3
          || Object.keys(row).some(key => !["event", "command", "matcher", "timeout"].includes(key)))
          throw Error("previous-runtime hook settings are customized; review hook configuration before retrying setup");
        return false;
      });
      const retired = updateTomlArray(old, ["hooks"], hooks);
      if (!hooks.some(h => record(h).event === "SessionEnd" && record(h).command === capture("kimi"))) hooks.push({ event: "SessionEnd", command: capture("kimi"), timeout: 3 });
      changes[1]!.after = image(updateTomlArray(retired, ["hooks"], hooks), changes[1]!.before.mode);
    }
    if (target === "pi") {
      const content = piExtension(c.bun, c.entry);
      if (!prior && changes[1]!.before.bytes !== null && changes[1]!.before.bytes !== image(content).bytes
        && !previous.some(runtime => changes[1]!.before.bytes === image(piExtension(runtime.bun, runtime.entry)).bytes)
        && !strays.length) throw Error("Pi amem-session extension already exists and is not this setup's file; inspect it, move your changes to another extension file or remove it, then rerun setup");
      changes[1]!.after = image(content, changes[1]!.before.mode);
    }
    // Never publish an image that this installer's own read/undo boundary cannot reopen.
    if (changes.some(change => change.after.bytes !== null && Buffer.from(change.after.bytes, "base64").byteLength > MAX)) throw Error("planned setup configuration exceeds the size bound; no configuration published");
    return { value: { version: (previous.length || strays.length) && changes.some((change, index) => retiresOriginalHook(target, index, change.before, change.after)) ? 2 : 1, target, intent: intent(c, target), phase: "prepared", changes, ...(prior?.createdDirectory ? { createdDirectory: prior.createdDirectory } : {}) }, expected, unchanged: false, ...(setAside ? { setAside } : {}) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function save(c: ReturnType<typeof context>, value: Receipt): void { write(journal(c, value.target), image(JSON.stringify(value) + "\n")); }
function available(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext): boolean { return target === "agy" || !!options.native || Bun.which(target, { PATH: c.env.PATH ?? process.env.PATH }) !== null; }
export interface SetupApplyResult { skills?: SetupSkillResult[]; applied: SetupTarget[]; unchanged: SetupTarget[]; skipped?: { target: SetupTarget; reason: string }[]; warnings?: string[] }
function skillResults(c: ReturnType<typeof context>, targets: SetupTarget[], mode: "preview" | "apply" | "undo", requested: SetupPlan["mode"] = mode, prior?: SetupSkillResult[]): SetupSkillResult[] {
  return targets.flatMap((target): SetupSkillResult[] => {
    const retry = `amem setup ${target} ${requested === "undo" ? "--undo" : "--apply"}${requested !== "undo" && c.root ? ` --root ${quote(c.root.path)}` : ""}`;
    try {
      const root = skillRoot(target, c.env, c.home);
      if (!root) return [];
      const planned = prior?.find(row => row.target === target)?.report;
      if (mode === "apply" && planned?.actions.every(action => action.change === "refused")) return [{ target, report: planned }];
      const expected = mode === "apply" && planned ? { root: planned.root, ...(planned.linkedFrom ? { linkedFrom: planned.linkedFrom } : {}) } : undefined;
      return [{ target, report: installSkills(root, mode, c.root?.path, c.root?.version, retry, c.env, expected) }];
    }
    catch (error) { return [{ target, refused: true, reason: `${error instanceof Error ? error.message : String(error)}; inspect and retry ${retry}` }]; }
  });
}
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
    if (item.setAside) setReceiptAside(item.setAside);
    save(c, value);
    prepareCreatedDirectory(c, value);
    for (let i = 0; i < value.changes.length; i++) { const change = value.changes[i]!; if (!sameImage(item.expected[i]!, change.after)) write(change.path, change.after, item.expected[i]!, publishGuard(c, value.target, options)); }
    value.phase = "applied"; save(c, value); applied.push(value.target);
  }
  const skills = skillResults(c, targets, "apply", "apply", plan.skills);
  return { applied, unchanged, ...(skills.length ? { skills } : {}), ...(skipped.length ? { skipped } : {}) };
}
/** Byte-exact for untouched files, otherwise remove/restore only this installer's owned entries. */
function undoUnlocked(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[]; skills?: SetupSkillResult[] } {
  const c = contextForPlan(plan, options), receipts = plan.targets.map(target => receipt(c, target, false)).filter((value): value is Receipt => !!value);
  const pending = receipts.map(value => ({ value, files: value.changes.map((change, index) => { const expected = read(change.path); return { change, expected, restored: restoreChange(value, change, index, expected) }; }) }));
  for (const item of pending) for (const file of item.files) if (!sameImage(read(file.change.path), file.expected)) throw Error("setup configuration changed during undo preparation");
  for (const item of pending) { if (item.value.target === "agy") c.workspace!.assertCurrent(); for (const file of item.files) if (!sameImage(file.expected, file.restored)) write(file.change.path, file.restored, file.expected, publishGuard(c, item.value.target, options)); removeCreatedDirectory(c, item.value); rmSync(journal(c, item.value.target)); }
  const skills = skillResults(c, plan.targets, "undo");
  return { restored: receipts.map(value => value.target), ...(skills.length ? { skills } : {}) };
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
  const result = withSetupLock(options, () => applyUnlocked(plan, options));
  // #551 AC2: `--apply` prints only this result, so the plan's placement warning is repeated on the receipt.
  return plan.placementWriter ? { ...result, warnings: [plan.placementWriter] } : result;
}
export function undoSetup(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[]; skills?: SetupSkillResult[] } {
  if (plan.targets.includes("jcode")) assertJcodeHome(options.env ?? process.env);
  if (plan.targets.includes("agy")) contextForPlan(plan, options);
  return withSetupLock(options, () => undoUnlocked(plan, options));
}

interface SetupRenderOptions { columns?: number; verbose?: boolean; writerCommands?: readonly string[] }
type SetupResult = SetupApplyResult | { restored: SetupTarget[]; skills?: SetupSkillResult[] };

function setupHookSummary(hooks: SetupPlan["actions"][number]["hooks"]): string {
  const events = hooks.map(hook => hook.event).join(", ");
  if (hooks.length === 1) return `${events}: ${hooks[0]!.command} (timeout ${hooks[0]!.timeout})`;
  const templates = hooks.map(hook => hook.command.endsWith(` ${hook.event}`) ? `${hook.command.slice(0, -hook.event.length)}<event>` : hook.command);
  const first = templates[0];
  return first !== undefined && templates.every(value => value === first) && hooks.every(hook => hook.timeout === hooks[0]!.timeout)
    ? `${events}; ${first} (timeout ${hooks[0]!.timeout})` : `${events}; commands differ (see --verbose or --json)`;
}

/** Human-only shortening; --json retains the exact path and command bytes. */
function setupDisplay(value: string, columns?: number): string {
  const limit = columns === undefined ? undefined : Math.max(12, columns - 30);
  if (limit === undefined) return singleLine(value);
  return singleLine(value).replace(/\S+/g, token => {
    if (cellWidth(token) <= limit) return token;
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token)].map(item => item.segment);
    let left = "", right = ""; const budget = limit - 3;
    while (graphemes.length && cellWidth(left) < Math.floor(budget / 2)) left += graphemes.shift();
    while (graphemes.length && cellWidth(left + "..." + graphemes.at(-1) + right) <= limit) right = graphemes.pop() + right;
    return left + "..." + right;
  });
}

function setupWriterCommands(plan: SetupPlan): string[] {
  if (!plan.placementWriter) return [];
  try {
    // The plan's receipt uses the same resolved memory home as setup, including HOME-only contexts.
    const receipt = plan.actions[0]?.receipt;
    if (!receipt) return ["amem doctor"];
    const home = dirname(dirname(receipt)), roots = readEffectiveSyncPlacementWriters(home).roots;
    if (!roots) return ["amem doctor"];
    const root = plan.root?.path ?? realPath(fileURLToPath(new URL("..", import.meta.url)));
    const all = [...new Set([...roots, ...readSetupWriterRoots(home), root].map(realPath))].sort();
    if (all.some(value => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))) return ["amem doctor"];
    const flags = all.map(value => `--writer-root ${quote(value)}`).join(" ");
    // #624: the checkpoint renews while sessions keep running; the person fills <saved preview JSON> from their own preview.
    // dry-run/apply is the fallback, which needs every amem session closed.
    return [`amem migrate --sync-placement --checkpoint ${flags}`, `amem migrate --sync-placement --checkpoint --confirm --plan <saved preview JSON> ${flags}`,
      `amem migrate --sync-placement --dry-run ${flags}`, `amem migrate --sync-placement --apply ${flags}`];
  } catch { return ["amem doctor"]; }
}

function renderSetup(plan: SetupPlan, result: SetupResult | undefined, s: Style, options: SetupRenderOptions = {}): string {
  const report = new Report(options.columns, s.ascii, { keepTokensWhole: true });
  const verb = plan.mode, changed = new Set(result && "applied" in result ? result.applied : result && "restored" in result ? result.restored : plan.actions.filter(action => action.mcpChange !== "unchanged").map(action => action.target));
  const skipped = new Map<SetupTarget, string>(result && "skipped" in result ? result.skipped?.map(row => [row.target, row.reason]) : !result && plan.mode !== "undo" ? plan.actions.filter(action => !action.available).map(action => [action.target, "CLI not installed"]) : []);
  const skills = result?.skills ?? plan.skills ?? [], warnings = plan.notes.filter(note => (note.startsWith("WARNING:") || note.includes("detected:") || note.includes("version-specific") && changed.size > 0) && note !== plan.placementWriter);
  let warningCount = 0;
  const counts = { toChange: 0, applied: 0, unchanged: 0, skipped: 0, restored: 0, nothing: 0 };
  report.header("amem", "Setup"); report.line(`${verb}: ${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}`);
  if ((plan.mode !== "undo" && plan.placementWriter) || warnings.length) {
    report.section("Attention");
    if (plan.mode !== "undo" && plan.placementWriter) {
      const writerCommands = options.writerCommands ?? ["amem doctor"];
      warningCount++; report.bullet("warn", writerCommands[0] === "amem doctor" ? "The placement writer inventory or its roots could not be verified; check them before renewal." : plan.placementWriter.includes("outside the active") ? "This install root is outside the active placement writer inventory; sync may refuse until it is renewed." : "The active placement writer inventory could not be verified.");
      for (const command of writerCommands) report.next(command);
    }
    const versionWarnings = warnings.filter(note => /layout verified on/.test(note));
    if (versionWarnings.length) { warningCount++; report.bullet("warn", `${versionWarnings.length} client version${versionWarnings.length === 1 ? " differs" : "s differ"} from a verified layout; native validation remains enabled.`); }
    for (const warning of [...new Set(warnings.filter(note => !versionWarnings.includes(note)))]) { warningCount++; report.bullet("warn", setupDisplay(warning.replace(/^WARNING:\s*/, ""), options.columns)); }
  }
  for (const action of plan.actions) {
    report.section(action.target);
    const reason = skipped.get(action.target) ?? (!result && plan.mode !== "undo" && !action.available ? "CLI not installed" : undefined);
    const state = reason ? `skipped: ${reason}` : plan.mode === "undo" && action.mcpChange === "unchanged" ? "no setup receipt; nothing to restore" : result ? changed.has(action.target) ? plan.mode === "undo" ? "restored" : "applied" : "unchanged" : action.mcpChange === "unchanged" ? "unchanged" : `${action.mcpChange}: ${action.state}`;
    const rows: [string, string][] = [["MCP", state]];
    if (!reason) {
      if (action.version) rows.push(["Version", `${action.version.output === null ? "unknown" : action.version.verified && action.version.matches === null ? `unrecognised (${action.version.output})` : action.version.output}; ${action.version.verified ? `verified ${action.version.verified}` : "unverified"}`]);
      if (plan.root) rows.push(["Install", setupDisplay(`${plan.root.path} (amem ${plan.root.version})`, options.columns)]);
      if (action.files.length) rows.push(["Files", action.files.map(file => setupDisplay(file, options.columns)).join(", ")]);
      if (action.cwd) rows.push(["Directory", setupDisplay(action.cwd, options.columns)]);
      rows.push(["Receipt", setupDisplay(action.receipt, options.columns)]);
      if (!result && action.available && action.registration) rows.push(["Command", setupDisplay(action.registration.map(quote).join(" "), options.columns)]);
      if (action.hooks.length) rows.push(["Hooks", setupDisplay(setupHookSummary(action.hooks), options.columns)]);
      for (const removal of action.removes ?? []) rows.push(["Remove", setupDisplay(`${removal.event}: ${removal.command} (in ${removal.file})`, options.columns)]);
    }
    const skill = skills.find(row => row.target === action.target);
    const skillChanged = skill?.report?.actions.some(item => ["install", "replace", "remove"].includes(item.change)) === true;
    if (reason) counts.skipped++;
    else if (plan.mode === "undo") { if (changed.has(action.target) || skillChanged) counts.restored++; else counts.nothing++; }
    else if (result) { if (changed.has(action.target) || skillChanged) counts.applied++; else counts.unchanged++; }
    else if (changed.has(action.target) || skillChanged) counts.toChange++; else counts.unchanged++;
    if (skill?.report) {
      const changedSkills = skill.report.actions.filter(item => item.change !== "unchanged" && item.change !== "absent");
      const unchanged = skill.report.actions.filter(item => item.change === "unchanged").length;
      const summary = [...changedSkills.map(item => `${item.name} ${item.change}`), ...(unchanged ? [`${unchanged} unchanged`] : []), ...(skill.report.linkedFrom ? [`root ${setupDisplay(skill.report.root, options.columns)} (linked from ${setupDisplay(skill.report.linkedFrom, options.columns)})`] : [])];
      rows.push(["Skills", summary.join(", ") || "no changes"]);
    } else if (skill?.reason) rows.push(["Skills", skill.refused ? "refused" : "unavailable"]);
    report.kv(rows);
    if (options.verbose) for (const hook of action.hooks) report.note(singleLine(`${hook.event}: ${hook.command} (timeout ${hook.timeout})`));
    if (skill?.reason) { warningCount++; report.bullet("warn", singleLine(skill.reason)); }
    for (const item of skill?.report?.actions ?? []) if (item.reason) { warningCount++; report.bullet("warn", singleLine(`${item.name}: ${item.reason}`)); }
  }
  const actionable = plan.actions.some(action => changed.has(action.target) && (plan.mode === "undo" || action.available))
    || skills.some(row => row.report?.actions.some(item => ["install", "replace", "remove"].includes(item.change)));
  const notes = plan.notes.filter(note => note !== plan.placementWriter && !warnings.includes(note));
  const noteTargets: [RegExp, SetupTarget][] = [[/^Codex requires/, "codex"], [/^Qwen capture/, "qwen"], [/^(Jcode setup|Launch Jcode)/, "jcode"], [/^Gemini CLI setup/, "gemini"], [/^OpenCode setup/, "opencode"], [/^Antigravity MCP/, "agy"]];
  const visibleNotes = options.verbose ? notes : notes.filter(note => (plan.mode !== "undo" && noteTargets.some(([pattern, target]) => pattern.test(note) && changed.has(target) && plan.actions.some(action => action.target === target && action.available))) || plan.actions.some(action => changed.has(action.target) && note.startsWith(`${action.target}: `)) || (plan.mode !== "undo" && actionable && note.startsWith("Antigravity is repository-scoped")));
  if (visibleNotes.length) { report.section("Notes"); for (const note of [...new Set(visibleNotes)]) report.note(setupDisplay(note, options.columns)); }
  if (!result && plan.mode === "preview" && actionable) {
    if (plan.root && /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(plan.root.path)) {
      warningCount++; report.bullet("warn", "The install root contains control characters; inspect it with --json before rerunning setup.");
    } else report.next(`amem setup ${plan.targets.length === 1 ? plan.targets[0] : "all"} --apply${plan.actions.some(action => action.state.includes("apply needs --adopt-current")) ? " --adopt-current" : ""}${plan.root ? ` --root ${quote(plan.root.path)}` : ""}`);
  }
  const outcomes = plan.mode === "undo" ? `${counts.restored} restored, ${counts.nothing} nothing to restore`
    : result ? `${counts.applied} applied, ${counts.unchanged} unchanged, ${counts.skipped} skipped`
    : `${counts.toChange} to change, ${counts.unchanged} unchanged, ${counts.skipped} skipped`;
  report.line("");
  report.line(`Summary: ${outcomes}${warningCount ? `, ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`);
  return report.render(s.color).join("\n");
}

export function setupPlanText(plan: SetupPlan, s: Style = PLAIN, options: SetupRenderOptions = {}): string { return renderSetup(plan, undefined, s, options); }
function setupResultText(result: SetupResult, s: Style, plan: SetupPlan, options: SetupRenderOptions = {}): string { return renderSetup(plan, result, s, options); }
/** Compatibility formatter for confirmation-style callers: the raw plan under `--json`, the readable plan otherwise. */
export function setupConfirmationText(plan: SetupPlan, json: boolean, s: Style = PLAIN): string { return json ? JSON.stringify(plan, null, 2) : setupPlanText(plan, s); }

export async function runSetup(target: string, mode: SetupPlan["mode"], options: SetupContext & { json?: boolean; style?: Style; columns?: number; verbose?: boolean } = {}): Promise<string> {
  const plan = planSetup(target, mode, options), s = options.json ? PLAIN : options.style ?? PLAIN;
  const renderOptions: SetupRenderOptions = { columns: options.columns, verbose: options.verbose, ...(!options.json && mode !== "undo" && plan.placementWriter ? { writerCommands: setupWriterCommands(plan) } : {}) };
  if (cliAttribution()?.actor === "agent") {
    const policy = configuredPolicy(memoryHome(options.env ?? process.env), options.cwd ?? process.cwd());
    if (!policy.screenStandalone(JSON.parse(JSON.stringify(plan))) || (renderOptions.writerCommands && !policy.screenStandalone(renderOptions.writerCommands))) throw Error("Memory operation unavailable or refused; no partial result is shown.");
  }
  if (mode === "preview") return options.json ? JSON.stringify(plan, null, 2) : setupPlanText(plan, s, renderOptions);
  const result = mode === "apply" ? applySetup(plan, options) : undoSetup(plan, options);
  return options.json ? JSON.stringify(result, null, 2) : setupResultText(result, s, plan, renderOptions);
}


