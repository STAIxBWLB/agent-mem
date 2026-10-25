import { SETUP_CONFIG_BYTES, updateTomlArray } from "./setup-toml.ts";
import { managedAfter, mcpRecord, putMcpRecord, restoreOwned, sameImage, type ConfigImage } from "./setup-owned.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { HOOK_EVENTS } from "./hook-contract.ts";
import { memoryHome } from "./memory/home.ts";
import { canonicalPath, processLiveness, processSignature, realPath } from "./memory/platform.ts";

export const SETUP_TARGETS = ["claude", "codex", "kimi", "pi"] as const;
export type SetupTarget = typeof SETUP_TARGETS[number];
type Env = Readonly<Record<string, string | undefined>>;
type Image = ConfigImage;
interface PlannedHook { event: string; command: string; timeout: number }
interface Change { key: string; path: string; before: Image; after: Image; start?: Image }
interface Receipt { version: 1; target: SetupTarget; intent: string; phase: "prepared" | "applied"; changes: Change[] }
export interface SetupContext {
  env?: Env; bun?: string; entry?: string; stdinTTY?: boolean;
  /** Trusted confirmation seam; ordinary CLI use always asks the person through stdin. */
  confirm?: (plan: SetupPlan) => Promise<boolean>;
  /** Host-only race fixture, called after temporary-file fsync and before the final comparison/rename. */
  beforePublish?: (file: string) => void;
  /** Trusted test seam; production always runs the named native CLI in a private staging HOME. */
  native?: (argv: readonly string[], env: Env, cwd: string) => void;
}
export interface SetupPlan {
  targets: SetupTarget[]; mode: "preview" | "apply" | "undo";
  actions: { target: SetupTarget; files: string[]; receipt: string; registration: string[] | null; lifecycle: string; available: boolean; hooks: PlannedHook[]; mcpChange: "add" | "replace" | "restore" | "unchanged"; commands: string[][]; state: string }[];
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
function context(options: SetupContext) {
  const env = options.env ?? process.env, home = realPath(resolve(env.HOME?.trim() || homedir()));
  const root = (key: string, fallback: string) => {
    if (!env[key]?.trim()) return join(home, fallback);
    const given = resolve(env[key]!), withinHome = relative(resolve(env.HOME?.trim() || homedir()), given);
    // Canonicalize the HOME alias only; named configuration-directory symlinks must still be refused.
    return withinHome !== ".." && !withinHome.startsWith("../") && !isAbsolute(withinHome) ? join(home, withinHome) : given;
  };
  const claude = root("CLAUDE_CONFIG_DIR", ".claude"), codex = root("CODEX_HOME", ".codex"), kimi = root("KIMI_CODE_HOME", ".kimi-code"), pi = root("PI_CODING_AGENT_DIR", ".pi/agent");
  const paths: Record<SetupTarget, string[]> = {
    claude: [env.CLAUDE_CONFIG_DIR?.trim() ? join(claude, ".claude.json") : join(home, ".claude.json"), join(claude, "settings.json")],
    codex: [join(codex, "config.toml"), join(codex, "hooks.json")],
    kimi: [join(kimi, "mcp.json"), join(kimi, "config.toml")],
    pi: [join(pi, "mcp.json"), join(pi, "extensions", "amem-session.ts")],
  };
  const requestedBun = options.bun ?? "bun", bun = requestedBun === "bun" ? Bun.which("bun", { PATH: env.PATH ?? process.env.PATH }) : requestedBun;
  const entry = options.entry ?? fileURLToPath(new URL("../bin/amem.js", import.meta.url));
  if (!bun || !isAbsolute(bun) || !isAbsolute(entry)) throw Error("setup needs a PATH-resolved absolute Bun runtime and an absolute installed entry");
  // The trusted native fixture may use a temporary package; ordinary CLI installation must outlive bunx's cache.
  if (!options.native) {
    const roots = [resolve(tmpdir()), realPath(tmpdir())], entries = [resolve(entry), realPath(entry)];
    if (roots.some(root => entries.some(file => { const part = relative(root, file); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); }))) throw Error("setup refuses a temporary package entry; install amem in a persistent location first");
  }
  return { env, home, paths, bun, entry, state: join(canonicalPath(memoryHome({ ...env, AGENTHUB_HOME: env.AGENTHUB_HOME?.trim() || join(home, ".agenthub") })), "setup") };
}
function command(target: SetupTarget, bun: string, entry: string): string[] | null {
  if (target === "kimi") return null;
  return [target, "mcp", "add", ...(target === "claude" ? ["--scope", "user", "--transport", "stdio"] : []), "amem", "--", bun, "--smol", entry, "mcp"];
}
function intent(c: ReturnType<typeof context>, target: SetupTarget): string { return digest([1, target, c.paths[target], c.bun, c.entry]); }
function journal(c: ReturnType<typeof context>, target: SetupTarget): string { return join(c.state, `${target}.json`); }
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
  return value as unknown as Receipt;
}
function plannedHooks(c: ReturnType<typeof context>, target: SetupTarget): PlannedHook[] {
  const launch = `${quote(c.bun)} --smol ${quote(c.entry)}`;
  return target === "claude" ? HOOK_EVENTS.map(event => ({ event, command: `${launch} hook ${event}`, timeout: 1 }))
    : [{ event: target === "pi" ? "session_shutdown" : "SessionEnd", command: `${launch} ingest ${target}`, timeout: target === "pi" ? 2.5 : 3 }];
}
const lifecycle = (target: SetupTarget) => target === "claude" ? "seven bounded native hooks" : target === "pi" ? "session_shutdown incremental ingest" : "SessionEnd incremental ingest";
export function planSetup(target: string, mode: SetupPlan["mode"] = "preview", options: SetupContext = {}): SetupPlan {
  if (target !== "all" && !SETUP_TARGETS.includes(target as SetupTarget)) throw Error("usage: amem setup claude|codex|kimi|pi|all [--apply|--undo]");
  const c = context(options), targets = target === "all" ? [...SETUP_TARGETS] : [target as SetupTarget];
  const pluginNotes: string[] = [];
  if (targets.includes("claude")) {
    const settings = json(read(c.paths.claude[1]!));
    // The settings-derived ids are computed outside the registry guard, so a broken installed_plugins.json cannot hide them.
    const ids = new Set<string>();
    try { for (const key of Object.keys(record(settings.enabledPlugins ?? {}))) ids.add(key); } catch { /* Optional plugin metadata must never prevent setup or recovery. */ }
    try { for (const key of Object.keys(record(json(read(join(dirname(c.paths.claude[1]!), "plugins", "installed_plugins.json"))).plugins ?? {}))) ids.add(key); } catch { /* Optional plugin metadata must never prevent setup or recovery; authoritative settings/receipts keep their guards. */ }
    for (const id of [...ids].filter(key => /^agent-mem(?:@[A-Za-z0-9._-]+)?$/.test(key))) pluginNotes.push(`Installed Claude plugin ${id} detected: if enabled, direct setup would duplicate its MCP server and seven hooks. Choose plugin installation or direct setup; disable/uninstall the plugin before applying direct setup.`);
  }
  return { targets, mode, actions: targets.map(target => {
    const prior = receipt(c, target, false); for (const file of c.paths[target]) read(file);
    const original = read(c.paths[target][0]!);
    const document = target === "codex" ? toml(original.bytes === null ? "" : Buffer.from(original.bytes, "base64").toString("utf8")) : json(original);
    const hasAmem = Object.hasOwn(record(document[target === "codex" ? "mcp_servers" : "mcpServers"] ?? {}), "amem");
    const unchanged = !!prior && prior.phase === "applied" && prior.intent === intent(c, target) && prior.changes.every((change, index) => { try { const live = read(change.path); restoreChange(prior, change, index, live); return managedAfter(target, index, change.before, change.after, live); } catch { return false; } });
    const add = command(target, c.bun, c.entry), remove = [target, "mcp", "remove", ...(target === "claude" ? ["--scope", "user"] : []), "amem"];
    return { target, available: available(c, target, options), files: c.paths[target], receipt: journal(c, target), registration: mode === "undo" ? null : add, lifecycle: mode === "undo" ? "restore original MCP/hook files" : lifecycle(target), hooks: mode === "undo" || unchanged ? [] : plannedHooks(c, target), mcpChange: mode === "undo" ? prior ? "restore" : "unchanged" : unchanged ? "unchanged" : hasAmem ? "replace" : "add", commands: mode === "undo" || prior?.intent === intent(c, target) || !add || !available(c, target, options) ? [] : [...(hasAmem ? [remove] : []), add], state: prior && prior.intent !== intent(c, target) ? "runtime changed; managed entries will update" : prior?.phase ?? "not installed" };
  }), notes: [...pluginNotes, ...(/\/[^/]*\d+\.\d+[^/]*\/(?:bin\/)?bun$/.test(c.bun) ? ["this bun path is version-specific; rerun setup --apply after changing Bun"] : []), "Preview only unless --apply or --undo is confirmed in a person's terminal.", "Native registration commands run in a private staging HOME; only the listed configuration files are published.", "Original file bytes restore exactly when untouched; otherwise undo preserves CLI-owned changes and restores only managed entries, refusing edits to those entries.", "No AGENTS.md, CLAUDE.md or rule files are edited.", `A private ${join(c.state, "setup.lock")} serializes mutations; temporary ${join(realPath(tmpdir()), "amem-setup-*")} staging homes are removed.`, "Codex requires its native /hooks review before newly registered hooks run; setup does not grant hook trust. Runtime registrations use the PATH-resolved absolute Bun path without resolving its stable symlink; setup all reports and skips missing clients."] };
}
function verifyNativeMcp(target: SetupTarget, env: Env, cwd: string): void {
  // In older free-form Pi CLIs, an unknown subcommand can be treated as a model prompt.
  const help = spawnSync(target, ["--help"], { cwd, env: { ...env }, encoding: "utf8", timeout: 5000, maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"] });
  if (help.status !== 0 || !/^\s+(?:pi\s+)?mcp(?:\s|$)/m.test(help.stdout)) throw Error(`installed ${target} CLI does not expose MCP registration; no registration command was run`);
}
function native(argv: readonly string[], env: Env, cwd: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: { ...env }, encoding: "utf8", timeout: 10_000, maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw Error(`${argv[0]} MCP registration failed in staging; no native output disclosed`);
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
  const prior = receipt(c, target, false), expected = c.paths[target].map(path => read(path));
  const restored = prior ? prior.changes.map((change, index) => restoreChange(prior, change, index, expected[index]!)) : expected;
  if (prior?.phase === "applied" && prior.intent === intent(c, target) && prior.changes.every((change, index) => managedAfter(target, index, change.before, change.after, expected[index]!))) return { value: prior, expected, unchanged: true };
  const changes: Change[] = c.paths[target].map((path, i) => ({ key: `${target}:${i}`, path, before: restored[i]!, after: restored[i]!, start: expected[i]! }));
  const staging = mkdtempSync(join(realPath(tmpdir()), "amem-setup-"));
  try {
    const env: Record<string, string | undefined> = { ...c.env, HOME: staging, AMEM_HOME: join(staging, "memory"), AGENTHUB_HOME: join(staging, "hub"), CODEX_HOME: join(staging, ".codex"), KIMI_CODE_HOME: join(staging, ".kimi-code"), PI_CODING_AGENT_DIR: join(staging, ".pi", "agent") };
    Object.assign(env, { XDG_CONFIG_HOME: join(staging, ".config"), XDG_DATA_HOME: join(staging, ".local", "share"), XDG_CACHE_HOME: join(staging, ".cache"), XDG_STATE_HOME: join(staging, ".local", "state"), TMPDIR: join(staging, "tmp"), TMP: join(staging, "tmp"), TEMP: join(staging, "tmp") });
    mkdirSync(env.TMPDIR!, { mode: 0o700 });
    if (c.env.CLAUDE_CONFIG_DIR?.trim()) env.CLAUDE_CONFIG_DIR = join(staging, ".claude"); else delete env.CLAUDE_CONFIG_DIR;
    const staged = context({ ...options, env });
    // Codex refuses an explicit CODEX_HOME that does not exist, even for mcp add.
    mkdirSync(dirname(staged.paths[target][0]!), { recursive: true, mode: 0o700 });
    for (let i = 0; i < changes.length; i++) if (expected[i]!.bytes !== null) write(staged.paths[target][i]!, expected[i]!);
    const argv = command(target, c.bun, c.entry);
    if (argv && prior?.intent === intent(c, target)) {
      changes[0]!.after = putMcpRecord(target, changes[0]!.before, mcpRecord(target, prior.changes[0]!.after));
    } else if (argv) {
      if (!options.native) verifyNativeMcp(target, env, staging);
      const text = expected[0]!.bytes === null ? "" : Buffer.from(expected[0]!.bytes!, "base64").toString("utf8");
      const document = target === "codex" ? toml(text) : json(expected[0]!);
      const servers = document[target === "codex" ? "mcp_servers" : "mcpServers"];
      if (servers && Object.hasOwn(record(servers), "amem")) (options.native ?? native)([target, "mcp", "remove", ...(target === "claude" ? ["--scope", "user"] : []), "amem"], env, staging);
      (options.native ?? native)(argv, env, staging);
      changes[0]!.after = { ...read(staged.paths[target][0]!), mode: changes[0]!.before.mode };
      if (changes[0]!.after.bytes === null) throw Error("native registration produced no configuration");
      const installedText = Buffer.from(changes[0]!.after.bytes!, "base64").toString("utf8");
      const installed = target === "codex" ? toml(installedText) : json(changes[0]!.after);
      const installedServer = record(record(installed[target === "codex" ? "mcp_servers" : "mcpServers"]).amem);
      if (installedServer.command !== c.bun || JSON.stringify(installedServer.args) !== JSON.stringify(["--smol", c.entry, "mcp"]) || installedServer.enabled === false) throw Error("native registration did not produce the planned amem server");
      const serverKey = target === "codex" ? "mcp_servers" : "mcpServers";
      const withoutAmem = (value: Record<string, unknown>) => { const copy = { ...value }, servers = { ...record(value[serverKey] ?? {}) }; delete servers.amem; copy[serverKey] = servers; return copy; };
      if (!isDeepStrictEqual(withoutAmem(document)[serverKey], withoutAmem(installed)[serverKey])) throw Error("native registration changed unrelated MCP servers; no configuration published");
      if (target === "codex") {
        if (!isDeepStrictEqual(withoutAmem(document), withoutAmem(installed))) throw Error("native registration changed unrelated settings; no configuration published");
      } else {
        // Keep all unrelated JSON settings from the original; use only the CLI-generated server record.
        document.mcpServers = { ...record(document.mcpServers ?? {}), amem: installedServer };
        changes[0]!.after = objectImage(document, changes[0]!.before);
      }
    } else {
      const document = json(changes[0]!.before), servers = document.mcpServers === undefined ? {} : record(document.mcpServers);
      servers.amem = { command: c.bun, args: ["--smol", c.entry, "mcp"] }; document.mcpServers = servers;
      changes[0]!.after = objectImage(document, changes[0]!.before);
    }
    const capture = (kind: string) => `${quote(c.bun)} --smol ${quote(c.entry)} ingest ${kind}`;
    if (target === "claude") changes[1]!.after = hookDocument(changes[1]!.before, HOOK_EVENTS, event => `${quote(c.bun)} --smol ${quote(c.entry)} hook ${event}`);
    if (target === "codex") changes[1]!.after = hookDocument(changes[1]!.before, ["SessionEnd"], () => capture("codex"), 3);
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
    return { value: { version: 1, target, intent: intent(c, target), phase: "prepared", changes }, expected, unchanged: false };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function save(c: ReturnType<typeof context>, value: Receipt): void { write(journal(c, value.target), image(JSON.stringify(value) + "\n")); }
function available(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext): boolean { return !!options.native || Bun.which(target, { PATH: c.env.PATH ?? process.env.PATH }) !== null; }
export interface SetupApplyResult { applied: SetupTarget[]; unchanged: SetupTarget[]; skipped?: { target: SetupTarget; reason: string }[] }
/** Caller enforces person markers/TTY and confirmation; CLI-owned unrelated fields remain live. */
function applyUnlocked(plan: SetupPlan, options: SetupContext = {}): SetupApplyResult {
  const c = context(options), skipped: { target: SetupTarget; reason: string }[] = [];
  const targets = plan.targets.filter(target => { if (available(c, target, options)) return true; if (plan.targets.length === 1) throw Error(`${target} CLI is not installed`); skipped.push({ target, reason: "CLI not installed" }); return false; });
  const prepared = targets.map(target => prepare(c, target, options));
  for (const item of prepared) if (!item.unchanged) for (let i = 0; i < item.value.changes.length; i++) if (!sameImage(read(item.value.changes[i]!.path), item.expected[i]!)) throw Error("setup configuration changed during preparation");
  const applied: SetupTarget[] = [], unchanged: SetupTarget[] = [];
  for (const item of prepared) {
    const value = item.value;
    if (item.unchanged) { unchanged.push(value.target); continue; }
    save(c, value);
    for (let i = 0; i < value.changes.length; i++) { const change = value.changes[i]!; if (!sameImage(item.expected[i]!, change.after)) write(change.path, change.after, item.expected[i]!, options.beforePublish); }
    value.phase = "applied"; save(c, value); applied.push(value.target);
  }
  return { applied, unchanged, ...(skipped.length ? { skipped } : {}) };
}
/** Byte-exact for untouched files, otherwise remove/restore only this installer's owned entries. */
function undoUnlocked(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[] } {
  const c = context(options), receipts = plan.targets.map(target => receipt(c, target, false)).filter((value): value is Receipt => !!value);
  const pending = receipts.map(value => ({ value, files: value.changes.map((change, index) => { const expected = read(change.path); return { change, expected, restored: restoreChange(value, change, index, expected) }; }) }));
  for (const item of pending) for (const file of item.files) if (!sameImage(read(file.change.path), file.expected)) throw Error("setup configuration changed during undo preparation");
  for (const item of pending) { for (const file of item.files) if (!sameImage(file.expected, file.restored)) write(file.change.path, file.restored, file.expected, options.beforePublish); rmSync(journal(c, item.value.target)); }
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
  return withSetupLock(options, () => applyUnlocked(plan, options));
}
export function undoSetup(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[] } {
  return withSetupLock(options, () => undoUnlocked(plan, options));
}

export async function runSetup(target: string, mode: SetupPlan["mode"], options: SetupContext = {}): Promise<string> {
  const plan = planSetup(target, mode, options);
  if (mode === "preview") return JSON.stringify(plan, null, 2);
  if (!(options.stdinTTY ?? process.stdin.isTTY)) throw Error("setup --apply/--undo require a terminal on stdin");
  const confirm = options.confirm ?? (async (shown: SetupPlan) => {
    process.stdout.write(JSON.stringify(shown, null, 2) + "\n");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await terminal.question(`Type yes to ${mode} the listed configuration changes: `)).trim() === "yes"; }
    finally { terminal.close(); }
  });
  if (!await confirm(plan)) return JSON.stringify({ cancelled: true });
  return JSON.stringify(mode === "apply" ? applySetup(plan, options) : undoSetup(plan, options), null, 2);
}
