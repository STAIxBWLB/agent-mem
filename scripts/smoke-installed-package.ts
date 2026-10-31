import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realPath } from "../src/memory/platform.ts";

const PACKAGE = "@staix/agent-mem", MARKER = "installedpublicsmokeneedle", HOOK_MARKER = "installednativesmokehookmarker", OUTPUT_BYTES = 2 * 1024 * 1024;
const inside = (root: string, file: string) => { const part = relative(resolve(root), resolve(file)); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); };
const requireSmoke = (condition: unknown, message: string): void => { if (!condition) throw Error(message); };
const object = (value: unknown): Record<string, any> => { requireSmoke(value && typeof value === "object" && !Array.isArray(value), "installed smoke expected an object"); return value as Record<string, any>; };

/** Pure path guards take canonical paths; the runner resolves each installed artifact through the shared platform helper. */
export function assertInstalledEntry(entry: string, installedRoot: string, checkout: string, childTmp: string): void {
  requireSmoke([entry, installedRoot, checkout, childTmp].every(isAbsolute), "installed smoke needs absolute artifact paths");
  requireSmoke(resolve(entry) === join(resolve(installedRoot), "bin", "amem.js") && inside(installedRoot, entry) && !inside(checkout, entry) && !inside(childTmp, entry), "installed entry escaped the artifact or overlaps checkout/child temporary storage");
}
export function assertInstalledAlias(alias: string, resolvedAlias: string, entry: string, appBin: string): void {
  requireSmoke([alias, resolvedAlias, entry, appBin].every(isAbsolute) && resolve(alias) === join(resolve(appBin), "amem") && resolve(resolvedAlias) === resolve(entry), "installed executable alias did not resolve to the packaged bin");
}
export function assertInstalledModule(modulePath: string, installedRoot: string, checkout: string): void {
  requireSmoke(isAbsolute(modulePath) && inside(installedRoot, modulePath) && !inside(checkout, modulePath), "public API fell back outside the installed artifact");
}
export function assertNoHubBranding(output: string): void { requireSmoke(!/(?<![a-z0-9])ahub(?![a-z0-9])/i.test(output), "legacy host command appeared in installed output"); }
export function assertSmokeCliArgs(args: readonly string[]): void {
  requireSmoke(args.length === 1 && ["--help", "--version", "mcp"].includes(args[0]!) || args.length === 2 && args[0] === "hook" && args[1] === "PostToolUse" || args.length === 3 && args[0] === "ingest" && ["codex", "kimi", "pi", "qwen"].includes(args[1]!) && args[2] === "--json" || ["setup all --json", "setup agy --json", "setup all --apply --json", "setup agy --apply --json"].includes(args.join(" ")), "installed smoke refuses unsupported CLI arguments");
}
export function registeredSmokeCommand(value: unknown, bun: string, entry: string): string[] {
  const raw = object(value);
  // OpenCode keeps one `command` array (type "local"); every other client splits command and args.
  const server = raw.type === "local" && Array.isArray(raw.command) ? { ...raw, command: raw.command[0], args: raw.command.slice(1) } : raw;
  requireSmoke(server.command === bun && JSON.stringify(server.args) === JSON.stringify(["--smol", entry, "mcp"]) && server.enabled !== false, "registered MCP command differs from the installed artifact");
  return [server.command, ...server.args];
}
export function assertSetupApplied(output: string, expected: readonly string[] = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini"]): void {
  const result = /\{\s*"applied"\s*:[\s\S]*\}\s*$/.exec(output);
  requireSmoke(result, "installed setup confirmation did not return an apply result");
  const applied = object(JSON.parse(result![0]));
  requireSmoke(JSON.stringify(applied.applied) === JSON.stringify(expected) && JSON.stringify(applied.unchanged) === "[]", "installed setup did not apply the expected targets");
}
export function allowlistedSmokeEnv(home: string, runtimePath: string): NodeJS.ProcessEnv {
  requireSmoke(isAbsolute(home), "installed smoke HOME must be absolute");
  // Keep the read-only HOME proof about application effects: Bun's transpiler otherwise caches .pile files during module load.
  return { HOME: home, PATH: runtimePath, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", AMEM_HOME: join(home, "memory"), TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: join(home, "clients", "claude"), CODEX_HOME: join(home, "clients", "codex"), KIMI_CODE_HOME: join(home, "clients", "kimi"), PI_CODING_AGENT_DIR: join(home, "clients", "pi"), QWEN_HOME: join(home, "clients", "qwen"), QWEN_RUNTIME_DIR: join(home, "qwen-runtime"), JCODE_HOME: join(home, "clients", "jcode"),
    BUN_INSTALL: join(home, ".bun"), BUN_INSTALL_CACHE_DIR: join(home, ".cache", "bun"), npm_config_cache: join(home, ".cache", "npm"), npm_config_userconfig: join(home, ".config", "npmrc"), npm_config_globalconfig: join(home, ".config", "global-npmrc"), npm_config_prefix: join(home, ".npm-prefix"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC", NO_COLOR: "1", TERM: "dumb" };
}
export function assertSetupPreview(value: unknown, home: string, entry: string): string[] {
  const plan = object(value);
  requireSmoke(plan.mode === "preview" && JSON.stringify(plan.targets) === JSON.stringify(["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini"]) && Array.isArray(plan.actions) && plan.actions.length === 8, "installed setup did not return the all-target dry-run plan");
  requireSmoke(JSON.stringify(plan.actions.map((action: any) => action?.target)) === JSON.stringify(plan.targets), "installed setup target inventory is incomplete");
  const files: string[] = [];
  for (const raw of plan.actions) { const action = object(raw); requireSmoke(Array.isArray(action.files) && action.files.length > 0 && typeof action.receipt === "string", "installed setup inventory is incomplete");
    if (action.registration !== null) requireSmoke(Array.isArray(action.registration) && action.registration.includes(entry), "installed setup registration uses a stale package entry");
    requireSmoke(Array.isArray(action.hooks) && (action.target === "jcode" || action.target === "opencode" || action.target === "gemini" ? action.hooks.length === 0 : action.hooks.length > 0) && action.hooks.every((hook: any) => typeof hook.command === "string" && hook.command.includes(entry)), "installed client hooks use a stale package entry");
    for (const file of [...action.files, action.receipt]) { requireSmoke(typeof file === "string" && isAbsolute(file) && inside(home, file), "installed setup escaped its isolated HOME"); files.push(file); }
  }
  return files;
}
export function assertAgySetupPreview(value: unknown, home: string, project: string): string[] {
  const plan = object(value), action = object(plan.actions?.[0]);
  requireSmoke(plan.mode === "preview" && JSON.stringify(plan.targets) === '["agy"]' && plan.actions.length === 1, "installed agy setup preview has the wrong scope");
  requireSmoke(action.cwd === project && JSON.stringify(action.files) === JSON.stringify([join(project, ".agents", "mcp_config.json")]), "installed agy setup escaped its Git workspace");
  requireSmoke(action.registration === null && Array.isArray(action.hooks) && action.hooks.length === 0, "installed agy setup must be MCP-only");
  requireSmoke(typeof action.receipt === "string" && isAbsolute(action.receipt) && inside(home, action.receipt), "installed agy receipt escaped its private HOME");
  return [...action.files, action.receipt];
}
export function assertMcpResult(output: string, version: string, seedId: string, project: string): void {
  assertNoHubBranding(output);
  const replies = output.trim().split("\n").filter(Boolean).map(line => object(JSON.parse(line))), initialized = replies.find(row => row.id === 1), search = replies.find(row => row.id === 2), listing = replies.find(row => row.id === 3);
  requireSmoke(replies.length === 3 && initialized?.result?.serverInfo?.name === "amem" && initialized.result.serverInfo.version === version && !search?.error && search?.result?.isError !== true, "installed MCP initialization/search failed");
  requireSmoke(!listing?.error && Array.isArray(listing?.result?.tools) && listing.result.tools.some((tool: any) => tool.name === "amem_search"), "installed MCP tool listing unavailable");
  for (const tool of listing!.result.tools) { requireSmoke(typeof tool.description === "string", "installed MCP tool description missing"); assertNoHubBranding(tool.description); }
  const content = search?.result?.content?.find((item: any) => item.type === "text" && typeof item.text === "string");
  requireSmoke(content, "installed MCP search has no JSON result");
  const result = object(JSON.parse(content.text));
  requireSmoke(Array.isArray(result.hits) && result.hits.length === 1 && result.hits.some((hit: any) => hit.source === "curated" && hit.evidence === true && hit.view?.id === seedId && hit.view.project === project && hit.view.text?.includes(MARKER)), "installed MCP search did not find its public installed-API seed");
}
export function assertPostToolUseOutput(output: string): void {
  requireSmoke(output.trim() === "", "native PostToolUse emitted output reserved for SessionStart context");
}
export interface HomeSnapshotEntry { path: string; type: "directory" | "file" | "symlink" | "other"; size: number; mode: number; hash?: string; link?: string }
export function snapshotPrivateHome(home: string): HomeSnapshotEntry[] {
  const rows: HomeSnapshotEntry[] = [];
  const walk = (file: string) => {
    const stat = lstatSync(file), path = relative(home, file) || ".", mode = stat.mode & 0o7777, size = stat.size;
    if (stat.isSymbolicLink()) rows.push({ path, type: "symlink", size, mode, link: readlinkSync(file) });
    else if (stat.isDirectory()) { rows.push({ path, type: "directory", size, mode }); for (const name of readdirSync(file).sort()) walk(join(file, name)); }
    else if (stat.isFile()) rows.push({ path, type: "file", size, mode, hash: createHash("sha256").update(readFileSync(file)).digest("hex") });
    else rows.push({ path, type: "other", size, mode });
  };
  walk(home); return rows.sort((a, b) => a.path.localeCompare(b.path));
}
export function assertHomeUnchanged(before: HomeSnapshotEntry[], after: HomeSnapshotEntry[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const prior = new Map(before.map(row => [row.path, JSON.stringify(row)])), next = new Map(after.map(row => [row.path, JSON.stringify(row)]));
  const changed = [...new Set([...prior.keys(), ...next.keys()])].filter(path => prior.get(path) !== next.get(path)).sort();
  throw Error(`setup dry run changed its private HOME (${changed.slice(0, 8).join(", ")})`);
}
export function assertHookMetric(before: string, after: string): void {
  requireSmoke(after.startsWith(before), "hook metric history changed rather than appending");
  const rows = after.slice(before.length).split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
  requireSmoke(rows.length === 1 && rows[0]!.kind === "hook" && typeof rows[0]!.at === "string" && Number.isFinite(Date.parse(rows[0]!.at)) && Number.isFinite(rows[0]!.wallMs) && rows[0]!.wallMs >= 0 && Number.isFinite(rows[0]!.rssMB) && rows[0]!.rssMB >= 0, "installed hook must append exactly one fresh hook metric");
}
export interface HookExpectation { project: string; cwd: string; event: string; agent: string; marker: string }
function pendingIdentity(item: any): string | undefined {
  if (typeof item?.path !== "string") return undefined;
  return /^hook-spool\/(?:\.capacity\/)?(hook-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json)(?:\.draining-[a-f0-9]{24})?$/.exec(item.path)?.[1];
}
export function assertHookEvidence(beforeMetrics: string, afterMetrics: string, beforeRaw: unknown, raw: unknown, expected: HookExpectation): void {
  assertHookMetric(beforeMetrics, afterMetrics);
  const before = object(beforeRaw), evidence = object(raw);
  requireSmoke(Array.isArray(before.rows) && Array.isArray(before.pending), "before-hook artifact snapshot unavailable");
  const oldRows = new Set(before.rows.filter((row: any) => Number.isSafeInteger(row.id) && row.id > 0).map((row: any) => row.id));
  const oldPending = new Set(before.pending.map(pendingIdentity).filter(Boolean));
  const capture = (row: any) => row && row.agent === expected.agent && row.event === expected.event && row.excerpt === expected.marker;
  const retained = before.captureKnown === true && evidence.captureKnown === true && Array.isArray(evidence.rows) && evidence.rows.some((row: any) => Number.isSafeInteger(row.id) && row.id > 0 && !oldRows.has(row.id) && row.project === expected.project && capture(row));
  const pending = before.pendingKnown === true && evidence.pendingKnown === true && Array.isArray(evidence.pending) && evidence.pending.some((item: any) => {
    if (!item || !pendingIdentity(item) || oldPending.has(pendingIdentity(item)) || item.type !== "file" || item.nlink !== 1 || item.project !== expected.project || typeof item.path !== "string") return false;
    const name = /^hook-spool\/(?:\.capacity\/)?hook-([a-f0-9]{64})-([a-f0-9]{64})-([a-f0-9]{32})\.json(?:\.draining-[a-f0-9]{24})?$/.exec(item.path), row = item.value;
    return !!name && name[1] === createHash("sha256").update(expected.cwd).digest("hex") && row?.schema === "agent-mem.hook-capture/v1" && row.cwd === expected.cwd && row.nonce === name[3]
      && (row.scope === null ? name[2] === "0".repeat(64) : row.scope === name[2]) && capture(row.capture) && typeof row.capture.at === "string" && Number.isFinite(Date.parse(row.capture.at));
  });
  requireSmoke(retained || pending, "installed hook metric lacks the matching durable capture or pending record");
}
/** Cache one bounded reap for both normal completion and finally, never extending cleanup by retrying. */
export function createReapWaiter(reaped: Promise<void>, failed: () => void, timeoutMs = 3000): () => Promise<void> {
  requireSmoke(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 3000, "invalid smoke reap bound");
  let cached: Promise<void> | undefined;
  return () => cached ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([reaped, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("owned smoke command was not reaped")), timeoutMs); })]); }
    catch (error) { try { failed(); } catch {} throw error; }
    finally { if (timer) clearTimeout(timer); }
  })();
}

/** Reap failures still fail a successful command, but cannot hide an earlier command/validation error. */
export async function preservingCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let primary = false;
  try { return await work(); } catch (error) { primary = true; throw error; }
  finally { try { await cleanup(); } catch (error) { if (!primary) throw error; } }
}
// The leader stays alive after its command exits so cleanup can safely stop its still-owned process group.
const LAUNCHER = String.raw`
import {writeSync} from 'node:fs';
setInterval(()=>{},1000);
let code=null;
try { code=await Bun.spawn(process.argv.slice(1),{stdin:'inherit',stdout:'inherit',stderr:'inherit'}).exited; } catch {}
writeSync(3,JSON.stringify({code})+'\n');
`;
const SETUP_LAUNCHER = String.raw`
import {writeSync} from 'node:fs';
setInterval(()=>{},1000);
let code=null, prompt='', answered=false;
let child, childExited=false, stopping=false, drain;
const drained=new Promise(resolve=>{drain=resolve;});
process.on('SIGTERM',async()=>{
  if(stopping)return; stopping=true;
  if(child&&!childExited){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
  child?.terminal?.close();
  if(child)await child.exited;
  process.exit(143);
});
try {
  child=Bun.spawn(process.argv.slice(1),{onExit(){childExited=true;},terminal:{cols:120,rows:40,exit(){drain();},data(terminal,data){
    writeSync(1,data); prompt=(prompt+Buffer.from(data).toString('utf8')).slice(-256);
    if(!answered&&prompt.includes('Type yes to apply the listed configuration changes: ')){answered=true;terminal.write('yes\n');}
  }}});
  code=await child.exited;
  await drained;
} catch {} finally { child?.terminal?.close(); }
writeSync(3,JSON.stringify({code})+'\n');
`;
async function ownedCommand(bun: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input = "", timeoutMs = 60000, setupTerminal = false): Promise<string> {
  const child = spawn(bun, ["--smol", "-e", setupTerminal ? SETUP_LAUNCHER : LAUNCHER, "--", ...argv], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let exited = false, control = "", bytes = 0; const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let resolveCode!: (code: number) => void, rejectCode!: (error: Error) => void;
  const completed = new Promise<number>((yes, no) => { resolveCode = yes; rejectCode = no; });
  const stop = () => { if (!exited && child.pid) { const signal = setupTerminal ? "SIGTERM" : "SIGKILL"; try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } } };
  const reaped = new Promise<void>(resolveClose => { child.once("exit", () => { exited = true; rejectCode(Error("installed smoke leader exited before command completion")); }); child.once("close", () => { exited = true; resolveClose(); }); });
  const waitForReap = createReapWaiter(reaped, () => { if (child.pid && !exited) try { process.kill(-child.pid, "SIGKILL"); } catch {} for (const pipe of child.stdio) try { (pipe as { destroy?(): void } | null)?.destroy?.(); } catch {} child.unref(); });
  child.once("error", () => rejectCode(Error("installed smoke could not start its owned command")));
  const collect = (target: Buffer[]) => (data: Buffer) => { if ((bytes += data.length) > OUTPUT_BYTES) { rejectCode(Error("installed smoke command output exceeded its bound")); stop(); } else target.push(data); };
  child.stdout?.on("data", collect(stdout)); child.stderr?.on("data", collect(stderr));
  (child.stdio[3] as NodeJS.ReadableStream | undefined)?.on("data", (data: Buffer) => {
    control += data.toString("utf8"); if (control.length > 128) { rejectCode(Error("installed smoke command completion unavailable")); stop(); return; }
    if (!control.endsWith("\n")) return;
    try { const row = JSON.parse(control); if (Object.keys(row).length !== 1 || !Number.isInteger(row.code) || row.code < 0 || row.code > 255) throw Error(); resolveCode(row.code); } catch { rejectCode(Error("installed smoke command completion unavailable")); }
  });
  const interrupted = () => { rejectCode(Error("installed smoke interrupted")); stop(); };
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  const timer = setTimeout(() => { rejectCode(Error("installed smoke command timed out")); stop(); }, timeoutMs);
  child.stdin?.on("error", () => {}); child.stdin?.end(input);
  return preservingCleanup(async () => {
    const code = await completed;
    requireSmoke(code === 0, `installed smoke command failed (${basename(argv[0] ?? "command")}, exit ${code})`);
    stop(); await waitForReap();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)), errors = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
    assertNoHubBranding(output); assertNoHubBranding(errors);
    return output;
  }, async () => { clearTimeout(timer); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted); stop(); await waitForReap(); });
}

/** A fixed, provider-free mini probe of the same owned launcher used by the artifact smoke. */
export async function probeSmokeLauncher(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const args = ["value with spaces", "--literal-option", "*"];
  const output = await ownedCommand(process.execPath, [process.execPath, "--smol", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args], cwd, env, "", 5000);
  const observed: unknown = JSON.parse(output);
  requireSmoke(JSON.stringify(observed) === JSON.stringify(args), "owned launcher did not forward the fixed argument vector");
  return observed as string[];
}
/** Test the same PTY launcher without installing a package or invoking a vendor CLI. */
export async function probeSmokeSetupTerminal(cwd: string, env: NodeJS.ProcessEnv, stall = false): Promise<string> {
  const code = `import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline/promises';
writeFileSync('pty-child.pid',String(process.pid));
if(!process.stdin.isTTY)process.exit(91);
const terminal=createInterface({input:process.stdin,output:process.stdout});
const answer=await terminal.question('Type yes to apply the listed configuration changes: ');terminal.close();
if(answer!=='yes')process.exit(92);
${stall ? "setInterval(()=>{},1000);" : "console.log('terminal-drained-'+ 'x'.repeat(20000)+'-complete');"}`;
  return ownedCommand(process.execPath, [process.execPath, "--smol", "-e", code], cwd, env, "", stall ? 500 : 5000, true);
}
export interface InstalledSmokeReport { package: string; version: string; setup: "preview and confirmed apply (stub CLIs)"; registeredMcp: string[]; mcp: "seeded search"; hook: "durable native capture observed"; timing: "not measured; existing R2 gates remain separate" }
export async function runInstalledPackageSmoke(options: { afterInstall?: (installedRoot: string) => void } = {}): Promise<InstalledSmokeReport> {
  const checkout = realPath(fileURLToPath(new URL("../", import.meta.url))), metadata = object(JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")));
  requireSmoke(metadata.name === PACKAGE && typeof metadata.version === "string", "unexpected source package metadata");
  const bun = process.execPath, npm = Bun.which("npm"), node = Bun.which("node"); requireSmoke(npm && node, "installed smoke requires npm and Node for offline local tarball installation");
  const root = realPath(mkdtempSync(join(realPath(tmpdir()), "amem-installed-smoke-"))), home = join(root, "home"), app = join(home, "app"), projectDir = join(home, "project"), artifacts = join(home, "artifacts"), traps = join(home, "native-traps"), nativeCalls = join(home, "native-calls");
  try {
    for (const folder of [home, app, projectDir, artifacts, traps, join(home, "tmp"), join(home, ".config")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
    const runtimePath = [...new Set([traps, dirname(bun), dirname(node!), dirname(npm!), "/usr/bin", "/bin"])].join(delimiter), env = allowlistedSmokeEnv(home, runtimePath);
    writeFileSync(env.npm_config_userconfig!, ""); writeFileSync(env.npm_config_globalconfig!, "");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const versionEnv = { AMEM_HOME: "memory", AGENTHUB_HOME: "hub", CLAUDE_CONFIG_DIR: ".claude", CODEX_HOME: ".codex", KIMI_CODE_HOME: ".kimi-code", PI_CODING_AGENT_DIR: ".pi/agent", QWEN_HOME: ".qwen", QWEN_RUNTIME_DIR: "qwen-runtime", QWEN_CODE_SYSTEM_SETTINGS_PATH: "qwen-system-settings.json", QWEN_CODE_SYSTEM_DEFAULTS_PATH: "qwen-system-defaults.json", GEMINI_CLI_SYSTEM_SETTINGS_PATH: "gemini-system-settings.json", GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "gemini-system-defaults.json", JCODE_HOME: ".jcode", XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", XDG_CACHE_HOME: ".cache", XDG_STATE_HOME: ".local/state", TMP: "tmp", TEMP: "tmp" };
    const versionShellChecks = Object.entries(versionEnv).map(([key, tail]) => `[ "\$${key}" = "\$stage/${tail}" ] || exit 96`).join("\n");
    for (const name of ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "gemini", "agy"]) writeFileSync(join(traps, name), `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then stage="\${TMPDIR%/tmp}"; case "$stage" in ${quote(env.TMPDIR! + "/amem-setup-")}*) ;; *) exit 96 ;; esac; [ -d "$stage" ] && [ ! -L "$stage" ] && [ "$(stat -c '%a' "$stage" 2>/dev/null || stat -f '%Lp' "$stage" 2>/dev/null)" = "700" ] && [ "$HOME" = "$stage" ] && [ "$PWD" = "$stage" ] && [ "$TMPDIR" = "$stage/tmp" ] || exit 96\n${versionShellChecks}\nprintf '%s 0.0.0-fixture\\n' ${quote(name)}; exit 0; fi\nprintf '%s\\n' "$0" >> ${quote(nativeCalls)}\nexit 97\n`, { mode: 0o700 });
    const packed = JSON.parse(await ownedCommand(bun, [npm!, "pack", checkout, "--offline", "--json", "--ignore-scripts", "--pack-destination", artifacts], artifacts, env));
    requireSmoke(Array.isArray(packed) && packed.length === 1 && typeof packed[0]?.filename === "string" && basename(packed[0].filename) === packed[0].filename, "npm pack did not return one local artifact");
    const tarball = realPath(join(artifacts, packed[0].filename)); requireSmoke(inside(artifacts, tarball), "packed artifact escaped its private directory");
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "installed-smoke-fixture", private: true, type: "module" }) + "\n");
    await ownedCommand(bun, [npm!, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], app, env);
    const installed = realPath(join(app, "node_modules", "@staix", "agent-mem")), entry = realPath(join(installed, "bin", "amem.js"));
    assertInstalledEntry(entry, installed, checkout, env.TMPDIR!);
    const installedMetadata = object(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")));
    requireSmoke(installedMetadata.name === PACKAGE && installedMetadata.version === metadata.version && installedMetadata.exports?.["."] === "./src/index.ts" && installedMetadata.bin?.amem === "bin/amem.js", "installed artifact metadata differs from its source contract");
    for (const name of ["bin/amem.js", "src/index.ts", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "hooks/hooks.json"]) requireSmoke(lstatSync(join(installed, name)).isFile(), "installed artifact is missing a required executable/plugin component");
    const appBin = join(app, "node_modules", ".bin"), installedEnv = { ...env, PATH: `${appBin}${delimiter}${runtimePath}` };
    const executable = Bun.which("amem", { PATH: installedEnv.PATH }); requireSmoke(executable, "installed package did not register its executable");
    assertInstalledAlias(executable!, realPath(executable!), entry, appBin);
    options.afterInstall?.(installed);
    await ownedCommand(bun, ["git", "init", "-q", projectDir], projectDir, installedEnv);
    const cli = (args: string[], input?: string) => { assertSmokeCliArgs(args); assertInstalledEntry(realPath(entry), realPath(installed), checkout, env.TMPDIR!); assertInstalledAlias(executable!, realPath(executable!), entry, appBin); return ownedCommand(bun, [executable!, ...args], projectDir, installedEnv, input, 60000, false); };
    const ruleFiles = [join(home, "AGENTS.md"), join(home, "CLAUDE.md"), join(projectDir, "AGENTS.md"), join(projectDir, "CLAUDE.md"), join(projectDir, "QWEN.md"), join(env.QWEN_HOME!, "QWEN.md"), join(env.QWEN_HOME!, "rules", "keep.md"), join(projectDir, "AGY.md"), join(projectDir, "JCODE.md"), join(env.JCODE_HOME!, "AGENTS.md"), join(env.CLAUDE_CONFIG_DIR!, "rules", "keep.md"), join(env.CODEX_HOME!, "rules", "keep.rules")];
    for (const file of ruleFiles) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, "installed smoke instruction/rule sentinel, keep exact bytes\n", { mode: 0o600 }); }
    const rules = ruleFiles.map(file => ({ file, bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 }));
    const verifyRules = () => { for (const rule of rules) requireSmoke(readFileSync(rule.file).equals(rule.bytes) && (lstatSync(rule.file).mode & 0o777) === rule.mode, "setup or runtime changed an instruction/rule sentinel"); };
    requireSmoke((await cli(["--version"])).trim() === `amem ${metadata.version}`, "installed CLI version output differs"); await cli(["--help"]);
    const beforeSetup = snapshotPrivateHome(home);
    const plan = JSON.parse(await cli(["setup", "all", "--json"])); const afterSetup = snapshotPrivateHome(home); assertHomeUnchanged(beforeSetup, afterSetup);
    requireSmoke(plan.actions.every((action: any) => action.version?.output === `${action.target} 0.0.0-fixture`), "installed setup version probes did not run in isolated staging homes");
    const plannedFiles = assertSetupPreview(plan, home, entry);
    requireSmoke(plannedFiles.every(file => !existsSync(file)) && !existsSync(nativeCalls), "setup dry run wrote configuration or invoked a native client"); verifyRules();
    // Explicit apply flags run without a terminal or prompt; the default setup call above remains a preview.
    // Only native registration is stubbed, matching the setup unit fixtures; no vendor CLI is exercised.
    const nativeStub = join(home, "native-registration.ts");
    writeFileSync(nativeStub, `import {appendFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';import {basename,dirname,join,resolve} from 'node:path';
const [target,...args]=process.argv.slice(2);
if(args.length===1&&args[0]==='--version'){const stage=dirname(process.env.TMPDIR||''),root=${JSON.stringify(resolve(env.TMPDIR!))},stat=lstatSync(stage),expected={HOME:stage,AMEM_HOME:join(stage,'memory'),AGENTHUB_HOME:join(stage,'hub'),CLAUDE_CONFIG_DIR:join(stage,'.claude'),CODEX_HOME:join(stage,'.codex'),KIMI_CODE_HOME:join(stage,'.kimi-code'),PI_CODING_AGENT_DIR:join(stage,'.pi','agent'),QWEN_HOME:join(stage,'.qwen'),QWEN_RUNTIME_DIR:join(stage,'qwen-runtime'),QWEN_CODE_SYSTEM_SETTINGS_PATH:join(stage,'qwen-system-settings.json'),QWEN_CODE_SYSTEM_DEFAULTS_PATH:join(stage,'qwen-system-defaults.json'),GEMINI_CLI_HOME:stage,GEMINI_CLI_SYSTEM_SETTINGS_PATH:join(stage,'gemini-system-settings.json'),GEMINI_CLI_SYSTEM_DEFAULTS_PATH:join(stage,'gemini-system-defaults.json'),JCODE_HOME:join(stage,'.jcode'),XDG_CONFIG_HOME:join(stage,'.config'),XDG_DATA_HOME:join(stage,'.local','share'),XDG_CACHE_HOME:join(stage,'.cache'),XDG_STATE_HOME:join(stage,'.local','state'),TMPDIR:join(stage,'tmp'),TMP:join(stage,'tmp'),TEMP:join(stage,'tmp')};if(!basename(stage).startsWith('amem-setup-')||dirname(resolve(stage))!==root||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.cwd()!==stage||Object.entries(expected).some(([key,value])=>process.env[key]!==value))process.exit(96);console.log(target+' 0.0.0-fixture');process.exit(0);}
if(!['claude','codex','pi','qwen','gemini'].includes(target))process.exit(97);
if(args.length===1&&args[0]==='--help'){console.log('  mcp Manage MCP servers');process.exit(0);}
const marker=args.indexOf('--'),launch=target==='qwen'||target==='gemini'?[args[marker-1],...args.slice(marker+1)]:args.slice(marker+1),home=process.env.HOME;
if(args[0]!=='mcp'||args[1]!=='add'||marker<0||process.cwd()!==home||!home.startsWith(${JSON.stringify(env.TMPDIR! + "/amem-setup-")}))process.exit(97);
appendFileSync(${JSON.stringify(nativeCalls)},JSON.stringify({target,args,home})+'\\n');
const server={command:launch[0],args:launch.slice(1)},file=target==='claude'?join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'):target==='codex'?join(process.env.CODEX_HOME,'config.toml'):target==='qwen'?join(process.env.QWEN_HOME,'settings.json'):target==='gemini'?join(process.env.GEMINI_CLI_HOME,'.gemini','settings.json'):join(process.env.PI_CODING_AGENT_DIR,'mcp.json');
mkdirSync(dirname(file),{recursive:true});writeFileSync(file,target==='codex'?Bun.TOML.stringify({mcp_servers:{amem:server}}):JSON.stringify({mcpServers:{amem:server}}));\n`);
    for (const target of ["claude", "codex", "pi", "qwen", "gemini"]) writeFileSync(join(traps, target), `#!/bin/sh\nexec ${quote(bun)} --smol ${quote(nativeStub)} ${quote(target)} "$@"\n`, { mode: 0o700 });
    assertSetupApplied(await cli(["setup", "all", "--apply", "--json"])); verifyRules();
    const registrations = readFileSync(nativeCalls, "utf8"), calls = registrations.trim().split("\n").map(line => object(JSON.parse(line)));
    requireSmoke(JSON.stringify(calls.map(call => call.target)) === JSON.stringify(["claude", "codex", "pi", "qwen", "gemini"]) && calls.every(call => !existsSync(call.home)), "setup did not use and remove only its private native staging homes");
    const seedFile = join(app, "seed-installed.ts");
    writeFileSync(seedFile, `import {MemoryStore,memoryProjectKey,realPath} from '@staix/agent-mem';import {fileURLToPath} from 'node:url';const resolved=realPath(fileURLToPath(import.meta.resolve('@staix/agent-mem')));const project=memoryProjectKey(process.cwd());const store=new MemoryStore({memoryDir:process.env.AMEM_HOME,deferPromotions:true});try{const id=store.note({op:'note',project,scope:'project',tier:'long',kind:'contract',peer:'person',source:'person',text:${JSON.stringify(MARKER)},about:[]});console.log(JSON.stringify({id,project,resolved}));}finally{store.close();}\n`);
    const seed = object(JSON.parse(await ownedCommand(bun, [bun, "--smol", seedFile], projectDir, installedEnv))); assertInstalledModule(seed.resolved, installed, checkout); requireSmoke(/^[a-f0-9]{32}$/.test(seed.id) && typeof seed.project === "string", "installed API seed failed");
    const frame = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const mcpInput = frame(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "installed-smoke", version: "1" } }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + frame(3, "tools/list", {}) + frame(2, "tools/call", { name: "amem_search", arguments: { query: MARKER, includeCapture: false, limit: 5 } });
    assertMcpResult(await cli(["mcp"], mcpInput), metadata.version, seed.id, seed.project);
    const beforeAgy = snapshotPrivateHome(home), agyPlan = JSON.parse(await cli(["setup", "agy", "--json"]));
    assertHomeUnchanged(beforeAgy, snapshotPrivateHome(home));
    const agyFiles = assertAgySetupPreview(agyPlan, home, projectDir);
    requireSmoke(agyFiles.every(file => !existsSync(file)), "agy preview wrote configuration or a receipt");
    assertSetupApplied(await cli(["setup", "agy", "--apply", "--json"]), ["agy"]); verifyRules();
    requireSmoke(!existsSync(join(home, ".gemini", "config", "mcp_config.json")) && !existsSync(join(projectDir, ".agents", "hooks.json")), "agy setup wrote global configuration or hooks");
    const registeredMcp: string[] = [];
    for (const action of [...plan.actions, ...agyPlan.actions]) {
      const source = readFileSync(action.files[0], "utf8"), document = object(action.target === "codex" ? Bun.TOML.parse(source) : JSON.parse(source));
      const server = object(document[action.target === "codex" ? "mcp_servers" : action.target === "jcode" ? "servers" : action.target === "opencode" ? "mcp" : "mcpServers"]).amem;
      if (action.target === "jcode") { requireSmoke(object(server).shared === false && action.hooks.length === 0, "Jcode registration must be private per session and MCP-only"); requireSmoke(!Object.hasOwn(document, "mcpServers") && !existsSync(join(env.JCODE_HOME!, "config.toml")), "Jcode setup wrote an alias or hook configuration"); }
      if (action.target === "gemini") requireSmoke(action.hooks.length === 0 && !existsSync(join(home, ".gemini", "config", "mcp_config.json")), "Gemini CLI registration must be MCP-only and never write the Antigravity file");
      if (action.target === "opencode") requireSmoke(object(server).type === "local" && object(server).cwd === undefined && action.hooks.length === 0 && !existsSync(join(dirname(action.files[0]), "plugins")), "OpenCode registration must be a local MCP-only server bound to the session directory");
      if (action.target === "agy") requireSmoke(object(server).cwd === projectDir && action.hooks.length === 0, "Antigravity registration has the wrong workspace binding");
      const command = registeredSmokeCommand(server, bun, entry);
      assertInstalledEntry(realPath(command[2]!), installed, checkout, env.TMPDIR!);
      assertMcpResult(await ownedCommand(bun, command, projectDir, installedEnv, mcpInput), metadata.version, seed.id, seed.project);
      registeredMcp.push(action.target); verifyRules();
    }
    const metrics = join(env.AMEM_HOME!, "metrics.jsonl"), reader = join(app, "read-hook-installed.ts");
    writeFileSync(reader, `import {CaptureStore,captureShardDir,memoryProjectKey,realPath} from '@staix/agent-mem';import {fileURLToPath} from 'node:url';import {lstatSync,readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';const base=process.env.AMEM_HOME;const project=memoryProjectKey(process.cwd());let rows=[],captureKnown=false;try{const store=new CaptureStore({memoryDir:base,project,readOnly:true,maxReadRows:32});try{rows=store.rows({project,limit:32});captureKnown=true;}finally{store.close();}}catch{try{const file=join(base,'machine.json'),stat=lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4096){const machine=JSON.parse(readFileSync(file,'utf8'));if(/^[a-f0-9]{16}$/.test(machine.id)){try{lstatSync(join(captureShardDir(base,project,machine.id),'capture.db'));}catch(error){if(error.code==='ENOENT')captureKnown=true;}}}}catch{}}const pending=[];let pendingKnown=true;for(const rel of ['hook-spool','hook-spool/.capacity']){const dir=join(base,rel);let stat;try{stat=lstatSync(dir);}catch(error){if(error.code!=='ENOENT')pendingKnown=false;continue;}if(!stat.isDirectory()||stat.isSymbolicLink()){pendingKnown=false;continue;}for(const name of readdirSync(dir)){const file=join(dir,name),s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>73728)continue;try{const value=JSON.parse(readFileSync(file,'utf8'));pending.push({path:rel+'/'+name,type:'file',nlink:s.nlink,project:value.cwd===process.cwd()?project:'',value});}catch{}}}console.log(JSON.stringify({resolved:realPath(fileURLToPath(import.meta.resolve('@staix/agent-mem'))),captureKnown,pendingKnown,rows,pending}));\n`);
    const inspect = async () => { const evidence = object(JSON.parse(await ownedCommand(bun, [bun, "--smol", reader], projectDir, installedEnv))); assertInstalledModule(evidence.resolved, installed, checkout); return evidence; };
    writeFileSync(join(projectDir, "public.txt"), "public installed hook fixture\n");
    const beforeArtifacts = await inspect(), beforeMetrics = existsSync(metrics) ? readFileSync(metrics, "utf8") : "";
    const hookOutput = await cli(["hook", "PostToolUse"], JSON.stringify({ session_id: "installed-smoke", hook_event_name: "PostToolUse", cwd: projectDir, tool_name: "Read", tool_input: { file_path: "public.txt" }, tool_response: HOOK_MARKER }));
    assertPostToolUseOutput(hookOutput); verifyRules();
    requireSmoke(existsSync(metrics), "installed native hook did not load its metric path");
    assertHookEvidence(beforeMetrics, readFileSync(metrics, "utf8"), beforeArtifacts, await inspect(), { project: seed.project, cwd: projectDir, event: "PostToolUse", agent: "claude", marker: `public.txt\n${HOOK_MARKER}` });
    requireSmoke(readFileSync(nativeCalls, "utf8") === registrations, "installed MCP or hook unexpectedly invoked a native coding client");
    const networkCalls = join(home, "network-calls"), networkTripwire = join(app, "ingest-network-tripwire.ts");
    writeFileSync(networkTripwire, `import {appendFileSync} from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),marker=${JSON.stringify(networkCalls)};
const trip=(name)=>{appendFileSync(marker,JSON.stringify({name})+'\\n');throw Error('installed ingest network tripwire');};
globalThis.fetch=(...args)=>trip('fetch');globalThis.WebSocket=class {constructor(){trip('WebSocket');}};
for(const [name,keys] of Object.entries({'node:http':['request','get'],'node:https':['request','get'],'node:net':['connect','createConnection'],'node:tls':['connect'],'node:dns':['lookup','resolve','resolve4','resolve6'],'node:dns/promises':['lookup','resolve','resolve4','resolve6']})){const module=require(name);for(const key of keys)module[key]=()=>trip(name+'.'+key);}
require('node:net').Socket.prototype.connect=function(){return trip('Socket.connect');};Bun.connect=()=>trip('Bun.connect');\n`);
    const ingest = (kind: "codex" | "kimi" | "pi" | "qwen") => {
      const args = ["ingest", kind, "--json"]; assertSmokeCliArgs(args); assertInstalledEntry(realPath(entry), realPath(installed), checkout, env.TMPDIR!); assertInstalledAlias(executable!, realPath(executable!), entry, appBin);
      return ownedCommand(bun, [bun, "--smol", "--preload", networkTripwire, entry, ...args], projectDir, installedEnv);
    };
    const at = "2026-10-23T01:00:00.000Z", nativeLine = (value: unknown) => JSON.stringify(value) + "\n";
    for (const kind of ["codex", "kimi", "pi", "qwen"] as const) {
      const marker = `installed-${kind}-ingest-marker`, nativeRoot = kind === "codex" ? env.CODEX_HOME! : kind === "kimi" ? env.KIMI_CODE_HOME! : kind === "qwen" ? env.QWEN_RUNTIME_DIR! : env.PI_CODING_AGENT_DIR!;
      const sessions = kind === "qwen" ? join(nativeRoot, "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"), "chats") : join(nativeRoot, "sessions");
      if (kind === "qwen") {
        mkdirSync(sessions, { recursive: true });
        const sessionId = "22222222-2222-4222-8222-222222222222";
        writeFileSync(join(sessions, `${sessionId}.jsonl`), nativeLine({ uuid: "11111111-1111-4111-8111-111111111111", parentUuid: null,
          sessionId, timestamp: at, type: "assistant", cwd: projectDir, version: "0.26.1", message: { role: "model", parts: [{ text: marker }] } }));
      } else if (kind === "kimi") {
        const session = join(sessions, "installed"), wire = join(session, "agents", "main", "wire.jsonl"); mkdirSync(dirname(wire), { recursive: true });
        writeFileSync(join(session, "state.json"), JSON.stringify({ cwd: projectDir }));
        writeFileSync(wire, nativeLine({ type: "metadata", protocol_version: "1.5" }) + nativeLine({ type: "context.append_message", time: Date.parse(at), message: { role: "assistant", content: [{ type: "text", text: marker }] } }));
      } else {
        mkdirSync(sessions, { recursive: true });
        const records = kind === "codex" ? [
          { timestamp: at, type: "session_meta", payload: { id: "installed-smoke", cwd: projectDir } },
          { timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] } },
        ] : [
          { type: "session", version: 3, id: "installed-smoke", timestamp: at, cwd: projectDir },
          { type: "message", id: "installed-smoke", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: marker }] } },
        ];
        writeFileSync(join(sessions, "installed.jsonl"), records.map(nativeLine).join(""));
      }
      const before = await inspect(), first = object(JSON.parse(await ingest(kind)));
      requireSmoke(first.files === 1 && first.imported === 1 && first.spooled === 0 && first.errors === 0 && first.remaining === false, `installed ${kind} ingest did not capture exactly one fixture`);
      const after = await inspect(), oldRows = new Set(before.rows.map((row: any) => row.id));
      requireSmoke(after.rows.filter((row: any) => !oldRows.has(row.id) && row.project === seed.project && row.agent === kind && row.event === "message" && row.excerpt === marker).length === 1, `installed ${kind} ingest lacks its durable project capture`);
      const second = object(JSON.parse(await ingest(kind))), replayed = await inspect();
      requireSmoke(second.imported === 0 && second.spooled === 0 && second.errors === 0 && second.remaining === false && JSON.stringify(replayed.rows) === JSON.stringify(after.rows), `installed ${kind} ingest cursor did not make its replay empty`);
      requireSmoke(!existsSync(networkCalls), `installed ${kind} ingest attempted a network call`); verifyRules();
    }
    requireSmoke(readFileSync(nativeCalls, "utf8") === registrations, "installed MCP, hook or ingest unexpectedly invoked a native coding client");
    return { package: PACKAGE, version: metadata.version, setup: "preview and confirmed apply (stub CLIs)", registeredMcp, mcp: "seeded search", hook: "durable native capture observed", timing: "not measured; existing R2 gates remain separate" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await runInstalledPackageSmoke(), null, 2)); }
  catch (error) { console.error(`installed package smoke: ${(error as Error).message}`); process.exitCode = 1; }
}
