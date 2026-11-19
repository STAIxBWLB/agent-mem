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

for (const action of ["resume"] as readonly ("resume" | "abandon")[]) for (const stage of ["after-companion", "after-stage", "after-install", "after-intent", "after-metadata", "after-proof", "after-append", "after-admission"] as const) test(`remote admission resume at ${stage} preserves the durable boundary`, async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const { readPlacementRuntimeMarkers } = await import("../src/memory/sync-placement-guard.ts");
  const { readActivePlacementBinding } = await import("../src/memory/sync-placement-active.ts");
  const { readEffectiveRealmInventory } = await import("../src/memory/sync-placement-realm-effective.ts");
  const { createHash } = await import("node:crypto");
  const shared = "example.test/adoption-crash/shared", target = "example.test/adoption-crash/target";
  const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
    const b = await inventoryFixture(1, [shared], true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
    const work = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { await work.write("existing", { task: "keep across crash" }); } finally { work.close(); }
    await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: at => {
      if (at === stage) throw Error("isolated crash seam");
    } })).rejects.toThrow();
    const result = await remoteRealmAdmission(b.home, target, { mode: action, ...(action === "abandon" ? { confirm: true } : {}), visibility: privateVisibility });
    const afterCommit = stage === "after-append" || stage === "after-admission", committed = action === "resume" || afterCommit;
    expect(result.state).toBe(committed ? (afterCommit ? "already-admitted" : "admitted") : "abandoned");
    const markers = readPlacementRuntimeMarkers(b.home), binding = readActivePlacementBinding(b.home, markers.profile, markers.shards)!;
    const realm = createHash("sha256").update(target).digest("hex");
    expect(readEffectiveRealmInventory(b.home, binding).realms.some(item => item.scope === "project" && item.keyHash === realm)).toBe(committed);
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-remote-adoption-")).length).toBe(0);
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-realm-intent-")).length).toBe(0);
    const restored = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { expect((await restored.read())[0]?.items[0]?.task).toBe("keep across crash"); } finally { restored.close(); }
    if (committed) {
      const reader = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
      try { expect(reader.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { reader.close(); }
    }
}, 240_000);

