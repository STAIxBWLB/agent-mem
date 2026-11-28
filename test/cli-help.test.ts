import { expect, test } from "bun:test";
import { runCli } from "../src/cli.ts";
import { commandHelp } from "../src/commands-table.ts";

const person = { env: {} };
const agent = { env: { CLAUDECODE: "1" } };

test("command --help shows that command's description, options and subcommands", async () => {
  for (const context of [person, agent]) {
    const capacity = await runCli(["capacity", "--help"], context);
    expect(capacity.startsWith("▸ Usage\n  amem capacity ")).toBe(true);
    expect(capacity).toContain("Report capture use and propose capture bounds");
    expect(capacity).toContain("Disk-share bound for the proposal (default 0.02)");
    expect(capacity).toMatch(/▸ Commands \(1\)\n {2}apply {2}Write the proposed/);
  }
});

test("a defaultCommand parent shows itself and its subcommands", async () => {
  const review = await runCli(["review", "--help"], person);
  expect(review.startsWith("▸ Usage\n  amem review ")).toBe(true);
  for (const name of ["list", "accept", "reject", "walk"]) expect(review).toMatch(new RegExp(`\\n {2}${name} +\\S`));
});

test("help command and short flag show bounded command details", async () => {
  expect(await runCli(["help", "status"], person)).toBe(await runCli(["status", "--help"], person));
  expect(await runCli(["status", "-h"], person)).toBe(await runCli(["status", "--help"], person));
  for (const command of ["status", "setup", "review", "capacity"]) {
    const text = await runCli([command, "--help"], person);
    for (const line of text.split("\n")) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
  }
});

test("existing help contracts hold", async () => {
  expect(await runCli(["import", "claude-mem", "--help"], person)).toContain("--capture-days");
  expect((await runCli(["ingest", "codex", "--help"], agent)).startsWith("▸ Usage\n  amem ingest codex|kimi|pi|qwen")).toBe(true);
  expect((await runCli(["list", "--help"], agent)).startsWith("▸ Usage\n  amem list")).toBe(true);
  // Positionals stop path resolution; an unknown command keeps the full list.
  expect((await runCli(["search", "capacity", "--help"], person)).startsWith("▸ Usage\n  amem search <words>")).toBe(true);
  expect(await runCli(["nosuch", "--help"], person)).toBe(commandHelp());
  // Option values are not command names; inherited Object names are not commands.
  expect(await runCli(["--peer", "review", "--help"], person)).toBe(commandHelp());
  expect((await runCli(["review", "--kind", "memory", "accept", "--help"], person)).startsWith("▸ Usage\n  amem review accept ")).toBe(true);
  for (const name of ["toString", "constructor", "__proto__"]) expect(await runCli([name, "--help"], agent)).toBe(commandHelp());
  // hook --help reaches the help renderer instead of the hook handler.
  expect((await runCli(["hook", "--help"], agent)).startsWith("▸ Usage\n  amem hook <event>")).toBe(true);
  expect(await runCli(["--help"], agent)).toBe(commandHelp());
  expect(await runCli(["help"], person)).toBe(commandHelp());
});

test("help <unknown> is a usage error and every usage error names its help page (#590 H7)", async () => {
  await expect(runCli(["help", "nosuch"], person)).rejects.toMatchObject({ exitCode: 2, message: "unknown command nosuch" });
  await expect(runCli(["help", "project", "nosuch"], person)).rejects.toMatchObject({ exitCode: 2 });
  const { formatCliError } = await import("../src/cli.ts");
  const refused = (argv: string[]) => runCli(argv, person).then(() => { throw new Error("accepted"); }, (error: Error) => formatCliError(error, true, argv));
  expect(await refused(["search", "--nope"])).toBe("amem: unknown option --nope\nUsage: amem search <words>... [options]\nRun 'amem help search' for details.");
  expect(await refused(["project"])).toBe("amem: amem project needs a command\nUsage: amem project <command> [options]\nRun 'amem help project' for details.");
  expect(await refused(["help", "nosuch"])).toBe("amem: unknown command nosuch\nUsage: amem <command> [options]\nRun 'amem help' for details.");
  for (const argv of [["skills"], ["formats"], ["note"], ["import"], ["project", "export"]]) {
    const text = await refused(argv);
    expect(text.split("\n").filter(line => /^Usage: |^amem: usage: /.test(line) || line.startsWith("amem: usage:"))).toHaveLength(1);
    expect(text).toContain(`Run 'amem help ${argv.join(" ")}' for details.`);
  }
});

test("agent-marked sessions get the same H7 usage errors, not a read failure", async () => {
  const { formatCliError } = await import("../src/cli.ts");
  for (const argv of [["help", "nosuch"], ["note"], ["project"], ["skills"], ["formats"], ["import"]]) {
    const seen = (context: typeof person) => runCli(argv, context).then(() => { throw new Error("accepted"); }, (error: Error & { exitCode?: number }) => ({ code: error.exitCode, text: formatCliError(error, true, argv) }));
    const marked = await seen(agent), unmarked = await seen(person);
    expect(marked.code, argv.join(" ")).toBe(2);
    expect(marked.text, argv.join(" ")).toBe(unmarked.text);
    expect(marked.text).toContain("Run 'amem help");
  }
});

function invokeCli(argv: string[], context: typeof person) {
  return Bun.spawnSync([process.execPath, import.meta.resolveSync("../bin/amem.js"), ...argv], {
    env: { AGENTHUB_HOME: process.env.AGENTHUB_HOME, ...context.env },
    stdout: "pipe", stderr: "pipe",
  });
}

test("formats raise reports missing and excess arguments in both sessions", () => {
  const help = invokeCli(["help", "formats", "raise"], person);
  expect(help.exitCode).toBe(0);
  const synopsis = help.stdout.toString().split("\n").find(line => line.trimStart().startsWith("amem formats raise "))?.trim();
  expect(synopsis).toBeDefined();
  for (const args of [[], ["home"], ["home", "0.38.0", "extra"]]) {
    for (const context of [person, agent]) {
      const result = invokeCli(["formats", "raise", ...args], context);
      expect(result.exitCode).toBe(2);
      const error = result.stderr.toString();
      expect(error.split("\n").filter(line => line.startsWith("Usage:"))).toEqual([`Usage: ${synopsis}`]);
      expect(error).toContain("Run 'amem help formats raise' for details.");
      expect(error).not.toMatch(/read_failed|Memory operation unavailable/);
      expect(result.stdout.toString()).toBe("");
    }
  }
});

test.each([
  ["completion", "amem completion zsh|bash|fish"],
  ["skills export", "amem skills export <dir> [--json]"],
  ["setup", "amem setup claude|codex|kimi|pi|qwen|jcode|opencode|gemini|agy|all|console [--root <abs path>] [--apply [--adopt-current]|--undo] | amem setup agy --list [--json] | amem setup agy --refresh [--root <abs path>] [--apply [--adopt-current]] [--json]"],
  ["brief", "amem brief --for <intent> [--paths <path>] [--symbols <symbol>] [--bytes N] [--json]"],
  ["eval audit", "amem eval audit sample --seed <s> [--n <n>] [--project <key>] | amem eval audit score <sheet>"],
  ["eval audit score", "amem eval audit score <sheet> (the file `amem eval audit sample` wrote)"],
  ["search --all-projects", "amem search --all-projects <words> [--limit N] [--include-archived] [--json]"],
  ["promote --to repo", "amem promote <id> --to repo --policy-free [--confirm [--confirm-public <entry id prefix>]]"],
])("%s preserves its argument-only usage error in a marked session", (command, usage) => {
  const result = invokeCli(command.split(" "), agent);
  const help = command.split(" --")[0];
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe(`amem: usage: ${usage}\nRun 'amem help ${help}' for details.\n`);
});
