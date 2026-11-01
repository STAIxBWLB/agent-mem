import { readFileSync } from "node:fs";

export const HOOK_RSS_COVERAGE = "images: bun+supervisor; descendants: not measured" as const;

export interface HookRssReading { kb: number; rawKB: number; source: "VmHWM" | "vmpeak-bound" | "platform-rusage" | "raw-fallback" | "unavailable"; known: boolean }
export interface HookRssSources { vmhwm: number; vmpeakBound: number; platformRusage: number; rawFallback: number; unavailable: number }
const positive = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0;

/** A raw fallback stays conservative, but is explicitly insufficient to certify a Linux image peak. */
export function selectHookRss(platform: string, imageKB: number | undefined, rawKB: number, virtualKB?: number): HookRssReading {
  const raw = positive(rawKB) ? rawKB : 0;
  if (platform === "linux" && positive(imageKB)) return { kb: imageKB, rawKB: raw, source: "VmHWM", known: true };
  if (platform === "linux" && positive(virtualKB)) return { kb: virtualKB, rawKB: raw, source: "vmpeak-bound", known: true };
  if (platform !== "linux" && raw) return { kb: Math.max(raw, positive(imageKB) ? imageKB : 0), rawKB: raw, source: "platform-rusage", known: true };
  return { kb: raw, rawKB: raw, source: raw ? "raw-fallback" : "unavailable", known: false };
}

export function processImageMemory(pid: number | "self"): { hwmKB?: number; virtualKB?: number } {
  if (process.platform !== "linux" || pid !== "self" && (!Number.isSafeInteger(pid) || pid <= 0)) return {};
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const field = (match: RegExpExecArray | null) => { const value = Number(match?.[1]); return positive(value) ? value : undefined; };
    return { hwmKB: field(/^VmHWM:\s+(\d+)\s+kB$/m.exec(text)), virtualKB: field(/^VmPeak:\s+(\d+)\s+kB$/m.exec(text)) };
  } catch { /* Missing or exited processes are unknown, never a fabricated zero peak. */ }
  return {};
}
export const processImageRssKB = (pid: number | "self"): number | undefined => processImageMemory(pid).hwmKB;

export function hookRssReading(): HookRssReading {
  const image = processImageMemory("self");
  return selectHookRss(process.platform, image.hwmKB, process.resourceUsage().maxRSS, image.virtualKB);
}
export const hookPeakRssKB = (): number => hookRssReading().kb;
export const emptyRssSources = (): HookRssSources => ({ vmhwm: 0, vmpeakBound: 0, platformRusage: 0, rawFallback: 0, unavailable: 0 });
export function rssSource(reading: HookRssReading): HookRssSources {
  const value = emptyRssSources();
  value[reading.source === "VmHWM" ? "vmhwm" : reading.source === "vmpeak-bound" ? "vmpeakBound" : reading.source === "platform-rusage" ? "platformRusage" : reading.source === "raw-fallback" ? "rawFallback" : "unavailable"] = 1;
  return value;
}
export function combineRssSources(...values: (HookRssSources | undefined)[]): HookRssSources {
  const result = emptyRssSources();
  for (const value of values) if (value) for (const key of Object.keys(result) as (keyof HookRssSources)[]) result[key] += value[key];
  return result;
}
export function countedRssSources(kb: number, value?: HookRssSources): HookRssSources {
  const result = combineRssSources(value);
  if (kb > 0 && Object.values(result).every(count => count === 0)) result.unavailable++;
  return result;
}
export function validRssSources(value: unknown): value is HookRssSources {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, keys = Object.keys(emptyRssSources());
  return Object.keys(row).length === keys.length && keys.every(key => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 && (row[key] as number) <= 1024);
}
export function rssSourcesKnown(value: HookRssSources): boolean {
  return value.rawFallback === 0 && value.unavailable === 0 && value.vmhwm + value.vmpeakBound + value.platformRusage > 0;
}
