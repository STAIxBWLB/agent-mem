import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionDefinitions, commandHelp, parseCommand } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";
import { GOAL_STATES, KINDS } from "../src/memory/store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "amem-completion-")); dirs.push(dir); return dir; };
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const shells = ["zsh", "bash", "fish"] as const;
const executable = (shell: typeof shells[number]) => Bun.which(shell) ?? ([`/bin/${shell}`, `/opt/homebrew/bin/${shell}`].find(existsSync));

function candidateRun(shell: typeof shells[number], script: string, args: string[], cwd: string): string[] {
  const bin = executable(shell)!;
  const file = join(cwd, `completion.${shell}`); writeFileSync(file, script);
  const call = `_amem_candidates ${args.map(quote).join(" ")}`;
  const code = `${shell === "zsh" ? "compdef() { :; }; " : ""}source ${quote(file)}; ${call}`;
  const child = Bun.spawnSync([bin, "-c", code], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe(""); expect(child.exitCode).toBe(0);
  return child.stdout.toString().split("\n").filter(Boolean);
}

for (const shell of shells) {
  test.skipIf(!executable(shell))(`${shell} generated completion parses (skip reason if absent: shell unavailable)`, () => {
    const dir = temp(), file = join(dir, `completion.${shell}`); writeFileSync(file, completionScript(shell));
    const result = Bun.spawnSync([executable(shell)!, "-n", file], { stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
  });
  test.skipIf(!executable(shell))(`${shell} native candidates cover commands, enums and paths with spaces (skip reason if absent: shell unavailable)`, () => {
    const dir = temp(), script = completionScript(shell);
    const top = candidateRun(shell, script, [""], dir);
    for (const command of ["list", "goal", "completion", "--help", "--json", "--version"]) expect(top).toContain(command);
    const goals = candidateRun(shell, script, ["goal", ""], dir);
    for (const command of ["list", "show", "new", "state", "take", "--all", "--json"]) expect(goals).toContain(command);
    expect(candidateRun(shell, script, ["--tier", ""], dir)).toEqual(expect.arrayContaining(["short", "long"]));
    expect(candidateRun(shell, script, ["list", "--tier="], dir)).toEqual(expect.arrayContaining(["--tier=short", "--tier=long"]));
    const tiers = candidateRun(shell, script, ["list", "--tier", ""], dir);
    expect(tiers).toContain("short"); expect(tiers).toContain("long");
    const kinds = candidateRun(shell, script, ["list", "--kind", ""], dir);
    for (const kind of KINDS) expect(kinds).toContain(kind);
    const states = candidateRun(shell, script, ["goal", "state", "fixture-id", ""], dir);
    for (const state of GOAL_STATES) expect(states).toContain(state);
    expect(candidateRun(shell, script, ["completion", ""], dir)).toEqual(expect.arrayContaining([...shells]));
    const nested = join(dir, "directory with spaces"); mkdirSync(nested);
    const path = join(nested, "fixture file.db"); writeFileSync(path, "synthetic");
    expect(candidateRun(shell, script, ["import", "claude-mem", "--db", join(nested, "fi")], dir)).toContain(path);
    expect(candidateRun(shell, script, ["list", "--", ""], dir)).toEqual([]);
  });
}

test.skipIf(!executable("zsh"))("zsh first autoload invocation invokes the registered completion hook (skip reason if absent: shell unavailable)", () => {
  const dir = temp(); writeFileSync(join(dir, "_amem"), completionScript("zsh"));
  // Match the README fpath/autoload installation without a real terminal or compinit cache.
  const script = `fpath=(${quote(dir)} $fpath); autoload -Uz _amem; compdef() { :; }; compadd() { printf '%s\\n' "$@"; }; words=(amem ''); CURRENT=2; _amem`;
  const result = Bun.spawnSync([executable("zsh")!, "-fc", script], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
  const candidates = result.stdout.toString().split("\n");
  for (const command of ["list", "goal", "completion"]) expect(candidates).toContain(command);
});

test("default command options and equals values share parser validation with completion", () => {
  expect(parseCommand(["goal", "--all", "--json"]).path).toEqual(["goal", "list"]);
  expect(parseCommand(["goal", "--all", "--json"]).options).toMatchObject({ "--all": true, "--json": true });
  const explicit = parseCommand(["list", "--tier=short", "--kind=contract"]);
  expect(explicit.options).toMatchObject({ "--tier": "short", "--kind": "contract" });
  expect(explicit.rawArgs).toEqual(["list", "--tier", "short", "--kind", "contract"]);
  expect(parseCommand(["--tier=long", "--json"]).path).toEqual(["list"]);
  expect(parseCommand(["--tier=long", "--json"]).options).toMatchObject({ "--tier": "long", "--json": true });
  expect(() => parseCommand(["list", "--tier=invalid"])).toThrow();
  expect(() => parseCommand(["list", "--json=true"])).toThrow();
});

test("completion metadata and CLI parser cover the retained raw command cases and flags", () => {
  const definitions = completionDefinitions(), help = commandHelp();
  const raw = readFileSync(join(import.meta.dir, "../src/memory/commands.ts"), "utf8");
  const split = raw.indexOf("export async function rawGoalCommand");
  expect(split).toBeGreaterThan(0);
  for (const [source, prefix] of [[raw.slice(0, split), []], [raw.slice(split), ["goal"]]] as const) {
    const cases = [...source.matchAll(/case "([a-z][a-z-]*)"\s*:/g)].map(match => match[1]!);
    for (const command of cases) {
      const path = [...prefix, command];
      expect(definitions.some(definition => definition.path.join(" ") === path.join(" "))).toBe(true);
      expect(help).toContain(command);
    }
  }
  // Per-case options must agree too: an option on another command cannot hide drift.
  for (const [source, prefix] of [[raw.slice(0, split), []], [raw.slice(split), ["goal"]]] as const) {
    const cases = [...source.matchAll(/case "([a-z][a-z-]*)"\s*:/g)];
    const pending: string[] = [];
    for (let index = 0; index < cases.length; index++) {
      const match = cases[index]!; pending.push(match[1]!);
      const body = source.slice(match.index! + match[0].length, cases[index + 1]?.index ?? source.length);
      if (!body.trim()) continue;
      const flags = new Set([...body.matchAll(/"(--[a-z][a-z-]*)"/g)].map(item => item[1]!));
      for (const name of pending.splice(0)) {
        const row = definitions.find(item => item.path.join(" ") === [...prefix, name].join(" "))!;
        for (const flag of flags) expect(Object.keys(row.options)).toContain(flag);
        // #15 T5: `search --all-projects` and `--include-archived` are the person's cross-project read, handled by src/cli.ts before the raw command (like --policy-free);
        // the raw command, which hosts share, refuses them (test/cli-projects.test.ts). The exemption is these two flags on `search` only.
        for (const flag of Object.keys(row.options)) expect(flags.has(flag) || ["--help", "--json", "--policy-free"].includes(flag) || name === "search" && ["--all-projects", "--include-archived"].includes(flag)).toBe(true);
      }
    }
  }
  const rawFlags = new Set([...raw.matchAll(/"(--[a-z][a-z-]*)"/g)].map(match => match[1]!));
  const tableFlags = new Set(definitions.flatMap(definition => Object.keys(definition.options)));
  for (const flag of rawFlags) { expect(tableFlags.has(flag)).toBe(true); expect(help).toContain(flag); }
  for (const tier of ["short", "long"]) expect(parseCommand(["list", "--tier", tier]).options["--tier"]).toBe(tier);
  for (const kind of KINDS) expect(parseCommand(["list", "--kind", kind]).options["--kind"]).toBe(kind);
  for (const state of GOAL_STATES) expect(parseCommand(["goal", "state", "fixture-id", state]).positionals).toContain(state);
  expect(() => parseCommand(["list", "--tier", "invalid"])).toThrow();
  expect(() => parseCommand(["list", "--unknown"])).toThrow();
});

test("completion generation and native candidate execution never open memory or invoke network programs", () => {
  const dir = temp(), home = join(dir, "must-not-open"), marker = join(dir, "network-called"), fakebin = join(dir, "bin"); mkdirSync(fakebin);
  for (const name of ["amem", "gh", "git", "curl", "wget", "ssh"]) {
    const path = join(fakebin, name); writeFileSync(path, `#!/bin/sh\nprintf called >> ${quote(marker)}\nexit 91\n`, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, AMEM_HOME: home, AGENTHUB_HOME: join(dir, "hub-must-not-open"), PATH: `${fakebin}:${process.env.PATH ?? ""}` };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
  for (const shell of shells) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/amem.js"), "completion", shell], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    expect(child.stderr.toString()).toBe(""); expect(child.exitCode).toBe(0);
    const script = child.stdout.toString(); expect(script.trimEnd()).toBe(completionScript(shell).trimEnd());
    if (executable(shell)) {
      const file = join(dir, `isolated.${shell}`); writeFileSync(file, script);
      const run = Bun.spawnSync([executable(shell)!, "-c", `${shell === "zsh" ? "compdef() { :; }; " : ""}source ${quote(file)}; _amem_candidates list --tier ''`], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      expect(run.stderr.toString()).toBe(""); expect(run.exitCode).toBe(0); expect(run.stdout.toString()).toContain("short");
    }
  }
  expect(existsSync(home)).toBe(false); expect(existsSync(env.AGENTHUB_HOME!)).toBe(false); expect(existsSync(marker)).toBe(false);
});
