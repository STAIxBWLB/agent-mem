/** #426: the fixed refusal categories of a placement sync; shared by the transport and the progress sidecar. */
export const PLACEMENT_REFUSAL_CATEGORIES = ["epoch", "source-selection", "policy", "remote", "writer-pin", "size-bound", "lock", "other"] as const;
export type PlacementRefusalCategory = typeof PLACEMENT_REFUSAL_CATEGORIES[number];
