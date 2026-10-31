import { expect, test } from "bun:test";
import { runCli } from "../src/cli.ts";
import { commandHelp } from "../src/commands-table.ts";

const person = { env: {} };
const agent = { env: { CLAUDECODE: "1" } };

test("command --help shows that command's description, options and subcommands", async () => {
  for (const context of [person, agent]) {
    const capacity = await runCli(["capacity", "--help"], context);
    expect(capacity.startsWith("usage: amem capacity ")).toBe(true);
    expect(capacity).toContain("Report capture use and propose R6 bounds (R7)");
    expect(capacity).toContain("Disk-share bound for the proposal (default 0.02)");
    expect(capacity).toMatch(/commands:\n {2}apply {2}Write the proposed/);
  }
});

test("a defaultCommand parent shows itself and its subcommands", async () => {
  const review = await runCli(["review", "--help"], person);
  expect(review.startsWith("usage: amem review ")).toBe(true);
  for (const name of ["list", "accept", "reject", "walk"]) expect(review).toMatch(new RegExp(`\\n {2}${name} +\\S`));
});

test("existing help contracts hold", async () => {
  expect(await runCli(["import", "claude-mem", "--help"], person)).toContain("--capture-days");
  expect((await runCli(["ingest", "codex", "--help"], agent)).startsWith("usage: amem ingest <kind>")).toBe(true);
  expect((await runCli(["list", "--help"], agent)).startsWith("usage: amem list")).toBe(true);
  // Positionals stop path resolution; an unknown command keeps the full list.
  expect((await runCli(["search", "capacity", "--help"], person)).startsWith("usage: amem search <words>")).toBe(true);
  expect(await runCli(["nosuch", "--help"], person)).toBe(commandHelp());
  // Option values are not command names; inherited Object names are not commands.
  expect(await runCli(["--peer", "review", "--help"], person)).toBe(commandHelp());
  expect((await runCli(["review", "--kind", "memory", "accept", "--help"], person)).startsWith("usage: amem review accept ")).toBe(true);
  for (const name of ["toString", "constructor", "__proto__"]) expect(await runCli([name, "--help"], agent)).toBe(commandHelp());
  // hook --help reaches the help renderer instead of the hook handler.
  expect((await runCli(["hook", "--help"], agent)).startsWith("usage: amem hook <event>")).toBe(true);
  expect(await runCli(["--help"], agent)).toBe(commandHelp());
  expect(await runCli(["help"], person)).toBe(commandHelp());
});
