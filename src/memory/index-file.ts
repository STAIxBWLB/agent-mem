/** Bumped when the index's tables change: an index with another version is dropped and rebuilt from the logs. */
export const INDEX_VERSION = 3; // 3: suggest, confirm and reject ops (an older index skipped them)
/** The version that released 0.14.0 through 0.18.0 build into the unversioned names below; it keeps them so this release shares their warm index. */
const SHARED_INDEX_VERSION = 3;

/**
 * The derived curated index file of a profile directory, one per `INDEX_VERSION` (#199 AC4): two releases with different index versions on
 * one home each keep their own file instead of dropping and rebuilding the other's. Version 3 keeps the released names (`index.db`, and
 * `index-v2.db` for the v2 public-prune view, whose `v2` is that view's format, not the index version); every later version names its own,
 * `index-v<N>.db` or `index-v2-i<N>.db`. An older version's file is left as it is.
 */
export function indexFileName(foreignPruneFormat: boolean, version: number = INDEX_VERSION): string {
  const base = foreignPruneFormat ? "index-v2" : "index";
  return version === SHARED_INDEX_VERSION ? `${base}.db` : foreignPruneFormat ? `${base}-i${version}.db` : `${base}-v${version}.db`;
}
