import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS } from "./hook-contract.ts";
import { memoryHome } from "./memory/home.ts";
import { canonicalPath, processLiveness, processSignature, realPath } from "./memory/platform.ts";

export const SETUP_TARGETS = ["claude", "codex", "kimi", "pi"] as const;
export type SetupTarget = typeof SETUP_TARGETS[number];
type Env = Readonly<Record<string, string | undefined>>;
interface Image { bytes: string | null; mode: number }
interface Change { key: string; path: string; before: Image; after: Image }
interface Receipt { version: 1; target: SetupTarget; intent: string; phase: "prepared" | "applied"; changes: Change[] }
export interface SetupContext {
  env?: Env; bun?: string; entry?: string; stdinTTY?: boolean;
  /** Trusted confirmation seam; ordinary CLI use always asks the person through stdin. */
  confirm?: (plan: SetupPlan) => Promise<boolean>;
  /** Trusted test seam; production always runs the named native CLI in a private staging HOME. */
  native?: (argv: readonly string[], env: Env, cwd: string) => void;
}
export interface SetupPlan {
  targets: SetupTarget[]; mode: "preview" | "apply" | "undo";
  actions: { target: SetupTarget; files: string[]; receipt: string; registration: string[] | null; lifecycle: string; state: string }[];
  notes: string[];
}
const MAX = 1024 * 1024, JOURNAL_MAX = 24 * MAX;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("setup configuration must be an object");
  return value as Record<string, unknown>;
}
function json(image: Image): Record<string, unknown> { return image.bytes === null ? {} : record(JSON.parse(Buffer.from(image.bytes, "base64").toString("utf8"))); }
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
    const data = Buffer.alloc(max + 1), size = readSync(fd, data, 0, data.length, 0), after = fstatSync(fd);
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error("setup configuration changed while reading");
    return { bytes: data.subarray(0, size).toString("base64"), mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}
function write(file: string, value: Image): void {
  names(file);
  if (value.bytes === null) { rmSync(file, { force: true }); return; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); names(dirname(file));
  const temporary = join(dirname(file), `.amem-setup-${randomUUID()}`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, Buffer.from(value.bytes, "base64")); fchmodSync(fd, value.mode); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, file); const parent = openSync(dirname(file), constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
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
  const bun = options.bun ?? process.execPath, entry = options.entry ?? fileURLToPath(new URL("../bin/amem.js", import.meta.url));
  if (![bun, entry].every(isAbsolute)) throw Error("setup executable paths must be absolute");
  return { env, home, paths, bun, entry, state: join(canonicalPath(memoryHome(env)), "setup") };
}
function command(target: SetupTarget, bun: string, entry: string): string[] | null {
  if (target === "kimi") return null;
  return [target, "mcp", "add", ...(target === "claude" ? ["--scope", "user", "--transport", "stdio"] : []), "amem", "--", bun, "--smol", entry, "mcp"];
}
function intent(c: ReturnType<typeof context>, target: SetupTarget): string { return digest([1, target, c.paths[target], c.bun, c.entry]); }
function journal(c: ReturnType<typeof context>, target: SetupTarget): string { return join(c.state, `${target}.json`); }
function receipt(c: ReturnType<typeof context>, target: SetupTarget): Receipt | undefined {
  const raw = read(journal(c, target), JOURNAL_MAX); if (raw.bytes === null) return;
  const value = record(JSON.parse(Buffer.from(raw.bytes, "base64").toString("utf8")));
  if (value.version !== 1 || value.target !== target || value.intent !== intent(c, target) || !["prepared", "applied"].includes(String(value.phase)) || !Array.isArray(value.changes) || value.changes.length !== c.paths[target].length) throw Error("setup receipt does not match this installation");
  for (let i = 0; i < value.changes.length; i++) {
    const change = record(value.changes[i]); if (change.path !== c.paths[target][i] || change.key !== `${target}:${i}`) throw Error("setup receipt target mismatch");
    for (const key of ["before", "after"]) {
      const v = record(change[key]);
      if (!Number.isInteger(v.mode) || Number(v.mode) < 0 || Number(v.mode) > 0o777 || v.bytes !== null && (typeof v.bytes !== "string" || v.bytes.length > 2 * MAX || Buffer.from(v.bytes, "base64").toString("base64") !== v.bytes)) throw Error("setup receipt invalid");
    }
  }
  return value as unknown as Receipt;
}
const lifecycle = (target: SetupTarget) => target === "claude" ? "seven bounded native hooks" : target === "pi" ? "session_shutdown incremental ingest" : "SessionEnd incremental ingest";
export function planSetup(target: string, mode: SetupPlan["mode"] = "preview", options: SetupContext = {}): SetupPlan {
  if (target !== "all" && !SETUP_TARGETS.includes(target as SetupTarget)) throw Error("usage: amem setup claude|codex|kimi|pi|all [--apply|--undo]");
  const c = context(options), targets = target === "all" ? [...SETUP_TARGETS] : [target as SetupTarget];
  return { targets, mode, actions: targets.map(target => {
    const prior = receipt(c, target); for (const file of c.paths[target]) read(file);
    return { target, files: c.paths[target], receipt: journal(c, target), registration: mode === "undo" ? null : command(target, c.bun, c.entry), lifecycle: mode === "undo" ? "restore original MCP/hook files" : lifecycle(target), state: prior?.phase ?? "not installed" };
  }), notes: ["Preview only unless --apply or --undo is confirmed in a person's terminal.", "Native registration commands run in a private staging HOME; only the listed configuration files are published.", "Original bytes, file modes and absence are backed up privately; undo refuses later configuration edits.", "No AGENTS.md, CLAUDE.md or rule files are edited.", `A private ${join(c.state, "setup.lock")} serializes mutations; temporary ${join(realPath(tmpdir()), "amem-setup-*")} staging homes are removed.`, "Codex requires its native /hooks review before newly registered hooks run; setup does not grant hook trust."] };
}
function native(argv: readonly string[], env: Env, cwd: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env: { ...env }, encoding: "utf8", timeout: 10_000, maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw Error(`${argv[0]} MCP registration failed in staging; no native output disclosed`);
}
function hookDocument(before: Image, events: readonly string[], commandFor: (event: string) => string): Image {
  const document = json(before), hooks = document.hooks === undefined ? {} : record(document.hooks);
  for (const event of events) {
    const rows = hooks[event] ?? []; if (!Array.isArray(rows)) throw Error("setup hook groups must be arrays");
    const command = commandFor(event);
    if (!rows.some(row => Array.isArray(row?.hooks) && row.hooks.some((h: unknown) => record(h).command === command))) rows.push({ hooks: [{ type: "command", command, timeout: event === "SessionEnd" ? 3 : 1 }] });
    hooks[event] = rows;
  }
  document.hooks = hooks; return objectImage(document, before);
}
function piExtension(bun: string, entry: string): string {
  return `// amem setup managed session-end ingest; no resident worker or instruction injection.\nimport { spawnSync } from 'node:child_process';\nexport default function (pi) {\n  pi.on('session_shutdown', (_event, ctx) => {\n    try { spawnSync(${JSON.stringify(bun)}, ['--smol', ${JSON.stringify(entry)}, 'ingest', 'pi'], { cwd: ctx.cwd, stdio: 'ignore', timeout: 2500 }); } catch {}\n  });\n}\n`;
}
function prepare(c: ReturnType<typeof context>, target: SetupTarget, options: SetupContext): Receipt {
  const prior = receipt(c, target); if (prior) return prior;
  const changes = c.paths[target].map((path, i) => { const before = read(path); return { key: `${target}:${i}`, path, before, after: before }; });
  const staging = mkdtempSync(join(realPath(tmpdir()), "amem-setup-"));
  try {
    const env: Record<string, string | undefined> = { ...c.env, HOME: staging, CODEX_HOME: join(staging, ".codex"), KIMI_CODE_HOME: join(staging, ".kimi-code"), PI_CODING_AGENT_DIR: join(staging, ".pi", "agent") };
    if (c.env.CLAUDE_CONFIG_DIR?.trim()) env.CLAUDE_CONFIG_DIR = join(staging, ".claude"); else delete env.CLAUDE_CONFIG_DIR;
    const staged = context({ ...options, env });
    for (let i = 0; i < changes.length; i++) if (changes[i]!.before.bytes !== null) write(staged.paths[target][i]!, changes[i]!.before);
    const argv = command(target, c.bun, c.entry);
    if (argv) {
      const text = changes[0]!.before.bytes === null ? "" : Buffer.from(changes[0]!.before.bytes!, "base64").toString("utf8");
      const document = target === "codex" ? record(Bun.TOML.parse(text)) : json(changes[0]!.before);
      const servers = document[target === "codex" ? "mcp_servers" : "mcpServers"];
      if (servers && Object.hasOwn(record(servers), "amem")) (options.native ?? native)([target, "mcp", "remove", ...(target === "claude" ? ["--scope", "user"] : []), "amem"], env, staging);
      (options.native ?? native)(argv, env, staging);
      changes[0]!.after = read(staged.paths[target][0]!);
      if (changes[0]!.after.bytes === null) throw Error("native registration produced no configuration");
      const installedText = Buffer.from(changes[0]!.after.bytes!, "base64").toString("utf8");
      const installed = target === "codex" ? record(Bun.TOML.parse(installedText)) : json(changes[0]!.after);
      const installedServer = record(record(installed[target === "codex" ? "mcp_servers" : "mcpServers"]).amem);
      if (installedServer.command !== c.bun || JSON.stringify(installedServer.args) !== JSON.stringify(["--smol", c.entry, "mcp"]) || installedServer.enabled === false) throw Error("native registration did not produce the planned amem server");
    } else {
      const document = json(changes[0]!.before), servers = document.mcpServers === undefined ? {} : record(document.mcpServers);
      servers.amem = { command: c.bun, args: ["--smol", c.entry, "mcp"] }; document.mcpServers = servers;
      changes[0]!.after = objectImage(document, changes[0]!.before);
    }
    const capture = (kind: string) => `${quote(c.bun)} --smol ${quote(c.entry)} ingest ${kind}`;
    if (target === "claude") changes[1]!.after = hookDocument(changes[1]!.before, HOOK_EVENTS, event => `${quote(c.bun)} --smol ${quote(c.entry)} hook ${event}`);
    if (target === "codex") changes[1]!.after = hookDocument(changes[1]!.before, ["SessionEnd"], () => capture("codex"));
    if (target === "kimi") {
      const old = changes[1]!.before.bytes === null ? "" : Buffer.from(changes[1]!.before.bytes!, "base64").toString("utf8");
      const parsed = record(Bun.TOML.parse(old)), hooks = parsed.hooks ?? [];
      if (!Array.isArray(hooks)) throw Error("Kimi hooks must be an array");
      changes[1]!.after = hooks.some(h => record(h).event === "SessionEnd" && record(h).command === capture("kimi")) ? changes[1]!.before : image(`${old}${old.endsWith("\n") || !old ? "" : "\n"}\n[[hooks]]\nevent = "SessionEnd"\ncommand = ${JSON.stringify(capture("kimi"))}\ntimeout = 3\n`, changes[1]!.before.mode);
    }
    if (target === "pi") {
      const content = piExtension(c.bun, c.entry);
      if (changes[1]!.before.bytes !== null && changes[1]!.before.bytes !== image(content).bytes) throw Error("Pi amem-session extension already exists and is not this setup's file");
      changes[1]!.after = image(content, changes[1]!.before.mode);
    }
    return { version: 1, target, intent: intent(c, target), phase: "prepared", changes };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function current(change: Change): "before" | "after" {
  const found = read(change.path), hash = digest(found);
  if (hash === digest(change.after)) return "after";
  if (hash === digest(change.before)) return "before";
  throw Error("setup configuration changed; refusing to overwrite later edits");
}
function save(c: ReturnType<typeof context>, value: Receipt): void { write(journal(c, value.target), image(JSON.stringify(value) + "\n")); }
/** Caller must enforce person markers/TTY and obtain confirmation before this mutation boundary. */
function applyUnlocked(plan: SetupPlan, options: SetupContext = {}): { applied: SetupTarget[]; unchanged: SetupTarget[] } {
  const c = context(options), receipts = plan.targets.map(target => prepare(c, target, options));
  for (const value of receipts) for (const change of value.changes) current(change);
  const applied: SetupTarget[] = [], unchanged: SetupTarget[] = [];
  for (const value of receipts) {
    if (value.phase === "applied" && value.changes.every(change => current(change) === "after")) { unchanged.push(value.target); continue; }
    save(c, value);
    for (const change of value.changes) { current(change); write(change.path, change.after); }
    value.phase = "applied"; save(c, value); applied.push(value.target);
  }
  return { applied, unchanged };
}
/** Restore only exact known target states; a later person's edit is never overwritten. */
function undoUnlocked(plan: SetupPlan, options: SetupContext = {}): { restored: SetupTarget[] } {
  const c = context(options), receipts = plan.targets.map(target => receipt(c, target)).filter((value): value is Receipt => !!value);
  for (const value of receipts) for (const change of value.changes) current(change);
  for (const value of receipts) { for (const change of value.changes) { current(change); write(change.path, change.before); } rmSync(journal(c, value.target)); }
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
    if (!owner || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.signature !== "string" || processLiveness(Number(owner.pid)) !== "gone" || digest(read(file)) !== digest(original)) throw Error("setup is busy; retry after the active setup exits");
    rmSync(file); fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  }
  const token = JSON.stringify({ pid: process.pid, signature, nonce: randomUUID() });
  try { writeFileSync(fd, token); fsyncSync(fd); return run(); }
  finally { closeSync(fd); if (read(file).bytes === Buffer.from(token).toString("base64")) rmSync(file); }
}
export function applySetup(plan: SetupPlan, options: SetupContext = {}): { applied: SetupTarget[]; unchanged: SetupTarget[] } {
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
