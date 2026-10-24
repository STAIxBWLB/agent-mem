import { SETUP_TARGETS } from "../src/setup.ts";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSON_ONLY, runCli, type CliContext } from "../src/cli.ts";
import { COMMANDS, parseCommand } from "../src/commands-table.ts";
import { realPath } from "../src/memory/platform.ts";
const cleanup: Array<() => void> = [], targets = ["claude", "codex", "kimi", "pi", "all"] as const;
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
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); mkdirSync(home); mkdirSync(cwd); mkdirSync(bin);
  const rules = [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md"), join(home, ".claude", "rules", "user.md"), join(home, ".codex", "rules", "user.rules")];
  for (const rule of rules) put(rule, "original rule bytes\n", 0o640);
  const env: Record<string, string | undefined> = { HOME: home, AMEM_HOME: join(home, "memory"), AGENTHUB_HOME: join(home, "hub"), CODEX_HOME: join(home, ".codex"), KIMI_CODE_HOME: join(home, ".kimi-code"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), XDG_CONFIG_HOME: join(home, ".config"), PATH: `${bin}:/usr/bin:/bin` };
  const fake = join(root, "fake-native.ts"), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  put(fake, `import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {join,dirname} from 'node:path';const argv=process.argv.slice(2);appendFileSync(${JSON.stringify(record)},JSON.stringify({argv,home:process.env.HOME,cwd:process.cwd(),claude:process.env.CLAUDE_CONFIG_DIR})+'\\n');if(argv[0]!=='claude')process.exit(77);const file=process.env.CLAUDE_CONFIG_DIR?join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'):join(process.env.HOME,'.claude.json');const document=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};document.mcpServers??={};if(argv[2]==='remove')delete document.mcpServers.amem;else{const marker=argv.indexOf('--'),launch=argv.slice(marker+1);document.mcpServers.amem={command:launch[0],args:launch.slice(1)};}mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(document,null,2)+'\\n');`);
  for (const target of ["claude", "codex", "pi"]) put(join(bin, target), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} ${quote(target)} "$@"\n`, 0o700);
  const context: CliContext = { cwd, env, stdinTTY: false, setupConfirm: async () => { throw Error("unexpected confirmation"); } };
  const calls = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; home: string; cwd: string; claude?: string }) : [];
  return { root, home, cwd, env, rules, context, calls };
}
test("setup command table, parser and actual help expose the same targets and apply/undo options", async () => {
  const f = fixture(), before = snapshot(f.root), help = await runCli(["--help"], f.context);
  expect(help).toContain("setup <target>"); expect(help).toContain("[--apply]"); expect(help).toContain("[--undo]");
  expect(COMMANDS.setup?.args?.[0]?.values).toEqual([...targets]); expect(Object.keys(COMMANDS.setup?.options ?? {}).sort()).toEqual(["--apply", "--undo"]);
  for (const target of targets) expect(parseCommand(["setup", target])).toMatchObject({ path: ["setup"], positionals: [target] });
  expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});
test("default setup CLI previews every target with no commands, home writes or changed rules", async () => {
  const f = fixture(), before = snapshot(f.root);
  for (const target of targets) {
    const plan = JSON.parse(await runCli(["setup", target], f.context));
    expect(plan.mode).toBe("preview"); expect(plan.targets).toEqual(target === "all" ? targets.slice(0, 4) : [target]);
    expect(plan.actions.every((action: { files: string[] }) => action.files.length === 2)).toBe(true);
  }
  expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before); expect(existsSync(f.env.AMEM_HOME!)).toBe(false);
});
for (const marker of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) test(`setup apply/undo refuse defined ${marker}, including empty, before confirmation/effects`, async () => {
  const f = fixture(), before = snapshot(f.root); let confirmations = 0;
  for (const value of ["", "fixture"]) for (const target of targets) for (const flag of ["--apply", "--undo"]) {
    await expect(runCli(["setup", target, flag], { ...f.context, env: { ...f.env, [marker]: value }, stdinTTY: true, setupConfirm: async () => { confirmations++; return true; } })).rejects.toThrow(PERSON_ONLY);
  }
  expect(confirmations).toBe(0); expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});
test("setup apply and undo require stdin TTY before confirmation or writes", async () => {
  const f = fixture(), before = snapshot(f.root); let confirmations = 0;
  for (const target of targets) for (const flag of ["--apply", "--undo"]) await expect(runCli(["setup", target, flag], { ...f.context, setupConfirm: async () => { confirmations++; return true; } })).rejects.toThrow("terminal on stdin");
  expect(confirmations).toBe(0); expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});
test("setup CLI refuses invalid targets, unknown flags and conflicting modes before confirmation/effects", async () => {
  const f = fixture(), before = snapshot(f.root); let confirmations = 0;
  for (const args of [["setup"], ["setup", "unknown", "--apply"], ["setup", "ALL"], ["setup", "claude", "extra"], ["setup", "claude", "--unknown"], ["setup", "all", "--apply", "--undo"], ["setup", "claude", "--apply=true"]]) {
    await expect(runCli(args, { ...f.context, stdinTTY: true, setupConfirm: async () => { confirmations++; return true; } })).rejects.toThrow();
  }
  expect(confirmations).toBe(0); expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});
test("cancelled setup CLI confirmations keep both apply and undo dry", async () => {
  const f = fixture(), before = snapshot(f.root); let confirmations = 0;
  for (const [flag, mode] of [["--apply", "apply"], ["--undo", "undo"]] as const) {
    const output = await runCli(["setup", "all", flag], { ...f.context, stdinTTY: true, setupConfirm: async plan => { confirmations++; expect(plan.targets).toEqual([...SETUP_TARGETS]); expect(plan.mode).toBe(mode); expect(plan.actions).toHaveLength(4); return false; } });
    expect(JSON.parse(output)).toEqual({ cancelled: true });
  }
  expect(confirmations).toBe(2); expect(f.calls()).toEqual([]); expect(snapshot(f.root)).toEqual(before);
});
test("confirmed actual CLI apply uses only fake native registration in staging and undo restores the original", async () => {
  const f = fixture(), config = join(f.home, ".claude.json"), original = '{ "other": true, "mcpServers": { "other": { "command": "keep" } } }\n'; put(config, original, 0o640);
  const rules = f.rules.map(file => readFileSync(file)), context = { ...f.context, stdinTTY: true, setupConfirm: async () => true };
  expect(JSON.parse(await runCli(["setup", "claude", "--apply"], context))).toEqual({ applied: ["claude"], unchanged: [] });
  const calls = f.calls(); expect(calls).toHaveLength(1); expect(calls[0]?.argv.slice(0, 8)).toEqual(["claude", "mcp", "add", "--scope", "user", "--transport", "stdio", "amem"]); expect(calls[0]?.home).not.toBe(f.home); expect(calls[0]?.cwd).toBe(calls[0]?.home); expect(existsSync(calls[0]!.home)).toBe(false);
  const document = JSON.parse(readFileSync(config, "utf8")); expect(document.mcpServers.other).toEqual({ command: "keep" });
  expect(document.mcpServers.amem).toEqual({ command: process.execPath, args: ["--smol", fileURLToPath(new URL("../bin/amem.js", import.meta.url)), "mcp"] });
  const receipt = readFileSync(join(f.home, "memory", "setup", "claude.json"));
  expect(JSON.parse(await runCli(["setup", "claude", "--apply"], context))).toEqual({ applied: [], unchanged: ["claude"] }); expect(f.calls()).toHaveLength(1); expect(readFileSync(join(f.home, "memory", "setup", "claude.json"))).toEqual(receipt);
  expect(JSON.parse(await runCli(["setup", "claude", "--undo"], context))).toEqual({ restored: ["claude"] }); expect(readFileSync(config, "utf8")).toBe(original); expect(lstatSync(config).mode & 0o777).toBe(0o640); expect(existsSync(join(f.home, ".claude", "settings.json"))).toBe(false); expect(f.rules.map(file => readFileSync(file))).toEqual(rules); expect(f.calls()).toHaveLength(1);
});
