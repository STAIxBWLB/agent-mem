import { closeSync, constants, fstatSync, openSync, readSync, appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { HookRssSources } from "../hook-resources.ts";
import { join } from "node:path";

/** Rolling resource samples; importing this leaf never loads a memory store or capacity probe. */
export interface MetricSample { at: string; kind: "hook" | "search"; wallMs?: number; rssMB?: number; rawRssMB?: number; rssSources?: HookRssSources; rssScope?: "owned-images"; transcriptOffset?: number; transcriptStopReason?: "cap" | "deadline" | "spool_full"; idleMB?: number; captureDrops?: number; captureDropReason?: CaptureDropReason }
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


export type CaptureDropReason = "spool_full" | "cwd_removed" | "undrainable_expired" | "scope_unknown" | "project_archived" | "project_forgotten" | "unknown_schema_expired" | "transcript_line_bound";
const DROP_REASONS: readonly CaptureDropReason[] = ["spool_full", "cwd_removed", "undrainable_expired", "scope_unknown", "project_archived", "project_forgotten", "unknown_schema_expired", "transcript_line_bound"];
/** Numeric notice only, bounded to the rolling metric tail; never an all-time counter. Fails open to no counts: hooks never deny over metrics. */
export function captureDropSummary(base: string): Partial<Record<CaptureDropReason, number>> {
  const read = readCaptureDrops(base);
  return read.readable ? read.counts : {};
}

/**
 * The same bounded read, but it says when an existing metrics file could not be read (a person-facing report must not show that as zero, #132).
 * An absent file is readable with no counts. `reason` is a fixed phrase, never file content.
 */
export function readCaptureDrops(base: string): { readable: true; counts: Partial<Record<CaptureDropReason, number>>; lines: number; malformedLines: number } | { readable: false; reason: string } {
  const counts: Partial<Record<CaptureDropReason, number>> = {};
  let fd: number | undefined, lines = 0, malformedLines = 0;
  try {
    try { fd = openSync(metricsPath(base), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { readable: true, counts, lines: 0, malformedLines: 0 }; return { readable: false, reason: "metrics.jsonl exists but cannot be opened" }; }
    const stat = fstatSync(fd); if (!stat.isFile()) return { readable: false, reason: "metrics.jsonl is not a plain file" };
    const start = Math.max(0, stat.size - METRICS_MAX_BYTES), bytes = Buffer.alloc(stat.size - start);
    const length = readSync(fd, bytes, 0, bytes.length, start);
    let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    if (start) text = text.slice(text.indexOf("\n") + 1);
    const tail = text.split("\n").filter(line => line.trim() !== "").slice(-METRICS_KEEP);
    lines = tail.length;
    for (const line of tail) {
      try {
        const sample = JSON.parse(line) as MetricSample;
        if (sample.kind !== "hook" || !DROP_REASONS.includes(sample.captureDropReason!) || !Number.isSafeInteger(sample.captureDrops) || sample.captureDrops! <= 0) continue;
        const reason = sample.captureDropReason!;
        counts[reason] = (counts[reason] ?? 0) + sample.captureDrops!;
      } catch { malformedLines++; /* A malformed metric is never a notice; doctor reports how many were skipped. */ }
    }
  } catch { return { readable: false, reason: "metrics.jsonl cannot be read or is not UTF-8" }; }
  finally { if (fd !== undefined) closeSync(fd); }
  return { readable: true, counts, lines, malformedLines };
}
