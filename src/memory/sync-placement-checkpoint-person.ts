/**
 * Person surface of the placement checkpoint (#288 step 3): a readonly preview, confirm of one exact sealed plan, resume
 * and abandon. Never automatic and never on the capture or hook path. Code never raises a floor: confirm only reads the
 * person-written floor record (`amem formats raise` is the one writer).
 */
import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { memoryPolicySnapshot } from "./policy.ts";
import { realPath } from "./platform.ts";
import { canonicalJSON } from "./generation.ts";
import { assertFormatFloor, formatFloorAtLeast } from "./formats.ts";
import { installVersion, versionBelow } from "./formats-raise.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";
import { PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_MAX_OBJECTS } from "./sync-placement-journal-format.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding, type ActivePlacementBinding } from "./sync-placement-active.ts";
import { readInitialSyncPlacementWriterLocator } from "./sync-placement-writer-roots.ts";
import { readEffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { readPlacementJournal, readPlacementPublicationMetadata, placementJournalObjectComposition, releasePlacementStorageCaches, type PlacementJournalObjectComposition } from "./sync-placement-journal-storage.ts";
import { publicationFileNames } from "./sync-placement-publication-plan.ts";
import { PLACEMENT_CHECKPOINT_COMMAND, PLACEMENT_CHECKPOINT_PENDING_MESSAGE, placementCheckpointPending, resolvePlacementWindow } from "./sync-placement-checkpoint-storage.ts";
import { abandonPlacementCheckpoint, applyPlacementCheckpoint, planPlacementCheckpoint, resumePlacementCheckpoint, type PlacementCheckpointInput, type PlacementCheckpointPhase } from "./sync-placement-checkpoint.ts";
import { PLACEMENT_CHECKPOINT_MIN_READER, validateCheckpointIntent, type CheckpointIntent } from "./sync-placement-checkpoint-format.ts";
import { withPlacementActivationFences } from "./sync-placement-activation-locks.ts";
import { assertPlacementActivationOwner } from "./sync-placement-activation-proof.ts";
import { placementFenceDirectories } from "./sync-placement-writer-renewal.ts";
import { initialPlacementWriterContext } from "../sync-placement-writer-context.ts";
import { checkpointProspective, type CheckpointProspective } from "./sync-placement-checkpoint-prospective.ts";

export const CHECKPOINT_PREVIEW = PLACEMENT_CHECKPOINT_COMMAND;
const RESUME = `${CHECKPOINT_PREVIEW} --resume`, ABANDON = `${CHECKPOINT_PREVIEW} --abandon`;

export type PlacementCheckpointCause = "pending" | "commit-started" | "floor" | "writer-below-floor" | "headroom" | "obligation" | "changed" | "inactive" | "candidate";
const MESSAGES: Record<PlacementCheckpointCause, string> = {
  pending: PLACEMENT_CHECKPOINT_PENDING_MESSAGE,
  "commit-started": `The placement checkpoint's commit line has started, so it can no longer be abandoned; run ${RESUME} to complete it.`,
  floor: `Confirming a placement checkpoint requires the person-written home or sync floor of ${PLACEMENT_CHECKPOINT_MIN_READER} or later; preview it with amem formats raise home ${PLACEMENT_CHECKPOINT_MIN_READER}, confirm it with --confirm, then rerun the confirm (amem never raises a floor itself).`,
  "writer-below-floor": `A writer sharing this home is below the ${PLACEMENT_CHECKPOINT_MIN_READER} checkpoint floor; upgrade it, then preview again with ${CHECKPOINT_PREVIEW} --writer-root <install root> for every install.`,
  headroom: "",
  obligation: "The placement journal has an unfinished append, publication, reservation, renewal or source recovery; finish it with amem sync (or the pending renewal with amem migrate --sync-placement --resume), then preview the checkpoint again.",
  changed: `The placement state changed since the checkpoint plan was sealed; preview a fresh plan with ${CHECKPOINT_PREVIEW} and confirm that one.`,
  inactive: "This home has no active sync placement; activate it with amem migrate --sync-placement --dry-run first.",
  candidate: `A checkpoint carries one writer renewal: pass the complete inventory as repeatable --writer-root <install root> (every amem install sharing this home), then preview again with ${CHECKPOINT_PREVIEW}.`,
};
/** A person-facing checkpoint refusal with one cause class and its next step; never a path, row or project name. */
export class PlacementCheckpointError extends Error {
  constructor(readonly causeClass: PlacementCheckpointCause, detail = "") {
    super(causeClass === "headroom" ? `The checkpoint would not leave room for the next sync: ${detail} A single checkpoint cannot unblock this plan; the deferred multi-plan split in #288 design item 5 is the open path. Nothing was written.` : MESSAGES[causeClass] + (detail ? ` ${detail}` : ""));
    this.name = "PlacementCheckpointError";
  }
}

function active(home: string): ActivePlacementBinding {
  const markers = readPlacementRuntimeMarkers(home), value = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!value) throw new PlacementCheckpointError("inactive"); return value;
}
function input(home: string, a: ActivePlacementBinding, roots: PlacementCheckpointInput["roots"], requestId: string): PlacementCheckpointInput {
  const locator = readInitialSyncPlacementWriterLocator(home);
  return { binding: { epochHash: a.profile.placementHead, activationHash: a.activation.seal, homeHash: a.epoch.homeHash, generation: a.epoch.generation, initialLocatorHash: locator.seal }, roots, requestId };
}
function measured(home: string, writerRoots: readonly string[], ownRoot: string): PlacementCheckpointInput["roots"] {
  if (!writerRoots.length) throw new PlacementCheckpointError("candidate");
  try { return initialPlacementWriterContext(home, writerRoots, ownRoot).measurement.roots; } catch { throw new PlacementCheckpointError("candidate"); }
}
function plan(home: string, epochHash: string, value: PlacementCheckpointInput): CheckpointIntent {
  if (placementCheckpointPending(home, epochHash)) throw new PlacementCheckpointError("pending");
  try { return planPlacementCheckpoint(home, epochHash, value); }
  catch (error) {
    const code = error instanceof SyncPlacementJournalError ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    if (code === "pending") throw new PlacementCheckpointError("obligation");
    if (code === "changed") throw new PlacementCheckpointError("changed");
    throw error;
  }
}
/** Journal chunk names a fresh plan reserves in an empty window: the same chunking `placementPublicationReservedJournalNames` uses. */
function freshReservedChunks(reservedRecordBytes: readonly number[]): number {
  let count = 0, size = 0;
  for (const bytes of reservedRecordBytes) { if (!count || size + bytes > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) { count++; size = 0; } size += bytes; }
  return count + (reservedRecordBytes.length ? 1 : 0); // + append-intent.json while the reservation is open
}
export interface PlacementCheckpointHeadroom {
  limit: number; liveAfter: number; nextRenewal: number; completedPlan: { slots: number; reservedJournalChunks: number }; prospectivePlan: CheckpointProspective;
  largestPlan: { slots: number; reservedJournalChunks: number }; required: number; remaining: number;
}
export interface PlacementCheckpointPreview {
  mode: "checkpoint-preview"; window: number; nextWindow: number; journalObjects: PlacementJournalObjectComposition; currentObjects: number;
  headroom: PlacementCheckpointHeadroom; floorReady: boolean; requiredHomeFloor: string; writers: number; planHash: string; plan: CheckpointIntent; nextStep: string;
}
/**
 * Readonly preview: validates complete history and publication closure through the planner, prints the composition and the
 * headroom after the checkpoint. The headroom covers one next renewal plus the largest observed plan and its reserved journal
 * chunks; a checkpoint that cannot unblock the next sync refuses with the exact shortfall.
 */
export async function previewPlacementCheckpoint(homeInput: string, opts: { writerRoots: readonly string[]; ownRoot: string; minReader?: string }): Promise<PlacementCheckpointPreview> {
  const home = realPath(homeInput), a = active(home), epochHash = a.profile.placementHead;
  const roots = measured(home, opts.writerRoots, opts.ownRoot), intent = plan(home, epochHash, input(home, a, roots, randomBytes(32).toString("hex")));
  const journal = readPlacementJournal(home, epochHash), window = resolvePlacementWindow(home, epochHash);
  const { headroom, journalObjects, assertCurrent } = await checkpointHeadroom(home, intent);
  assertCurrent();
  const minReader = opts.minReader ?? PLACEMENT_CHECKPOINT_MIN_READER;
  return { mode: "checkpoint-preview", window: window.window, nextWindow: intent.window, journalObjects, currentObjects: journal.objects, headroom,
    floorReady: formatFloorAtLeast(home, "sync", minReader), requiredHomeFloor: minReader, writers: roots.length, planHash: intent.seal, plan: intent,
    nextStep: `${CHECKPOINT_PREVIEW} --confirm --plan <saved preview JSON> --writer-root <install root> (repeat for every install)` };
}
async function checkpointHeadroom(home: string, intent: CheckpointIntent): Promise<{ headroom: PlacementCheckpointHeadroom; journalObjects: PlacementJournalObjectComposition; assertCurrent(): void }> {
  const epochHash = intent.epochHash, prospective = await checkpointProspective(home);
  let completed = { slots: 0, reservedJournalChunks: 0 }, journalObjects!: PlacementJournalObjectComposition;
  readPlacementPublicationMetadata(home, epochHash, io => {
    journalObjects = placementJournalObjectComposition({ names: io.names() });
    const attempts = new Set([...io.names().flatMap(name => /^publication-([a-f0-9]{64})-root\.json$/.exec(name)?.[1] ?? []), ...io.archivedPublications()]);
    for (const attempt of attempts) {
      const root = io.publication(attempt).bundle.root, candidate = { slots: publicationFileNames(root).length, reservedJournalChunks: freshReservedChunks(root.reservedRecordBytes) };
      if (candidate.slots + candidate.reservedJournalChunks > completed.slots + completed.reservedJournalChunks) completed = candidate;
    }
  });
  const headroom = checkpointHeadroomFor(intent.pages.length, completed, prospective.value);
  return { headroom, journalObjects, assertCurrent: prospective.assertCurrent };
}
/** Shared arithmetic for both offline preview and confirm revalidation; never invent a missing plan. */
export function checkpointHeadroomFor(pages: number, completed: { slots: number; reservedJournalChunks: number }, prospective: CheckpointProspective): PlacementCheckpointHeadroom {
  const largest = prospective.state === "cache-only" && prospective.slots + prospective.reservedJournalChunks > completed.slots + completed.reservedJournalChunks
    ? { slots: prospective.slots, reservedJournalChunks: prospective.reservedJournalChunks } : completed;
  const liveAfter = pages + 4 + 1, nextRenewal = 1, required = liveAfter + nextRenewal + largest.slots + largest.reservedJournalChunks;
  const result: PlacementCheckpointHeadroom = { limit: PLACEMENT_JOURNAL_MAX_OBJECTS, liveAfter, nextRenewal, completedPlan: completed, prospectivePlan: prospective,
    largestPlan: largest, required, remaining: PLACEMENT_JOURNAL_MAX_OBJECTS - required };
  if (result.remaining < 0) throw new PlacementCheckpointError("headroom",
    `the new window needs ${required} of ${PLACEMENT_JOURNAL_MAX_OBJECTS} objects (${liveAfter} after the checkpoint, ${nextRenewal} for the next renewal, ${largest.slots} for the largest observed plan and ${largest.reservedJournalChunks} for its reserved journal chunks), ${-result.remaining} over the limit.`);
  return result;
}
/** The saved preview must include both its sealed intent and the reviewed headroom. */
export function checkpointPlanFrom(value: unknown): CheckpointIntent {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw new PlacementCheckpointError("changed");
  const field = Object.getOwnPropertyDescriptor(value, "plan");
  if (!field || !("value" in field)) throw new PlacementCheckpointError("changed");
  try { return validateCheckpointIntent(field.value); } catch { throw new PlacementCheckpointError("changed"); }
}
function reviewedHeadroom(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw new PlacementCheckpointError("changed");
  const field = Object.getOwnPropertyDescriptor(value, "headroom");
  const detached = field && "value" in field ? memoryPolicySnapshot(field.value) : undefined;
  if (!detached) throw new PlacementCheckpointError("changed");
  return detached;
}
function checkFloor(home: string, roots: PlacementCheckpointInput["roots"] | undefined, minReader: string): void {
  if (!formatFloorAtLeast(home, "sync", minReader)) throw new PlacementCheckpointError("floor");
  // This reader itself below the recorded floor cannot measure anything: name the writer cause, not the inventory.
  try { assertFormatFloor(home, "sync"); } catch { throw new PlacementCheckpointError("writer-below-floor"); }
  if (!roots) return;
  const effective = readEffectiveSyncPlacementWriters(home).roots ?? [];
  const versions = [...roots.map(root => root.version), ...effective.map(root => installVersion(root))];
  if (versions.some(version => version === null || versionBelow(version, minReader))) throw new PlacementCheckpointError("writer-below-floor");
}
/**
 * Confirm one exact sealed plan under the profile, sync and home/realm fences: the floor first, then the planner's own
 * revalidation (fresh install, journal and history must reproduce the sealed bytes), then intent, staging and the commit line.
 * `minReader` is a test seam the CLI never passes.
 * ponytail: the seam exists only while this package is below 0.30.0 (a 0.30.0 floor refuses a 0.29.x reader); task 312 removes it.
 */
export async function confirmPlacementCheckpoint(homeInput: string, value: unknown, opts: { writerRoots: readonly string[]; ownRoot: string; minReader?: string; phase?: (phase: PlacementCheckpointPhase) => void }): Promise<{ window: number; renewed: true; planHash: string; nextStep: string }> {
  const home = realPath(homeInput), intent = checkpointPlanFrom(value), a = active(home), minReader = opts.minReader ?? PLACEMENT_CHECKPOINT_MIN_READER;
  if (intent.epochHash !== a.profile.placementHead) throw new PlacementCheckpointError("changed");
  checkFloor(home, undefined, minReader); checkFloor(home, measured(home, opts.writerRoots, opts.ownRoot), minReader);
  const prospective = await checkpointHeadroom(home, intent);
  if (canonicalJSON(reviewedHeadroom(value)) !== canonicalJSON(prospective.headroom)) throw new PlacementCheckpointError("changed");
  return withPlacementActivationFences(home, placementFenceDirectories(home, a), async (mutation, owner) => {
    const now = active(home), roots = measured(home, opts.writerRoots, opts.ownRoot);
    if (canonicalJSON(now) !== canonicalJSON(a)) throw new PlacementCheckpointError("changed");
    prospective.assertCurrent();
    checkFloor(home, roots, minReader);
    if (placementCheckpointPending(home, intent.epochHash)) throw new PlacementCheckpointError("pending");
    const value = input(home, now, roots, intent.writerRevision.requestId);
    const assertCurrent = () => { assertPlacementActivationOwner(owner); if (!formatFloorAtLeast(home, "sync", minReader)) throw new PlacementCheckpointError("floor"); };
    try { return { ...applyPlacementCheckpoint(home, intent, value, { mutation, assertCurrent, ...(opts.phase ? { phase: opts.phase } : {}) }), renewed: true as const, planHash: intent.seal, nextStep: "amem sync" }; }
    catch (error) {
      const code = error instanceof SyncPlacementJournalError ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
      if (code === "changed" && !placementCheckpointPending(home, intent.epochHash)) throw new PlacementCheckpointError("changed");
      throw error;
    } finally { releasePlacementStorageCaches(); }
  });
}
/** Resume completes only the frozen bytes of the recorded intent: metadata only, no fresh install, policy or source check. */
export async function resumePlacementCheckpointPerson(homeInput: string): Promise<{ window: number; resumed: boolean; nextStep: string }> {
  const home = realPath(homeInput), a = active(home), epochHash = a.profile.placementHead;
  return withPlacementActivationFences(home, placementFenceDirectories(home, a), async (mutation, owner) => {
    try {
      const done = resumePlacementCheckpoint(home, epochHash, { mutation, assertCurrent: () => assertPlacementActivationOwner(owner) });
      return done ? { window: done.window, resumed: true, nextStep: "amem sync" } : { window: resolvePlacementWindow(home, epochHash).window, resumed: false, nextStep: "amem sync" };
    } catch (error) {
      // A torn intent never staged anything: only abandon removes it.
      if (error instanceof SyncPlacementJournalError && Object.getOwnPropertyDescriptor(error, "code")?.value === "pending") throw new PlacementCheckpointError("pending", `The recorded intent is incomplete; run ${ABANDON}.`);
      throw error;
    } finally { releasePlacementStorageCaches(); }
  });
}
/** Abandon removes only intent-owned staging before the first commit byte; after it, refuses and names resume. */
export async function abandonPlacementCheckpointPerson(homeInput: string): Promise<{ removed: number; abandoned: boolean; nextStep: string }> {
  const home = realPath(homeInput), a = active(home), epochHash = a.profile.placementHead;
  return withPlacementActivationFences(home, placementFenceDirectories(home, a), async (mutation, owner) => {
    try {
      const pending = placementCheckpointPending(home, epochHash), done = abandonPlacementCheckpoint(home, epochHash, { mutation, assertCurrent: () => assertPlacementActivationOwner(owner) });
      return { removed: done.removed, abandoned: pending, nextStep: CHECKPOINT_PREVIEW };
    } catch (error) {
      if (error instanceof SyncPlacementJournalError && Object.getOwnPropertyDescriptor(error, "code")?.value === "pending") throw new PlacementCheckpointError("commit-started");
      throw error;
    } finally { releasePlacementStorageCaches(); }
  });
}
