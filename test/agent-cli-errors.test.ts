import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCliError, main, runCli } from "../src/cli.ts";
import { READ_FAILURE } from "../src/cli-agent-reads.ts";
import * as configModule from "../src/memory/config.ts";
import * as mcpMemory from "../src/mcp-memory.ts";

const UNAVAILABLE = "Memory operation unavailable or refused; no partial result is shown.";
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

test("#431: marked doctor, status and the wider read options run the person handler; read-route value checks stay", async () => {
  const { context } = agent();
  expect(await runCli(["status", "--json"], context)).toContain('"home"');
  expect(JSON.parse(await runCli(["doctor", "--json"], context))).toMatchObject({ schema: "amem.doctor/v1" });
  expect(await runCli(["list", "--history"], context)).toContain("retained memory as of");
  expect(await message(["search", "foo", "--limit", "500"], context)).toBe("--limit takes a whole number from 1 to 100.");
});

test("refusal messages never name a marker or suggest leaving the session", async () => {
  const { context } = agent();
  for (const args of [["serch"], ["show", "a", "b"], ["graph", "x", "--hops", "3"], ["capacity", "--json", "--bogus"], ["search", "foo", "--limit", "500"]]) {
    const text = await message(args, context);
    expect(text).not.toMatch(MARKERS);
    expect(text).not.toMatch(/unset|outside|without the|bypass/i);
  }
});

test("a marked read whose MCP handler fails reports a fixed read failure", async () => {
  const { context } = agent();
  const spy = spyOn(mcpMemory, "createMemoryMcp").mockImplementation(() => { throw new Error("secret path /private/x"); });
  try { expect(await message(["search", "foo"], context)).toBe(READ_FAILURE); }
  finally { spy.mockRestore(); }
});

test("a marked administrative handler failure after the store opens still prints the uniform message", async () => {
  const { context } = agent();
  expect(await message(["forget", "mem:00000000000000000000000000000000"], context)).toBe(UNAVAILABLE);
});


test("#511: marked failed reads never expose caught content in CLI or JSON modes", async () => {
  const { context } = agent(), secret = "ROW_SENTINEL /private/SECRET_PATH token=secret123";
  const spy = spyOn(mcpMemory, "createMemoryMcp").mockImplementation(() => { throw new Error(secret); });
  try {
    for (const args of [["search", "foo"], ["search", "foo", "--json"]]) {
      let caught: unknown; try { await runCli(args, context); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      for (const output of [(caught as Error).message, formatCliError(caught), JSON.stringify({ error: (caught as Error).message })]) {
        expect(output).toContain("read_failed");
        for (const hidden of ["ROW_SENTINEL", "/private/SECRET_PATH", "secret123"]) expect(output).not.toContain(hidden);
      }
    }
    const old = process.env.CODEX_THREAD_ID; process.env.CODEX_THREAD_ID = "fixture";
    const logged: string[] = [], output: string[] = [];
    const stderr = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const oldExit = process.exitCode;
    try { for (const args of [["search", "foo"], ["search", "foo", "--json"]]) {
      logged.length = 0; output.length = 0; await main(args);
      expect(logged.join(" ")).toContain("read_failed"); expect(output).toEqual([]);
      for (const hidden of ["ROW_SENTINEL", "/private/SECRET_PATH", "secret123"]) expect(logged.join(" ")).not.toContain(hidden);
    } }
    finally { stderr.mockRestore(); stdout.mockRestore(); process.exitCode = oldExit ?? 0; if (old === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = old; }
  } finally { spy.mockRestore(); }
});


test("#511: non-MCP read errors use the same fixed failure class", async () => {
  const { context } = agent(), secret = "ROW_SENTINEL /private/SECRET_PATH token=secret123";
  const spy = spyOn(configModule, "loadAmemConfig").mockImplementation(() => { throw new Error(secret); });
  try { for (const args of [["status"], ["status", "--json"]]) { const result = await message(args, context); expect(result).toBe(READ_FAILURE); expect(result).not.toContain(secret); } }
  finally { spy.mockRestore(); }
});


test("#511: a withheld read has a distinct policy cause", async () => {
  const { context } = agent(), original = configModule.configuredPolicy;
  const spy = spyOn(configModule, "configuredPolicy").mockImplementation((...args) => ({ ...original(...args), screenStandalone: () => false }));
  try {
    const result = await message(["review", "targets", "--json"], context);
    expect(result).toContain("policy_withheld"); expect(result).not.toContain("read_failed");
  } finally { spy.mockRestore(); }
});

test("#511: MCP's ambiguous refusal is not misclassified as failure or policy", async () => {
  const { context } = agent();
  const spy = spyOn(mcpMemory, "createMemoryMcp").mockImplementation(() => { throw new Error("memory operation unavailable"); });
  try {
    const output = await message(["search", "foo", "--json"], context);
    expect(output).toContain("cause: unavailable"); expect(output).not.toContain("read_failed"); expect(output).not.toContain("policy_withheld");
    expect(output).toContain("same command from their own shell");
  } finally { spy.mockRestore(); }
});


test("#511: effectful audit sample and project export keep the existing failure treatment", async () => {
  const { context } = agent();
  for (const args of [["eval", "audit", "sample", "--seed", ""], ["project", "export", "fixture", "--to", "/nonexistent/fixture.json"]]) {
    expect(await message(args, context)).toBe(UNAVAILABLE);
  }
});

test("#511: missing and policy-hidden show IDs are indistinguishable in current and historical reads", async () => {
  const { cwd, home, context } = agent();
  const { MemoryStore } = await import("../src/memory/store.ts"), { memoryProjectKey } = await import("../src/memory/project.ts");
  const { writeFileSync } = await import("node:fs");
  const store = new MemoryStore({ memoryDir: home, deferPromotions: true });
  let hidden: string;
  try { hidden = store.note({ op: "note", project: memoryProjectKey(cwd), scope: "project", tier: "long", kind: "decision", peer: "person", source: "person", text: "HIDDEN_FIXTURE_MARKER", about: [] }); } finally { store.close(); }
  writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: ["HIDDEN_FIXTURE_MARKER"] }));
  const absent = "f".repeat(32), asOf = new Date(Date.now() + 60_000).toISOString();
  for (const command of ["show", "graph"]) for (const options of [[], ["--history"], ["--as-of", asOf]]) for (const json of [[], ["--json"]]) {
    const outcome = async (id: string) => { try { return { output: await runCli([command, id, ...options, ...json], context) }; } catch (error) { return { error: (error as Error).message }; } };
    const expected = await outcome(absent), actual = await outcome(hidden);
    expect(actual).toEqual(expected); expect(JSON.stringify(actual)).not.toContain("HIDDEN_FIXTURE_MARKER");
  }
  for (const flags of [["--color=always"], ["--ascii"], ["--color=never", "--ascii"]]) {
    const plain = await runCli(["show", absent, "--json"], context);
    expect(await runCli(["show", absent, "--json", ...flags], context)).toBe(plain);
    expect(await runCli(["show", hidden, "--json", ...flags], context)).toBe(plain);
  }
});
