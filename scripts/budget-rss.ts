import { readFileSync } from "node:fs";

/**
 * Per-process peak RSS in kilobytes. On Linux, /proc/self/status VmHWM is the process's own high-water mark
 * (Bun's resourceUsage().maxRSS matched the parent group's mark in CI); elsewhere Bun 1.4.2's maxRSS is already
 * kilobytes (probed on macOS: 80 MB touched -> 92304).
 */
export function peakRssKB(): number {
  if (process.platform === "linux") {
    try {
      const hw = /VmHWM:\s*(\d+)\s*kB/.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
      if (hw !== undefined) return Number(hw);
    } catch { /* fall through to resourceUsage */ }
  }
  return process.resourceUsage().maxRSS;
}
