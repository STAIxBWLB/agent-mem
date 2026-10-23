import { readFileSync } from "node:fs";

/** Linux rusage includes the pre-exec launcher's inherited high-water value. VmHWM belongs
 * to this process image, so a large test runner cannot be mistaken for resident hook memory.
 * Unavailable telemetry falls back conservatively to rusage, never to zero. */
export function hookPeakRssKB(): number {
  if (process.platform === "linux") {
    try {
      const text = readFileSync("/proc/self/status", "utf8");
      const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(text), peak = match && Number(match[1]);
      if (peak && Number.isSafeInteger(peak) && peak > 0) return peak;
    } catch { /* Non-proc Linux hosts retain the conservative historical measurement. */ }
  }
  return process.resourceUsage().maxRSS;
}
