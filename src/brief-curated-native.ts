import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { briefCacheFile, readBriefCache, type BriefCache } from "./brief-cache.ts";
import { briefCacheFresh, curatedCacheFresh } from "./brief-curated.ts";
import { assertFormatFloor, formatFloorAtLeast, FormatFloorError, PREFERENCE_MIN_READER } from "./memory/formats.ts";
import { captureShardDir } from "./memory/shard.ts";

// ponytail: #322 is planned for 0.24.0. If that release ships before this change,
// the release PR must move this constant to the first release containing invalidation.
export const CURATED_CACHE_MIN_READER = "0.24.0";

/**
 * ponytail: a missed invalidation path can serve at most 24 hours of stale curated data.
 * Upgrade to the bounded authoritative manifest frontier if real missed paths justify it.
 * No writer or reader raises the person-owned floor.
 */
export function readCuratedBriefCache(options: { base: string; project: string; profile: string; supportingRelease: string; deferredReason: string; now: number }): { cache?: BriefCache; reason?: string } {
  try {
    assertFormatFloor(options.base, "curated");
    if (!formatFloorAtLeast(options.base, "curated", options.supportingRelease)) return { reason: options.deferredReason };
    let machine: unknown;
    try { machine = JSON.parse(readFileSync(join(options.base, "machine.json"), "utf8")).id; } catch { /* No machine means no prebuilt section. */ }
    if (typeof machine !== "string" || !/^[a-f0-9]{16}$/.test(machine)) return { reason: "curated cache missing" };
    const binding = { directory: captureShardDir(options.base, options.project, machine), project: options.project, section: "curated" as const };
    if (!lstatSync(briefCacheFile(binding), { throwIfNoEntry: false })) return { reason: "curated cache missing" };
    const cache = readBriefCache(binding);
    return cache && curatedCacheFresh(cache, options.profile, options.now) ? { cache } : { reason: "curated cache stale" };
  } catch (error) {
    if (error instanceof FormatFloorError) return { reason: error.code === "format_floor" ? "floor: upgrade amem" : "floor: amem doctor" };
    return { reason: "curated cache stale" };
  }
}

/**
 * #370: the SessionStart preference slot's sidecar. It carries the curated section's gate, not one of its own: a person-recorded floor
 * above this reader refuses before any prebuilt row is served, and a home whose floor does not admit the kind cannot legitimately hold
 * a preference row at all. A missing or stale sidecar yields no slot, never a coverage reason, so a home without preferences keeps a
 * byte-identical brief.
 */
export function readPreferenceBriefCache(options: { base: string; project: string; profile: string; now: number }): BriefCache | undefined {
  try {
    assertFormatFloor(options.base, "curated");
    if (!formatFloorAtLeast(options.base, "curated", PREFERENCE_MIN_READER)) return;
    let machine: unknown;
    try { machine = JSON.parse(readFileSync(join(options.base, "machine.json"), "utf8")).id; } catch { /* No machine means no prebuilt section. */ }
    if (typeof machine !== "string" || !/^[a-f0-9]{16}$/.test(machine)) return;
    const binding = { directory: captureShardDir(options.base, options.project, machine), project: options.project, section: "preferences" as const };
    if (!lstatSync(briefCacheFile(binding), { throwIfNoEntry: false })) return;
    const cache = readBriefCache(binding);
    return cache && briefCacheFresh(cache.preferences, options.profile, options.now) ? cache : undefined;
  } catch { return undefined; }
}
