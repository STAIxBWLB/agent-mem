/** Placement sync size contract and its privacy-safe refusal receipt (#419). Numbers only: no row, path or policy text. */
import { types } from "node:util";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";

/**
 * One source envelope from activation to first sync: home-wide capture, the selected-source prefixes a publication
 * plan binds, and the canonical rows materialization admits (selected sources plus verified incoming rows) share
 * 64 MiB and 20000 rows. Journal limits are separate and unchanged (20000 records and 256 objects per epoch).
 */
export const PLACEMENT_SOURCE_MAX_BYTES = 64 * 1024 * 1024, PLACEMENT_SOURCE_MAX_ROWS = 20000;

export type PlacementSyncBoundPhase = "source-capture" | "materialization" | "publication-plan";
const KINDS = ["source-bytes", "source-rows", "journal-records", "journal-objects", "bytes", "rows", "source-files", "metadata-bytes", "row-bytes", "retained-identities"] as const;
export type PlacementSyncBoundKind = typeof KINDS[number];
export interface PlacementSyncBound { phase: PlacementSyncBoundPhase; kind: PlacementSyncBoundKind; limit: number; observed: number }

const phases: Record<PlacementSyncBoundPhase, string> = { "source-capture": "source capture", materialization: "materialization", "publication-plan": "publication planning" };
export function placementSyncBoundMessage(bound: PlacementSyncBound): string {
  // #288 step 3: a full live window is relieved by a person-reviewed checkpoint; records stay a reported bound.
  const remedy = bound.kind === "journal-objects"
    ? "The active epoch journal cannot hold this publication. Save a new private preview with (umask 077; set -C; amem migrate --sync-placement --checkpoint --writer-root <install root> --json > checkpoint-plan.json). Repeat --writer-root for every install. After reviewing and approving the saved plan, run amem migrate --sync-placement --checkpoint --writer-root <install root> --confirm --plan checkpoint-plan.json with the same roots, then rerun amem sync."
    : bound.kind === "journal-records"
      ? "The active epoch journal cannot hold this publication; retain the inputs and report this bound."
      : "Retain the inputs and report this bound; no row was omitted to fit.";
  return `Placement sync refused before any publication attempt: ${phases[bound.phase]} exceeds its supported ${bound.kind} bound (observed ${bound.observed}, limit ${bound.limit}). No source, selector, epoch, journal or remote ref was changed by this publication. ${remedy}`;
}
/** Expected input refusal before a publication attempt exists. Code stays "bound" for existing callers. */
export class PlacementSyncBoundError extends SyncPlacementJournalError {
  /** `detail` is an optional numbers-only clause about the same measurement; the receipt never carries it. */
  constructor(readonly bound: PlacementSyncBound, readonly detail?: string) {
    super("bound"); this.message = placementSyncBoundMessage(bound) + (detail ? ` ${detail}` : ""); this.name = "PlacementSyncBoundError";
  }
}
/**
 * #288 step 1: the thrown error's own clause, so a caller that rebuilds the message from the receipt still reports it.
 * Only this class' allowlisted `detail` is read; the receipt stays four fields and no raw caught text is exposed.
 */
export function placementSyncBoundDetail(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== "object" || types.isProxy(error) || !(error instanceof PlacementSyncBoundError)) return undefined;
    const detail = Object.getOwnPropertyDescriptor(error, "detail")?.value;
    return typeof detail === "string" && detail.length > 0 && detail.length <= 512 ? detail : undefined;
  } catch { return undefined; }
}
/** Only allowlisted own data properties of a journal bound error become a receipt; any other exception yields none. */
export function placementSyncBoundReceipt(error: unknown): PlacementSyncBound | undefined {
  try {
    if (!error || typeof error !== "object" || types.isProxy(error) || !(error instanceof SyncPlacementJournalError)) return undefined;
    const own = (object: object, key: string): unknown => Object.getOwnPropertyDescriptor(object, key)?.value;
    const raw = own(error, "bound"); if (own(error, "code") !== "bound" || !raw || typeof raw !== "object" || types.isProxy(raw)) return undefined;
    const kind = own(raw, "kind"), limit = own(raw, "limit"), observed = own(raw, "observed"), phase = own(raw, "phase") ?? "source-capture";
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind) || typeof phase !== "string" || !Object.hasOwn(phases, phase)
      || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 0) return undefined;
    return { phase: phase as PlacementSyncBoundPhase, kind: kind as PlacementSyncBoundKind, limit, observed };
  } catch { return undefined; }
}
