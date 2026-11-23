import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMMANDS, commandHelp, completionDefinitions, GLOBAL_OPTIONS, isAmemCommand, parseCommand, type CommandDefinition } from "../src/commands-table.ts";
import { planSetup } from "../src/setup.ts";

// #590 H1-H6 as one lint over COMMANDS, so a new command cannot drift from the help contract.
const entries = (): [string, CommandDefinition][] => {
  const out: [string, CommandDefinition][] = [];
  const walk = (commands: Record<string, CommandDefinition>, path: string[]) => {
    for (const [name, command] of Object.entries(commands)) { out.push([[...path, name].join(" "), command]); if (command.commands) walk(command.commands, [...path, name]); }
  };
  walk(COMMANDS, []); return out;
};

test("every summary is one imperative phrase of at most 60 characters with no design reference (H1)", () => {
  for (const [path, command] of entries()) {
    expect(command.description.length, path).toBeLessThanOrEqual(60);
    expect(command.description, path).toMatch(/^[A-Z][a-z-]+,? /);
    expect(command.description, path).not.toMatch(/#\d|\b[FRDTP]\d+\b|\(R\d|\bAC\d/);
    expect(command.description, path).not.toMatch(/\.$/);
    for (const [name, option] of Object.entries(command.options ?? {})) {
      expect(option.description.length, `${path} ${name}`).toBeLessThanOrEqual(60);
      expect(`${option.description} ${option.details ?? ""}`, `${path} ${name}`).not.toMatch(/#\d|\b[FRDTP]\d+\b|\(R\d|\bAC\d/);
    }
    expect(command.details ?? "", path).not.toMatch(/#\d|\b[FRDTP]\d+\b|\(R\d|\bAC\d/);
  }
});

test("every top-level command has an overview group and the overview lists them all untruncated (H2)", () => {
  const overview = commandHelp();
  for (const [name, command] of Object.entries(COMMANDS)) {
    expect(command.group, name).toBeDefined();
    expect(overview, name).toContain(`  ${name}  `.trimEnd());
    expect(overview).toContain(command.description);
  }
  expect(overview).not.toContain("...");
});

test("every help page fits 80 columns, opens with Usage and lists global flags once (H3, H4)", () => {
  for (const row of completionDefinitions().filter(row => row.path[0] !== "help")) {
    const page = commandHelp(row.path);
    for (const line of page.split("\n")) expect(Bun.stringWidth(line), `${row.path.join(" ")}: ${line}`).toBeLessThanOrEqual(80);
    expect(page.startsWith(`▸ Usage\n  amem ${row.path.join(" ")}`), row.path.join(" ")).toBe(true);
    expect(page.match(/Global: /g)?.length ?? 0, row.path.join(" ")).toBe(1);
    expect(page, row.path.join(" ")).not.toMatch(/\n {2}--help /);
  }
});

test("a command accepts only its own and global flags, never a parent's (H5)", () => {
  const rows = new Map(completionDefinitions().map(row => [row.path.join(" "), row]));
  for (const [path, command] of entries()) {
    const row = rows.get(path)!;
    const child = command.defaultCommand ? command.commands?.[command.defaultCommand]?.options : {};
    for (const name of Object.keys(row.options)) expect(Object.hasOwn(GLOBAL_OPTIONS, name) || Object.hasOwn(command.options ?? {}, name) || Object.hasOwn(child ?? {}, name), `${path} ${name}`).toBe(true);
  }
  // The flags this change refuses, as listed in CHANGELOG Unreleased.
  for (const argv of [["eval", "audit", "score", "s.tsv", "--k", "1"], ["eval", "audit", "sample", "--seed", "s", "--set", "ko"], ["repo", "attributes", "--json"],
    ["import", "codex", "--db", "x"], ["import", "claude-auto", "--limit", "1"], ["goal", "new", "--json", "t"], ["goal", "link", "--json", "a", "b"],
    ["goal", "state", "--json", "a", "open"], ["goal", "take", "--json", "a"], ["review", "walk", "--json"]]) expect(() => parseCommand(argv), argv.join(" ")).toThrow();
  const changelog = readFileSync(join(import.meta.dir, "../CHANGELOG.md"), "utf8");
  const unreleased = changelog.slice(changelog.indexOf("## Unreleased"), changelog.indexOf("\n## ", changelog.indexOf("## Unreleased") + 1));
  for (const named of ["eval audit", "repo attributes", "import codex", "import claude-auto", "goal new", "goal link", "goal state", "goal take", "review walk"]) expect(unreleased, named).toContain(`\`amem ${named}`);
});

test("every example, and every command amem emits, resolves to a real command (H6, AC9)", () => {
  for (const [path, command] of entries()) for (const example of command.examples ?? []) {
    expect(isAmemCommand(example), `${path}: ${example}`).toBe(true);
    expect(example.startsWith(`amem ${path}`), `${path}: ${example}`).toBe(true);
  }
  // Every runnable command that takes a flag or writes shows how to run it.
  for (const [path, command] of entries()) if (!command.commands && (command.mutates || command.options)) expect(command.examples?.length ?? 0, path).toBeGreaterThan(0);
  const emitted = ["amem hook jcode", "amem mcp", "amem ingest pi", ...["codex", "kimi", "qwen"].map(cli => `amem ingest ${cli} --json`),
    ...["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"].map(event => `amem hook ${event}`)];
  for (const line of emitted) expect(isAmemCommand(line), line).toBe(true);
  // Setup's own planned hook commands, with the launcher prefix replaced by `amem`.
  const home = mkdtempSync(join(tmpdir(), "amem-help-lint-"));
  const env = { HOME: home, AGENTHUB_HOME: join(home, "hub"), PATH: dirname(process.execPath) };
  for (const target of ["claude", "codex", "kimi", "pi", "qwen", "jcode"]) {
    const plan = planSetup(target, "preview", { env, bun: process.execPath, native: () => {} });
    for (const action of plan.actions) for (const hook of action.hooks ?? []) {
      const line = `amem ${hook.command.replace(/^.*amem\.js'?\s+/, "")}`;
      expect(isAmemCommand(line), `${target}: ${hook.command}`).toBe(true);
    }
  }
});
