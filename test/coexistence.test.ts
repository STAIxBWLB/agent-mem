import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { manifest, MCP_PRELOAD, runCli } from "../src/cli.ts";
import { COMMANDS, commandHelp } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";
import { installRoot, planSetup } from "../src/setup.ts";
import { realPath } from "../src/memory/platform.ts";

// #199 change 6: versions coexist on one machine. A release is registered by its own install root, and a running server keeps its code.
const PACKAGE = resolve(import.meta.dir, ".."), VERSION = (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { version: string }).version;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string { const root = realPath(mkdtempSync(join(tmpdir(), "amem-coexist-"))); roots.push(root); return root; }
/** A copy of this package as `<root>/releases/<version>/`, with only what the published tarball runs from. */
function release(root: string, version: string): string {
  const dir = join(root, "releases", version);
  for (const part of ["bin", "src"]) cpSync(join(PACKAGE, part), join(dir, part), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version }));
  return dir;
}

test("manifest --json lists the package, the MCP tools with their read-only claims and the command table", async () => {
  const printed = JSON.parse(await runCli(["manifest", "--json"]));
  expect(printed).toEqual(manifest());
  expect(printed).toMatchObject({ name: "@staix/agent-mem", version: VERSION, mcp: { server: "amem" } });
  const readOnly = ["search", "show", "timeline", "brief", "graph", "evidence", "vault_candidates", "capacity", "work_state_read"].map(name => `amem_${name}`);
  expect(printed.mcp.tools.filter((tool: unknown) => typeof tool === "object").sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)))
    .toEqual(readOnly.sort().map(name => ({ name, readOnly: true })));
  expect(printed.mcp.tools.filter((tool: unknown) => typeof tool === "string").sort()).toEqual(["amem_correct", "amem_remember", "amem_work_state_write"]);
  expect(printed.commands).toEqual(Object.keys(COMMANDS)); expect(printed.commands).toContain("manifest");
  // An agent-marked shell reads it too: it carries no memory data.
  expect(JSON.parse(await runCli(["manifest", "--json"], { env: { ...process.env, AGENTHUB_PEER_ID: "codex" } }))).toEqual(printed);
  expect(commandHelp()).toContain("  manifest [--help] [--json]");
  expect(completionScript("zsh")).toContain("manifest");
});

test("setup --root registers the real path of a validated install root and refuses anything else", () => {
  const root = scratch(), v1 = release(root, "9.9.1"); symlinkSync(v1, join(root, "current"));
  expect(installRoot(join(root, "current"))).toEqual({ path: v1, version: "9.9.1" });
  mkdirSync(join(root, "home"));
  const env = { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "hub"), PATH: dirname(process.execPath) };
  // The trusted native seam lets a temporary root through the persistent-install check; nothing runs in preview.
  const plan = planSetup("claude", "preview", { env, bun: process.execPath, root: join(root, "current"), native: () => { throw Error("preview runs no native command"); } });
  expect(plan.root).toEqual({ path: v1, version: "9.9.1" });
  expect(plan.actions[0]!.hooks.length).toBeGreaterThan(0);
  for (const hook of plan.actions[0]!.hooks) expect(hook.command).toContain(`'${join(v1, "bin", "amem.js")}' hook `);
  expect(plan.notes.some(note => note.includes(`install root ${v1} (amem 9.9.1)`))).toBe(true);
  expect(planSetup("claude", "preview", { env, bun: process.execPath, native: () => {} }).root).toBeUndefined();

  expect(() => installRoot("releases/9.9.1")).toThrow("absolute path");
  expect(() => installRoot(join(root, "missing"))).toThrow("not found");
  const other = join(root, "other"); mkdirSync(join(other, "bin"), { recursive: true }); writeFileSync(join(other, "bin", "amem.js"), "");
  expect(() => installRoot(other)).toThrow("no readable package.json");
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@staix/vault-mem", version: "1.0.0" }));
  expect(() => installRoot(other)).toThrow("not an @staix/agent-mem install root");
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "1.0.0", pad: "x".repeat(70_000) }));
  expect(() => installRoot(other)).toThrow("at most 64 KiB");
  rmSync(join(other, "package.json")); execFileSync("mkfifo", [join(other, "package.json")]);
  expect(() => installRoot(other)).toThrow("at most 64 KiB"); // a FIFO is refused on fstat, never waited on
  rmSync(join(other, "package.json")); writeFileSync(join(other, "real.json"), JSON.stringify({ name: "@staix/agent-mem", version: "1.0.0" })); symlinkSync(join(other, "real.json"), join(other, "package.json"));
  expect(() => installRoot(other)).toThrow("no readable package.json");
  rmSync(join(other, "package.json")); writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "1.0.0" })); rmSync(join(other, "bin", "amem.js"));
  expect(() => installRoot(other)).toThrow("no regular bin/amem.js");
});

test("setup console --root points the acon manifest at that root's plugin", async () => {
  const root = scratch(), v1 = release(root, "9.9.1");
  const result = JSON.parse(await runCli(["setup", "console", "--root", v1, "--json"], { env: { ...process.env, AGENTHUB_HOME: join(root, "hub") } }));
  expect(result).toMatchObject({ module: join(v1, "src", "ui", "plugin.ts"), change: "add" });
});

test("amem mcp keeps answering from its own code after its install root is removed", async () => {
  const root = scratch(), v1 = release(root, "9.9.1"), project = join(root, "project"); mkdirSync(project);
  const env: Record<string, string | undefined> = { ...process.env, HOME: root, AMEM_HOME: join(root, "memory") };
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) delete env[key];
  const child = Bun.spawn([process.execPath, "--smol", join(v1, "bin", "amem.js"), "mcp"], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000), reader = child.stdout.getReader(), decoder = new TextDecoder();
  let buffered = "";
  const reply = async (): Promise<Record<string, any>> => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) { const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); return JSON.parse(line); }
      const { value, done } = await reader.read(); if (done) throw Error("server exited");
      buffered += decoder.decode(value, { stream: true });
    }
  };
  const send = (frame: unknown) => { child.stdin.write(JSON.stringify(frame) + "\n"); child.stdin.flush(); };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "coexist", version: "1" } } });
    expect((await reply()).result.serverInfo).toEqual({ name: "amem", version: "9.9.1" });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    rmSync(join(v1, "src"), { recursive: true }); // an in-place replacement or removal of the release under the running server
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await reply()).result.tools).toHaveLength(12);
    const calls: [string, Record<string, unknown>][] = [["amem_remember", { text: "coexistence candidate" }], ["amem_search", { query: "coexistence" }],
      ["amem_work_state_read", {}], ["amem_brief", { intent: "coexistence" }], ["amem_capacity", {}]];
    for (const [index, [name, args]] of calls.entries()) {
      send({ jsonrpc: "2.0", id: 3 + index, method: "tools/call", params: { name, arguments: args } });
      const answer = await reply();
      expect({ name, isError: answer.result.isError }).toEqual({ name, isError: undefined });
    }
    child.stdin.end(); expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
});

// CLI-only modules: no MCP handler reaches them, so `amem mcp` does not load them.
const CLI_ONLY = ["hooks.ts", "ingest.ts", "setup.ts", "setup-console.ts", "session-brief.ts", "memory/decay-review.ts", "memory/goal-promotion.ts"];
test("every lazy import under src/ is preloaded by amem mcp or named CLI-only", () => {
  const src = join(PACKAGE, "src"), found = new Set<string>();
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "ui") walk(file); continue; }
    if (!entry.name.endsWith(".ts")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/import\("(\.{1,2}\/[^"]+\.ts)"\)(?!\.)/g)) found.add(relative(src, resolve(dirname(file), match[1]!)));
  } };
  walk(src);
  const covered = new Set([...MCP_PRELOAD.map(module => relative(src, resolve(src, module))), ...CLI_ONLY]);
  expect([...found].filter(module => !covered.has(module)).sort()).toEqual([]);
  const cli = readFileSync(join(src, "cli.ts"), "utf8"), preload = /const preloadMcp = \(\) => Promise\.all\(\[(.*)\]\);/.exec(cli)?.[1] ?? "";
  expect([...preload.matchAll(/import\("([^"]+)"\)/g)].map(match => match[1])).toEqual([...MCP_PRELOAD]);
});
