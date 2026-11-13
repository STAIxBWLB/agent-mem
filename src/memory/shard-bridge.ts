import { inspectLegacySnapshot, readLegacySnapshot, type LegacySegmentInspector, type LegacyCheckpoint, type LegacySegment, type LegacySnapshotOptions } from "./bridge.ts";
import type { BoundProfile } from "./generation.ts";

/** Copied bridge roots keep their original birth realm; no foreign project root is scanned. */
export function readShardLegacySnapshot(profile: BoundProfile, options: Pick<LegacySnapshotOptions, "checkpoints" | "limits" | "reader" | "incremental">, inspect?: LegacySegmentInspector): LegacySegment[] {
  const local = (rows: readonly LegacyCheckpoint[] | undefined) => rows?.filter(row => row.source === "legacy-local");
  const main = (rows: readonly LegacyCheckpoint[] | undefined) => rows?.filter(row => row.source === "legacy-main").map(row => ({ ...row, source: "legacy-local", commit: undefined }));
  const read = (home: string, input: LegacySnapshotOptions, visitor = inspect) => visitor ? inspectLegacySnapshot(home, input, visitor) : readLegacySnapshot(home, input);
  const result = read(profile.legacyHome ?? profile.home, {
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
  const publicRows = read(profile.legacyMainHome, {
    ...options, checkpoints: main(options.checkpoints), ...(options.limits ? { limits: main(options.limits) } : {}),
  }, publicInspector).map(segment => ({ ...segment, source: "legacy-main" }));
  return [...result, ...publicRows];
}
