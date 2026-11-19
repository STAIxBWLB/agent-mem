import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

test("#288: the published 0.29.0 CLI refuses a raised home before store or sync effects", async () => {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  const install = join(import.meta.dir, "../node_modules/@staix/agent-mem-v0290");
  expect(JSON.parse(readFileSync(join(install, "package.json"), "utf8")).version).toBe("0.29.0");
  const env: NodeJS.ProcessEnv = { ...f.env, AMEM_HOME: f.base };
  delete env.AGENTHUB_PEER_ID;
  delete env.CLAUDECODE;
  const oldRead = Bun.spawnSync([process.execPath, join(install, "bin/amem.js"), "search", "--all-projects", "permitted"], { cwd: f.root, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(oldRead.exitCode, oldRead.stderr.toString()).toBe(0);
  expect(oldRead.stdout.toString()).toContain("initial activation permitted original");
  await activateSyncPlacement(f.options("apply"));
  // This is a fake home. The record models the person's confirmed formats raise; no real home is touched.
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const before = inspectionFilesystemSnapshot(f.base);
  for (const args of [["search", "checkpoint"], ["sync"]]) {
    const child = Bun.spawnSync([process.execPath, join(install, "bin/amem.js"), ...args], { cwd: f.root, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString() + child.stdout.toString()).toContain("format floor 0.30.0");
    expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  }
}, 120_000);
