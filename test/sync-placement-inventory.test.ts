import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { syncMemory, type SyncOptions } from "../src/memory/sync.ts";
import { placementInventory, placementInventoryBatches, syncPlacementInventory } from "../src/memory/sync-placement-inventory.ts";
import { syncPlacementMemory, type PlacementSyncPhase } from "../src/memory/sync-placement-transport.ts";
import { validatePlacementPublicationRoot } from "../src/memory/sync-placement-publication-plan.ts";
import { SyncProgress, readSyncStatus, renderSyncStatus, syncProgressSidecar } from "../src/memory/sync-progress.ts";

// Real local-Git round trips over several realms: each test keeps a generous local allowance (global --timeout unchanged).
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const temp = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-placement-inventory-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const git = (dir: string, ...args: string[]) => { const r = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" }); if (r.status !== 0) throw Error(`git ${args[0]} failed`); return r.stdout.trim(); };
const bare = () => { const dir = temp(); git(dir, "init", "--bare", "-q"); return dir; };
const json = (value: unknown) => canonicalJSON(value) + "\n";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const note = (text: string, project: string, scope: "project" | "shared" = "project"): NoteInput => ({ op: "note", project, scope, tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
const refs = (remote: string) => git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter(Boolean).sort();
let generations = 900;

/** One activated home with the user realm and `count` project realms, prepared through the real APIs (like the transport fixture). */
export async function inventoryFixture(count: number) {
  const root = temp(), home = join(root, "memory"), projects = Array.from({ length: count }, (_, index) => `example.test/placement/inventory-${String(index).padStart(2, "0")}`);
  const seed = new MemoryStore({ memoryDir: home, deferPromotions: true });
  try {
    seed.note(note("inventory shared fact", projects[0]!, "shared"));
    for (const project of projects) seed.note(note(`inventory note for ${project}`, project));
  } finally { seed.close(); }
  const generation = (++generations).toString(16).padStart(32, "0");
  expect(await migrateShards({ memoryDir: home, generation, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  writeFileSync(join(home, "amem.config.json"), json({ piiPatterns: ["NEVER_PUBLIC_"] }), { mode: 0o600 });
  const port: PlacementJournalPort = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }),
    policyVersion: () => "initial", authorize: () => true };
  const preview = planPlacementJournal(home, port), { epochHash } = preparePlacementJournal(home, preview, port);
  const oldShards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")), profile = preview.plan.targetProfile;
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), json({ ...oldShards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
  const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home); if (!mutation) throw Error("synthetic home mutation unavailable");
  try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
  const opts = (remote: string): SyncOptions => ({ remote, visibility: async () => "private", placementAttestation: port.attest, policyVersion: port.policyVersion });
  const plans = () => readdirSync(join(home, "sync-placement", "epochs", epochHash)).filter(name => /^publication-[a-f0-9]{64}-root\.json$/.test(name)).sort();
  const entry = () => { const store = openShardStore({ memoryDir: home, user: true, deferPromotions: true }); cleanup.push(() => store.close()); return store; };
  return { root, home, projects, epochHash, opts, plans, entry };
}
const expectedRefs = (projects: readonly string[]) => ["refs/heads/amem/u", ...projects.map(project => `refs/heads/amem/p/${shardKeyHash(project)}`)].sort();
/** Every realm order after the user realm is by full key hash. */
const expectedOrder = (projects: readonly string[]) => ["user", ...projects.map(digest).sort()];

test("#450 the inventory runs in sorted two-realm publications, user first, independent of the entry store", async () => {
  const f = await inventoryFixture(4), { local } = placementInventory(f.home);
  expect(local.map(realm => realm.scope === "user" ? "user" : realm.keyHash)).toEqual(expectedOrder(f.projects));
  expect(placementInventoryBatches(local).map(batch => batch.length)).toEqual([2, 2, 1]);
  const remote = bare(), result = await syncMemory(f.entry(), f.opts(remote));
  expect(result.ok).toBe(true);
  expect(result.placementRealms!.map(item => item.realm)).toEqual(expectedOrder(f.projects));
  expect(result.placementRealms!.map(item => item.publication)).toEqual([1, 1, 2, 2, 3]);
  expect(result.placementRealms!.every(item => item.outcome === "committed")).toBe(true);
  expect(refs(remote)).toEqual(expectedRefs(f.projects));
  // Every retained plan still validates under the unchanged at-most-two-target format that 0.28.x reads.
  for (const name of f.plans()) {
    const root = validatePlacementPublicationRoot(JSON.parse(readFileSync(join(f.home, "sync-placement", "epochs", f.epochHash, name), "utf8")));
    expect(root.targets.length).toBeLessThanOrEqual(2);
  }
  expect(f.plans()).toHaveLength(3);
  const again = await syncMemory(f.entry(), f.opts(remote));
  expect(again.ok).toBe(true); expect(again.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
}, 240_000);

test("#450 AC3: a crash inside the second publication stops before the third, reports published vs not-run, and a rerun resumes the retained publication first", async () => {
  const f = await inventoryFixture(4), remote = bare();
  const progress = new SyncProgress({ sink: syncProgressSidecar(f.home), intervalMs: 0 });
  let publication = 0;
  const open = (realm: Parameters<Parameters<typeof syncPlacementInventory>[2]["open"]>[0]) => openShardStore({ memoryDir: f.home, deferPromotions: true, ...(realm.scope === "user" ? { user: true } : { project: realm.key }) });
  const crashed = await syncPlacementInventory(f.home, { ...f.opts(remote), progress }, { open, close: store => store.close(), publish: (primary, targets, options) => {
    publication++;
    return syncPlacementMemory(primary, options, (at: PlacementSyncPhase) => { if (publication === 2 && at === "cas-returned") throw Error("synthetic second-publication crash"); }, undefined, undefined, targets);
  } });
  expect(crashed.ok).toBe(false);
  const order = expectedOrder(f.projects), outcomes = crashed.placementRealms!.map(item => item.outcome);
  expect(crashed.placementRealms!.map(item => item.realm)).toEqual(order);
  expect(outcomes.slice(0, 2)).toEqual(["committed", "committed"]);
  expect(outcomes.slice(2, 4).every(outcome => outcome === "unknown" || outcome === "failed")).toBe(true);
  expect(outcomes[4]).toBe("not-run");
  const status = readSyncStatus(f.home).operations[0]!;
  expect(status).toMatchObject({ state: "failed", cause: "unknown-outcome", inventory: { publications: 3, completed: 1, realms: 5 } });
  expect(status.inventory!.outcomes).toEqual(crashed.placementRealms!.map(item => ({ realm: item.realm === "user" ? "user" : item.realm.slice(0, 16), outcome: item.outcome })));
  expect(publication).toBe(2);
  const retained = f.plans();
  const resumed = await syncMemory(f.entry(), f.opts(remote));
  expect(resumed.ok).toBe(true);
  // The retained second publication runs first, through its own realms; then the rest in the usual order (already published ones are not-needed).
  expect(resumed.placementRealms!.map(item => item.realm)).toEqual([...order.slice(2, 4), ...order.slice(0, 2), ...order.slice(4)]);
  expect(resumed.placementRealms!.map(item => item.publication)).toEqual([1, 1, 2, 2, 3]);
  expect(resumed.placementRealms!.slice(2, 4).every(item => item.outcome === "not-needed")).toBe(true);
  expect(f.plans().filter(name => retained.includes(name))).toEqual(retained);
  expect(refs(remote)).toEqual(expectedRefs(f.projects));
}, 240_000);

test("#450 AC2: per-realm outcomes reach `sync --status` through the sidecar, counts and hashes only", async () => {
  const f = await inventoryFixture(3), remote = bare();
  const progress = new SyncProgress({ sink: syncProgressSidecar(f.home), intervalMs: 0 });
  const result = await syncMemory(f.entry(), { ...f.opts(remote), progress });
  expect(result.ok).toBe(true);
  const [operation] = readSyncStatus(f.home).operations;
  expect(operation!.state).toBe("succeeded");
  expect(operation!.inventory).toMatchObject({ publications: 2, completed: 2, realms: 4 });
  expect(operation!.inventory!.outcomes!.map(item => item.realm)).toEqual(expectedOrder(f.projects).map(realm => realm === "user" ? realm : realm.slice(0, 16)));
  const text = renderSyncStatus(readSyncStatus(f.home));
  expect(text).toContain("publications 2/2 over 4 realms");
  for (const project of f.projects) expect(text).not.toContain(project);
}, 240_000);

test("#450: an inventory realm without a local curated shard is a named not-local outcome and is never opened", async () => {
  const f = await inventoryFixture(3), gone = f.projects[1]!, remote = bare();
  // Synthetic: this machine never received the shard (temp fixture only).
  rmSync(join(shardDir(f.home, gone), "generation.json"));
  const inventory = placementInventory(f.home);
  expect(inventory.missing).toEqual([digest(gone)]);
  expect(inventory.local.map(realm => realm.scope === "user" ? "user" : realm.keyHash)).not.toContain(digest(gone));
  const progress = new SyncProgress({ sink: syncProgressSidecar(f.home), intervalMs: 0 });
  const result = await syncMemory(f.entry(), { ...f.opts(remote), progress });
  expect(result.ok).toBe(true);
  expect(result.placementRealms).toContainEqual({ realm: digest(gone), outcome: "not-local" });
  expect(refs(remote)).not.toContain(`refs/heads/amem/p/${shardKeyHash(gone)}`);
  const text = renderSyncStatus(readSyncStatus(f.home));
  expect(text).toContain(`${digest(gone).slice(0, 16)}=not-local`); expect(text).not.toContain(gone);
}, 240_000);

test("#450: cancellation between publications records remaining realms before the terminal status", async () => {
  const f = await inventoryFixture(4), remote = bare(), controller = new AbortController();
  const progress = new SyncProgress({ sink: syncProgressSidecar(f.home), intervalMs: 0 });
  const open = (realm: Parameters<Parameters<typeof syncPlacementInventory>[2]["open"]>[0]) => openShardStore({ memoryDir: f.home, deferPromotions: true, ...(realm.scope === "user" ? { user: true } : { project: realm.key }) });
  let publications = 0;
  const result = await syncPlacementInventory(f.home, { ...f.opts(remote), progress, signal: controller.signal }, {
    open, close: store => store.close(), publish: async (primary, targets, options) => {
      const published = await syncPlacementMemory(primary, options, undefined, undefined, undefined, targets);
      if (++publications === 1) controller.abort();
      return published;
    },
  });
  expect(result.ok).toBe(false); expect(publications).toBe(1);
  expect(result.placementRealms.map(item => item.outcome)).toEqual(["committed", "committed", "not-run", "not-run", "not-run"]);
  const status = readSyncStatus(f.home).operations[0]!;
  expect(status).toMatchObject({ state: "cancelled", cause: "cancelled", inventory: { publications: 3, completed: 1, realms: 5 } });
  expect(status.inventory!.outcomes!.map(item => item.outcome)).toEqual(result.placementRealms.map(item => item.outcome));
}, 240_000);
