/**
 * #450: one `amem sync` under an active placement covers the whole activated realm inventory, not only the cwd binding.
 *
 * The persisted publication plan still holds at most two targets (0.28.x readers validate exactly that), so the inventory
 * runs as sequential publications of at most two realms each. Atomicity, journal, reservation and crash recovery are those
 * of one publication, unchanged; nothing is atomic across the whole inventory. Order is deterministic: the user realm is
 * in the first publication, then project realms by key hash. A publication that does not succeed stops the run before the
 * next one. A retained publication reservation is resumed first, through its own realms, before any new publication.
 *
 * ponytail: ceil(N/2) publications. One N-target plan behind an explicitly raised `sync` floor is the upgrade path.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readPlacementJournal } from "./sync-placement-journal-storage.ts";
import { readPlacementPublication } from "./sync-placement-publication-storage.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { readShardDescriptor, shardDir, userShardDir } from "./shard.ts";
import { projectState } from "./lifecycle.ts";
import type { PlacementRealm } from "./sync-placement-journal-format.ts";
import type { SyncOptions, SyncResult } from "./sync.ts";
import type { MemoryStore } from "./store.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const PUBLICATION_TARGETS = 2;

/** One activated realm with its local key (the project key is resolved from the local descriptor; user has none). */
export type InventoryRealm = { scope: "user" } | { scope: "project"; key: string; keyHash: string };
export type PlacementRealmOutcome = "committed" | "not-needed" | "unknown" | "failed" | "not-run" | "not-local" | "inactive";
/** Per-realm receipt: identifiers only (the user realm or the full key hash), never a project name, row or path. */
export interface PlacementRealmResult { realm: "user" | string; outcome: PlacementRealmOutcome; publication?: number }

const label = (realm: PlacementRealm | InventoryRealm): string => realm.scope === "user" ? "user" : realm.keyHash;

/** The effective activated inventory in publication order; realms without a local curated shard are reported, never opened or initialized.
 * The inventory is the effective one (#448): a realm admitted after activation by an appended extension joins it exactly like an activated realm.
 */
export function placementInventory(home: string): { local: InventoryRealm[]; missing: string[]; inactive: string[] } {
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!active) throw new Error("sync placement activation metadata unavailable or changed; inspect the retained activation before continuing");
  const { realms } = readEffectiveRealmInventory(home, active);
  const local: InventoryRealm[] = [], missing: string[] = [], inactive: string[] = [];
  for (const realm of realms) {
    if (realm.scope === "user") { if (existsSync(join(userShardDir(home), "generation.json"))) local.unshift({ scope: "user" }); else missing.push("user"); continue; }
    const descriptor = readShardDescriptor(home, realm.keyHash.slice(0, 16));
    if (!descriptor || digest(descriptor.key) !== realm.keyHash || !lstatSync(join(shardDir(home, descriptor.key), "generation.json"), { throwIfNoEntry: false })) { missing.push(realm.keyHash); continue; }
    // An archived or forgotten project is never opened for publication; its realm is reported and left as it is.
    if (projectState(home, descriptor.key) !== "active") { inactive.push(realm.keyHash); continue; }
    local.push({ scope: "project", key: descriptor.key, keyHash: realm.keyHash });
  }
  const user = local.filter(realm => realm.scope === "user"), projects = local.filter((realm): realm is Extract<InventoryRealm, { scope: "project" }> => realm.scope === "project")
    .sort((a, b) => a.keyHash < b.keyHash ? -1 : a.keyHash > b.keyHash ? 1 : 0);
  return { local: [...user, ...projects], missing: missing.sort(), inactive: inactive.sort() };
}

/** Deterministic publication batches of at most two realms; the user realm is always in the first. */
export function placementInventoryBatches(realms: readonly InventoryRealm[]): InventoryRealm[][] {
  const batches: InventoryRealm[][] = [];
  for (let at = 0; at < realms.length; at += PUBLICATION_TARGETS) batches.push(realms.slice(at, at + PUBLICATION_TARGETS));
  return batches;
}

export interface PlacementInventoryPorts {
  /** Opens exactly one realm's curated shard (no user overlay, no alias stores). */
  open(realm: InventoryRealm): MemoryStore;
  /** Releases a store from `open`; a store the caller already held is left open. */
  close(store: MemoryStore): void;
  /** Runs one unchanged two-target placement publication over the given opened stores. */
  publish(primary: MemoryStore, targets: readonly MemoryStore[], opts: SyncOptions): Promise<SyncResult>;
}

function sum(results: readonly SyncResult[]): Pick<SyncResult, "entries" | "pushed"> & { exported: number; withheld: number } {
  return { entries: results.reduce((n, r) => n + r.entries, 0), pushed: results.some(r => r.pushed),
    exported: results.reduce((n, r) => n + (r.placementPublication?.exported ?? 0), 0), withheld: results.reduce((n, r) => n + (r.placementPublication?.withheld ?? 0), 0) };
}

/** Retained publication realms (by label), when a reservation exists; resumed before any new publication. */
function retainedRealms(home: string): string[] | undefined {
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!active) return undefined;
  const reservation = readPlacementJournal(home, active.profile.placementHead).publicationReservation;
  if (!reservation) return undefined;
  return readPlacementPublication(home, active.profile.placementHead, reservation.attemptHash).bundle.root.targets.map(target => label(target.realm));
}

export async function syncPlacementInventory(home: string, opts: SyncOptions, ports: PlacementInventoryPorts): Promise<SyncResult & { placementRealms: PlacementRealmResult[] }> {
  const { local, missing, inactive } = placementInventory(home);
  const retained = retainedRealms(home);
  let order = local;
  if (retained) {
    // The retained plan names its own realms; it runs first, exactly as recorded, then the rest in the usual order.
    const first = retained.map(name => local.find(realm => label(realm) === name));
    if (first.some(realm => !realm)) throw new Error("a retained placement publication names a realm without a local curated shard; inspect it before continuing");
    order = [...first as InventoryRealm[], ...local.filter(realm => !retained.includes(label(realm)))];
  }
  const batches = retained ? [order.slice(0, retained.length), ...placementInventoryBatches(order.slice(retained.length))] : placementInventoryBatches(order);
  const realms: PlacementRealmResult[] = [...missing.map(realm => ({ realm, outcome: "not-local" as const })), ...inactive.map(realm => ({ realm, outcome: "inactive" as const }))];
  const progress = opts.progress, total = batches.filter(batch => batch.length).length;
  // One reporter for the whole run: each publication reports its phases, but only this driver reports the terminal state.
  const report = (completed: number) => progress?.inventory({ publications: total, completed, realms: order.length,
    outcomes: realms.map(item => ({ realm: item.realm === "user" ? "user" : item.realm.slice(0, 16), outcome: item.outcome })) });
  progress?.deferFinish(true); report(0);
  let completed = 0;
  const results: SyncResult[] = [];
  let stopped: SyncResult | undefined;
  for (const [index, batch] of batches.entries()) {
    if (!batch.length) continue;
    if (stopped) { for (const realm of batch) realms.push({ realm: label(realm), outcome: "not-run" }); continue; }
    if (opts.signal?.aborted) { stopped = { ok: false, pushed: false, entries: 0, error: "stopped" }; for (const realm of batch) realms.push({ realm: label(realm), outcome: "not-run" }); continue; }
    const stores: MemoryStore[] = [];
    let result: SyncResult;
    try {
      for (const realm of batch) stores.push(ports.open(realm));
      result = await ports.publish(stores[0]!, stores, opts);
    } catch (error) {
      result = { ok: false, pushed: false, entries: 0, error: (error as Error).message };
    } finally { for (const store of stores.reverse()) try { ports.close(store); } catch { /* preserve the publication result */ } }
    results.push(result);
    const outcome: PlacementRealmOutcome = result.ok ? result.placementPublication?.outcome ?? "not-needed" : result.placementPublication?.outcome === "unknown" ? "unknown" : "failed";
    for (const realm of batch) realms.push({ realm: label(realm), outcome, publication: index + 1 });
    if (!result.ok) stopped = result;
    else completed++;
    report(completed);
  }
  if (stopped) report(completed);
  progress?.deferFinish(false);
  if (stopped) progress?.finish(opts.signal?.aborted ? "cancelled" : "failed", opts.signal?.aborted ? "cancelled" : "unavailable");
  else progress?.finish("succeeded");
  const totals = sum(results), last = stopped ?? results.at(-1);
  const base: SyncResult = last ? { ...last } : { ok: true, pushed: false, entries: 0 };
  return { ...base, ok: !stopped, pushed: totals.pushed, entries: totals.entries,
    ...(base.placementPublication ? { placementPublication: { ...base.placementPublication, exported: totals.exported, withheld: totals.withheld } } : {}),
    ...(stopped?.error !== undefined ? { error: stopped.error } : {}), placementRealms: realms };
}
