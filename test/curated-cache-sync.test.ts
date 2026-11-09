import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBriefCache } from "../src/brief-cache.ts";
import { machineId, MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { applyPrune, planPrune } from "../src/memory/prune.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { shardMachineDir } from "../src/memory/shard.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";

const dirs: string[] = [], cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const G = "b".repeat(32), privateRemote = { visibility: async () => "private" as const };
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-curated-cache-sync-"))); dirs.push(dir); return dir; }
function git(dir: string, ...args: string[]) {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sync fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}
function remote() { const dir = temp(); git(dir, "init", "-q", "--bare"); return dir; }
function note(project: string, text: string): NoteInput {
  return { op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text, about: [] };
}
function cache(store: MemoryStore, project: string) {
  const directory = shardMachineDir(store.profile.home, project, machineId(store.profile.home).id);
  return readBriefCache({ directory, project, section: "curated" });
}
function track(store: MemoryStore) { cleanup.push(() => store.close()); return store; }

test("shared-v1 sync pull publishes curated cache and removes forgotten rows", async () => {
  const url = remote(), homeA = temp(), homeB = temp(), project = "curated/shared-v1";
  const a = track(new MemoryStore({ home: homeA, deferPromotions: true })), b = track(new MemoryStore({ home: homeB, deferPromotions: true }));
  const forgotten = a.note(note(project, "forget this cached row"));
  expect(await syncMemory(a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(await syncMemory(b, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(cache(b, project)?.rows.some(row => (row.source as { id: string }).id === forgotten)).toBe(true);
  a.forget(forgotten, "person", project);
  expect(await syncMemory(a, privateRemote)).toMatchObject({ ok: true });
  expect(await syncMemory(b, privateRemote)).toMatchObject({ ok: true });
  const current = cache(b, project)!;
  expect(current.curated).toBeDefined();
  expect(current.rows.some(row => (row.source as { id: string }).id === forgotten)).toBe(false);
});

test("generation sync pull publishes the current curated cache after a forget", async () => {
  const url = remote(), project = "curated/generation";
  const side = async () => {
    const home = temp(), seed = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true }), memoryDir = seed.dir; seed.close();
    await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
    return track(new MemoryStore({ home, profile: { generation: G }, deferPromotions: true }));
  };
  const a = await side(), b = await side();
  const forgotten = a.note(note(project, "generation forget target"));
  expect(await syncMemory(a, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(await syncMemory(b, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(cache(b, project)?.rows.some(row => (row.source as { id: string }).id === forgotten)).toBe(true);
  a.forget(forgotten, "person", project);
  expect(await syncMemory(a, privateRemote)).toMatchObject({ ok: true });
  expect(await syncMemory(b, privateRemote)).toMatchObject({ ok: true });
  expect(cache(b, project)?.rows.some(row => (row.source as { id: string }).id === forgotten)).toBe(false);
});

test("sharded sync pull publishes cache without a publicly pruned row", async () => {
  const url = remote(), project = "curated/sharded";
  const side = async () => {
    const home = temp(), legacy = new MemoryStore({ home, profile: "shared-v1", deferPromotions: true });
    const memoryDir = legacy.dir; legacy.close();
    await migrateShards({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
    await activatePublicPruneView({ memoryDir, mode: "apply", authorizedPerson: true, tty: true });
    const clock = { now: Date.now() }, store = track(openShardStore({ home, project, deferPromotions: true, ttlMs: 1000, now: () => clock.now }));
    return { home, store, clock };
  };
  const a = await side(), b = await side(), target = a.store.note(note(project, "pruned cached row"));
  expect(await syncMemory(a.store, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(await syncMemory(b.store, { remote: url, ...privateRemote })).toMatchObject({ ok: true });
  expect(cache(b.store, project)?.rows.some(row => (row.source as { id: string }).id === target)).toBe(true);
  expect(a.store.demote(target, "person", project)).toBeDefined(); a.clock.now += 2000;
  const authorization = { project, actor: "person" as const, authorize: () => true,
    policy: { revision: () => "curated-cache-sync-v1", classify: () => "public" as const, attest: () => true } };
  const plan = planPrune(a.store.prunePort(), { cutoff: new Date(a.clock.now).toISOString(), targets: [target] }, authorization);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("synced");
  expect(applyPrune(a.store.prunePort(), plan, authorization).completed).toContain(plan.rows[0]!.payload.id);
  expect(await syncMemory(a.store, privateRemote)).toMatchObject({ ok: true });
  expect(await syncMemory(b.store, privateRemote)).toMatchObject({ ok: true });
  const current = cache(b.store, project)!;
  expect(current.curated).toBeDefined();
  expect(current.rows.some(row => (row.source as { id: string }).id === target)).toBe(false);
});
