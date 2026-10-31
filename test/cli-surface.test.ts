import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentMarked, runCli } from "../src/cli.ts";
import { AMEM_NAMES, GOAL_USAGE, MEMORY_USAGE, goalUsage, memoryUsage } from "../src/memory/commands.ts";
import { commandHelp } from "../src/commands-table.ts";
import { realPath } from "../src/memory/platform.ts";

// agent-mem#40 F1: help and usage name amem's own paths and never a host; unsupported marked-agent reads use the fixed MCP refusal.
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"] as const;
const HOST = /\bahub\b|hub_memory|hub_task|the hub's|agent-hub/i;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rig() {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-surface-"))); roots.push(root);
  const cwd = join(root, "repo"); mkdirSync(join(cwd, ".git"), { recursive: true });
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = join(root, "memory");
  return { root, cwd, restore: () => { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; } };
}
const message = (promise: Promise<unknown>) => promise.then(() => "", error => (error as Error).message);

test("help and usage text names amem and never a host", () => {
  const texts = [commandHelp(), MEMORY_USAGE, GOAL_USAGE, memoryUsage(), goalUsage()];
  for (const text of texts) expect(text, text.slice(0, 60)).not.toMatch(HOST);
  expect(MEMORY_USAGE).toStartWith("usage: amem "); expect(GOAL_USAGE).toStartWith("usage: amem goal ");
  const help = commandHelp();
  expect(help).toContain("  mcp [--help]"); expect(help).toContain("  review list");
  expect(help).toContain("--policy-free: accepted and ignored");
  expect(help).toContain("Agent-marked reads use the MCP privacy ceiling.");
  expect(help).toContain("Explicit apply/confirm flags do not require a terminal");
  expect(help).not.toContain("Mutating commands require a terminal on stdin");
  expect(help).toContain("--apply"); expect(help).toContain("--confirm");
});

test("a host that exposes the same commands under its own name gets its own name in every message", () => {
  expect(memoryUsage("ahub memory")).toStartWith("usage: ahub memory ");
  expect(goalUsage("ahub goal")).toStartWith("usage: ahub goal ");
  expect(AMEM_NAMES).toEqual({ memory: "amem", goal: "amem goal" });
});

test("every refusal a person can reach from the commands names amem, not a host", async () => {
  const r = rig();
  try {
    const person = { cwd: r.cwd, env: {}, stdinTTY: true };
    const refusals = [
      await message(runCli(["promote"], person)), await message(runCli(["import"], person)), await message(runCli(["sync"], person)),
      await message(runCli(["show"], person)), await message(runCli(["graph"], person)), await message(runCli(["supersede", "a"], person)),
      await message(runCli(["confirm"], person)), await message(runCli(["goal", "link", "missing", "1"], person)),
      await message(runCli(["search", "--all-projects", "--include-archived", "--to", "repo"], person)), await message(runCli(["review", "accept", "bad"], person)),
      await message(runCli(["review", "accept", "a".repeat(64), "--kind", "memory"], person)),
    ];
    for (const refusal of refusals) { expect(refusal).not.toBe(""); expect(refusal, refusal).not.toMatch(HOST); }
    expect(refusals.some(text => text.includes("usage: amem"))).toBe(true);
  } finally { r.restore(); }
});

for (const marker of MARKERS) test(`${marker}: --help, help, --version and version work in an agent shell`, async () => {
  const r = rig();
  try {
    for (const value of ["", "1", "codex"]) {
      const agent = { cwd: r.cwd, env: { [marker]: value }, stdinTTY: false };
      expect(agentMarked(agent.env)).toBe(true);
      for (const args of [["--help"], ["help"]]) expect(await runCli(args, agent)).toContain("usage: amem");
      for (const args of [["--version"], ["version"]]) expect(await runCli(args, agent)).toMatch(/^amem \d+\.\d+\.\d+/);
      expect(await runCli(["completion", "bash"], agent)).toContain("_amem_candidates");
    }
  } finally { r.restore(); }
});

for (const marker of MARKERS) test(`${marker}: unsupported historical reads use the generic MCP refusal; help flags stay static`, async () => {
  const r = rig();
  try {
    const agent = { cwd: r.cwd, env: { [marker]: "x", AMEM_HOME: join(r.root, "agent-memory") }, stdinTTY: false, stdoutTTY: false };
    for (const args of [["list", "--history"], ["search", "needle", "--as-of", "2026-01-01T00:00:00.000Z"], ["show", "a".repeat(32), "--history"]]) {
      await expect(runCli(args, agent), args.join(" ")).rejects.toThrow(/^agent-marked (list|search|show) accepts (only|no options)/);
    }
    for (const args of [["--help", "--json"], ["list", "--help"], ["review", "--help"], ["--version", "--json"]]) {
      const output = await runCli(args, agent); expect(output).not.toMatch(HOST);
    }
  } finally { r.restore(); }
});

test("ingest keeps its capture-only agent-facing path", async () => {
  const r = rig();
  try {
    const agent = { cwd: r.cwd, env: { AGENTHUB_PEER_ID: "codex" }, stdinTTY: false };
    expect(await runCli(["ingest", "codex", "--help"], agent)).toContain("usage: amem");
    // Ingest retains its command-specific validation.
    const bad = await message(runCli(["ingest", "nonsense"], agent));
    expect(bad).toContain("kind takes codex or kimi or pi or qwen"); expect(bad).not.toMatch(HOST);
  } finally { r.restore(); }
});

test("the bin prints help and version in an agent shell and uses the generic error for an unsupported read", () => {
  const bin = resolve(import.meta.dir, "../bin/amem.js");
  const home = mkdtempSync(join(tmpdir(), "amem-surface-bin-")); roots.push(home);
  const env = { PATH: process.env.PATH, HOME: home, AMEM_HOME: join(home, "memory"), AGENTHUB_PEER_ID: "codex" };
  const help = Bun.spawnSync([process.execPath, bin, "--help"], { env, stdout: "pipe", stderr: "pipe" });
  expect(help.exitCode).toBe(0); expect(help.stdout.toString()).toContain("usage: amem"); expect(help.stdout.toString()).not.toMatch(HOST);
  const version = Bun.spawnSync([process.execPath, bin, "--version"], { env, stdout: "pipe", stderr: "pipe" });
  expect(version.exitCode).toBe(0); expect(version.stdout.toString()).toMatch(/^amem \d/);
  const refused = Bun.spawnSync([process.execPath, bin, "list", "--history"], { env, stdout: "pipe", stderr: "pipe" });
  expect(refused.exitCode).toBe(1); expect(refused.stderr.toString()).toContain("agent-marked list accepts only --limit and --since."); expect(refused.stderr.toString()).not.toMatch(HOST);
});
