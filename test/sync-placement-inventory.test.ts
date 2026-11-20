import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "../src/memory/generation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA } from "../src/memory/sync-placement-realm-extension-format.ts";
import { writerInventoryGenesis } from "../src/memory/sync-placement-writer-revision-format.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { readPlacementJournal } from "../src/memory/sync-placement-journal-storage.ts";
import { SyncPlacementJournalError } from "../src/memory/sync-placement-journal-format.ts";
import { placementInventory, placementInventoryBatches, syncPlacementInventory } from "../src/memory/sync-placement-inventory.ts";
import { syncPlacementMemory, type PlacementSyncPhase } from "../src/memory/sync-placement-transport.ts";
import { validatePlacementPublicationRoot } from "../src/memory/sync-placement-publication-plan.ts";
import { SyncProgress, readSyncStatus, renderSyncStatus, syncProgressSidecar } from "../src/memory/sync-progress.ts";
import { bareRemote, closeInventoryFixtures, digest, expectedOrder, expectedRefs, installSyntheticRealm, inventoryFixture, note, refsOf } from "./fakes/sync-placement-inventory.ts";

// Real local-Git round trips over several realms: each test keeps a generous local allowance (global --timeout unchanged).
afterEach(closeInventoryFixtures);
const bare = bareRemote, refs = refsOf;
const json = (value: unknown) => canonicalJSON(value) + "\n";

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

test("#448 AC3: a realm admitted after activation joins the inventory, is openable and is published with the rest", async () => {
  const f = await inventoryFixture(2), markers = readPlacementRuntimeMarkers(f.home), active = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  const admitted = "example.test/placement/admitted-after-activation", keyHash = digest(admitted), generation = active.epoch.generation;
  writeFileSync(join(f.home, "placement-realm-extensions.jsonl"), json(createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: f.epochHash,
    activationHash: active.activation.seal, homeHash: active.epoch.homeHash, generation, sequence: 1, previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal),
    realm: { scope: "project", keyHash, bindingHash: digest("binding") }, sourceHash: digest("source"), aliasesHash: digest("aliases"), policyHash: digest("policy"),
    writerHash: writerInventoryGenesis(f.epochHash, active.activation.seal), journal: { sequence: 0, headHash: f.epochHash } })), { mode: 0o600 });
  // Until its curated shard exists the admitted realm is named, never opened, created or published.
  const staged = placementInventory(f.home);
  expect(staged.missing).toEqual([keyHash]); expect(staged.local.some(realm => realm.scope === "project" && realm.keyHash === keyHash)).toBe(false);
  installSyntheticRealm(f.home, generation, admitted);
  const after = placementInventory(f.home), order = expectedOrder([...f.projects, admitted]);
  expect(after.missing).toEqual([]); expect(after.local.map(realm => realm.scope === "user" ? "user" : realm.keyHash)).toEqual(order);
  // The curated shard path check must now let a write into the admitted realm; before the extension it refused it.
  const realm = openShardStore({ memoryDir: f.home, project: admitted, deferPromotions: true });
  try { realm.note(note("admitted after activation", admitted)); } finally { realm.close(); }
  const remote = bare(), result = await syncMemory(f.entry(), f.opts(remote));
  expect(result.ok).toBe(true);
  expect(result.placementRealms).toContainEqual({ realm: keyHash, outcome: "committed", publication: Math.floor(order.indexOf(keyHash) / 2) + 1 });
  expect(refs(remote)).toEqual(expectedRefs([...f.projects, admitted]));
  // The activation metadata that admitted it is never rewritten by publication.
  const bound = readActivePlacementBinding(f.home, readPlacementRuntimeMarkers(f.home).profile, readPlacementRuntimeMarkers(f.home).shards)!;
  expect(bound.activation.seal).toBe(active.activation.seal); expect(bound.activation.realms).toEqual(active.activation.realms);
}, 240_000);

test("#492 an unknown epoch member is the run's own failure result, not a throw, and it changes nothing", async () => {
  const f = await inventoryFixture(2), remote = bare(), epochs = join(f.home, "sync-placement", "epochs", f.epochHash);
  const before = readdirSync(epochs).sort(), refsBefore = refs(remote), epochBytes = readFileSync(join(epochs, "epoch.json"), "utf8");
  // One retained-epoch member a newer version could write, which this runtime must refuse rather than guess at.
  writeFileSync(join(epochs, "future-placement-history-v99.json"), "{}", { mode: 0o600 });
  try {
    // The journal read itself still refuses: only the sync's answer moves from a throw to its own result shape.
    expect(() => readPlacementJournal(f.home, f.epochHash)).toThrow(SyncPlacementJournalError);
    const result = await syncMemory(f.entry(), f.opts(remote));
    expect(result).toMatchObject({ ok: false, pushed: false, entries: 0, failure: { cause: "unavailable" } });
    expect(result.placementRealms).toEqual([]);
    // The cause names the next step without parsing text; the text is the journal's own fixed refusal message.
    expect(result.error).toContain("restore the exact retained evidence before continuing");
    // Effect-free, as the refusal was before: no ref reached the remote, no epoch byte or member changed, nothing cached.
    expect(refs(remote)).toEqual(refsBefore);
    expect(readdirSync(epochs).sort()).toEqual([...before, "future-placement-history-v99.json"].sort());
    expect(readFileSync(join(epochs, "epoch.json"), "utf8")).toBe(epochBytes);
    expect(existsSync(join(f.home, "shard-sync-placement"))).toBe(false);
  } finally { rmSync(join(epochs, "future-placement-history-v99.json"), { force: true }); }
}, 120_000);

test("#508: local-key realms are held while their partner and later publications sync", async () => {
  const local = "fixture@12345678", choices = Array.from({ length: 100 }, (_, i) => `github.com/example/repo-${i}`);
  const below = choices.filter(key => digest(key) < digest(local)), above = choices.filter(key => digest(key) > digest(local));
  expect(below.length).toBeGreaterThan(0); expect(above.length).toBeGreaterThan(1);
  const projects = [local, below[0]!, above[0]!, above[1]!];
  const f = await inventoryFixture(projects.length, projects), remote = bare(), user = f.entry();
  const seeded = await syncPlacementMemory(user, f.opts(remote), undefined, undefined, undefined, [user]);
  expect(seeded.ok).toBe(true);
  const { remote: _remote, ...implicit } = f.opts(remote);
  const localStore = openShardStore({ memoryDir: f.home, project: local, deferPromotions: true });
  try {
    const refusal = await syncPlacementMemory(localStore, implicit, undefined, undefined, undefined, [localStore]);
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain(local);
    expect(refusal.error).toContain("--remote");
    expect(refusal.error).toContain("amem project archive");
    expect(refusal.placementPublication?.refusal?.category).not.toBe("remote");
  } finally { localStore.close(); }
  const progress = new SyncProgress({ sink: syncProgressSidecar(f.home), intervalMs: 0 });
  const result = await syncMemory(user, { ...implicit, progress });
  expect(result.ok).toBe(true);
  expect(result.placementRealms).toContainEqual({ realm: digest(local), outcome: "held" });
  expect(readSyncStatus(f.home).operations[0]!.inventory!.outcomes).toContainEqual({ realm: digest(local).slice(0, 16), outcome: "held" });
  expect(result.warning).toContain(local);
  expect(result.placementRealms!.filter(row => row.realm !== digest(local) && row.realm !== "user").every(row => row.outcome === "committed")).toBe(true);
  expect(refs(remote)).toEqual(expectedRefs(projects.filter(project => project !== local)));
}, 240_000);

test("#508: retained local-key publication is not reshaped without opt-in", async () => {
  const local = "fixture@12345678", f = await inventoryFixture(1, [local]), remote = bare(), user = f.entry();
  const target = openShardStore({ memoryDir: f.home, project: local, deferPromotions: true });
  try {
    const interrupted = await syncPlacementMemory(user, f.opts(remote), phase => { if (phase === "plan-fsynced") throw Error("fixture interruption"); }, undefined, undefined, [user, target]);
    expect(interrupted.ok).toBe(false);
    const before = f.plans(); expect(before).toHaveLength(1);
    const { remote: _remote, ...implicit } = f.opts(remote);
    const result = await syncMemory(user, implicit);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(local);
    expect(result.placementRealms).toContainEqual({ realm: digest(local), outcome: "held" });
    expect(f.plans()).toEqual(before);
    expect(refs(remote)).toEqual([]);
  } finally { target.close(); }
}, 240_000);
