import { closeSync, constants, fstatSync, openSync, readSync, appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rolling resource samples; importing this leaf never loads a memory store or capacity probe. */
export interface MetricSample { at: string; kind: "hook" | "search"; wallMs?: number; rssMB?: number; rawRssMB?: number; idleMB?: number; captureDrops?: number; captureDropReason?: CaptureDropReason }
const METRICS_MAX_BYTES = 64 * 1024, METRICS_KEEP = 200;

export function metricsPath(base: string): string {
  return join(base, "metrics.jsonl");
}

/** Append samples, trimming the rolling file when it outgrows its bound (newest samples win). */
export function appendMetrics(base: string, samples: MetricSample[]): void {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const file = metricsPath(base);
  appendFileSync(file, samples.map((s) => JSON.stringify(s)).join("\n") + "\n", { mode: 0o600 });
  try {
    if (statSync(file).size <= METRICS_MAX_BYTES) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-METRICS_KEEP);
    writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  } catch { /* a trim failure loses nothing: the file simply stays larger */ }
}

/** The newest samples first-preserved order (oldest to newest); malformed lines are skipped. */
export function readMetrics(base: string, limit = METRICS_KEEP): MetricSample[] {
  let lines: string[] = [];
  try { lines = readFileSync(metricsPath(base), "utf8").split("\n").filter(Boolean); } catch { return []; }
  const out: MetricSample[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const s = JSON.parse(line) as MetricSample;
      if ((s?.kind === "hook" || s?.kind === "search") && typeof s.at === "string") out.push(s);
    } catch { /* a malformed line is skipped */ }
  }
  return out;
}


export type CaptureDropReason = "spool_full" | "cwd_removed" | "undrainable_expired" | "scope_unknown" | "project_archived" | "project_forgotten";
const DROP_REASONS: readonly CaptureDropReason[] = ["spool_full", "cwd_removed", "undrainable_expired", "scope_unknown", "project_archived", "project_forgotten"];
/** Numeric notice only, bounded to the rolling metric tail; never an all-time counter. */
export function captureDropSummary(base: string): Partial<Record<CaptureDropReason, number>> {
  const counts: Partial<Record<CaptureDropReason, number>> = {};
  let fd: number | undefined;
  try {
    fd = openSync(metricsPath(base), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); if (!stat.isFile()) return counts;
    const start = Math.max(0, stat.size - METRICS_MAX_BYTES), bytes = Buffer.alloc(stat.size - start);
    const length = readSync(fd, bytes, 0, bytes.length, start);
    let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    if (start) text = text.slice(text.indexOf("\n") + 1);
    for (const line of text.split("\n").filter(Boolean).slice(-METRICS_KEEP)) {
      try {
        const sample = JSON.parse(line) as MetricSample;
        if (sample.kind !== "hook" || !DROP_REASONS.includes(sample.captureDropReason!) || !Number.isSafeInteger(sample.captureDrops) || sample.captureDrops! <= 0) continue;
        const reason = sample.captureDropReason!;
        counts[reason] = (counts[reason] ?? 0) + sample.captureDrops!;
      } catch { /* A malformed metric is never a notice. */ }
    }
  } catch { /* Metric availability never denies the native call. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return counts;
}
