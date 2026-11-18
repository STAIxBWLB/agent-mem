import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { openShardStore } from "../src/memory/store.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { discoverRemotePlacementRealms, prepareRemotePlacementRealm } from "../src/memory/sync-placement-transport.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture } from "./fakes/sync-placement-inventory.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";

afterEach(closeInventoryFixtures);

test("configured private remote listing is hash-only and does not change the home", async () => {
  const shared = "example.test/list/shared", remoteOnly = "example.test/list/private-name";
  const a = await inventoryFixture(2, [shared, remoteOnly]), b = await inventoryFixture(1, [shared]), remote = bareRemote();
  for (const f of [a, b]) {
    const user = openShardStore({ memoryDir: f.home, user: true, deferPromotions: true });
    try { const result = await syncMemory(user, f.opts(remote)); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { user.close(); }
  }
  const before = inspectionFilesystemSnapshot(b.home), visibility = async () => "private" as const;
  expect(await discoverRemotePlacementRealms(b.home, { visibility })).toEqual([{ scope: "project", keyHash: shardKeyHash(remoteOnly) }]);
  expect(inspectionFilesystemSnapshot(b.home)).toEqual(before);
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = b.home;
  try {
    const output = await runCli(["migrate", "--sync-placement", "--list-remote", "--json"], { cwd: b.root, env: {}, visibility });
    expect(JSON.parse(output)).toEqual({ realms: [{ scope: "project", keyHash: shardKeyHash(remoteOnly) }] });
    expect(output).not.toContain(remoteOnly); expect(output).not.toContain(remote); expect(output).not.toContain(b.home);
    expect(inspectionFilesystemSnapshot(b.home)).toEqual(before);
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
  await expect(discoverRemotePlacementRealms(b.home, { visibility: async () => "public" })).rejects.toThrow("unavailable");
  expect(inspectionFilesystemSnapshot(b.home)).toEqual(before);
  const trace = join(b.root, "must-not-write-trace"), priorTrace = process.env.GIT_TRACE; process.env.GIT_TRACE = trace;
  try { await expect(discoverRemotePlacementRealms(b.home, { visibility })).rejects.toThrow("unavailable"); expect(existsSync(trace)).toBe(false); }
  finally { if (priorTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = priorTrace; }
  expect(readFileSync(join(b.home, "sync-placement", "active.json")).length).toBeGreaterThan(0);
}, 120_000);

test("remote realm preview audits the frozen ref in the configured cache without materializing a shard", async () => {
  const shared = "example.test/preview/shared", remoteOnly = "example.test/preview/target";
  const a = await inventoryFixture(2, [shared, remoteOnly]), b = await inventoryFixture(1, [shared]), remote = bareRemote();
  for (const f of [a, b]) {
    const user = openShardStore({ memoryDir: f.home, user: true, deferPromotions: true });
    try { const result = await syncMemory(user, f.opts(remote)); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { user.close(); }
  }
  const target = join(b.home, "projects", shardKeyHash(remoteOnly)); expect(existsSync(target)).toBe(false);
  const prepared = await prepareRemotePlacementRealm(b.home, remoteOnly, { visibility: async () => "private" });
  expect(prepared.plan.keyHash.startsWith(shardKeyHash(remoteOnly))).toBe(true); expect(prepared.plan.remoteHead).toMatch(/^[a-f0-9]{40}$/);
  expect(prepared.plan.omitted).toBe(0); expect(prepared.packs.length).toBeGreaterThan(0);
  expect(existsSync(target)).toBe(false);
  const receipt = JSON.stringify({ realm: prepared.plan.keyHash, head: prepared.plan.remoteHead, omitted: prepared.plan.omitted });
  expect(receipt).not.toContain(remoteOnly); expect(receipt).not.toContain(remote); expect(receipt).not.toContain(b.home);
}, 120_000);
