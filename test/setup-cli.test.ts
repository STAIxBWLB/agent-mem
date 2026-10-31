import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliContext } from "../src/cli.ts";
import { COMMANDS, parseCommand } from "../src/commands-table.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [], targets = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "opencode", "agy", "all"] as const;
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function put(file: string, value: string, mode = 0o600) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); chmodSync(file, mode); }
function snapshot(root: string): Array<{ file: string; mode: number; bytes?: string }> {
  const rows: Array<{ file: string; mode: number; bytes?: string }> = [];
  const scan = (directory: string) => { for (const name of readdirSync(directory).sort()) { const file = join(directory, name), stat = lstatSync(file), row = { file: relative(root, file), mode: stat.mode & 0o777 };
    if (stat.isDirectory()) { rows.push(row); scan(file); } else rows.push({ ...row, bytes: readFileSync(file).toString("base64") });
  } }; scan(root); return rows;
}
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-setup-cli-"))), home = join(root, "home"), cwd = join(root, "project"), bin = join(root, "bin"), record = join(root, "native-calls");
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); mkdirSync(home); mkdirSync(cwd); expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "bun"));
  const rules = [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md"), join(home, ".claude", "rules", "user.md"), join(home, ".codex", "rules", "user.rules")];
  for (const rule of rules) put(rule, "original rule bytes\n", 0o640);
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), AGENTHUB_HOME: join(home, "hub"), CODEX_HOME: join(home, ".codex"), KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), XDG_CONFIG_HOME: join(home, ".config"), PATH: `${bin}:/usr/bin:/bin` };
  const fake = join(root, "fake-native.ts"), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  put(fake, `import {appendFileSync,existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {basename,dirname,join,resolve} from 'node:path';const argv=process.argv.slice(2);if(argv.includes('--version')){const stage=dirname(process.env.TMPDIR||''),root=${JSON.stringify(realPath(tmpdir()))},expected={HOME:stage,AMEM_HOME:join(stage,'memory'),AGENTHUB_HOME:join(stage,'hub'),CODEX_HOME:join(stage,'.codex'),KIMI_CODE_HOME:join(stage,'.kimi-code'),PI_CODING_AGENT_DIR:join(stage,'.pi','agent'),QWEN_HOME:join(stage,'.qwen'),QWEN_RUNTIME_DIR:join(stage,'qwen-runtime'),QWEN_CODE_SYSTEM_SETTINGS_PATH:join(stage,'qwen-system-settings.json'),QWEN_CODE_SYSTEM_DEFAULTS_PATH:join(stage,'qwen-system-defaults.json'),JCODE_HOME:join(stage,'.jcode'),XDG_CONFIG_HOME:join(stage,'.config'),XDG_DATA_HOME:join(stage,'.local','share'),XDG_CACHE_HOME:join(stage,'.cache'),XDG_STATE_HOME:join(stage,'.local','state'),TMPDIR:join(stage,'tmp'),TMP:join(stage,'tmp'),TEMP:join(stage,'tmp')};const claude=process.env.CLAUDE_CONFIG_DIR;if(claude!==undefined)expected.CLAUDE_CONFIG_DIR=join(stage,'.claude');const stat=lstatSync(stage);if(!basename(stage).startsWith('amem-setup-')||dirname(resolve(stage))!==root||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.cwd()!==stage||Object.entries(expected).some(([key,value])=>process.env[key]!==value))process.exit(78);console.log(argv[0]+' 0.0.0-fixture');process.exit(0);}if(argv.includes('--help')){console.log('  mcp Manage MCP servers');process.exit(0);}appendFileSync(${JSON.stringify(record)},JSON.stringify({argv,home:process.env.HOME,cwd:process.cwd(),claude:process.env.CLAUDE_CONFIG_DIR})+'\\n');if(argv[0]!=='claude')process.exit(77);const file=process.env.CLAUDE_CONFIG_DIR?join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'):join(process.env.HOME,'.claude.json');const document=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};document.mcpServers??={};if(argv[2]==='remove')delete document.mcpServers.amem;else{const marker=argv.indexOf('--'),launch=argv.slice(marker+1);document.mcpServers.amem={command:launch[0],args:launch.slice(1)};}mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(document,null,2)+'\\n');`);
  for (const target of ["claude", "codex", "pi"]) put(join(bin, target), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} ${quote(target)} "$@"\n`, 0o700);
  const context: CliContext = { cwd, env, stdinTTY: false, setupConfirm: async () => { throw Error("unexpected confirmation"); } };
  const calls = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; home: string; cwd: string; claude?: string }) : [];
  return { root, home, cwd, env, rules, context, calls };
}
test("setup command table, parser and actual help expose the same targets and apply/undo options", async () => {
  const f = fixture(), before = snapshot(f.root), help = await runCli(["--help"], f.context);
  expect(help).toContain("setup <target>"); expect(help).toContain("[--apply]"); expect(help).toContain("[--undo]");
  expect(COMMANDS.setup?.args?.[0]?.values).toEqual([...targets]); expect(Object.keys(COMMANDS.setup?.options ?? {}).sort()).toEqual(["--apply", "--json", "--undo"]);
  for (const target of targets) expect(parseCommand(["setup", target])).toMatchObject({ path: ["setup"], positionals: [target] });
  expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});

test("Jcode setup-only support does not expose ingest or create capture state", async () => {
  const f = fixture(), before = snapshot(f.root);
  await expect(runCli(["ingest", "jcode"], { ...f.context, env: { ...f.env, AGENTHUB_PEER_ID: "jcode" } })).rejects.toThrow("kind takes codex or kimi or pi or qwen");
  expect(snapshot(f.root)).toEqual(before); expect(f.calls()).toEqual([]);
});
test("default setup CLI previews every target with no commands, home writes or changed rules", async () => {
  const f = fixture(), before = snapshot(f.root);
  for (const target of targets) {
    const plan = JSON.parse(await runCli(["setup", target, "--json"], f.context));
    expect(plan.mode).toBe("preview"); expect(plan.targets).toEqual(target === "all" ? targets.filter(value => value !== "all" && value !== "agy") : [target]);
    for (const action of plan.actions) if (["claude", "codex", "pi"].includes(action.target)) expect(action.version.output).toBe(`${action.target} 0.0.0-fixture`);
    expect(plan.actions.every((action: { target: string; files: string[] }) => action.files.length === (["qwen", "jcode", "opencode", "agy"].includes(action.target) ? 1 : 2))).toBe(true);
  }
  expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before); expect(existsSync(f.env.AMEM_HOME!)).toBe(false);
});
for (const marker of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) test(`setup explicit modes work with ${marker} set and leave no setup state after undo`, async () => {
  const f = fixture(), original = '{ "other": true, "mcpServers": { "other": { "command": "keep" } } }\n'; put(join(f.home, ".claude.json"), original); const before = snapshot(f.root);
  for (const value of ["", "fixture"]) {
    const context = { ...f.context, env: { ...f.env, [marker]: value } };
    expect(JSON.parse(await runCli(["setup", "claude", "--apply", "--json"], context))).toEqual({ applied: ["claude"], unchanged: [] });
    expect(JSON.parse(await runCli(["setup", "claude", "--undo", "--json"], context))).toEqual({ restored: ["claude"] });
  }
  expect(f.calls()).toHaveLength(2); expect(f.calls().every(call => call.argv[0] === "claude")).toBe(true);
  expect(snapshot(f.root).filter(row => !["home/memory", "home/memory/setup", "native-calls"].includes(row.file))).toEqual(before);
});
test("setup apply and undo flags need no stdin TTY or confirmation callback", async () => {
  const f = fixture(), config = join(f.home, ".claude.json"), original = '{ "other": true, "mcpServers": { "other": { "command": "keep" } } }\n'; put(config, original);
  expect(JSON.parse(await runCli(["setup", "claude", "--apply", "--json"], f.context))).toEqual({ applied: ["claude"], unchanged: [] });
  expect(JSON.parse(await runCli(["setup", "claude", "--undo", "--json"], f.context))).toEqual({ restored: ["claude"] });
  expect(f.calls()).toHaveLength(1); expect(readFileSync(config, "utf8")).toBe(original);
});
test("setup CLI refuses invalid targets, unknown flags and conflicting modes before effects", async () => {
  const f = fixture(), before = snapshot(f.root);
  for (const args of [["setup"], ["setup", "unknown", "--apply"], ["setup", "ALL"], ["setup", "claude", "extra"], ["setup", "claude", "--unknown"], ["setup", "all", "--apply", "--undo"], ["setup", "claude", "--apply=true"]]) {
    await expect(runCli(args, f.context)).rejects.toThrow();
  }
  expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});
test("setup CLI apply and undo flags do not invoke the legacy confirmation callback", async () => {
  const f = fixture(), original = '{ "other": true, "mcpServers": { "other": { "command": "keep" } } }\n'; put(join(f.home, ".claude.json"), original); let confirmations = 0;
  for (const [flag, mode] of [["--apply", "apply"], ["--undo", "undo"]] as const) {
    const output = await runCli(["setup", "claude", flag, "--json"], { ...f.context, setupConfirm: async () => { confirmations++; throw Error("legacy confirmation callback must not run"); } });
    expect(JSON.parse(output)).toEqual(mode === "apply" ? { applied: ["claude"], unchanged: [] } : { restored: ["claude"] });
  }
  expect(confirmations).toBe(0); expect(f.calls()).toHaveLength(1); expect(readFileSync(join(f.home, ".claude.json"), "utf8")).toBe(original);
});
test("explicit CLI apply uses only fake native registration in staging and undo restores the original", async () => {
  const f = fixture(), config = join(f.home, ".claude.json"), original = '{ "other": true, "mcpServers": { "other": { "command": "keep" } } }\n'; put(config, original, 0o640);
  const rules = f.rules.map(file => readFileSync(file)), context = f.context;
  expect(JSON.parse(await runCli(["setup", "claude", "--apply", "--json"], context))).toEqual({ applied: ["claude"], unchanged: [] });
  const calls = f.calls(); expect(calls).toHaveLength(1); expect(calls[0]?.argv.slice(0, 8)).toEqual(["claude", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem"]); expect(calls[0]?.home).not.toBe(f.home); expect(calls[0]?.cwd).toBe(calls[0]?.home); expect(existsSync(calls[0]!.home)).toBe(false);
  const document = JSON.parse(readFileSync(config, "utf8")); expect(document.mcpServers.other).toEqual({ command: "keep" });
  expect(document.mcpServers.amem).toEqual({ command: Bun.which("bun", { PATH: f.env.PATH }), args: ["--smol", fileURLToPath(new URL("../bin/amem.js", import.meta.url)), "mcp"] });
  const receipt = readFileSync(join(f.home, "memory", "setup", "claude.json"));
  expect(JSON.parse(await runCli(["setup", "claude", "--apply", "--json"], context))).toEqual({ applied: [], unchanged: ["claude"] }); expect(f.calls()).toHaveLength(1); expect(readFileSync(join(f.home, "memory", "setup", "claude.json"))).toEqual(receipt);
  expect(JSON.parse(await runCli(["setup", "claude", "--undo", "--json"], context))).toEqual({ restored: ["claude"] }); expect(readFileSync(config, "utf8")).toBe(original); expect(lstatSync(config).mode & 0o777).toBe(0o640); expect(existsSync(join(f.home, ".claude", "settings.json"))).toBe(false); expect(f.rules.map(file => readFileSync(file))).toEqual(rules); expect(f.calls()).toHaveLength(1);
});

test("a native CLI without MCP administration is refused before free-form prompt execution", async () => {
  const f = fixture(), called = join(f.root, "unsupported-registration-called"), binary = join(f.root, "bin", "claude");
  put(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'claude 0.0.0-fixture'; exit 0; fi\nif [ "$1" = "--help" ]; then printf 'Usage: chat assistant'; exit 0; fi\nprintf called > '${called}'\n`, 0o700);
  await expect(runCli(["setup", "claude", "--apply"], f.context)).rejects.toThrow("does not expose MCP registration");
  expect(existsSync(called)).toBe(false); expect(f.calls()).toEqual([]);
});
test("all setup skips and reports absent CLIs while configuring the available client", async () => {
  const f = fixture(); rmSync(join(f.root, "bin", "codex")); rmSync(join(f.root, "bin", "pi"));
  const result = JSON.parse(await runCli(["setup", "all", "--apply", "--json"], f.context));
  expect(result.applied).toEqual(["claude"]); expect(result.skipped.map((item: { target: string }) => item.target)).toEqual(["codex", "kimi", "pi", "qwen", "jcode", "opencode"]);
  expect(existsSync(join(f.home, ".codex", "config.toml"))).toBe(false); expect(existsSync(join(f.home, ".kimi-code", "mcp.json"))).toBe(false); expect(existsSync(join(f.home, ".pi", "agent", "mcp.json"))).toBe(false);
  expect(f.calls()).toHaveLength(1);
});
