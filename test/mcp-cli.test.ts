import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the installed JS entry point under an agent marker; ordinary person commands remain refused.
test("agent-marked CLI exposes only the MCP session path and exits on EOF", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-mcp-cli-"));
  const env = { ...process.env, HOME: root, AMEM_HOME: join(root, "memory"), CODEX_THREAD_ID: "fixture-agent" };
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
    expect(replies[1].result.tools).toHaveLength(11);
    expect(replies[1].result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["amem_brief", "amem_capacity", "amem_correct", "amem_graph", "amem_remember", "amem_search", "amem_show", "amem_timeline", "amem_vault_candidates", "amem_work_state_read", "amem_work_state_write"]);
    expect(replies[2].result.isError).toBeUndefined();
    const person = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/amem.js"), "review", "list"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(await person.exited).toBe(1);
    expect(await new Response(person.stderr).text()).toContain("for the person");
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } rmSync(root, { recursive: true, force: true }); }
});
