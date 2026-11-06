import { validatePlacementProfile, validatePlacementShards } from "./sync-placement-format.ts";
import { assertPlacementViewAdvance } from "./sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { types } from "node:util";
import { randomBytes } from "node:crypto";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { acquireMutation, type MutationHandle } from "./mutation.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { outboundPolicyEvaluator, type RowScreen } from "./sync-screen.ts";
import { assertPlacementRuntime } from "./sync-placement-guard.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import { planSyncPlacementActivation, validatePlacementPlan, validateSyncPlacementActivation, type SyncPlacementActivationPlan } from "./sync-placement-plan.ts";
import { captureSyncPlacementContext, placementCaptureContextHash, type PlacementCapturePort, type PlacementCapture } from "./sync-placement-capture.ts";
import { PLACEMENT_EPOCH_SCHEMA, placementEpochHash, placementKeyId, validatePlacementEpoch, validatePlacementKey, validatePlacementEvent,
  SyncPlacementJournalError, type PlacementEpoch, type PlacementKey, type PlacementCommittedOutcome, type PlacementAmbiguousOutcome } from "./sync-placement-journal-format.ts";
import { rebuildPlacementProjection } from "./sync-placement-projection.ts";
import { preparePlacementEpoch, readPlacementJournal, appendPlacementEvent } from "./sync-placement-journal-storage.ts";

export interface PlacementJournalPreview { epoch: PlacementEpoch; plan: SyncPlacementActivationPlan }
export interface PlacementAuthorizationBinding {
  action: "prepare" | "hold" | "release"; seal: string;
  epochHash?: string; key?: PlacementKey; expectedHead?: string; policyHash?: string;
}
export interface PlacementJournalPort extends PlacementCapturePort {
  /** Person intent is authenticated by the host. Data/seals/session markers grant no authority. */
  authorize(binding: Readonly<PlacementAuthorizationBinding>): boolean;
  screen?: RowScreen;
}
function fail(code: "invalid" | "changed" | "authorization" | "policy" | "local" | "conflict" | "pending" | "busy" = "invalid"): never { throw new SyncPlacementJournalError(code); }
function protectedCall<T>(work: () => T): T {
  try { return work(); } catch (error) { if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SyncPlacementJournalError) throw error; return fail("changed"); }
}
function person(port: PlacementJournalPort, action: "prepare" | "hold" | "release", seal: string, details: Omit<PlacementAuthorizationBinding, "action" | "seal"> = {}): void {
  let authorized = false;
  try { authorized = port.authorize(Object.freeze({ action, seal, ...details })) === true; } catch { fail("authorization"); }
  if (!authorized) fail("authorization");
}
function fenced<T>(capture: PlacementCapture, work: (homeMutation: MutationHandle) => T): T {
  const handles: MutationHandle[] = [];
  try {
    let homeMutation: MutationHandle | undefined;
    for (const dir of capture.directories) {
      const handle = acquireMutation(dir); if (!handle) fail("busy");
      handles.push(handle); if (dir === capture.home) homeMutation = handle;
    }
    capture.assertCurrent(); if (!homeMutation) fail();
    return work(homeMutation);
  } finally { for (const release of handles.reverse()) release(); }
}
/** Read-only concrete preview. Preparing it still requires a fresh capture and explicit person authorization. */
export function planPlacementJournal(home: string, port: PlacementCapturePort): PlacementJournalPreview {
  return protectedCall(() => {
    assertPlacementRuntime(home);
    const capture = captureSyncPlacementContext(home, port); if (capture.activeHead) fail("conflict");
    const epoch = validatePlacementEpoch({ schema: PLACEMENT_EPOCH_SCHEMA, publicationFormat: PLACEMENT_FORMAT,
      generation: (capture.context.profile as { generation: string }).generation, homeHash: capture.context.homeHash,
      contextHash: hashJSON(capture.context), nonce: randomBytes(16).toString("hex") });
    const plan = planSyncPlacementActivation(capture.context, placementEpochHash(epoch));
    capture.assertCurrent(); return { epoch, plan };
  });
}
/** Creates only an empty private epoch on v2; never writes profile/shards/formats markers or enables transport. */
export function preparePlacementJournal(home: string, preview: PlacementJournalPreview, port: PlacementJournalPort): { activated: false; epochHash: string } {
  return protectedCall(() => {
    const copied = memoryPolicySnapshot(preview); if (!copied || Object.keys(copied).sort().join() !== "epoch,plan") fail();
    assertPlacementRuntime(home);
    const epoch = validatePlacementEpoch(copied.epoch), plan = validatePlacementPlan(copied.plan), epochHash = placementEpochHash(epoch);
    const capture = captureSyncPlacementContext(home, port);
    if (capture.activeHead || epoch.homeHash !== capture.context.homeHash || epoch.contextHash !== hashJSON(capture.context)
      || epoch.generation !== plan.generation || epochHash !== plan.targetProfile.placementHead) fail("changed");
    validateSyncPlacementActivation(plan, { current: () => { capture.assertCurrent(); return capture.context; },
      authorize: binding => { person(port, "prepare", binding.seal); return true; } });
    fenced(capture, mutation => preparePlacementEpoch(capture.home, epoch, plan, { mutation, assertCurrent: capture.assertCurrent }));
    return { activated: false, epochHash };
  });
}
export interface PlacementEffectRequest { epochHash: string; expectedHead: string; requestId: string; key: PlacementKey }
function request(input: PlacementEffectRequest): PlacementEffectRequest {
  const value = memoryPolicySnapshot(input);
  if (!value || Object.keys(value).sort().join() !== "epochHash,expectedHead,key,requestId"
    || ![value.epochHash, value.expectedHead, value.requestId].every(x => typeof x === "string" && x.length === 64 && /^[a-f0-9]+$/.test(x))) fail();
  return { epochHash: value.epochHash, expectedHead: value.expectedHead, requestId: value.requestId, key: validatePlacementKey(value.key) };
}
function active(home: string, input: PlacementEffectRequest, port: PlacementCapturePort) {
  const capture = captureSyncPlacementContext(home, port), journal = readPlacementJournal(capture.home, input.epochHash);
  if (capture.activeHead !== input.epochHash || journal.epoch.homeHash !== capture.context.homeHash
    || journal.epoch.generation !== (capture.context.profile as { generation: string }).generation
    || journal.activation.targetProfile.placementHead !== input.epochHash
    || canonicalJSON(capture.context.writers) !== canonicalJSON(capture.writerInventory?.writers??journal.activation.writers)
    || canonicalJSON(capture.context.realms.map(({ bindingHash: _hash, ...identity }) => identity))
      !== canonicalJSON(journal.activation.realms.map(({ bindingHash: _hash, ...identity }) => identity))) fail("changed");
  const markers = readPlacementRuntimeMarkers(capture.home), profile = validatePlacementProfile(markers.profile);
  assertPlacementViewAdvance(capture.home, journal.activation, profile, validatePlacementShards(markers.shards, profile));
  const projection = rebuildPlacementProjection(journal.epoch, journal.records);
  const source = capture.rows.get(placementKeyId(input.key)); if (!source) fail("changed");
  return { capture, journal, projection, source };
}
type Decision = { kind: "hold"; mode: "policy" | "person" } | { kind: "release" }
  | { kind: "publication-committed"; outcome: PlacementCommittedOutcome; verify(binding: Readonly<{ effectHash: string; outcome: PlacementCommittedOutcome }>): boolean }
  | { kind: "publication-ambiguous"; outcome: PlacementAmbiguousOutcome };
function effect(home: string, raw: PlacementEffectRequest, port: PlacementJournalPort, decision: Decision) {
  return protectedCall(() => {
    const input = request(raw), { capture, source } = active(home, input, port);
    if (port.screen && !port.policyVersion) fail("policy");
    const fields = { requestId: input.requestId, key: input.key, sourcePlacement: source.sourcePlacement };
    let partial: Record<string, unknown>;
    if (decision.kind === "hold") {
      if (decision.mode === "person") partial = { ...fields, kind: "hold", reason: "person-local" };
      else {
        const verdict = outboundPolicyEvaluator(capture.home, port.screen)(source.row as unknown as Record<string, unknown>);
        if (verdict.ok) fail("policy");
        partial = { ...fields, kind: "hold", reason: verdict.category };
      }
    } else if (decision.kind === "release") {
      if (source.intrinsicLocal) fail("local");
      if (!outboundPolicyEvaluator(capture.home, port.screen)(source.row as unknown as Record<string, unknown>).ok) fail("policy");
      partial = { ...fields, kind: "release" };
    } else partial = { ...fields, kind: decision.kind, outcome: decision.outcome };
    const effectHash = hashJSON({ event: partial, expectedHead: input.expectedHead, markerHash: capture.markerHash, contextHash: placementCaptureContextHash(capture) });
    const event = validatePlacementEvent({ ...partial, effectHash });
    if (decision.kind === "release" || decision.kind === "hold" && decision.mode === "person") person(port, decision.kind, effectHash, { epochHash: input.epochHash, key: Object.freeze({ ...input.key, realm: Object.freeze({ ...input.key.realm }) }),
      expectedHead: input.expectedHead, policyHash: capture.context.policyHash });
    if (decision.kind === "publication-committed") {
      let verified = false;
      try { verified = decision.verify(Object.freeze({ effectHash, outcome: structuredClone(decision.outcome) })) === true; } catch { fail("authorization"); }
      if (!verified) fail("authorization");
    }
    capture.assertCurrent();
    return fenced(capture, mutation => appendPlacementEvent(capture.home, input.epochHash, event, input.expectedHead,
      { mutation, assertCurrent: capture.assertCurrent }));
  });
}
/** Sticky local placement. Retrying or loosening a policy never invokes the release path. */
export const holdPlacementRow = (home: string, input: PlacementEffectRequest, port: PlacementJournalPort, mode: "policy" | "person" = "policy") => effect(home, input, port, { kind: "hold", mode });
export const releasePlacementHold = (home: string, input: PlacementEffectRequest, port: PlacementJournalPort) => effect(home, input, port, { kind: "release" });
/** Records verified evidence only. This API performs no publication, fetch, git or network operation. */
export function recordPlacementPublication(home: string, input: PlacementEffectRequest, port: PlacementJournalPort,
  outcome: PlacementCommittedOutcome, verify: (binding: Readonly<{ effectHash: string; outcome: PlacementCommittedOutcome }>) => boolean) {
  const copied = memoryPolicySnapshot(outcome); if (!copied) return fail();
  return effect(home, input, port, { kind: "publication-committed", outcome: copied, verify });
}
export function recordPlacementAmbiguity(home: string, input: PlacementEffectRequest, port: PlacementJournalPort, outcome: PlacementAmbiguousOutcome) {
  const copied = memoryPolicySnapshot(outcome); if (!copied) return fail();
  return effect(home, input, port, { kind: "publication-ambiguous", outcome: copied });
}
/** Rebuilds solely from the private journal, not from any index flag. Pending writes never yield a complete empty result. */
export function readPlacementProjection(home: string, epochHash: string) {
  return protectedCall(() => {
    const journal = readPlacementJournal(home, epochHash); if (journal.pending) fail("pending");
    const projection = rebuildPlacementProjection(journal.epoch, journal.records);
    return { epochHash: projection.epochHash, headHash: projection.headHash, sequence: projection.sequence, states: projection.states() };
  });
}
