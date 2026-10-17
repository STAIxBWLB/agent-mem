import { readLegacySnapshot, type LegacyCheckpoint, type LegacySegment, type LegacySnapshotOptions } from "./bridge.ts";
import type { BoundProfile } from "./generation.ts";

/** Copied bridge roots keep their original birth realm; no foreign project root is scanned. */
export function readShardLegacySnapshot(profile: BoundProfile, options: Pick<LegacySnapshotOptions, "checkpoints" | "limits" | "reader" | "incremental">): LegacySegment[] {
  const local = (rows: readonly LegacyCheckpoint[] | undefined) => rows?.filter(row => row.source === "legacy-local");
  const main = (rows: readonly LegacyCheckpoint[] | undefined) => rows?.filter(row => row.source === "legacy-main").map(row => ({ ...row, source: "legacy-local", commit: undefined }));
  const result = readLegacySnapshot(profile.legacyHome ?? profile.home, {
    ...options, checkpoints: local(options.checkpoints), ...(options.limits ? { limits: local(options.limits) } : {}),
  });
  if (!profile.legacyMainHome) {
    if ((main(options.checkpoints)?.length ?? 0) || (main(options.limits)?.length ?? 0)) throw new Error("curated shard public bridge is unavailable");
    return result;
  }
  const publicRows = readLegacySnapshot(profile.legacyMainHome, {
    ...options, checkpoints: main(options.checkpoints), ...(options.limits ? { limits: main(options.limits) } : {}),
  }).map(segment => ({ ...segment, source: "legacy-main" }));
  return [...result, ...publicRows];
}
