import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { memoryBase } from "./home.ts";
import { walkShards } from "./catalog.ts";
import { captureShardGrowth, captureShardStats, readCaptureConfigFile, CAPTURE_DEFAULT_CAP_MB, CAPTURE_DEFAULT_RETENTION_DAYS, type CaptureConfig } from "./capture.ts";

/**
 * #13 R7: the capacity advisor. `capacityReport()` reads this machine's load and proposes capture bounds; the
 * `amem capacity` CLI renders it and `amem capacity apply` writes the home default config after a preview. An
 * agent may read the proposal through this library function; applying stays person-only at the CLI.
 *
 * Proposal rule (owner decision, 2026-10-17, item 2): the proposed cap and retention are the largest values whose projection stays within the
 * disk-share bound (default 2% of free space, configurable) and whose measured search and hook readings stay within R2/R3, and they may be above
 * the current ones. The cap is the disk-share bound itself; retention is the share over the daily growth, up to a 365-day ceiling. R2 halves the cap
 * and R3 halves the retention. The reason names every binding constraint: `disk-share retention` or `retention ceiling`, `disk-share cap`,
 * `R3 search RSS`, `R2 hook cost`. The advisor never writes: applying stays person-only, preview first.
 *
 * Metrics: a small rolling `metrics.jsonl` in the memory home (not a memory log: it is trimmed, never synced).
 * `scripts/measure-budget.ts` writes only to its synthetic home; the P3 hooks will append real samples per invocation.
 */

export interface MetricSample { at: string; kind: "hook" | "search"; wallMs?: number; rssMB?: number; idleMB?: number }
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

const p95 = (samples: number[]): number | null => samples.length ? [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * 0.95) - 1)]! : null;

function diskReadings(path: string): { freeBytes: number; totalBytes: number } {
  const df = spawnSync("df", ["-k", path], { encoding: "utf8" });
  const line = df.stdout?.trim().split("\n").at(-1) ?? "";
  const fields = line.split(/\s+/);
  const total = Number(fields[1]), avail = Number(fields[3]);
  if (df.status !== 0 || !Number.isFinite(total) || !Number.isFinite(avail)) throw new Error(`df could not read ${path}`);
  return { freeBytes: avail * 1024, totalBytes: total * 1024 };
}

/** Best-effort memory pressure: macOS `memory_pressure`, Linux `/proc/pressure/memory`; null when neither answers. */
function memoryPressure(): string | null {
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/bin/memory_pressure", [], { encoding: "utf8" });
    const free = /System-wide memory free percentage:\s*(\d+)%/.exec(r.stdout ?? "")?.[1];
    if (free !== undefined) return `free ${free}%`;
    const level = /The system has (?:memory pressure level )?(\w+)/.exec(r.stdout ?? "")?.[1];
    return level ?? null;
  }
  try {
    const avg10 = /avg10=([\d.]+)/.exec(readFileSync("/proc/pressure/memory", "utf8"))?.[1];
    return avg10 === undefined ? null : `avg10 ${avg10}`;
  } catch { return null; }
}

export interface CapacityReport {
  at: string;
  capture: { shards: number; bytes: number; rows: number; rowsPerDay: number; bytesPerDay: number };
  disk: { freeBytes: number; totalBytes: number };
  memory: { totalBytes: number; pressure: string | null };
  metrics: { samples: number; hookP95Ms: number | null; hookRssMB: number | null; searchP95Ms: number | null; searchRssMB: number | null };
  projected: { days: number; bytes: number };
  current: CaptureConfig;
  diskShare: number;
  proposal: { capMb: number; retentionDays: number; reason: string };
}

const MB = 1048576, GROWTH_DAYS = 7, PROJECT_DAYS = 30;
// ponytail: the advisor never proposes more than a year of retention. The ceiling keeps a quiet home's proposal finite; the upgrade path is a person setting (a configured ceiling) once someone wants longer.
const RETENTION_CEILING_DAYS = 365;

export function capacityReport(opts: {
  home?: string; memoryDir?: string; diskShare?: number; now?: () => number;
  /** Tests and fixtures inject machine readings; the CLI always uses the native ones. */
  inject?: { disk?: { freeBytes: number; totalBytes: number }; memoryPressure?: string | null; metrics?: MetricSample[] };
} = {}): CapacityReport {
  if (opts.memoryDir !== undefined && opts.home !== undefined) throw new Error("choose a home or an exact memory directory");
  const base = opts.memoryDir ?? memoryBase(opts.home);
  mkdirSync(base, { recursive: true, mode: 0o700 }); // a report on a fresh home still needs a path df can read
  const now = opts.now ?? Date.now;
  const since = new Date(now() - GROWTH_DAYS * 24 * 3600_000).toISOString();
  const shards = walkShards(base);
  let bytes = 0, rows = 0, growthRows = 0, growthBytes = 0;
  for (const shard of shards) for (const dir of shard.machineDirs) {
    const total = captureShardStats(dir);
    rows += total.rows;
    bytes += total.bytes;
    const growth = captureShardGrowth(dir, since);
    growthRows += growth.rows;
    growthBytes += growth.bytes;
  }
  const rowsPerDay = growthRows / GROWTH_DAYS, bytesPerDay = growthBytes / GROWTH_DAYS;
  const disk = opts.inject?.disk ?? diskReadings(base);
  const pressure = opts.inject?.memoryPressure !== undefined ? opts.inject.memoryPressure : memoryPressure();
  const samples = opts.inject?.metrics ?? readMetrics(base);
  const hookWalls = samples.filter((s) => s.kind === "hook" && typeof s.wallMs === "number").map((s) => s.wallMs!);
  const hookRss = samples.filter((s) => s.kind === "hook" && typeof s.rssMB === "number").map((s) => s.rssMB!);
  const searchWalls = samples.filter((s) => s.kind === "search" && typeof s.wallMs === "number").map((s) => s.wallMs!);
  const searchRss = samples.filter((s) => s.kind === "search" && typeof s.rssMB === "number").map((s) => s.rssMB!);
  const metrics = { samples: samples.length, hookP95Ms: p95(hookWalls), hookRssMB: p95(hookRss), searchP95Ms: p95(searchWalls), searchRssMB: p95(searchRss) };

  const homeConfig = readCaptureConfigFile(join(base, "capture-config.json"));
  const current: CaptureConfig = {
    capMb: homeConfig.capMb ?? CAPTURE_DEFAULT_CAP_MB,
    retentionDays: homeConfig.retentionDays ?? CAPTURE_DEFAULT_RETENTION_DAYS,
  };
  const diskShare = opts.diskShare ?? 0.02;
  // ponytail: the 2026-10-17 owner decision keeps R6 caps per shard in P1, while the disk-share budget is
  // machine-wide; #15 T5 (D7) owns the machine-total split. Until then a home with N shards can hold N x cap.
  const budgetBytes = diskShare * disk.freeBytes;
  // Growth (owner decision 2026-10-17, item 2): propose the largest cap and retention that fit the disk share, above the current values when there is room.
  // The cap's ceiling is the disk-share bound itself. A person's own setting above the retention ceiling is never proposed down for the ceiling alone.
  const retentionCeiling = Math.max(RETENTION_CEILING_DAYS, current.retentionDays);
  let capMb = Math.max(1, Math.floor(budgetBytes / MB));
  let retentionDays = retentionCeiling;
  const binding: string[] = [];
  const fitDays = bytesPerDay > 0 ? Math.floor(budgetBytes / bytesPerDay) : Infinity;
  if (fitDays < retentionCeiling) {
    retentionDays = Math.max(1, fitDays);
    binding.push("disk-share retention: steady-state capture at the current growth fills the disk-share bound");
  } else {
    binding.push(`retention ceiling: ${retentionCeiling} days fit the disk share, so the ceiling stops growth`);
  }
  binding.push("disk-share cap: the cap is the largest size the disk-share bound allows");
  if (metrics.searchRssMB !== null && metrics.searchRssMB > 200) {
    retentionDays = Math.max(1, Math.floor(retentionDays / 2));
    binding.push("R3 search RSS: measured peak search memory exceeds 200 MB");
  }
  if ((metrics.hookRssMB !== null && metrics.hookRssMB > 100) || (metrics.hookP95Ms !== null && metrics.hookP95Ms > 150)) {
    capMb = Math.max(1, Math.floor(capMb / 2));
    binding.push("R2 hook cost: measured hook latency or RSS exceeds the budget");
  }
  const reason = binding.join("; ");
  return {
    at: new Date(now()).toISOString(),
    capture: { shards: shards.length, bytes, rows, rowsPerDay, bytesPerDay },
    disk,
    memory: { totalBytes: totalmem(), pressure },
    metrics,
    projected: { days: PROJECT_DAYS, bytes: Math.round(bytes + bytesPerDay * PROJECT_DAYS) },
    current,
    diskShare,
    proposal: { capMb, retentionDays, reason },
  };
}

/** The non-JSON rendering of `amem capacity`. */
export function capacityText(report: CapacityReport): string {
  const mb = (n: number): string => `${(n / MB).toFixed(1)} MB`;
  return [
    `capture: ${report.capture.rows} rows, ${mb(report.capture.bytes)} in ${report.capture.shards} shard(s), +${report.capture.rowsPerDay.toFixed(1)} rows/day, +${mb(report.capture.bytesPerDay)}/day`,
    `disk: ${mb(report.disk.freeBytes)} free of ${mb(report.disk.totalBytes)}; memory: ${mb(report.memory.totalBytes)} total${report.memory.pressure ? `, pressure ${report.memory.pressure}` : ""}`,
    `metrics: ${report.metrics.samples} samples (hook p95 ${report.metrics.hookP95Ms?.toFixed(1) ?? "?"} ms, search peak ${report.metrics.searchRssMB?.toFixed(1) ?? "?"} MB)`,
    `projected capture in ${report.projected.days} days: ${mb(report.projected.bytes)}`,
    `current: cap ${report.current.capMb} MB, retention ${report.current.retentionDays} days`,
    `proposal: cap ${report.proposal.capMb} MB, retention ${report.proposal.retentionDays} days (${report.proposal.reason})`,
  ].join("\n");
}
