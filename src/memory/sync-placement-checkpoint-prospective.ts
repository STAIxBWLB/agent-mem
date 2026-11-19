/** Offline, effect-free prospective publication sizing for checkpoint headroom. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON, readProfileJSON } from "./generation.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { previewSelectedSyncPlacementSources } from "./sync-placement-capture.ts";
import { placementInventory, placementInventoryBatches, type InventoryRealm } from "./sync-placement-inventory.ts";
import { captureInspectionJournal, PlacementInspectionObjects } from "./sync-placement-inspection-evidence.ts";
import { createPlacementRecord, placementKeyId, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, type PlacementRealm } from "./sync-placement-journal-format.ts";
import { materializePlacementRows, verifiedPlacementPrunes } from "./sync-placement-materialize.ts";
import { planPlacementPublicationAsync, publicationBytes, publicationFileNames } from "./sync-placement-publication-plan.ts";
import { placementPublicationEventSteps } from "./sync-placement-publication-events.ts";
import { drainSteps } from "./sync-placement-yield.ts";
import { outboundPolicyEvaluator } from "./sync-screen.ts";
import { resolveShardProfile } from "./shard.ts";
import { readPublicPruneViewForActivation } from "./public-prune-view.ts";
import { reducePublicPruneInputs } from "./public-prune-inputs.ts";
import { reducePruneRows, type PruneRow } from "./prune.ts";
import { explicitExpirySnapshot } from "./generation-index.ts";
import { inspectPublisherPruneLineages } from "./prune-publisher-lineage.ts";
import type { ShardSyncRealm, ShardSyncRow } from "./shard-sync-format.ts";

export type CheckpointProspective = { state: "none" } | { state: "cache-only"; slots: number; reservedJournalChunks: number }
  | { state: "unavailable"; reason: "cache-or-remote-evidence-unavailable" };
const realm = (item: InventoryRealm): PlacementRealm => item.scope === "user" ? { scope: "user" } : { scope: "project", keyHash: item.keyHash };
const shard = (item: InventoryRealm): ShardSyncRealm => item.scope === "user" ? { scope: "user" } : { scope: "project", key: item.key };
const same = (a: PlacementRealm, b: PlacementRealm) => canonicalJSON(a) === canonicalJSON(b);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const slots = (value: { slots: number; reservedJournalChunks: number }) => value.slots + value.reservedJournalChunks;
function reserve(lengths: readonly number[]): number {
  let chunks = 0, size = 0;
  for (const bytes of lengths) { if (!chunks || size + bytes > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) { chunks++; size = 0; } size += bytes; }
  return chunks + (lengths.length ? 1 : 0);
}
/** Only fixed local Git reads; missing cached refs/objects cannot establish a current remote plan without network. */
export async function checkpointProspective(home: string): Promise<{ value: CheckpointProspective; assertCurrent(): void }> {
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!active) throw new Error("sync placement unavailable");
  const inventory = placementInventory(home), inventoryHash = hashJSON(inventory), effective = readEffectiveRealmInventory(home, active);
  const batches = placementInventoryBatches(inventory.local), sourceChecks: (() => void)[] = [];
  const checkInventory = () => { effective.assertCurrent(); if (hashJSON(placementInventory(home)) !== inventoryHash) throw new Error("placement inventory changed"); };
  if (!batches.length) return { value: { state: "none" }, assertCurrent: checkInventory };
  const cache = join(home, "shard-sync-placement", "objects.git");
  if (!existsSync(cache)) return { value: { state: "unavailable", reason: "cache-or-remote-evidence-unavailable" }, assertCurrent: checkInventory };
  const journal = captureInspectionJournal(home, active.profile.placementHead);
  let objects: PlacementInspectionObjects;
  try { objects = new PlacementInspectionObjects(home, () => { checkInventory(); journal.assertCurrent(); }); }
  catch { return { value: { state: "unavailable", reason: "cache-or-remote-evidence-unavailable" }, assertCurrent: checkInventory }; }
  const view = readPublicPruneViewForActivation(home, active.profile.pruneInputSetHash, active.profile.generation);
  let largest: { slots: number; reservedJournalChunks: number } | undefined;
  for (const batch of batches) {
    const selected = batch.map(realm), source = previewSelectedSyncPlacementSources(home, selected);
    const targets = batch.map(item => ({ realm: shard(item), profile: resolveShardProfile(home, item.scope === "user" ? { user: true } : { project: item.key }) }));
    const heads = targets.map(target => objects.ref(target.realm));
    // A missing ref cannot distinguish an empty remote from one not fetched yet.
    if (heads.some(head => head === undefined)) return { value: { state: "unavailable", reason: "cache-or-remote-evidence-unavailable" }, assertCurrent: checkInventory };
    const old = await Promise.all(targets.map((target, index) => objects.auditor(target.realm, active.profile.generation).history(heads[index]!)));
    const planned = targets.map((target, index) => {
      const identity = selected[index]!, id = canonicalJSON(identity), sources = source.sourceRowsByRealm.get(id);
      if (!sources) throw new Error("selected placement source unavailable");
      const prunes = [...source.specialRows.values()].filter(row => same(row.key.realm, identity) && row.row.op === "prune");
      const reduced = reducePruneRows(prunes.map(row => ({ row: row.row as PruneRow, placement: row.sourcePlacement })), { rows: sources, expiries: explicitExpirySnapshot(sources) }, active.profile.generation);
      if (reduced.invalid || reduced.pending.length) throw new Error("placement prune proof unavailable");
      const inputHash = view.realms[target.realm.scope === "user" ? "user" : `project:${target.realm.key}`];
      const pruned = inputHash ? reducePublicPruneInputs({ dir: target.profile.dir, realm: target.realm, receivingGeneration: active.profile.generation, inputSetHash: inputHash,
        publicationFormat: active.profile.publicationFormat, nativeTargets: [...reduced.targets], ordinary: sources.map(row => row.row) }).targets : reduced.targets;
      return { realm: target.realm, generation: active.profile.generation, remote: heads[index], local: heads[index], fetched: new Set(old[index]!.rows.keys()),
        localPrunes: new Map(prunes.filter(row => row.sourcePlacement === "synced").map(row => [row.key.id, row.row as PruneRow])), pruned };
    });
    const lineages = targets.map((target, index) => {
      const rows = new Map<string, ShardSyncRow>(old[index]!.rows);
      for (const value of [...source.rows.values(), ...source.specialRows.values()]) if (same(value.key.realm, selected[index]!) && value.row.op !== "vault_link") {
        const prior = rows.get(value.key.id); if (prior && hashJSON(prior) !== value.key.rowHash) throw new Error("placement row mismatch"); rows.set(value.key.id, value.row);
      }
      const candidates = [...rows.values()].filter((row): row is PruneRow => row.op === "prune" && row.generation === active.profile.generation);
      const machine = readProfileJSON(join(target.profile.dir, "machine.json")) as { id: string };
      const boundary = join(target.profile.dir, "local", `publisher-boundary-${machine.id}.json`);
      return { rows, proof: existsSync(boundary) ? inspectPublisherPruneLineages(target.profile, candidates) : new Map() };
    });
    const verified = verifiedPlacementPrunes(targets.map((target, index) => ({ realm: target.realm, generation: active.profile.generation, rows: lineages[index]!.rows,
      fetched: planned[index]!.fetched, lineageIds: new Set<string>(lineages[index]!.proof.keys()) })));
    const evaluate = outboundPolicyEvaluator(home), now = Date.now(), materialized = await materializePlacementRows({ capture: source, projection: journal.projection,
      generation: active.profile.generation, targets: planned, old, verifiedPrunes: verified, evaluate, createdUnixSeconds: Math.floor(now / 1000),
      readTree: async (_index, head) => objects.tree(head), publisherLineages: (index, rows) => inspectPublisherPruneLineages(targets[index]!.profile, rows) });
    const body = { epochHash: active.profile.placementHead, generation: active.profile.generation, homeHash: source.base.homeHash,
      contextHash: sha("checkpoint-preview"), markerHash: source.markerHash, sourceHash: source.base.sourceHash, aliasesHash: source.base.aliasesHash,
      policyHash: source.base.policyHash, remoteHash: objects.remoteHash, journal: { sequence: journal.journal.sequence, headHash: journal.journal.headHash },
      createdUnixSeconds: Math.floor(now / 1000), policySnapshotUnixMs: now, targets: materialized.plannedTargets, reservedRecords: 0, reservedRecordBytes: [] as number[] };
    const items = { sources: source.prefixes, decisions: materialized.decisions, objects: materialized.objects };
    let bundle = await planPlacementPublicationAsync(body, items);
    const scheduled = drainSteps(placementPublicationEventSteps(bundle, journal.projection, old));
    let head = body.journal.headHash;
    const lengths = scheduled.events.map((event, index) => { const record = createPlacementRecord(body.epochHash, body.journal.sequence + index + 1, head, event); head = record.seal; return publicationBytes(record).length; });
    bundle = await planPlacementPublicationAsync({ ...body, reservedRecords: lengths.length, reservedRecordBytes: lengths }, items);
    const changed = bundle.root.targets.some((target, index) => target.publish && target.commit !== heads[index]);
    if (scheduled.events.length || changed) {
      const candidate = { slots: publicationFileNames(bundle.root).length, reservedJournalChunks: reserve(lengths) };
      if (!largest || slots(candidate) > slots(largest)) largest = candidate;
    }
    source.assertSourcesUnchanged(); journal.assertCurrent(); objects.assertRetained(); sourceChecks.push(source.assertSourcesUnchanged);
  }
  return { value: largest ? { state: "cache-only", ...largest } : { state: "none" },
    assertCurrent: () => { checkInventory(); for (const check of sourceChecks) check(); journal.assertCurrent(); objects.assertRetained(); } };
}
