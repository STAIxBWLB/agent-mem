import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryGitSync } from "../src/index.ts";

test("amem list/show/graph JSON matches installed ahub 0.12.29 byte for byte", () => {
  const fixture = join(import.meta.dir, "fixtures/parity");
  const receipt = JSON.parse(readFileSync(join(fixture, "receipt.json"), "utf8")) as { version: string; remote: string; commands: Record<string, string[]> };
  expect(receipt.version).toBe("0.12.29");
  const root = mkdtempSync(join(tmpdir(), "amem-parity-test-"));
  try {
    const cwd = join(root, "project"); mkdirSync(cwd);
    for (const args of [["init", "-q", cwd], ["-C", cwd, "remote", "add", "origin", receipt.remote]]) expect(memoryGitSync(args, { encoding: "utf8" }).status).toBe(0);
    cpSync(join(fixture, "memory"), join(root, "home/memory"), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: join(root, "home") };
    for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AMEM_HOME"]) delete env[key];
    for (const [name, args] of Object.entries(receipt.commands)) {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../bin/amem.js"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(readFileSync(join(fixture, `${name}.json`), "utf8"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
