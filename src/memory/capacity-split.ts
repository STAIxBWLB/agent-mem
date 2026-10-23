import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { capacityReport, type ShardSplit } from "./capacity.ts";
import { readCaptureConfigFile, writeCaptureConfigFile, type CaptureConfig } from "./capture.ts";
import { walkShards } from "./catalog.ts";
import { lifecycleResolver } from "./lifecycle.ts";
import { machineId } from "./store.ts";

/**
 * #15 T5 / D7: `amem capacity apply --split`. Writes each shard's own capture config (`machine/<id>/config.json`, which overrides the home default) with its
 * share of the global budget. Person-only like the other apply (the CLI refuses an agent marker and a missing terminal before this runs), and in two steps:
 * a preview that records which shards, which current configs and which target values the person is shown, and a `--confirm` that writes exactly those
 * target values and nothing recomputed. It refuses unless the set of shards and every shard's current config are unchanged, and unless the preview is younger
 * than `PREVIEW_MAX_AGE_MS`: a week-old preview cannot write a cap the person never saw, and free disk drifting a little between the two steps changes nothing
 * that is written. A forgotten shard is never written. This changes capture bounds only: gc and the capture path apply them later, in bounded
 * batches (R2); nothing is evicted here, and no curated note, goal or work list is read or written.
 */

export interface SplitTarget { key: string; dir: string; current: Partial<CaptureConfig>; target: CaptureConfig; reason: string }
export interface SplitPreview { at: number; split: SplitTarget[]; skipped: string[] }
/** A preview older than this is refused: the person saw those values, but the readings behind them are stale. */
export const PREVIEW_MAX_AGE_MS = 3600_000;

const previewPath = (base: string): string => join(base, "capacity-split.preview.json");

/**
 * One target per non-forgotten shard that has a directory of this machine. A shard that only another machine has (a synced home) is never written here: that
 * machine's config is its own, so the shard is left out and named in `skipped`. The directory is matched by its name, which is portable, not by a path suffix.
 */
function targets(base: string, split: ShardSplit[]): { targets: SplitTarget[]; skipped: string[] } {
  const dirs = new Map(walkShards(base).map(shard => [shard.key, shard.machineDirs]));
  const stateOf = lifecycleResolver(base);
  const machine = machineId(base).id;
  const out: SplitTarget[] = [], skipped: string[] = [];
  for (const row of split) {
    if (stateOf(row.key) === "forgotten") continue;
    const dir = (dirs.get(row.key) ?? []).find(candidate => basename(candidate) === machine);
    if (!dir) { skipped.push(row.key); continue; }
    out.push({ key: row.key, dir, current: readCaptureConfigFile(join(dir, "config.json")), target: { capMb: row.capMb, retentionDays: row.retentionDays }, reason: row.reason });
  }
  return { targets: out, skipped };
}

export function previewSplit(base: string, opts: { diskShare?: number; now?: () => number } = {}): SplitPreview & { confirm: string } {
  const report = capacityReport({ memoryDir: base, ...(opts.diskShare !== undefined ? { diskShare: opts.diskShare } : {}) });
  const found = targets(base, report.split);
  const preview: SplitPreview = { at: (opts.now ?? Date.now)(), split: found.targets, skipped: found.skipped };
  writeFileSync(previewPath(base), JSON.stringify(preview) + "\n", { mode: 0o600 });
  return { ...preview, confirm: "re-run with --confirm to write each shard's share" };
}

export function applySplit(base: string, opts: { diskShare?: number; now?: () => number } = {}): { split: SplitTarget[]; written: { key: string; cap_mb: number; retention_days: number }[] } {
  const file = previewPath(base);
  let approved: SplitPreview;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    approved = JSON.parse(readFileSync(file, "utf8")) as SplitPreview;
  } catch { throw new Error("capacity apply --split needs a preview first; re-run without --confirm"); }
  const report = capacityReport({ memoryDir: base, ...(opts.diskShare !== undefined ? { diskShare: opts.diskShare } : {}) });
  const live = targets(base, report.split).targets;
  const age = (opts.now ?? Date.now)() - approved.at;
  if (!Number.isFinite(age) || age < 0 || age > PREVIEW_MAX_AGE_MS) throw new Error("capacity preview is out of date (older than an hour); re-run without --confirm");
  // What was previewed is what is written: the same shards, each with the config the person saw replaced by the target the person saw.
  const identity = (rows: SplitTarget[]) => JSON.stringify(rows.map(({ key, dir, current }) => ({ key, dir, current })));
  if (!Array.isArray(approved.split) || identity(approved.split) !== identity(live)) throw new Error("capacity preview changed (a shard appeared or went, or a shard's config moved); re-run without --confirm");
  const written = approved.split.map(row => {
    const next = writeCaptureConfigFile(join(row.dir, "config.json"), row.target);
    return { key: row.key, cap_mb: next.capMb ?? row.target.capMb, retention_days: next.retentionDays ?? row.target.retentionDays };
  });
  rmSync(file, { force: true });
  return { split: approved.split, written };
}

