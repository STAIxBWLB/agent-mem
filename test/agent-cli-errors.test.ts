import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import * as mcpMemory from "../src/mcp-memory.ts";

const UNAVAILABLE = "Memory operation unavailable or refused; no partial result is shown.";
const READS = "Agent reads: search, list, show, brief, graph, vault-candidates, capacity.";
const MARKERS = /AGENTHUB_PEER_ID|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|PI_SESSION_ID/;
const roots: string[] = [];
const oldHome = process.env.AMEM_HOME;
afterEach(() => {
  if (oldHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(marker: Record<string, string> = { CLAUDECODE: "1" }) {
  const root = mkdtempSync(join(tmpdir(), "amem-agent-errors-")); roots.push(root);
  const cwd = join(root, "repo"), home = join(root, "memory");
  mkdirSync(cwd, { recursive: true });
  process.env.AMEM_HOME = home;
  return { root, cwd, home, context: { cwd, env: { AMEM_HOME: home, HOME: root, ...marker }, stdinTTY: false, stdoutTTY: false } };
}
async function message(args: string[], context: Parameters<typeof runCli>[1]): Promise<string> {
  try { await runCli(args, context); } catch (error) { return (error as Error).message; }
  throw new Error(`expected an error: ${args.join(" ")}`);
}

test("marked usage errors show parseCommand's own message", async () => {
  for (const marker of <Record<string, string>[]>[{ CLAUDECODE: "1" }, { CODEX_THREAD_ID: "x" }, { AGENTHUB_PEER_ID: "kimi" }, { PI_SESSION_ID: "p" }, { CLAUDE_CODE_SESSION_ID: "s" }]) {
    const { context } = agent(marker);
    expect(await message(["serch", "foo"], context)).toBe("unknown command serch");
    expect(await message(["search", "foo", "--bogus"], context)).toBe("unknown option --bogus");
  }
});

test("marked routing refusals name the command or the accepted options", async () => {
  const { context } = agent();
  expect(await message(["doctor"], context)).toBe(`amem doctor is not available to an agent-marked session. ${READS}`);
  expect(await message(["status"], context)).toBe(`amem status is not available to an agent-marked session. ${READS}`);
  expect(await message(["search", "--tier", "long", "foo"], context)).toBe("agent-marked search accepts only --limit, --since and --explain.");
  expect(await message(["search", "foo", "--limit", "500"], context)).toBe("--limit takes a whole number from 1 to 100.");
  expect(await message(["list", "--history"], context)).toBe("agent-marked list accepts only --limit and --since.");
});

test("refusal messages never name a marker or suggest leaving the session", async () => {
  const { context } = agent();
  for (const args of [["doctor"], ["status"], ["serch"], ["search", "--tier", "long", "x"], ["list", "--history"], ["show", "a", "b"], ["graph", "x", "--hops", "3"], ["capacity", "--json", "--bogus"]]) {
    const text = await message(args, context);
    expect(text).not.toMatch(MARKERS);
    expect(text).not.toMatch(/unset|outside|without the|bypass/i);
  }
});

test("a marked read whose MCP handler fails still prints the uniform message", async () => {
  const { context } = agent();
  const spy = spyOn(mcpMemory, "createMemoryMcp").mockImplementation(() => { throw new Error("secret path /private/x"); });
  try { expect(await message(["search", "foo"], context)).toBe(UNAVAILABLE); }
  finally { spy.mockRestore(); }
});

test("a marked administrative handler failure after the store opens still prints the uniform message", async () => {
  const { context } = agent();
  expect(await message(["forget", "mem:00000000000000000000000000000000"], context)).toBe(UNAVAILABLE);
});
