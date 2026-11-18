import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture, note } from "./fakes/sync-placement-inventory.ts";

// Frozen 0.29.0 release-preparation source: the release itself has not been published at fixture creation time.
const BASELINE = "57a4ace57bdf5c4fc12996146c76843de4ee21cc";
for (const reader of ["baseline", "current"] as const) test(`an old empty admission syncs both sides without loss with ${reader} source`, async () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "amem-029-admission-"));
  const archive = Bun.spawnSync(["git", "archive", BASELINE], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", oldRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0);
  const moduleAt = (path: string) => pathToFileURL(join(oldRoot, path)).href;
  const oldFixture = await import(moduleAt("test/fakes/sync-placement-inventory.ts"));
  const oldAdmission = await import(moduleAt("src/memory/sync-placement-realm-admission.ts"));
  const oldStore = await import(moduleAt("src/memory/store.ts"));
  const oldSync = await import(moduleAt("src/memory/sync.ts"));
  const shared = "example.test/remote-existing/shared", target = "example.test/remote-existing/target";
  try {
    const a = await inventoryFixture(2, [shared, target], true), b = await oldFixture.inventoryFixture(1, [shared], true), remote = bareRemote();
    const aUser = openShardStore({ memoryDir: a.home, user: true, deferPromotions: true });
    try { const result = await syncMemory(aUser, a.opts(remote)); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { aUser.close(); }
    expect(await oldAdmission.applyRealmAdmission(b.home, target, { mode: "apply" })).toMatchObject({ state: "admitted" });
    const bTarget = oldStore.openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
    try { bTarget.note(note("local B before pull", target)); } finally { bTarget.close(); }
    const bUser = reader === "baseline" ? oldStore.openShardStore({ memoryDir: b.home, user: true, deferPromotions: true }) : openShardStore({ memoryDir: b.home, user: true, deferPromotions: true });
    try { const result = await (reader === "baseline" ? oldSync.syncMemory(bUser, b.opts(remote)) : syncMemory(bUser, b.opts(remote))); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { bUser.close(); }
    const bRead = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
    try { const texts = bRead.list({ project: target }).map(row => row.text); expect(texts).toContain(`inventory note for ${target}`); expect(texts).toContain("local B before pull"); } finally { bRead.close(); }
    const aAgain = openShardStore({ memoryDir: a.home, user: true, deferPromotions: true });
    try { const result = await syncMemory(aAgain, a.opts(remote)); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { aAgain.close(); }
    const aRead = openShardStore({ memoryDir: a.home, project: target, deferPromotions: true });
    try { const texts = aRead.list({ project: target }).map(row => row.text); expect(texts).toContain(`inventory note for ${target}`); expect(texts).toContain("local B before pull"); } finally { aRead.close(); }
  } finally { oldFixture.closeInventoryFixtures(); closeInventoryFixtures(); rmSync(oldRoot, { recursive: true, force: true }); }
}, 240_000);
