import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { openShardStore } from "../src/memory/store.ts";
import { shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture } from "./fakes/sync-placement-inventory.ts";

afterEach(closeInventoryFixtures);
const privateVisibility = async () => "private" as const;
async function sync(home: string, opts: Parameters<typeof syncMemory>[1]) {
  const user = openShardStore({ memoryDir: home, user: true, deferPromotions: true });
  try { return await syncMemory(user, opts); } finally { user.close(); }
}

test("remote-only realm is explicitly previewed and admitted without changing existing work", async () => {
  const shared = "example.test/adoption/shared", target = "example.test/adoption/target";
  const a = await inventoryFixture(2, [shared, target], true), b = await inventoryFixture(1, [shared], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
  const work = new WorkListStore({ base: b.home, project: target, policy: () => true });
  try { await work.write("existing", { task: "preserved local work" }); } finally { work.close(); }
  const project = shardDir(b.home, target), before = readFileSync(join(project, "project.json")), prior = process.env.AMEM_HOME; process.env.AMEM_HOME = b.home;
  try {
    const invoke = (args: string[]) => runCli(args, { cwd: b.root, env: {}, visibility: privateVisibility });
    const listing = JSON.parse(await invoke(["migrate", "--sync-placement", "--list-remote", "--json"]));
    expect(listing.realms).toContainEqual({ scope: "project", keyHash: shardKeyHash(target) });
    const dry = await invoke(["migrate", "--sync-placement", "--admit", target, "--from-remote", "--dry-run", "--json"]);
    const preview = JSON.parse(dry); expect(preview.state).toBe("preview"); expect(preview.omitted).toBe(0); expect(preview.remoteHead).toMatch(/^[a-f0-9]{40}$/);
    expect(dry).not.toContain(target); expect(dry).not.toContain(remote); expect(existsSync(join(project, "generation.json"))).toBe(false);
    const applied = JSON.parse(await invoke(["migrate", "--sync-placement", "--admit", target, "--from-remote", "--apply", "--json"]));
    expect(applied).toMatchObject({ state: "admitted", omitted: 0, nextStep: "amem sync" });
    expect(readFileSync(join(project, "project.json"))).toEqual(before);
    const workAgain = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { expect((await workAgain.read())[0]?.items[0]?.task).toBe("preserved local work"); } finally { workAgain.close(); }
    const targetStore = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
    try { expect(targetStore.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { targetStore.close(); }
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-remote-adoption-")).length).toBe(0);
    expect((await sync(b.home, b.opts(remote))).ok).toBe(true); expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
}, 240_000);

test("remote admission resumes or abandons each durable staging boundary", async () => {
  const { remoteRealmAdmission } = await import("../src/memory/sync-placement-remote-admission.ts");
  const { readPlacementRuntimeMarkers } = await import("../src/memory/sync-placement-guard.ts");
  const { readActivePlacementBinding } = await import("../src/memory/sync-placement-active.ts");
  const { readEffectiveRealmInventory } = await import("../src/memory/sync-placement-realm-effective.ts");
  const { createHash } = await import("node:crypto");
  const shared = "example.test/adoption-crash/shared", target = "example.test/adoption-crash/target";
  const a = await inventoryFixture(2, [shared, target], true), remote = bareRemote();
  expect((await sync(a.home, a.opts(remote))).ok).toBe(true);
  for (const action of ["resume", "abandon"] as const) for (const stage of ["after-companion", "after-stage", "after-install", "after-admission"] as const) {
    const b = await inventoryFixture(1, [shared], true); expect((await sync(b.home, b.opts(remote))).ok).toBe(true);
    const work = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { await work.write("existing", { task: "keep across crash" }); } finally { work.close(); }
    await expect(remoteRealmAdmission(b.home, target, { mode: "apply", visibility: privateVisibility, checkpoint: at => {
      if (at === stage) throw Error("isolated crash seam");
    } })).rejects.toThrow();
    const result = await remoteRealmAdmission(b.home, target, { mode: action, ...(action === "abandon" ? { confirm: true } : {}), visibility: privateVisibility });
    const committed = action === "resume" || stage === "after-admission";
    expect(result.state).toBe(committed ? (stage === "after-admission" ? "already-admitted" : "admitted") : "abandoned");
    const markers = readPlacementRuntimeMarkers(b.home), binding = readActivePlacementBinding(b.home, markers.profile, markers.shards)!;
    const realm = createHash("sha256").update(target).digest("hex");
    expect(readEffectiveRealmInventory(b.home, binding).realms.some(item => item.scope === "project" && item.keyHash === realm)).toBe(committed);
    expect(readdirSync(b.home).filter(name => name.startsWith("placement-remote-adoption-")).length).toBe(0);
    const restored = new WorkListStore({ base: b.home, project: target, policy: () => true });
    try { expect((await restored.read())[0]?.items[0]?.task).toBe("keep across crash"); } finally { restored.close(); }
    if (committed) {
      const reader = openShardStore({ memoryDir: b.home, project: target, deferPromotions: true });
      try { expect(reader.list({ project: target }).map(row => row.text)).toContain(`inventory note for ${target}`); } finally { reader.close(); }
    }
  }
}, 240_000);
