import type { PlacementWriterRootCategory } from "../sync-placement-writer-context.ts";

/** #426: the fixed refusal categories of a placement sync; shared by the transport and the progress sidecar. */
export const PLACEMENT_REFUSAL_CATEGORIES = ["epoch", "source-selection", "policy", "remote", "writer-pin", "size-bound", "lock", "other"] as const;
export type PlacementRefusalCategory = typeof PLACEMENT_REFUSAL_CATEGORIES[number];

/** #613: only these two fixed writer-proof facts may be retained. */
export const WRITER_ROOT_CATEGORIES = ["running CLI", "host package", "setup receipt", "declared writer", "active locator", "home floor", "writer renewal"] as const satisfies readonly PlacementWriterRootCategory[];
export const WRITER_CAUSE_CLASSES = ["missing", "changed", "unavailable"] as const;
export interface PlacementWriterRefusal {
  causeClass: typeof WRITER_CAUSE_CLASSES[number];
  rootCategory: PlacementWriterRootCategory;
}

export function validPlacementWriterRefusal(value: unknown): value is PlacementWriterRefusal {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return false;
  const { causeClass, rootCategory } = value as Record<string, unknown>;
  return Object.hasOwn(value, "causeClass") && Object.hasOwn(value, "rootCategory")
    && (WRITER_CAUSE_CLASSES as readonly unknown[]).includes(causeClass)
    && (WRITER_ROOT_CATEGORIES as readonly unknown[]).includes(rootCategory);
}
