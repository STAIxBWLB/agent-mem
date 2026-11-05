/** IDs-only current placement decisions and separately verified historical exposure. No effects or network. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { types } from "node:util";
import { SegmentReadBudgetError } from "./bridge.ts";
import { canonicalJSON, hashJSON, selectorRevision } from "./generation.ts";
import { assertFormatFloor, FormatFloorError } from "./formats.ts";
import { readPlacementRuntimeMarkers, SyncPlacementRuntimeError } from "./sync-placement-guard.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import { captureSyncPlacementContext, type PlacementCapturePort } from "./sync-placement-capture.ts";
import { placementKeyId, SyncPlacementJournalError, type PlacementKey, type PlacementHoldReason } from "./sync-placement-journal-format.ts";
import { materializePlacementRows, verifiedPlacementPrunes } from "./sync-placement-materialize.ts";
import { placementCacheRootStamp } from "./sync-placement-cache.ts";
import { captureInspectionJournal, inspectRetainedPublicationHistories, PlacementInspectionObjects, type InspectionExposureProof } from "./sync-placement-inspection-evidence.ts";
import { outboundPolicyEvaluator, type RowScreen, type SyncPolicyCategory } from "./sync-screen.ts";
import { explicitExpirySnapshot } from "./generation-index.ts";
import { reducePruneRows, type PruneRow } from "./prune.ts";
import { readPublicPruneViewForActivation } from "./public-prune-view.ts";
import { reducePublicPruneInputs } from "./public-prune-inputs.ts";
import { inspectPublisherPruneLineages } from "./prune-publisher-lineage.ts";
import type { PublicPruneLineage } from "./public-prune-witness.ts";
import type { PlacementPublicationDecisionReason } from "./sync-placement-publication-plan.ts";
import type { ShardSyncRealm, ShardSyncRow } from "./shard-sync-format.ts";
import type { MemoryStore } from "./store.ts";
import { captureInspectionPendingPrunes } from "./sync-placement-inspection-pending.ts";

export interface SyncPlacementInspectionOptions {
  screen?: RowScreen;
  policyVersion?: () => string;
  /** Same fresh writer-pin binding as v3 sync; this read-only port grants no effect or activation authority. */
  placementAttestation?: PlacementCapturePort["attest"];
}
export type SyncPlacementDisposition = "eligible" | "policy-local" | "person-local" | "held";
export type SyncPlacementExposureEvidence = InspectionExposureProof;
export type SyncPlacementExposure = { certainty: "verified-published"; evidence: SyncPlacementExposureEvidence[] }
  | { certainty: "not-observed" | "unknown" };
export interface SyncPlacementInspectionRow extends PlacementKey {
  sourcePlacement: "local" | "synced";
  disposition: SyncPlacementDisposition;
  reason: PlacementPublicationDecisionReason;
  categories: SyncPolicyCategory[];
  holdReasons: PlacementHoldReason[];
  exposure: SyncPlacementExposure;
}
export interface SyncPlacementIntrinsicLocalRow extends PlacementKey {
  sourcePlacement: "local";
  reason: "intrinsic-local";
  categories: SyncPolicyCategory[];
  holdReasons: PlacementHoldReason[];
  exposure: SyncPlacementExposure;
}
export type SyncPlacementInspectionIncompleteReason = "placement-not-active" | "binding-changed" | "input-unavailable" | "input-bound" | "input-changed"
  | "journal-unavailable" | "policy-unavailable" | "attestation-unavailable" | "evidence-unavailable" | "reader-upgrade-required";
export type SyncPlacementInspection = {
  complete: true; rows: SyncPlacementInspectionRow[]; intrinsicLocal: SyncPlacementIntrinsicLocalRow[]; fingerprint: string;
  counts: { selected: number; rows: number; intrinsicLocal: number; eligible: number; policyLocal: number; personLocal: number; held: number; verifiedPublished: number; notObserved: number; unknown: number };
} | { complete: false; reason: SyncPlacementInspectionIncompleteReason; nextStep: string };

const categories: readonly SyncPolicyCategory[] = ["secret", "personal-data", "deny-path", "private-or-invalid", "host"];
const remedies: Record<SyncPlacementInspectionIncompleteReason, string> = {
  "placement-not-active": "Placement is not active; complete the person-reviewed shard/public-prune migrations and separately authorized placement activation before inspecting placement.",
  "binding-changed": "Selected placement bindings changed; inspect the retained activation to restore matching markers when required, then reopen the selected project/user handles and inspect again.",
  "input-unavailable": "Selected source or placement-context inputs are unreadable, incomplete or unsupported; inspect retained source metadata and any recorded partial request, verify compatible writer pins, then inspect again.",
  "input-bound": "Placement inspection exceeds its supported 8 MiB/20000-row or retained-evidence bounds; request a person-reviewed bounded epoch transition before inspecting again.",
  "input-changed": "The selected placement inspection context changed; wait for stable source, journal and policy bindings, then inspect again.",
  "journal-unavailable": "The retained placement journal is incomplete or inconsistent; preserve it and resume its exact recorded request with a compatible runtime before inspecting again.",
  "policy-unavailable": "The policy callback/version or configured/default-deny epoch is unavailable or changed; restore a stable policy and policyVersion before inspecting again.",
  "attestation-unavailable": "Fresh placement writer-pin/quiescence attestation is missing or invalid; supply the matching placementAttestation callback and inspect again.",
  "evidence-unavailable": "Retained publication evidence is unreadable or inconsistent; check the private cache's ownership, permissions, links and exact objects, restore compatible retained evidence, then use a separately authorized sync to reverify before inspecting again.",
  "reader-upgrade-required": "The configured sync format floor refuses the loaded reader; install a compatible newer runtime, reopen the selected handles and inspect again.",
};
class Incomplete extends Error {
  constructor(readonly reason: SyncPlacementInspectionIncompleteReason) { super(remedies[reason]); }
}
function fail(reason: SyncPlacementInspectionIncompleteReason): never { throw new Incomplete(reason); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function physical(realm: ShardSyncRealm): PlacementKey["realm"] { return realm.scope === "user" ? { scope: "user" } : { scope: "project", keyHash: digest(realm.key) }; }
function callbacks(input: SyncPlacementInspectionOptions): SyncPlacementInspectionOptions {
  if (!input || typeof input !== "object" || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("policy-unavailable");
  const fields = Object.getOwnPropertyDescriptors(input);
  const read = <K extends keyof SyncPlacementInspectionOptions>(key: K): SyncPlacementInspectionOptions[K] => {
    const field = fields[key]; if (!field) return undefined;
    if (!("value" in field) || !field.enumerable || field.value !== undefined && typeof field.value !== "function") fail("policy-unavailable");
    return field.value as SyncPlacementInspectionOptions[K];
  };
  const result = { screen: read("screen"), policyVersion: read("policyVersion"), placementAttestation: read("placementAttestation") };
  if (result.screen && !result.policyVersion) fail("policy-unavailable"); return result;
}
function inactive(store: MemoryStore): Extract<SyncPlacementInspection, { complete: false }> {
  const steps: string[] = [];
  if (!store.profile.sharded) steps.push("Have the person run amem migrate --shards --dry-run, review the plan, then amem migrate --shards --apply.");
  if (!store.profile.foreignPruneFormat) steps.push("Have the person run amem migrate --public-prune-view --dry-run, review the plan, then amem migrate --public-prune-view --apply.");
  steps.push("Complete separately person-authorized placement activation with compatible exact writer pins; this stage provides no placement activation command or marker writer.");
  return { complete: false, reason: "placement-not-active", nextStep: "Placement is not active. " + steps.join(" ") };
}

export async function inspectSyncPlacement(store: MemoryStore, input: SyncPlacementInspectionOptions = {}): Promise<SyncPlacementInspection> {
  let phase: SyncPlacementInspectionIncompleteReason = "input-unavailable";
  let captured = false;
  try {
    const options = callbacks(input), home = store.profile.home;
    assertFormatFloor(home, "sync");
    const opened = [...store.openedSyncTargets()];
    const binding = () => hashJSON(store.openedSyncTargets().map(target => ({ profile: target.profile, machine: target.machine,
      selector: selectorRevision(target.profile.home) })));
    if (opened.some(target => selectorRevision(target.profile.home) !== target.profile.selectorRevision)) fail("binding-changed");
    const beforeBinding = binding();
    if (store.profile.publicationFormat !== PLACEMENT_FORMAT) return inactive(store);
    if (!options.placementAttestation) fail("attestation-unavailable");
    if (!opened.length || opened.length > 2 || !opened.includes(store) || opened.some(target => target.profile.home !== home || !target.profile.sharded
      || !target.profile.generation || !target.profile.shardUser && target.profile.shardKey !== store.profile.shardKey)) fail("binding-changed");
    const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards);
    if (!active || active.profile.placementHead !== store.profile.placementHead) fail("binding-changed");
    const targets = opened.map(target => ({ store: target, realm: target.profile.shardUser ? { scope: "user" as const } : { scope: "project" as const, key: target.profile.shardKey! }, generation: target.profile.generation! }));
    const pendingChecks = targets.map(target => captureInspectionPendingPrunes(target.store.dir));
    const port: PlacementCapturePort = { attest: options.placementAttestation, ...(options.policyVersion ? { policyVersion: options.policyVersion } : {}) };
    const capture = captureSyncPlacementContext(home, port, targets.map(target => physical(target.realm)));
    captured = true;
    if (capture.activeHead !== active.profile.placementHead || canonicalJSON(capture.context.writers) !== canonicalJSON(active.activation.writers)) fail("attestation-unavailable");
    phase = "journal-unavailable"; const retained = captureInspectionJournal(home, active.profile.placementHead);
    const check = () => {
      if (binding() !== beforeBinding) fail("binding-changed"); retained.assertCurrent(); capture.assertUnchanged();
      if (binding() !== beforeBinding) fail("binding-changed");
    };
    phase = "evidence-unavailable";
    const cacheRoot = join(home, "shard-sync-placement"), rootStamp = lstatSync(cacheRoot, { throwIfNoEntry: false }) ? placementCacheRootStamp(home) : undefined;
    const cache = join(cacheRoot, "objects.git"), cacheAbsent = !lstatSync(cache, { throwIfNoEntry: false });
    const objects = cacheAbsent ? undefined : new PlacementInspectionObjects(home, check);
    const histories = await inspectRetainedPublicationHistories(retained, targets, objects);
    const cached = targets.map(target => objects?.ref(target.realm));
    const view = readPublicPruneViewForActivation(home, active.profile.pruneInputSetHash, active.profile.generation);
    const foreignChecks: (() => void)[] = [];
    phase = "input-unavailable";
    const plannedTargets = targets.map((target, index) => {
      const realm = physical(target.realm), id = canonicalJSON(realm), sources = capture.sourceRowsByRealm.get(id);
      if (!sources) fail("binding-changed");
      const prunes = [...capture.specialRows.values()].filter(source => canonicalJSON(source.key.realm) === id && source.row.op === "prune");
      const reduced = reducePruneRows(prunes.map(source => ({ row: source.row, placement: source.sourcePlacement })), { rows: sources, expiries: explicitExpirySnapshot(sources) }, target.generation);
      if (reduced.invalid || reduced.pending.length) fail("input-unavailable");
      const inputSetHash = view.realms[target.realm.scope === "user" ? "user" : `project:${target.realm.key}`];
      let pruned = reduced.targets;
      if (inputSetHash) {
        const replay = () => reducePublicPruneInputs({ dir: target.store.dir, realm: target.realm, receivingGeneration: target.generation, inputSetHash,
          publicationFormat: PLACEMENT_FORMAT, nativeTargets: [...reduced.targets], ordinary: sources.map(source => source.row) });
        const before = replay(); pruned = before.targets;
        const identity = (value: ReturnType<typeof replay>) => hashJSON({ targets: [...value.targets].sort(), rows: [...value.rowHashes].sort(), inputs: value.inputs, commitments: value.commitments });
        const fingerprint = identity(before); foreignChecks.push(() => { if (identity(replay()) !== fingerprint) fail("input-changed"); });
      }
      const localPrunes = new Map(prunes.filter(source => source.sourcePlacement === "synced").map(source => [source.key.id, source.row as PruneRow]));
      return { realm: target.realm, generation: target.generation, remote: histories.tips[index], local: cached[index], fetched: new Set(histories.old[index]?.rows.keys()), localPrunes, pruned };
    });
    const lineages = targets.map((target, index) => {
      const rows = new Map<string, ShardSyncRow>(histories.old[index]?.rows);
      for (const source of [...capture.rows.values(), ...capture.specialRows.values()]) if (canonicalJSON(source.key.realm) === canonicalJSON(physical(target.realm)) && source.row.op !== "vault_link") {
        const prior = rows.get(source.key.id); if (prior && hashJSON(prior) !== source.key.rowHash) fail("input-unavailable"); rows.set(source.key.id, source.row);
      }
      const candidates = [...rows.values()].filter((row): row is PruneRow => row.op === "prune" && row.generation === target.generation);
      const boundary = join(target.store.dir, "local", `publisher-boundary-${target.store.machine.id}.json`);
      const proof = lstatSync(boundary, { throwIfNoEntry: false }) ? inspectPublisherPruneLineages(target.store.profile, candidates) : new Map<string, PublicPruneLineage>();
      return { rows, proof };
    });
    const verified = verifiedPlacementPrunes(targets.map((target, index) => ({ realm: target.realm, generation: target.generation, rows: lineages[index]!.rows,
      fetched: plannedTargets[index]!.fetched, lineageIds: new Set<string>(lineages[index]!.proof.keys()) })));
    const rowCategories = new Map<string, Set<SyncPolicyCategory>>();
    phase = "policy-unavailable"; const evaluate = outboundPolicyEvaluator(home, options.screen);
    phase = "input-unavailable";
    const guardedEvaluate = (value: unknown): ReturnType<typeof evaluate> => {
      check(); let verdict: ReturnType<typeof evaluate>;
      try { verdict = evaluate(structuredClone(value) as Record<string, unknown>); } catch { return fail("policy-unavailable"); }
      check();
      if (!verdict.ok && value && typeof value === "object" && "id" in value && typeof value.id === "string") {
        let known = rowCategories.get(value.id); if (!known) rowCategories.set(value.id, known = new Set()); known.add(verdict.category);
      }
      return verdict;
    };
    const materialized = await materializePlacementRows({ capture, projection: retained.projection, generation: active.profile.generation, targets: plannedTargets,
      old: histories.old, verifiedPrunes: verified, createdUnixSeconds: Math.floor(Date.now() / 1000), evaluate: guardedEvaluate,
      readTree: async (_index, head) => { if (!objects) fail("evidence-unavailable"); return objects.tree(head); },
      publisherLineages: (index, rows) => inspectPublisherPruneLineages(targets[index]!.store.profile, rows) });
    const exposureFor = (key: PlacementKey): SyncPlacementExposure => {
      const known = histories.published.get(placementKeyId(key)), attempts = retained.projection.get(key)?.attempts;
      return known?.length ? { certainty: "verified-published", evidence: known } : { certainty: attempts?.length ? "unknown" : "not-observed" };
    };
    const rows: SyncPlacementInspectionRow[] = materialized.decisions.map(decision => {
      const state = retained.projection.get(decision.key), holdReasons = state?.reasons ?? [], own = new Set<SyncPolicyCategory>(rowCategories.get(decision.key.id));
      for (const value of [decision.reason, ...holdReasons]) if (categories.includes(value as SyncPolicyCategory)) own.add(value as SyncPolicyCategory);
      const disposition: SyncPlacementDisposition = decision.eligible ? "eligible" : holdReasons.includes("person-local") ? "person-local"
        : decision.reason !== "source-local" && own.size ? "policy-local" : "held";
      return { ...decision.key, sourcePlacement: decision.sourcePlacement, disposition, reason: decision.reason,
        categories: [...own].sort(), holdReasons: [...holdReasons].sort(), exposure: exposureFor(decision.key) };
    });
    const outboundKeys = new Set(rows.map(row => placementKeyId(row)));
    const intrinsicLocal: SyncPlacementIntrinsicLocalRow[] = [];
    for (const source of capture.specialRows.values()) if (!outboundKeys.has(placementKeyId(source.key))) {
      if (source.sourcePlacement !== "local") fail("input-unavailable");
      guardedEvaluate(source.row);
      const holdReasons = retained.projection.get(source.key)?.reasons ?? [], own = new Set<SyncPolicyCategory>(rowCategories.get(source.key.id));
      for (const reason of holdReasons) if (categories.includes(reason as SyncPolicyCategory)) own.add(reason as SyncPolicyCategory);
      intrinsicLocal.push({ ...source.key, sourcePlacement: "local", reason: "intrinsic-local", categories: [...own].sort(), holdReasons: [...holdReasons].sort(), exposure: exposureFor(source.key) });
    }
    intrinsicLocal.sort((a, b) => placementKeyId(a).localeCompare(placementKeyId(b)));
    // The final recapture invokes host callbacks first; every remaining proof is passive filesystem/data validation.
    phase = "input-changed"; capture.assertCurrent(); retained.assertCurrent(); for (const checkPending of pendingChecks) checkPending(); for (const checkForeign of foreignChecks) checkForeign(); objects?.assertRetained();
    if (cacheAbsent && lstatSync(cache, { throwIfNoEntry: false })) fail("input-changed");
    if (rootStamp !== undefined ? placementCacheRootStamp(home) !== rootStamp : lstatSync(cacheRoot, { throwIfNoEntry: false }) !== undefined) fail("input-changed");
    if (binding() !== beforeBinding) fail("binding-changed");
    assertFormatFloor(home, "sync");
    const counts = { selected: rows.length + intrinsicLocal.length, rows: rows.length, intrinsicLocal: intrinsicLocal.length, eligible: 0, policyLocal: 0, personLocal: 0, held: 0, verifiedPublished: 0, notObserved: 0, unknown: 0 };
    for (const row of rows) {
      counts[row.disposition === "policy-local" ? "policyLocal" : row.disposition === "person-local" ? "personLocal" : row.disposition]++;
    }
    for (const row of [...rows, ...intrinsicLocal]) {
      counts[row.exposure.certainty === "verified-published" ? "verifiedPublished" : row.exposure.certainty === "not-observed" ? "notObserved" : "unknown"]++;
    }
    return { complete: true, rows, intrinsicLocal, counts, fingerprint: hashJSON({ rows, intrinsicLocal }) };
  } catch (error) {
    let reason: SyncPlacementInspectionIncompleteReason = phase;
    if (error && typeof error === "object" && !types.isProxy(error)) {
      if (error instanceof Incomplete) reason = error.reason;
      else if (error instanceof FormatFloorError) {
        if (error.code === "format_floor") reason = "reader-upgrade-required";
        else return { complete: false, reason: "input-unavailable", nextStep: "The sync reader-floor declaration is unreadable or unsupported; inspect and restore the person-approved declaration with a compatible runtime, then inspect again." };
      }
      else if (error instanceof SyncPlacementRuntimeError) reason = "binding-changed";
      else if (error instanceof SegmentReadBudgetError) reason = "input-bound";
      else if (error instanceof SyncPlacementJournalError) {
        if (error.code === "bound") reason = "input-bound";
        else if (error.code === "changed") reason = captured ? "input-changed" : "input-unavailable";
      }
    }
    return { complete: false, reason, nextStep: remedies[reason] };
  }
}
