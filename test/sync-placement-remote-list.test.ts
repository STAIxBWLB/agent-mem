import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { openShardStore } from "../src/memory/store.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { assertRemoteAdoptionCurrent, discoverRemotePlacementRealms, prepareRemotePlacementRealm, recoverRemoteStagedPacks } from "../src/memory/sync-placement-transport.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture } from "./fakes/sync-placement-inventory.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";

afterEach(closeInventoryFixtures);

test("listing without an active placement names activation as the next step", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-remote-no-placement-"));
  try { await expect(discoverRemotePlacementRealms(home)).rejects.toThrow("activate placement"); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

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
    expect(JSON.parse(output)).toEqual({ realms: [{ scope: "project", keyHash: shardKeyHash(remoteOnly) }], nextStep: "amem migrate --sync-placement --admit <project> --from-remote --dry-run" });
    expect(output).not.toContain(remoteOnly); expect(output).not.toContain(remote); expect(output).not.toContain(b.home);
    expect(inspectionFilesystemSnapshot(b.home)).toEqual(before);
    await expect(runCli(["migrate", "--sync-placement", "--list-remote"], { cwd: b.root, env: { AGENTHUB_PEER_ID: "test" }, visibility: async () => "public" })).rejects.toThrow("not private");
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
  await expect(discoverRemotePlacementRealms(b.home, { visibility: async () => "public" })).rejects.toThrow("not private");
  expect(inspectionFilesystemSnapshot(b.home)).toEqual(before);
  const trace = join(b.root, "must-not-write-trace"), priorTrace = process.env.GIT_TRACE; process.env.GIT_TRACE = trace;
  try { await expect(discoverRemotePlacementRealms(b.home, { visibility })).rejects.toThrow("unavailable"); expect(existsSync(trace)).toBe(false); }
  finally { if (priorTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = priorTrace; }
  const link = join(b.home, "shard-sync-placement", "objects.git", "objects", "unsafe-link"); symlinkSync(b.root, link);
  try { await expect(discoverRemotePlacementRealms(b.home, { visibility })).rejects.toThrow("unavailable"); } finally { rmSync(link); }
  const alternate = join(b.home, "shard-sync-placement", "objects.git", "objects", "info", "alternates");
  try {
    await expect(discoverRemotePlacementRealms(b.home, { visibility: async () => { writeFileSync(alternate, "foreign\n", { mode: 0o600 }); return "private"; } })).rejects.toThrow("unavailable");
    expect(readFileSync(alternate, "utf8")).toBe("foreign\n");
  } finally { rmSync(alternate, { force: true }); }
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
  const held = acquireMutation(join(b.home, "shard-sync-placement")); expect(held).toBeTruthy();
  try { await expect(prepareRemotePlacementRealm(b.home, remoteOnly, { visibility: async () => "private" })).rejects.toThrow("wait for it to finish"); }
  finally { held!(); }
  const receipt = JSON.stringify({ realm: prepared.plan.keyHash, head: prepared.plan.remoteHead, omitted: prepared.plan.omitted });
  expect(receipt).not.toContain(remoteOnly); expect(receipt).not.toContain(remote); expect(receipt).not.toContain(b.home);
  await expect(assertRemoteAdoptionCurrent(b.home, remoteOnly, prepared.plan, { visibility: async () => "private" })).resolves.toBeUndefined();
  const removed = memoryGitSync(["--git-dir", remote, "update-ref", "-d", `refs/heads/amem/p/${shardKeyHash(remoteOnly)}`], { encoding: "utf8" });
  expect(removed.status).toBe(0);
  await expect(assertRemoteAdoptionCurrent(b.home, remoteOnly, prepared.plan, { visibility: async () => "private" })).rejects.toThrow("remote head moved");
  expect(await recoverRemoteStagedPacks(b.home, remoteOnly, prepared.plan)).toEqual(prepared.packs);
  expect(existsSync(target)).toBe(false);
}, 120_000);
