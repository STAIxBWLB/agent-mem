import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openShardStore } from "../src/memory/store.ts";
import { applyPrune, planPrune } from "../src/memory/prune.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { prepareRemotePlacementRealm } from "../src/memory/sync-placement-transport.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture, note } from "./fakes/sync-placement-inventory.ts";

const BASELINE = "57a4ace57bdf5c4fc12996146c76843de4ee21cc";
for (const reader of ["baseline", "current", "remote-admission"] as const) test(`a strict staged subset accepts foreign prune history with ${reader} source`, async () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "amem-029-prune-"));
  const archive = Bun.spawnSync(["git", "archive", BASELINE], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", oldRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0);
  const moduleAt = (path: string) => pathToFileURL(join(oldRoot, path)).href;
  const oldFixture = await import(moduleAt("test/fakes/sync-placement-inventory.ts"));
  const oldStore = await import(moduleAt("src/memory/store.ts"));
  const oldShard = await import(moduleAt("src/memory/shard.ts"));
  const oldAdmission = await import(moduleAt("src/memory/sync-placement-realm-admission.ts"));
  const oldSync = await import(moduleAt("src/memory/sync.ts"));
  const shared = "example.test/remote-prune/shared", target = "example.test/remote-prune/target", start = Date.now();
  let now = start;
  try {
    const a = await inventoryFixture(1, [target], true), b = reader === "baseline"
      ? await oldFixture.inventoryFixture(1, [shared], true) : await inventoryFixture(1, [shared], true), remote = bareRemote();
    const source = openShardStore({ memoryDir: a.home, project: target, deferPromotions: true, ttlMs: 1000, now: () => now });
    try {
      const masked = source.note(note("remote pruned target", target)), safe = source.note(note("remote safe subset", target));
      const publish = async () => { const user = openShardStore({ memoryDir: a.home, user: true, deferPromotions: true }); try { const result = await syncMemory(user, a.opts(remote)); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { user.close(); } };
      await publish();
      expect(source.demote(masked, "person", target)).toBeDefined(); await publish();
      now += 2000;
      const auth = { project: target, actor: "person" as const, authorize: () => true, policy: { revision: () => "probe", classify: () => "public" as const, attest: () => true } };
      const plan = planPrune(source.prunePort(), { cutoff: new Date(now).toISOString(), targets: [masked] }, auth);
      expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("synced");
      expect(applyPrune(source.prunePort(), plan, auth).completed).toContain(plan.rows[0]!.payload.id);
      await publish();
      const existing = oldStore.openShardStore({ memoryDir: b.home, user: true, deferPromotions: true });
      try { const result = await oldSync.syncMemory(existing, b.opts(remote)); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { existing.close(); }
      const preview = await prepareRemotePlacementRealm(b.home, target, { visibility: async () => "private" });
      expect(preview.plan.omitted).toBeGreaterThanOrEqual(2);
      const staged = preview.packs.flatMap(pack => pack.bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string }));
      expect(staged.some(row => row.id === safe)).toBe(true); expect(staged.some(row => row.id === masked)).toBe(false);
      if (reader === "remote-admission") {
        const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
        expect(await remoteRealmAdmission(b.home, target, { mode: "apply", visibility: async () => "private" })).toMatchObject({ state: "admitted", omitted: preview.plan.omitted });
      } else {
        oldShard.ensureShardDescriptor(b.home, target); const log = join(oldShard.shardDir(b.home, target), "log"); mkdirSync(log, { recursive: true, mode: 0o700 });
        for (const pack of preview.packs) writeFileSync(join(log, pack.name), pack.bytes, { mode: 0o600 });
        const admission = reader === "baseline" ? oldAdmission : await import("../src/memory/sync-placement-realm-admission.ts");
        expect(await admission.applyRealmAdmission(b.home, target, { mode: "apply" })).toMatchObject({ state: "admitted" });
      }
      const before = oldStore.openShardStore({ memoryDir: b.home, project: target, deferPromotions: true, now: () => start });
      try { expect(before.get(masked, target)).toBeUndefined(); expect(before.get(safe, target)?.text).toBe("remote safe subset"); } finally { before.close(); }
      const bUser = reader === "baseline" ? oldStore.openShardStore({ memoryDir: b.home, user: true, deferPromotions: true }) : openShardStore({ memoryDir: b.home, user: true, deferPromotions: true });
      try { const result = await (reader === "baseline" ? oldSync.syncMemory(bUser, b.opts(remote)) : syncMemory(bUser, b.opts(remote))); expect(result.ok, JSON.stringify(result)).toBe(true); } finally { bUser.close(); }
      const after = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true, now: () => start });
      try {
        expect(after.get(masked, target)).toBeUndefined(); expect(after.get(safe, target)?.text).toBe("remote safe subset");
        expect(after.prunePort().snapshot().pruned).toContain(masked);
        const incremental = after.derivedTables(); after.rebuild(); expect(after.derivedTables()).toEqual(incremental);
      } finally { after.close(); }
    } finally { source.close(); }
  } finally { oldFixture.closeInventoryFixtures(); closeInventoryFixtures(); rmSync(oldRoot, { recursive: true, force: true }); }
}, 240_000);
