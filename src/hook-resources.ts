import { readFileSync } from "node:fs";

export interface HookRssReading { kb: number; rawKB: number; source: "VmHWM" | "platform-rusage" | "raw-fallback" | "unavailable"; known: boolean }
export interface HookRssSources { vmhwm: number; platformRusage: number; rawFallback: number; unavailable: number }
const positive = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0;

/** A raw fallback stays conservative, but is explicitly insufficient to certify a Linux image peak. */
export function selectHookRss(platform: string, imageKB: number | undefined, rawKB: number): HookRssReading {
  const raw = positive(rawKB) ? rawKB : 0;
  if (platform === "linux" && positive(imageKB)) return { kb: imageKB, rawKB: raw, source: "VmHWM", known: true };
  if (platform !== "linux" && raw) return { kb: Math.max(raw, positive(imageKB) ? imageKB : 0), rawKB: raw, source: "platform-rusage", known: true };
  return { kb: raw, rawKB: raw, source: raw ? "raw-fallback" : "unavailable", known: false };
}

export function processImageRssKB(pid: number | "self"): number | undefined {
  if (process.platform !== "linux" || pid !== "self" && (!Number.isSafeInteger(pid) || pid <= 0)) return;
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8"), match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(text);
    const peak = match ? Number(match[1]) : undefined;
    if (positive(peak)) return peak;
  } catch { /* Missing or exited processes are unknown, never a fabricated zero peak. */ }
}

export function hookRssReading(): HookRssReading {
  return selectHookRss(process.platform, processImageRssKB("self"), process.resourceUsage().maxRSS);
}
export const hookPeakRssKB = (): number => hookRssReading().kb;
export const emptyRssSources = (): HookRssSources => ({ vmhwm: 0, platformRusage: 0, rawFallback: 0, unavailable: 0 });
export function rssSource(reading: HookRssReading): HookRssSources {
  const value = emptyRssSources();
  value[reading.source === "VmHWM" ? "vmhwm" : reading.source === "platform-rusage" ? "platformRusage" : reading.source === "raw-fallback" ? "rawFallback" : "unavailable"] = 1;
  return value;
}
export function combineRssSources(...values: (HookRssSources | undefined)[]): HookRssSources {
  const result = emptyRssSources();
  for (const value of values) if (value) for (const key of Object.keys(result) as (keyof HookRssSources)[]) result[key] += value[key];
  return result;
}
export function validRssSources(value: unknown): value is HookRssSources {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, keys = Object.keys(emptyRssSources());
  return Object.keys(row).length === keys.length && keys.every(key => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 && (row[key] as number) <= 1024);
}
export function rssSourcesKnown(value: HookRssSources): boolean {
  return value.rawFallback === 0 && value.unavailable === 0 && value.vmhwm + value.platformRusage > 0;
}
