import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHome } from "../src/memory/home.ts";

test("test preload refuses even a caught resolution of the real default memory home", () => {
  expect(memoryHome()).not.toBe(join(homedir(), ".agenthub", "memory"));
  const root = mkdtempSync(join(tmpdir(), "amem-home-guard-test-")), file = join(root, "guard.test.ts");
  try {
    const module = join(import.meta.dir, "../src/memory/home.ts");
    writeFileSync(file, `import { test } from "bun:test";\nimport { memoryHome } from ${JSON.stringify(module)};\ntest("caught guard", () => { try { memoryHome({ AMEM_HOME: ${JSON.stringify(join(homedir(), ".agenthub", "memory"))} }); } catch {} });\n`);
    const run = Bun.spawnSync([process.execPath, "test", file], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("test resolved the real default memory home");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
