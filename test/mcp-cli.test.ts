import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE } from "../src/memory/config.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { MemoryStore } from "../src/memory/store.ts";

// Exercise the installed JS entry point under an agent marker; MCP surface is unchanged and ordinary CLI uses the same privacy ceiling.
test("MCP surface stays stable while marked CLI reads are screened and writes retain peer attribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-mcp-cli-"));
  const memory = join(root, "memory"), project = memoryProjectKey(root);
  const store = new MemoryStore({ memoryDir: memory, screen: () => "keep" });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", text: "MCP-CLI public control", about: [], source: "person" });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", text: "MCP-CLI private marker", about: [], source: "person" });
  store.close();
  writeFileSync(join(memory, CONFIG_FILE), JSON.stringify({ piiPatterns: ["MCP-CLI private marker"] }));
  const env = { ...process.env, HOME: root, AMEM_HOME: memory, CODEX_THREAD_ID: "fixture-agent" };
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/amem.js"), "mcp"], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    child.stdin.write([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "amem_remember", arguments: { text: "Durable transaction principle" } } },
    ].map(frame => JSON.stringify(frame)).join("\n") + "\n");
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stderr).toBe("");
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies.map(row => row.id)).toEqual([1, 2, 3]);
    expect(replies[1].result.tools).toHaveLength(12);
    expect(replies[1].result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["amem_brief", "amem_capacity", "amem_correct", "amem_evidence", "amem_graph", "amem_remember", "amem_search", "amem_show", "amem_timeline", "amem_vault_candidates", "amem_work_state_read", "amem_work_state_write"]);
    expect(replies[2].result.isError).toBeUndefined();

    const bin = join(import.meta.dir, "../bin/amem.js");
    const list = Bun.spawnSync([process.execPath, bin, "list", "--json"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(list.exitCode).toBe(0); expect(list.stderr.toString()).toBe("");
    const visible = JSON.parse(list.stdout.toString()) as { text: string; peer: string }[];
    expect(visible.some(row => row.text === "MCP-CLI public control")).toBe(true);
    expect(JSON.stringify(visible)).not.toContain("MCP-CLI private marker");
    const history = Bun.spawnSync([process.execPath, bin, "list", "--history"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(history.exitCode).toBe(1); expect(history.stderr.toString()).toContain("Memory operation unavailable or refused; no partial result is shown.");

    const unmarkedEnv = { ...env };
    for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) delete unmarkedEnv[key];
    const unmarked = Bun.spawnSync([process.execPath, bin, "list", "--json"], { cwd: root, env: unmarkedEnv, stdout: "pipe", stderr: "pipe" });
    expect(unmarked.exitCode).toBe(0); expect(unmarked.stdout.toString()).toContain("MCP-CLI private marker");

    const added = Bun.spawnSync([process.execPath, bin, "note", "add", "MCP-CLI attributed writer", "--json"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(added.exitCode).toBe(0); expect(added.stderr.toString()).toBe("");
    const id = (JSON.parse(added.stdout.toString()) as { id: string }).id;
    const after = new MemoryStore({ memoryDir: memory });
    try { expect(after.get(id, project)).toMatchObject({ peer: "codex", text: "MCP-CLI attributed writer", source: "person" }); }
    finally { after.close(); }

    const review = Bun.spawnSync([process.execPath, bin, "review", "list"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(review.exitCode).toBe(1); expect(review.stderr.toString()).toContain("Memory operation unavailable or refused; no partial result is shown.");
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } rmSync(root, { recursive: true, force: true }); }
});
