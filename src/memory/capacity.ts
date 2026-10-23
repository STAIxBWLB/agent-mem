import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { memoryBase } from "./home.ts";
import { readMetrics, type MetricSample } from "./metrics.ts";
export { appendMetrics, readMetrics, metricsPath, type MetricSample } from "./metrics.ts";
import { walkShards } from "./catalog.ts";
import { lifecycleResolver } from "./lifecycle.ts";
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
  /** #15 D7: the per-shard split of the global capture budget (the disk share, less what forgotten shards still hold), one row per non-forgotten shard. A proposal: applying it is person-only. */
  split: ShardSplit[];
  /** Why `split` is empty although shards exist: the budget cannot give each shard its 1 MB minimum. Absent when the split was made. */
  splitRefused?: string;
}

export interface ShardSplit { key: string; capMb: number; retentionDays: number; reason: string }
export interface SplitInput {
  /** The global capture budget in bytes: the disk-share bound the single-shard advisor already uses. */
  budgetBytes: number;
  shards: { key: string; useBytes: number; growthBytesPerDay: number; lastAt: string | null }[];
  now: number;
}

const ACTIVITY_HALF_LIFE_DAYS = 14, ACTIVITY_FLOOR = 0.02, SPLIT_HORIZON_DAYS = 30;
// ponytail: a quiet shard keeps its last month of rows, counted from its last capture, so a proposal never empties a shard that merely went quiet (gc evicts by
// age from now). That floor is the one case allowed above the year ceiling: a shard idle for more than 335 days keeps idle days plus the floor. The upgrade path is a configured floor.
const SPLIT_RETENTION_FLOOR_DAYS = 30;

/** Share `amount` whole MB over `items` in proportion to weight x want, no item above its want (a bounded water-fill); the shares sum to at most `amount`. */
function waterFill(items: { key: string; weight: number; want: number }[], amount: number): Map<string, number> {
  const out = new Map<string, number>(items.map(item => [item.key, 0]));
  let free = items.filter(item => item.want > 0), remaining = amount;
  for (let guard = 0; guard <= items.length && free.length; guard++) {
    const total = free.reduce((sum, item) => sum + item.weight * item.want, 0);
    const share = (item: (typeof items)[number]) => remaining * item.weight * item.want / total;
    const high = free.filter(item => share(item) > item.want);
    if (high.length) { for (const item of high) { out.set(item.key, item.want); remaining -= item.want; } free = free.filter(item => !high.includes(item)); continue; }
    for (const item of free) out.set(item.key, Math.floor(share(item)));
    break;
  }
  return out;
}

/**
 * #15 D7: split one global capture budget across shards. Only capture is in it: the inputs are capture bytes, capture growth and the last capture time,
 * so curated notes, goals and work lists have no quantity here to evict.
 *
 * Each shard has an activity weight, 0.5 per 14 days since its last capture (a shard with none counts as a year cold), plus a small floor. What a shard needs
 * is what it holds now plus 30 days of its growth scaled by that weight. Three cases, by what fits:
 * 1. every need fits: each shard gets its need and the surplus goes by weight.
 * 2. every shard's use fits but not every need: each shard gets its use first (rounded up to whole MB, at least 1), and only the headroom is shared, by weight times
 *    the growth it asked for, so a cold shard keeps what it holds and a hot one gets the room.
 * 3. the use itself does not fit: the budget is shared by weight times need, between 1 MB and the need, so cold shards shrink first, and a shard pushed
 *    below what it holds says so.
 * The caps are whole MB, each at least 1 (a cap of 0 is not a bound), and their sum never exceeds the budget. When the budget holds fewer whole MB than there are shards, no split can
 * satisfy both, so the function refuses with `SplitBudgetError` instead of returning an over-budget proposal.
 * A shard's retention is the activity window, but never shorter than its idle time plus a month: gc counts age from now, so a shorter window would delete rows the shard still holds.
 */
/** The budget cannot give every shard its 1 MB minimum: there is no valid split to propose. */
export class SplitBudgetError extends Error {}

export function capacitySplit(input: SplitInput): ShardSplit[] {
  if (!Number.isFinite(input.budgetBytes) || input.budgetBytes < 0) throw new Error("the capture budget must be a finite number of bytes, zero or more");
  if (!Number.isFinite(input.now)) throw new Error("the split needs a clock");
  for (const shard of input.shards) {
    if (!Number.isFinite(shard.useBytes) || shard.useBytes < 0) throw new Error(`shard use must be a finite number of bytes, zero or more (${shard.key})`);
    if (!Number.isFinite(shard.growthBytesPerDay) || shard.growthBytesPerDay < 0) throw new Error(`shard growth must be a finite number of bytes per day, zero or more (${shard.key})`);
  }
  const shards = [...input.shards].sort((a, b) => a.key.localeCompare(b.key));
  if (!shards.length) return [];
  const budgetMb = Math.floor(input.budgetBytes / MB);
  if (budgetMb < shards.length) throw new SplitBudgetError(`the capture budget holds ${budgetMb} MB, fewer than the ${shards.length} shards that each need a 1 MB minimum; free disk or raise --disk-share before splitting`);
  const rows = shards.map((shard) => {
    const lastMs = shard.lastAt === null ? Number.NaN : Date.parse(shard.lastAt);
    const known = Number.isFinite(lastMs), days = known ? Math.max(0, (input.now - lastMs) / (24 * 3600_000)) : 365;
    const activity = Math.pow(0.5, days / ACTIVITY_HALF_LIFE_DAYS);
    const weight = activity + ACTIVITY_FLOOR;
    const useMb = shard.useBytes / MB, growthMb = shard.growthBytesPerDay / MB;
    const base = Math.max(1, Math.ceil(useMb)), need = Math.max(base, Math.ceil(useMb + growthMb * SPLIT_HORIZON_DAYS * activity));
    const windowDays = Math.round(SPLIT_RETENTION_FLOOR_DAYS + (RETENTION_CEILING_DAYS - SPLIT_RETENTION_FLOOR_DAYS) * activity);
    // A shard with no capture time holds no row to protect; the idle floor applies to a known last capture only.
    const retentionDays = Math.max(windowDays, known ? Math.ceil(days) + SPLIT_RETENTION_FLOOR_DAYS : 0);
    return { key: shard.key, useMb, activity, weight, base, need, retentionDays, cap: 1 };
  });
  const totalNeed = rows.reduce((sum, row) => sum + row.need, 0), totalBase = rows.reduce((sum, row) => sum + row.base, 0);
  const reasons = new Map<string, string>();
  if (totalNeed <= budgetMb) {
    const surplus = budgetMb - totalNeed, totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    for (const row of rows) {
      row.cap = row.need + Math.floor(surplus * row.weight / totalWeight);
      reasons.set(row.key, `fits the budget: keeps its ${row.useMb.toFixed(1)} MB in use plus growth headroom for ${SPLIT_HORIZON_DAYS} days at its recent activity (weight ${row.activity.toFixed(2)})`);
    }
  } else if (totalBase <= budgetMb) {
    const extra = waterFill(rows.map(row => ({ key: row.key, weight: row.weight, want: row.need - row.base })), budgetMb - totalBase);
    for (const row of rows) {
      row.cap = row.base + (extra.get(row.key) ?? 0);
      reasons.set(row.key, `budget is tight: keeps the ${row.useMb.toFixed(1)} MB it holds, and its growth headroom is shared by recent activity (weight ${row.activity.toFixed(2)})`);
    }
  } else {
    // The use itself does not fit: shares by weight x need, between 1 MB and the need; fix the violators of one bound at a time and share what is left.
    let free = [...rows], remaining = budgetMb;
    const fixed = new Map<string, number>();
    for (let guard = 0; guard <= rows.length && free.length; guard++) {
      const total = free.reduce((sum, row) => sum + row.weight * row.need, 0);
      const share = (row: (typeof rows)[number]) => remaining * row.weight * row.need / total;
      const low = free.filter(row => share(row) < 1), high = free.filter(row => share(row) > row.need);
      if (low.length) { for (const row of low) { fixed.set(row.key, 1); remaining -= 1; } free = free.filter(row => !low.includes(row)); continue; }
      if (high.length) { for (const row of high) { fixed.set(row.key, row.need); remaining -= row.need; } free = free.filter(row => !high.includes(row)); continue; }
      for (const row of free) fixed.set(row.key, Math.max(1, Math.floor(share(row))));
      free = [];
    }
    for (const row of rows) {
      row.cap = fixed.get(row.key) ?? 1;
      reasons.set(row.key, row.cap < row.useMb
        ? `budget forces shrink: the global budget is smaller than what the shards hold, and this shard's recent activity (weight ${row.activity.toFixed(2)}) ranks it ${row.cap <= 1 ? "last: the 1 MB minimum" : "below the others"}`
        : `budget is tight: capped below its growth headroom by recent activity (weight ${row.activity.toFixed(2)}), still above what it holds`);
    }
  }
  return rows.map(row => ({ key: row.key, capMb: row.cap, retentionDays: row.retentionDays, reason: reasons.get(row.key)! }));
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
  const shards = walkShards(base), stateOf = lifecycleResolver(base);
  let bytes = 0, rows = 0, growthRows = 0, growthBytes = 0, forgottenBytes = 0;
  const perShard: SplitInput["shards"] = [];
  for (const shard of shards) {
    let useBytes = 0, growthShard = 0, lastAt: string | null = null;
    for (const dir of shard.machineDirs) {
      const total = captureShardStats(dir);
      rows += total.rows;
      bytes += total.bytes;
      useBytes += total.bytes;
      if (total.lastAt && (lastAt === null || total.lastAt > lastAt)) lastAt = total.lastAt;
      const growth = captureShardGrowth(dir, since);
      growthRows += growth.rows;
      growthBytes += growth.bytes;
      growthShard += growth.bytes;
    }
    if (stateOf(shard.key) === "forgotten") forgottenBytes += useBytes;
    else perShard.push({ key: shard.key, useBytes, growthBytesPerDay: growthShard / GROWTH_DAYS, lastAt });
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
  // The single proposal below is one shard's bounds (the home default). #15 T5 (D7): `split` shares the machine-wide budget across the shards, so a
  // home with N shards no longer holds N x cap once the person applies it (`amem capacity apply --split`).
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
  // The split shares the same disk-share budget; what a forgotten shard still holds on disk is not available to the others.
  let split: ShardSplit[] = [], splitRefused: string | undefined;
  try { split = capacitySplit({ budgetBytes: Math.max(0, budgetBytes - forgottenBytes), shards: perShard, now: now() }); }
  catch (error) { if (!(error instanceof SplitBudgetError)) throw error; splitRefused = error.message; }
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
    split,
    ...(splitRefused ? { splitRefused } : {}),
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
    ...(report.splitRefused ? [`split: none proposed (${report.splitRefused})`] : []),
    ...(report.split.length ? ["split of the global budget per shard (a proposal: amem capacity apply --split):", ...report.split.map(row => `  ${row.key}: cap ${row.capMb} MB, retention ${row.retentionDays} days (${row.reason})`)] : []),
  ].join("\n");
}
