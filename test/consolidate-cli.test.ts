import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { memoryProjectKey } from "../src/memory/project.ts";
import { realPath } from "../src/memory/platform.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("a marked nonTTY CLI can queue consolidation candidates and accept through the current policy path", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-consolidate-cli-"))), base = join(root, "memory"), project = memoryProjectKey(root); roots.push(root);
  let clock = Date.now(); const store = new MemoryStore({ memoryDir: base, now: () => clock, deferPromotions: true });
  try { for (let i = 0; i < 2; i++) { clock++; store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "bounded writer lease avoids transaction contention", about: ["path:src/writer.ts"] }); } }
  finally { store.close(); }
  const beforeHome = process.env.AMEM_HOME; process.env.AMEM_HOME = base;
  try {
    const cli = (args: string[], extra: { env?: Record<string, string>; stdinTTY?: boolean } = {}) => runCli(args, { cwd: root, env: {}, stdinTTY: true, ...extra });
    const agent = { env: { CLAUDECODE: "fixture" }, stdinTTY: false };
    const result = JSON.parse(await cli(["consolidate", "--json"], agent));
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0].action).toBe("supersession");
    const check = new MemoryStore({ memoryDir: base, screen: () => "keep" }); expect(check.list({ project }).length).toBe(2); check.close();
    await expect(cli(["consolidate", "--project", "local:somewhere-else"], agent)).rejects.toThrow("must name the current project");
    const accepted = JSON.parse(await cli(["review", "accept", result.candidates[0].id, "--kind", "consolidation", "--json"], agent));
    expect(accepted.noteId).toMatch(/^[a-f0-9]{32}$/);
    const after = new MemoryStore({ memoryDir: base, screen: () => "keep" });
    try { expect(after.get(accepted.noteId, project)).toMatchObject({ peer: "claude", source: "person" }); } finally { after.close(); }
  } finally { if (beforeHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = beforeHome; }
});
