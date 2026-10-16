import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";

test("person generation status counts malformed legacy lines without exposing their bodies or changing JSON lists", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-generation-status-")), oldHome = process.env.AMEM_HOME;
  let store: MemoryStore | undefined;
  try {
    store = new MemoryStore({ home, profile: "shared-v1" });
    const memoryDir = store.dir;
    appendFileSync(join(memoryDir, "log", `${store.machine.id}.jsonl`), "PRIVATE-malformed-body\n");
    store.close(); store = undefined;
    await migrate({ memoryDir, mode: "apply", generation: "a".repeat(32), authorizedPerson: true, tty: true });
    process.env.AMEM_HOME = memoryDir;
    const output = await runCli(["list"], { env: {}, cwd: home });
    expect(output).toContain("legacy malformed lines skipped: 1");
    expect(output).not.toContain("PRIVATE-malformed-body");
    expect(JSON.parse(await runCli(["list", "--json"], { env: {}, cwd: home }))).toEqual([]);
    store = new MemoryStore();
    expect(store.bridgeStatus()).toEqual({ skippedRows: 1 });
    expect(store.counts().segments).toBe(1); // Includes the bridged input, not only G-owned files.
    store.rebuild(); expect(store.bridgeStatus()).toEqual({ skippedRows: 1 });
  } finally {
    store?.close();
    if (oldHome === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
