import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realPath } from "../src/memory/platform.ts";

const PACKAGE = "@staix/agent-mem", MARKER = "installedpublicsmokeneedle", OUTPUT_BYTES = 2 * 1024 * 1024;
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
export function assertNoHubBranding(output: string): void { requireSmoke(!/\bahub\b/i.test(output), "legacy host command appeared in installed output"); }
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
export function assertSetupPreview(value: unknown, home: string): string[] {
  const plan = object(value);
  requireSmoke(plan.mode === "preview" && JSON.stringify(plan.targets) === JSON.stringify(["claude", "codex", "kimi", "pi"]) && Array.isArray(plan.actions) && plan.actions.length === 4, "installed setup did not return the all-target dry-run plan");
  requireSmoke(JSON.stringify(plan.actions.map((action: any) => action?.target)) === JSON.stringify(plan.targets), "installed setup target inventory is incomplete");
  const files: string[] = [];
  for (const raw of plan.actions) { const action = object(raw); requireSmoke(Array.isArray(action.files) && action.files.length > 0 && typeof action.receipt === "string", "installed setup inventory is incomplete");
    for (const file of [...action.files, action.receipt]) { requireSmoke(typeof file === "string" && isAbsolute(file) && inside(home, file), "installed setup escaped its isolated HOME"); files.push(file); }
  }
  return files;
}
export function assertMcpResult(output: string, version: string, seedId: string, project: string): void {
  assertNoHubBranding(output);
  const replies = output.trim().split("\n").filter(Boolean).map(line => object(JSON.parse(line))), initialized = replies.find(row => row.id === 1), search = replies.find(row => row.id === 2);
  requireSmoke(replies.length === 2 && initialized?.result?.serverInfo?.name === "amem" && initialized.result.serverInfo.version === version && !search?.error && search?.result?.isError !== true, "installed MCP initialization/search failed");
  const content = search?.result?.content?.find((item: any) => item.type === "text" && typeof item.text === "string");
  requireSmoke(content, "installed MCP search has no JSON result");
  const result = object(JSON.parse(content.text));
  requireSmoke(Array.isArray(result.hits) && result.hits.length === 1 && result.hits.some((hit: any) => hit.source === "curated" && hit.evidence === true && hit.view?.id === seedId && hit.view.project === project && hit.view.text?.includes(MARKER)), "installed MCP search did not find its public installed-API seed");
}
export function assertPostToolUseOutput(output: string): void {
  requireSmoke(output.trim() === "", "native PostToolUse emitted output reserved for SessionStart context");
}
export function assertHookMetric(metrics: string): void {
  const rows = metrics.split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
  requireSmoke(rows.some(row => row.kind === "hook" && typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) && Number.isFinite(row.wallMs) && row.wallMs >= 0 && Number.isFinite(row.rssMB) && row.rssMB >= 0), "installed native hook produced no load/metric evidence");
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
    const code = await completed; stop(); await reaped;
    const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)), errors = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
    assertNoHubBranding(output); assertNoHubBranding(errors);
    requireSmoke(code === 0, `installed smoke command failed (${basename(argv[0] ?? "command")}, exit ${code})`);
    return output;
  } finally { clearTimeout(timer); process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted); stop(); await reaped; }
}

/** A fixed, provider-free mini probe of the same owned launcher used by the artifact smoke. */
export async function probeSmokeLauncher(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const args = ["value with spaces", "--literal-option", "*"];
  const output = await ownedCommand(process.execPath, [process.execPath, "--smol", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args], cwd, env, "", 5000);
  const observed: unknown = JSON.parse(output);
  requireSmoke(JSON.stringify(observed) === JSON.stringify(args), "owned launcher did not forward the fixed argument vector");
  return observed as string[];
}
export interface InstalledSmokeReport { package: string; version: string; setup: "dry-run"; mcp: "seeded search"; hook: "native metric observed"; timing: "not measured; existing R2 gates remain separate" }
export async function runInstalledPackageSmoke(): Promise<InstalledSmokeReport> {
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
    const cli = (args: string[], input?: string) => { assertSmokeCliArgs(args); assertInstalledEntry(realPath(entry), realPath(installed), checkout, env.TMPDIR!); assertInstalledAlias(executable!, realPath(executable!), entry, appBin); return ownedCommand(bun, [executable!, ...args], projectDir, installedEnv, input); };
    const ruleFiles = [join(home, "AGENTS.md"), join(home, "CLAUDE.md"), join(projectDir, "AGENTS.md"), join(projectDir, "CLAUDE.md"), join(env.CLAUDE_CONFIG_DIR!, "rules", "keep.md"), join(env.CODEX_HOME!, "rules", "keep.rules")];
    for (const file of ruleFiles) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, "installed smoke instruction/rule sentinel, keep exact bytes\n", { mode: 0o600 }); }
    const rules = ruleFiles.map(file => ({ file, bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 }));
    const verifyRules = () => { for (const rule of rules) requireSmoke(readFileSync(rule.file).equals(rule.bytes) && (lstatSync(rule.file).mode & 0o777) === rule.mode, "setup or runtime changed an instruction/rule sentinel"); };
    requireSmoke((await cli(["--version"])).trim() === `amem ${metadata.version}`, "installed CLI version output differs"); await cli(["--help"]);
    const plan = JSON.parse(await cli(["setup", "all"])); const plannedFiles = assertSetupPreview(plan, home);
    requireSmoke(plannedFiles.every(file => !existsSync(file)) && !existsSync(nativeCalls), "setup dry run wrote configuration or invoked a native client"); verifyRules();
    const seedFile = join(app, "seed-installed.ts");
    writeFileSync(seedFile, `import {MemoryStore,memoryProjectKey,realPath} from '@staix/agent-mem';import {fileURLToPath} from 'node:url';const resolved=realPath(fileURLToPath(import.meta.resolve('@staix/agent-mem')));const project=memoryProjectKey(process.cwd());const store=new MemoryStore({memoryDir:process.env.AMEM_HOME,deferPromotions:true});try{const id=store.note({op:'note',project,scope:'project',tier:'long',kind:'contract',peer:'person',source:'person',text:${JSON.stringify(MARKER)},about:[]});console.log(JSON.stringify({id,project,resolved}));}finally{store.close();}\n`);
    const seed = object(JSON.parse(await ownedCommand(bun, [bun, "--smol", seedFile], projectDir, installedEnv))); assertInstalledModule(seed.resolved, installed, checkout); requireSmoke(/^[a-f0-9]{32}$/.test(seed.id) && typeof seed.project === "string", "installed API seed failed");
    const frame = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const mcpInput = frame(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "installed-smoke", version: "1" } }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + frame(2, "tools/call", { name: "amem_search", arguments: { query: MARKER, includeCapture: false, limit: 5 } });
    assertMcpResult(await cli(["mcp"], mcpInput), metadata.version, seed.id, seed.project);
    const metrics = join(env.AMEM_HOME!, "metrics.jsonl"); requireSmoke(!existsSync(metrics) || !readFileSync(metrics, "utf8").includes('"kind":"hook"'), "hook evidence unexpectedly predates native execution");
    writeFileSync(join(projectDir, "public.txt"), "public installed hook fixture\n");
    const hookOutput = await cli(["hook", "PostToolUse"], JSON.stringify({ session_id: "installed-smoke", hook_event_name: "PostToolUse", cwd: projectDir, tool_name: "Read", tool_input: { file_path: "public.txt" }, tool_response: "public installed hook result" }));
    assertPostToolUseOutput(hookOutput); verifyRules();
    requireSmoke(existsSync(metrics), "installed native hook did not load its metric path"); assertHookMetric(readFileSync(metrics, "utf8"));
    requireSmoke(!existsSync(nativeCalls), "installed smoke unexpectedly invoked a native coding client");
    return { package: PACKAGE, version: metadata.version, setup: "dry-run", mcp: "seeded search", hook: "native metric observed", timing: "not measured; existing R2 gates remain separate" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await runInstalledPackageSmoke(), null, 2)); }
  catch (error) { console.error(`installed package smoke: ${(error as Error).message}`); process.exitCode = 1; }
}
