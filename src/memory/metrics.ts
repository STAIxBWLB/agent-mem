import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rolling resource samples; importing this leaf never loads a memory store or capacity probe. */
export interface MetricSample { at: string; kind: "hook" | "search"; wallMs?: number; rssMB?: number; rawRssMB?: number; idleMB?: number; captureDrops?: number }
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

