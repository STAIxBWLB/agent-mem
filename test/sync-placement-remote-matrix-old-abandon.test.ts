import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openShardStore } from "../src/memory/store.ts";
import { shardDir } from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture } from "./fakes/sync-placement-inventory.ts";

afterEach(closeInventoryFixtures);
const privateVisibility = async () => "private" as const;
async function sync(home: string, opts: Parameters<typeof syncMemory>[1]) {
  const user = openShardStore({ memoryDir: home, user: true, deferPromotions: true });
  try { return await syncMemory(user, opts); } finally { user.close(); }
}

for (const stage of ["after-intent", "after-metadata", "after-proof"] as const) test(`new resume survives older confirmed abandon at ${stage}`, async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const oldRoot = mkdtempSync(join(tmpdir(), "amem-029-remote-abandon-"));
  const archive = Bun.spawnSync(["git", "archive", "57a4ace57bdf5c4fc12996146c76843de4ee21cc"], { stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode, archive.stderr.toString()).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", oldRoot], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  expect(extract.exitCode, extract.stderr.toString()).toBe(0);
  const oldAdmission = await import(pathToFileURL(join(oldRoot, "src/memory/sync-placement-realm-admission.ts")).href);
  const shared = "example.test/adoption-old-abandon/shared", target = "example.test/adoption-old-abandon/target";
  try {
    const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote(); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
      const b = await inventoryFixture(1, [shared], true, [oldRoot]); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
      await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: at => {
        if (at === stage) throw Error("isolated crash seam");
      } })).rejects.toThrow();
      expect(await oldAdmission.applyRealmAdmission(b.home, target, { mode: "abandon", confirm: true })).toMatchObject({ state: "abandoned" });
      expect(await remoteRealmAdmission(b.home, target, { mode: "resume", visibility: privateVisibility })).toMatchObject({ state: "admitted" });
      const targetStore = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
      try { expect(targetStore.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { targetStore.close(); }
  } finally { rmSync(oldRoot, { recursive: true, force: true }); }
}, 240_000);

