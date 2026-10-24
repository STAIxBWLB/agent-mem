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
  requireSmoke(args.length === 1 && ["--help", "--version", "mcp"].includes(args[0]!) || args.length === 2 && (args[0] === "setup" && args[1] === "all" || args[0] === "hook" && args[1] === "PostToolUse"), "installed smoke refuses mutating or unsupported CLI arguments");
}
export function allowlistedSmokeEnv(home: string, runtimePath: string): NodeJS.ProcessEnv {
  requireSmoke(isAbsolute(home), "installed smoke HOME must be absolute");
  return { HOME: home, PATH: runtimePath, AMEM_HOME: join(home, "memory"), TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: join(home, "clients", "claude"), CODEX_HOME: join(home, "clients", "codex"), KIMI_CODE_HOME: join(home, "clients", "kimi"), PI_CODING_AGENT_DIR: join(home, "clients", "pi"),
    BUN_INSTALL: join(home, ".bun"), BUN_INSTALL_CACHE_DIR: join(home, ".cache", "bun"), npm_config_cache: join(home, ".cache", "npm"), npm_config_userconfig: join(home, ".config", "npmrc"), npm_config_globalconfig: join(home, ".config", "global-npmrc"), npm_config_prefix: join(home, ".npm-prefix"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC", NO_COLOR: "1", TERM: "dumb" };
}
export function assertSetupPreview(value: unknown, home: string, entry: string): string[] {
  const plan = object(value);
  requireSmoke(plan.mode === "preview" && JSON.stringify(plan.targets) === JSON.stringify(["claude", "codex", "kimi", "pi"]) && Array.isArray(plan.actions) && plan.actions.length === 4, "installed setup did not return the all-target dry-run plan");
  requireSmoke(JSON.stringify(plan.actions.map((action: any) => action?.target)) === JSON.stringify(plan.targets), "installed setup target inventory is incomplete");
  const files: string[] = [];
  for (const raw of plan.actions) { const action = object(raw); requireSmoke(Array.isArray(action.files) && action.files.length > 0 && typeof action.receipt === "string", "installed setup inventory is incomplete");
    if (action.registration !== null) requireSmoke(Array.isArray(action.registration) && action.registration.includes(entry), "installed setup registration uses a stale package entry");
    if (action.target === "kimi" && action.hooks !== undefined) requireSmoke(Array.isArray(action.hooks) && action.hooks.length > 0 && action.hooks.every((hook: any) => typeof hook.command === "string" && hook.command.includes(entry)), "installed Kimi hooks use a stale package entry");
    for (const file of [...action.files, action.receipt]) { requireSmoke(typeof file === "string" && isAbsolute(file) && inside(home, file), "installed setup escaped its isolated HOME"); files.push(file); }
  }
  return files;
}
export function assertMcpResult(output: string, version: string, seedId: string, project: string): void {
  assertNoHubBranding(output);
  const replies = output.trim().split("\n").filter(Boolean).map(line => object(JSON.parse(line))), initialized = replies.find(row => row.id === 1), search = replies.find(row => row.id === 2), listing = replies.find(row => row.id === 3);
  requireSmoke(replies.length === 3 && initialized?.result?.serverInfo?.name === "amem" && initialized.result.serverInfo.version === version && !search?.error && search?.result?.isError !== true, "installed MCP initialization/search failed");
  requireSmoke(!listing?.error && Array.isArray(listing?.result?.tools) && listing.result.tools.some((tool: any) => tool.name === "amem_search"), "installed MCP tool listing unavailable");
  for (const tool of listing.result.tools) { requireSmoke(typeof tool.description === "string", "installed MCP tool description missing"); assertNoHubBranding(tool.description); }
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
export function assertHomeUnchanged(before: HomeSnapshotEntry[], after: HomeSnapshotEntry[]): void { requireSmoke(JSON.stringify(before) === JSON.stringify(after), "setup dry run changed its private HOME"); }
export function assertHookMetric(before: string, after: string): void {
  requireSmoke(after.startsWith(before), "hook metric history changed rather than appending");
  const rows = after.slice(before.length).split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
  requireSmoke(rows.length === 1 && rows[0]!.kind === "hook" && typeof rows[0]!.at === "string" && Number.isFinite(Date.parse(rows[0]!.at)) && Number.isFinite(rows[0]!.wallMs) && rows[0]!.wallMs >= 0 && Number.isFinite(rows[0]!.rssMB) && rows[0]!.rssMB >= 0, "installed hook must append exactly one fresh hook metric");
}
export interface HookExpectation { project: string; cwd: string; event: string; agent: string; marker: string }
export function assertHookEvidence(beforeMetrics: string, afterMetrics: string, raw: unknown, expected: HookExpectation): void {
  assertHookMetric(beforeMetrics, afterMetrics);
  const evidence = object(raw), capture = (row: any) => row && row.agent === expected.agent && row.event === expected.event && row.excerpt === expected.marker;
  const retained = Array.isArray(evidence.rows) && evidence.rows.some((row: any) => row.project === expected.project && capture(row));
  const pending = Array.isArray(evidence.pending) && evidence.pending.some((item: any) => {
    if (!item || item.type !== "file" || item.nlink !== 1 || item.project !== expected.project || typeof item.path !== "string") return false;
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

// The leader stays alive after its command exits so cleanup can safely stop its still-owned process group.
const LAUNCHER = String.raw`
import {writeSync} from 'node:fs';
setInterval(()=>{},1000);
let code=null;
try { code=await Bun.spawn(process.argv.slice(1),{stdin:'inherit',stdout:'inherit',stderr:'inherit'}).exited; } catch {}
writeSync(3,JSON.stringify({code})+'\n');
`;
async function ownedCommand(bun: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input = "", timeoutMs = 60000): Promise<string> {
  const child = spawn(bun, ["--smol", "-e", LAUNCHER, "--", ...argv], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let exited = false, control = "", bytes = 0; const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let resolveCode!: (code: number) => void, rejectCode!: (error: Error) => void;
  const completed = new Promise<number>((yes, no) => { resolveCode = yes; rejectCode = no; });
  const stop = () => { if (!exited && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } } };
  const reaped = new Promise<void>(resolveClose => { child.once("exit", () => { exited = true; rejectCode(Error("installed smoke leader exited before command completion")); }); child.once("close", () => { exited = true; resolveClose(); }); });
  const waitForReap = createReapWaiter(reaped, () => { for (const pipe of child.stdio) try { (pipe as { destroy?(): void } | null)?.destroy?.(); } catch {} child.unref(); });
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
  try {
    const code = await completed; stop(); await waitForReap();
    const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)), errors = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
    assertNoHubBranding(output); assertNoHubBranding(errors);
    requireSmoke(code === 0, `installed smoke command failed (${basename(argv[0] ?? "command")}, exit ${code})`);
    return output;
  } finally { clearTimeout(timer); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted); stop(); await waitForReap(); }
}

/** A fixed, provider-free mini probe of the same owned launcher used by the artifact smoke. */
export async function probeSmokeLauncher(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const args = ["value with spaces", "--literal-option", "*"];
  const output = await ownedCommand(process.execPath, [process.execPath, "--smol", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args], cwd, env, "", 5000);
  const observed: unknown = JSON.parse(output);
  requireSmoke(JSON.stringify(observed) === JSON.stringify(args), "owned launcher did not forward the fixed argument vector");
  return observed as string[];
}
export interface InstalledSmokeReport { package: string; version: string; setup: "dry-run"; mcp: "seeded search"; hook: "durable native capture observed"; timing: "not measured; existing R2 gates remain separate" }
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
    for (const name of ["claude", "codex", "kimi", "pi"]) writeFileSync(join(traps, name), `#!/bin/sh\nprintf '%s\\n' "$0" >> ${quote(nativeCalls)}\nexit 97\n`, { mode: 0o700 });
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
    const cli = (args: string[], input?: string) => { assertSmokeCliArgs(args); assertInstalledEntry(realPath(entry), realPath(installed), checkout, env.TMPDIR!); assertInstalledAlias(executable!, realPath(executable!), entry, appBin); return ownedCommand(bun, [executable!, ...args], projectDir, installedEnv, input); };
    const ruleFiles = [join(home, "AGENTS.md"), join(home, "CLAUDE.md"), join(projectDir, "AGENTS.md"), join(projectDir, "CLAUDE.md"), join(env.CLAUDE_CONFIG_DIR!, "rules", "keep.md"), join(env.CODEX_HOME!, "rules", "keep.rules")];
    for (const file of ruleFiles) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, "installed smoke instruction/rule sentinel, keep exact bytes\n", { mode: 0o600 }); }
    const rules = ruleFiles.map(file => ({ file, bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 }));
    const verifyRules = () => { for (const rule of rules) requireSmoke(readFileSync(rule.file).equals(rule.bytes) && (lstatSync(rule.file).mode & 0o777) === rule.mode, "setup or runtime changed an instruction/rule sentinel"); };
    requireSmoke((await cli(["--version"])).trim() === `amem ${metadata.version}`, "installed CLI version output differs"); await cli(["--help"]);
    const beforeSetup = snapshotPrivateHome(home);
    const plan = JSON.parse(await cli(["setup", "all"])); const afterSetup = snapshotPrivateHome(home); assertHomeUnchanged(beforeSetup, afterSetup);
    const plannedFiles = assertSetupPreview(plan, home, entry);
    requireSmoke(plannedFiles.every(file => !existsSync(file)) && !existsSync(nativeCalls), "setup dry run wrote configuration or invoked a native client"); verifyRules();
    const seedFile = join(app, "seed-installed.ts");
    writeFileSync(seedFile, `import {MemoryStore,memoryProjectKey,realPath} from '@staix/agent-mem';import {fileURLToPath} from 'node:url';const resolved=realPath(fileURLToPath(import.meta.resolve('@staix/agent-mem')));const project=memoryProjectKey(process.cwd());const store=new MemoryStore({memoryDir:process.env.AMEM_HOME,deferPromotions:true});try{const id=store.note({op:'note',project,scope:'project',tier:'long',kind:'contract',peer:'person',source:'person',text:${JSON.stringify(MARKER)},about:[]});console.log(JSON.stringify({id,project,resolved}));}finally{store.close();}\n`);
    const seed = object(JSON.parse(await ownedCommand(bun, [bun, "--smol", seedFile], projectDir, installedEnv))); assertInstalledModule(seed.resolved, installed, checkout); requireSmoke(/^[a-f0-9]{32}$/.test(seed.id) && typeof seed.project === "string", "installed API seed failed");
    const frame = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const mcpInput = frame(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "installed-smoke", version: "1" } }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + frame(3, "tools/list", {}) + frame(2, "tools/call", { name: "amem_search", arguments: { query: MARKER, includeCapture: false, limit: 5 } });
    assertMcpResult(await cli(["mcp"], mcpInput), metadata.version, seed.id, seed.project);
    const metrics = join(env.AMEM_HOME!, "metrics.jsonl"), beforeMetrics = existsSync(metrics) ? readFileSync(metrics, "utf8") : "";
    writeFileSync(join(projectDir, "public.txt"), "public installed hook fixture\n");
    const hookOutput = await cli(["hook", "PostToolUse"], JSON.stringify({ session_id: "installed-smoke", hook_event_name: "PostToolUse", cwd: projectDir, tool_name: "Read", tool_input: { file_path: "public.txt" }, tool_response: HOOK_MARKER }));
    assertPostToolUseOutput(hookOutput); verifyRules();
    requireSmoke(existsSync(metrics), "installed native hook did not load its metric path");
    const reader = join(app, "read-hook-installed.ts");
    writeFileSync(reader, `import {CaptureStore,memoryProjectKey,realPath} from '@staix/agent-mem';import {fileURLToPath} from 'node:url';import {lstatSync,readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';const base=process.env.AMEM_HOME;const project=memoryProjectKey(process.cwd());let rows=[];try{const store=new CaptureStore({memoryDir:base,project,readOnly:true,maxReadRows:32});try{rows=store.rows({project,limit:32});}finally{store.close();}}catch{}const pending=[];for(const rel of ['hook-spool','hook-spool/.capacity']){const dir=join(base,rel);let stat;try{stat=lstatSync(dir);}catch{continue;}if(!stat.isDirectory()||stat.isSymbolicLink())continue;for(const name of readdirSync(dir)){const file=join(dir,name),s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>73728)continue;try{const value=JSON.parse(readFileSync(file,'utf8'));pending.push({path:rel+'/'+name,type:'file',nlink:s.nlink,project:value.cwd===process.cwd()?project:'',value});}catch{}}}console.log(JSON.stringify({resolved:realPath(fileURLToPath(import.meta.resolve('@staix/agent-mem'))),rows,pending}));\n`);
    const evidence = object(JSON.parse(await ownedCommand(bun, [bun, "--smol", reader], projectDir, installedEnv))); assertInstalledModule(evidence.resolved, installed, checkout);
    assertHookEvidence(beforeMetrics, readFileSync(metrics, "utf8"), evidence, { project: seed.project, cwd: projectDir, event: "PostToolUse", agent: "claude", marker: HOOK_MARKER });
    requireSmoke(!existsSync(nativeCalls), "installed smoke unexpectedly invoked a native coding client");
    return { package: PACKAGE, version: metadata.version, setup: "dry-run", mcp: "seeded search", hook: "durable native capture observed", timing: "not measured; existing R2 gates remain separate" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await runInstalledPackageSmoke(), null, 2)); }
  catch (error) { console.error(`installed package smoke: ${(error as Error).message}`); process.exitCode = 1; }
}
