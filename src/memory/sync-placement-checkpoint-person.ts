/**
 * Person surface of the placement checkpoint (#288 step 3): a readonly preview, confirm of one exact sealed plan, resume
 * and abandon. Never automatic and never on the capture or hook path. Code never raises a floor: confirm only reads the
 * person-written floor record (`amem formats raise` is the one writer).
 */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { memoryPolicySnapshot } from "./policy.ts";
import { realPath } from "./platform.ts";
import { canonicalJSON } from "./generation.ts";
import { assertFormatFloor, formatVersionBelow, readFormatFloors } from "./formats.ts";
import { installVersion } from "./formats-raise.ts";
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
import { PLACEMENT_CHECKPOINT_LIMIT, PLACEMENT_CHECKPOINT_MIN_READER, validateCheckpointIntent, type CheckpointIntent } from "./sync-placement-checkpoint-format.ts";
import { withPlacementCheckpointFences } from "./sync-placement-activation-locks.ts";
import { assertPlacementActivationOwner } from "./sync-placement-activation-proof.ts";
import { placementFenceDirectories } from "./sync-placement-writer-renewal.ts";
import { initialPlacementWriterContext } from "../sync-placement-writer-context.ts";
import { readSetupWriterRoots, SetupWriterRootsError } from "../setup-writer-roots.ts";
import { checkpointProspective, type CheckpointProspective } from "./sync-placement-checkpoint-prospective.ts";
import { ShardHistoryError, type ShardHistoryCause } from "./shard-sync-history.ts";

export const CHECKPOINT_PREVIEW = PLACEMENT_CHECKPOINT_COMMAND;
const RESUME = `${CHECKPOINT_PREVIEW} --resume`, ABANDON = `${CHECKPOINT_PREVIEW} --abandon`;
const homeFloorAtLeast = (home: string, minimum: string): boolean =>
  (readFormatFloors(home) ?? []).some(floor => floor.surface === "home" && !formatVersionBelow(floor.minReader, minimum));

export type PlacementCheckpointCause = "pending" | "commit-started" | "floor" | "writer-below-floor" | "headroom" | "obligation" | "changed" | "inactive" | "candidate" | "history" | "writer-missing";
const MESSAGES: Record<PlacementCheckpointCause, string> = {
  pending: PLACEMENT_CHECKPOINT_PENDING_MESSAGE,
  "commit-started": `The placement checkpoint's commit line has started, so it can no longer be abandoned; run ${RESUME} to complete it.`,
  floor: `Confirming a placement checkpoint requires the person-written home floor of ${PLACEMENT_CHECKPOINT_MIN_READER} or later; preview it with amem formats raise home ${PLACEMENT_CHECKPOINT_MIN_READER}, confirm it with --confirm, then rerun the confirm (amem never raises a floor itself).`,
  "writer-below-floor": `A writer sharing this home is below the recorded home or sync format floor; inspect formats.json and upgrade it, then preview again with ${CHECKPOINT_PREVIEW} --writer-root <install root> for every install.`,
  headroom: "",
  obligation: "The placement journal has an unfinished append, publication, reservation, renewal or source recovery; finish it with amem sync (or the pending renewal with amem migrate --sync-placement --resume), then preview the checkpoint again.",
  changed: `The placement state changed since the checkpoint plan was sealed; preview a fresh plan with ${CHECKPOINT_PREVIEW} and confirm that one.`,
  inactive: "This home has no active sync placement; activate it with amem migrate --sync-placement --dry-run first.",
  candidate: `A checkpoint carries one writer renewal: pass the complete inventory as repeatable --writer-root <install root> (every amem install sharing this home), then preview again with ${CHECKPOINT_PREVIEW}.`,
  history: "",
  "writer-missing": "",
};
/** #567: the retained-history cause class and, for `bound`, which bound with its counts. Never a path, row or object id. */
export interface PlacementCheckpointHistoryRefusal { category: "shard history"; cause: ShardHistoryCause; kind?: string; limit?: number; observed?: number }
function historyMessage(refusal: PlacementCheckpointHistoryRefusal): string {
  const exceeded = refusal.cause === "bound" && refusal.kind !== undefined ? ` (${refusal.kind}: ${refusal.observed} over the limit of ${refusal.limit})` : "";
  const next = refusal.cause === "bound"
    ? "Retain the history and do not abandon or edit it; a window this large needs the multi-plan checkpoint work in #288. Nothing was written."
    : `Retain the selected history and inspect it with a compatible runtime, then preview again with ${CHECKPOINT_PREVIEW}. Nothing was written.`;
  return `The checkpoint could not inspect retained shard history: shard history ${refusal.cause}${exceeded}. ${next}`;
}
/** A person-facing checkpoint refusal with one cause class and its next step; never a path, row or project name. */
export class PlacementCheckpointError extends Error {
  readonly history?: PlacementCheckpointHistoryRefusal;
  constructor(readonly causeClass: PlacementCheckpointCause, detail = "", history?: PlacementCheckpointHistoryRefusal) {
    super(causeClass === "headroom" ? `The checkpoint would not leave room for the next sync: ${detail} A single checkpoint cannot unblock this plan; the deferred multi-plan split in #288 design item 5 is the open path. Nothing was written.`
      : causeClass === "history" && history ? historyMessage(history) : [MESSAGES[causeClass], detail].filter(Boolean).join(" "));
    this.name = "PlacementCheckpointError";
    if (causeClass === "history" && history) this.history = history;
  }
}
/** Maps only this module's closed ShardHistoryError data to the checkpoint's history cause; anything else is rethrown. */
function historyRefusal(error: unknown): never {
  if (error instanceof ShardHistoryError) {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value as ShardHistoryCause, bound = code === "bound" ? error.bound : undefined;
    throw new PlacementCheckpointError("history", "", { category: "shard history", cause: code, ...(bound ? { kind: bound.kind, limit: bound.limit, observed: bound.observed } : {}) });
  }
  throw error;
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
  // #634: name a removed install before measurement turns it into a generic inventory refusal; preview and confirm both pass here.
  const missing = writerRoots.find(installAbsent);
  if (missing !== undefined) throw new PlacementCheckpointError("writer-missing", missingWriterMessage(missing));
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
export async function previewPlacementCheckpoint(homeInput: string, opts: { writerRoots: readonly string[]; ownRoot: string }): Promise<PlacementCheckpointPreview> {
  const home = realPath(homeInput), a = active(home), epochHash = a.profile.placementHead;
  const roots = measured(home, opts.writerRoots, opts.ownRoot), intent = plan(home, epochHash, input(home, a, roots, randomBytes(32).toString("hex")));
  const journal = readPlacementJournal(home, epochHash), window = resolvePlacementWindow(home, epochHash);
  const { headroom, journalObjects, assertCurrent } = await checkpointHeadroom(home, intent);
  assertCurrent();
  const minReader = PLACEMENT_CHECKPOINT_MIN_READER;
  return { mode: "checkpoint-preview", window: window.window, nextWindow: intent.window, journalObjects, currentObjects: journal.objects, headroom,
    floorReady: homeFloorAtLeast(home, minReader), requiredHomeFloor: minReader, writers: roots.length, planHash: intent.seal, plan: intent,
    nextStep: `(umask 077; set -C; ${CHECKPOINT_PREVIEW} --writer-root <install root> --json > checkpoint-plan.json), repeating --writer-root for every install, then ${CHECKPOINT_PREVIEW} --confirm --plan checkpoint-plan.json with the same --writer-root list` };
}
async function checkpointHeadroom(home: string, intent: CheckpointIntent): Promise<{ headroom: PlacementCheckpointHeadroom; journalObjects: PlacementJournalObjectComposition; assertCurrent(): void }> {
  const epochHash = intent.epochHash, prospective = await checkpointProspective(home).catch(historyRefusal);
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
/**
 * #634: an install whose root no longer exists (ENOENT or ENOTDIR on the root itself). An existing root with a missing or
 * unreadable package.json is not absent: it can still run, so the floor check keeps refusing it.
 */
function installAbsent(root: string): boolean {
  try { lstatSync(root); return false; } catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }
}
function missingWriterMessage(root: string): string {
  return `The install at ${root} no longer exists; drop that --writer-root, then save the preview again with (umask 077; set -C; ${CHECKPOINT_PREVIEW} --writer-root <install root> --json > checkpoint-plan.json), repeating --writer-root for every remaining install, and confirm it with ${CHECKPOINT_PREVIEW} --confirm --plan checkpoint-plan.json with the same --writer-root list.`;
}
function checkFloor(home: string, roots: PlacementCheckpointInput["roots"] | undefined, minReader: string): void {
  if (!homeFloorAtLeast(home, minReader)) throw new PlacementCheckpointError("floor");
  // This reader itself below the recorded floor cannot measure anything: name the writer cause, not the inventory.
  try { assertFormatFloor(home, "sync"); } catch { throw new PlacementCheckpointError("writer-below-floor"); }
  if (!roots) return;
  const effective = readEffectiveSyncPlacementWriters(home).roots ?? [];
  // #634: an inventoried install that is gone from disk and left out of the new plan can no longer write here; the
  // renewal removes it. A root the new plan measures is checked through its measured version.
  const renewed = new Set(roots.map(root => root.root));
  const retained = effective.filter(root => !renewed.has(root) && !installAbsent(root));
  const versions = [...roots.map(root => root.version), ...retained.map(root => installVersion(root))];
  const floors = (readFormatFloors(home) ?? []).filter(floor => floor.surface === "home" || floor.surface === "sync");
  if (versions.some(version => version === null || floors.some(floor => formatVersionBelow(version, floor.minReader)))) throw new PlacementCheckpointError("writer-below-floor");
}
/**
 * Confirm one exact sealed plan under the profile, sync and home/realm fences: the floor first, then the planner's own
 * revalidation (fresh install, journal and history must reproduce the sealed bytes), then intent, staging and the commit line.
 */
export async function confirmPlacementCheckpoint(homeInput: string, value: unknown, opts: { writerRoots: readonly string[]; ownRoot: string; phase?: (phase: PlacementCheckpointPhase) => void }): Promise<{ window: number; renewed: true; planHash: string; nextStep: string }> {
  const home = realPath(homeInput), intent = checkpointPlanFrom(value), a = active(home), minReader = PLACEMENT_CHECKPOINT_MIN_READER;
  if (intent.epochHash !== a.profile.placementHead) throw new PlacementCheckpointError("changed");
  checkFloor(home, undefined, minReader); checkFloor(home, measured(home, opts.writerRoots, opts.ownRoot), minReader);
  const prospective = await checkpointHeadroom(home, intent);
  if (canonicalJSON(reviewedHeadroom(value)) !== canonicalJSON(prospective.headroom)) throw new PlacementCheckpointError("changed");
  return withPlacementCheckpointFences(home, placementFenceDirectories(home, a), async (mutation, owner) => {
    const now = active(home), roots = measured(home, opts.writerRoots, opts.ownRoot);
    if (canonicalJSON(now) !== canonicalJSON(a)) throw new PlacementCheckpointError("changed");
    prospective.assertCurrent();
    checkFloor(home, roots, minReader);
    const floorSnapshot = canonicalJSON(readFormatFloors(home));
    if (placementCheckpointPending(home, intent.epochHash)) throw new PlacementCheckpointError("pending");
    const value = input(home, now, roots, intent.writerRevision.requestId);
    const assertCurrent = () => { assertPlacementActivationOwner(owner); if (canonicalJSON(readFormatFloors(home)) !== floorSnapshot) throw new PlacementCheckpointError("floor"); };
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
  return withPlacementCheckpointFences(home, placementFenceDirectories(home, a), async (mutation, owner) => {
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
  return withPlacementCheckpointFences(home, placementFenceDirectories(home, a), async (mutation, owner) => {
    try {
      const pending = placementCheckpointPending(home, epochHash), done = abandonPlacementCheckpoint(home, epochHash, { mutation, assertCurrent: () => assertPlacementActivationOwner(owner) });
      return { removed: done.removed, abandoned: pending, nextStep: CHECKPOINT_PREVIEW };
    } catch (error) {
      if (error instanceof SyncPlacementJournalError && Object.getOwnPropertyDescriptor(error, "code")?.value === "pending") throw new PlacementCheckpointError("commit-started");
      throw error;
    } finally { releasePlacementStorageCaches(); }
  });
}

/** #578 Q2: the counts-only outcome of a sync-run checkpoint, or its refusal with a fixed cause and text. */
export type CheckpointOnBoundResult = { ok: true; window: number; objectsBefore: number; objectsAfter: number }
  | { ok: false; cause: PlacementCheckpointCause | "pins" | "cap" | "fence"; message: string };
/**
 * #578 Q2 (owner choice c): a sync-run checkpoint with an unchanged writer inventory, behind the home opt-in.
 * The caller must already have released every placement lock its failed publication held (the transport's own finally),
 * because the checkpoint fence takes the same mutation and sync locks again in this process.
 * The root set is this package's own root (`import.meta.url`), every setup-receipt root and every effective root; it
 * runs only when that set is exactly the effective inventory and the caller's attestation re-measures identical pins.
 * Every other refusal comes from the person preview and confirm themselves (headroom, floors, obligations, history).
 */
export async function checkpointOnBound(homeInput: string, attest: () => unknown, ownRoot = fileURLToPath(new URL("../..", import.meta.url))): Promise<CheckpointOnBoundResult> {
  const refuse = (cause: Extract<CheckpointOnBoundResult, { ok: false }>["cause"], message: string): CheckpointOnBoundResult => ({ ok: false, cause, message });
  const pins = "Sync-run placement checkpoint refused: the writer inventory changed or is incomplete; a person renews it with amem migrate --sync-placement --dry-run, then --apply.";
  try {
    const home = realPath(homeInput), effective = readEffectiveSyncPlacementWriters(home), roots = effective.roots;
    if (!roots) return refuse("pins", pins);
    let own: string; try { own = realPath(ownRoot); } catch { return refuse("pins", pins); }
    const wanted = new Set([...roots, ...readSetupWriterRoots(home), own]);
    if (wanted.size !== roots.length || ![...wanted].every(root => roots.includes(root))) return refuse("pins", pins);
    try { attest(); } catch { return refuse("pins", pins); }
    const window = resolvePlacementWindow(home, effective.epochHash);
    if (window.window + 1 >= PLACEMENT_CHECKPOINT_LIMIT - 1)
      return refuse("cap", `Sync-run placement checkpoint refused: window ${window.window + 1} would reach the last checkpoints of this epoch; a person decides it with ${CHECKPOINT_PREVIEW}.`);
    const preview = await previewPlacementCheckpoint(home, { writerRoots: roots, ownRoot: own });
    const done = await confirmPlacementCheckpoint(home, preview, { writerRoots: roots, ownRoot: own });
    return { ok: true, window: done.window, objectsBefore: preview.currentObjects, objectsAfter: readPlacementJournal(home, effective.epochHash).objects };
  } catch (error) {
    if (error instanceof PlacementCheckpointError) return refuse(error.causeClass, `Sync-run placement checkpoint refused: ${error.message}`);
    if (error instanceof Error && error.name === "PlacementInventoryFenceError") return refuse("fence", error.message);
    if (error instanceof SetupWriterRootsError) return refuse("pins", pins);
    return refuse("changed", "Sync-run placement checkpoint refused: placement state changed or could not be read; run the checkpoint preview.");
  } finally { releasePlacementStorageCaches(); }
}
