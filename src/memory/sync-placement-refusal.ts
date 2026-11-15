/**
 * #426: why a placement sync refused before a publication attempt existed, as a fixed category and the phase it was in.
 * Category, phase and next step are fixed strings: no path, row content, URL or secret ever reaches the message.
 */
import { types } from "node:util";
import type { SyncProgressPhase } from "./sync-progress.ts";

import { PLACEMENT_REFUSAL_CATEGORIES, type PlacementRefusalCategory } from "./sync-placement-refusal-category.ts";
export { PLACEMENT_REFUSAL_CATEGORIES, type PlacementRefusalCategory };

/** One next step per category (AC2). */
const NEXT: Record<PlacementRefusalCategory, string> = {
  epoch: "Check the active placement epoch with amem migrate --sync-placement --dry-run; do not restore v2 markers.",
  "source-selection": "Another writer changed the selected sources during the run; close other memory writers, then rerun amem sync.",
  policy: "The memory policy changed or is not attested; reload the host so it passes the current policy, then rerun amem sync.",
  remote: "Check the private sync remote (amem sync --remote <url> once, and that the repository is private and reachable), then rerun amem sync.",
  "writer-pin": "A writer sharing this home no longer matches its recorded install; upgrade it to the pinned version, or have the person review amem migrate --sync-placement --dry-run --writer-root <install root> to re-pin it, then rerun amem sync.",
  "size-bound": "Retain the inputs and report this bound; no row was omitted to fit.",
  lock: "Another sync or memory writer holds this home; wait for it to finish (amem sync --status), then rerun amem sync.",
  other: "Rerun amem sync; if it refuses again, report the category and phase shown here.",
};

/** A refusal raised by the transport itself, tagged where the failing check is known. */
export class PlacementSyncRefusal extends Error {
  readonly category: PlacementRefusalCategory;
  constructor(category: PlacementRefusalCategory = "other") {
    const safe = (PLACEMENT_REFUSAL_CATEGORIES as readonly string[]).includes(category) ? category : "other";
    super("placement sync unavailable"); this.name = "PlacementSyncRefusal"; this.category = safe;
  }
}

/** Reads only an own, allowlisted `category` of a real PlacementSyncRefusal; anything else is `undefined`. */
export function placementRefusalCategoryOf(error: unknown): PlacementRefusalCategory | undefined {
  try {
    if (!error || typeof error !== "object" || types.isProxy(error) || !(error instanceof PlacementSyncRefusal)) return undefined;
    const value = Object.getOwnPropertyDescriptor(error, "category")?.value;
    return typeof value === "string" && (PLACEMENT_REFUSAL_CATEGORIES as readonly string[]).includes(value) ? value as PlacementRefusalCategory : undefined;
  } catch { return undefined; }
}

export function placementRefusalNextStep(category: PlacementRefusalCategory): string { return NEXT[category]; }

/** AC1/AC4: the person-facing refusal. `other` keeps the generic wording and still names the phase. */
export function placementRefusalMessage(category: PlacementRefusalCategory, phase: SyncProgressPhase): string {
  const where = phase.replaceAll("-", " ");
  return category === "other"
    ? `Placement sync is unavailable (category other, phase ${where}); verify the active epoch, selected sources, policy, private remote and writer pins before retrying. ${NEXT.other}`
    : `Placement sync refused (category ${category}, phase ${where}). ${NEXT[category]}`;
}
