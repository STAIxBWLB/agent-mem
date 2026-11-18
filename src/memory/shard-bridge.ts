import { inspectLegacySnapshot, legacySnapshotSteps, type LegacySegmentInspector, type LegacyCheckpoint, type LegacySegment, type LegacySnapshotOptions } from "./bridge.ts";
import { drainSteps } from "./sync-placement-yield.ts";
import type { BoundProfile } from "./generation.ts";

/** Copied bridge roots keep their original birth realm; no foreign project root is scanned. */
export function readShardLegacySnapshot(profile: BoundProfile, options: Pick<LegacySnapshotOptions, "checkpoints" | "limits" | "reader" | "incremental">, inspect?: LegacySegmentInspector): LegacySegment[] {
  return drainSteps(shardLegacySnapshotSteps(profile, options, inspect));
}
/** #462: one collector for both curated halves, so a caller that yields reads the public bridge in its own turns too. */
export function* shardLegacySnapshotSteps(profile: BoundProfile, options: Pick<LegacySnapshotOptions, "checkpoints" | "limits" | "reader" | "incremental">, inspect?: LegacySegmentInspector): Generator<void, LegacySegment[], void> {
  const local = (rows: readonly LegacyCheckpoint[] | undefined) => rows?.filter(row => row.source === "legacy-local");
  const main = (rows: readonly LegacyCheckpoint[] | undefined) => rows?.filter(row => row.source === "legacy-main").map(row => ({ ...row, source: "legacy-local", commit: undefined }));
  let result: LegacySegment[];
  if (inspect) result = inspectLegacySnapshot(profile.legacyHome ?? profile.home, {
    ...options, checkpoints: local(options.checkpoints), ...(options.limits ? { limits: local(options.limits) } : {}),
  }, inspect);
  else result = yield* legacySnapshotSteps(profile.legacyHome ?? profile.home, {
    ...options, checkpoints: local(options.checkpoints), ...(options.limits ? { limits: local(options.limits) } : {}),
  });
  if (!profile.legacyMainHome) {
    if ((main(options.checkpoints)?.length ?? 0) || (main(options.limits)?.length ?? 0)) throw new Error("curated shard public bridge is unavailable");
    return result;
  }
  const publicInspector: LegacySegmentInspector | undefined = inspect ? (file, context, prior) => {
    const result = inspect(file, { ...context, source: "legacy-main" }, prior);
    return { ...result, source: context.source };
  } : undefined;
  let publicRows: LegacySegment[];
  if (publicInspector) publicRows = inspectLegacySnapshot(profile.legacyMainHome, {
    ...options, checkpoints: main(options.checkpoints), ...(options.limits ? { limits: main(options.limits) } : {}),
  }, publicInspector);
  else publicRows = yield* legacySnapshotSteps(profile.legacyMainHome, {
    ...options, checkpoints: main(options.checkpoints), ...(options.limits ? { limits: main(options.limits) } : {}),
  });
  return [...result, ...publicRows.map(segment => ({ ...segment, source: "legacy-main" }))];
}
