import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capacityReport, type ShardSplit } from "./capacity.ts";
import { readCaptureConfigFile, writeCaptureConfigFile, type CaptureConfig } from "./capture.ts";
import { walkShards } from "./catalog.ts";
import { lifecycleStates } from "./lifecycle.ts";
import { machineId } from "./store.ts";

/**
 * #15 T5 / D7: `amem capacity apply --split`. Writes each shard's own capture config (`machine/<id>/config.json`, which overrides the home default) with its
 * share of the global budget. Person-only like the other apply (the CLI refuses an agent marker and a missing terminal before this runs), and in two steps:
 * a preview that records exactly which shards and which current configs it was made for, and a `--confirm` that refuses unless the set of shards and every
 * shard's current config are unchanged (the written values are recomputed from the live readings, and the preview's own values are what the person saw: they are
 * allowed to drift a little with free disk, a shard or a config changing is not). A forgotten shard is never written. This changes capture bounds only: gc and the capture path apply them later, in bounded
 * batches (R2); nothing is evicted here, and no curated note, goal or work list is read or written.
 */

export interface SplitTarget { key: string; dir: string; current: Partial<CaptureConfig>; target: CaptureConfig; reason: string }
export interface SplitPreview { split: SplitTarget[] }

const previewPath = (base: string): string => join(base, "capacity-split.preview.json");

function targets(base: string, split: ShardSplit[]): SplitTarget[] {
  const dirs = new Map(walkShards(base).map(shard => [shard.key, shard.machineDirs]));
  const states = lifecycleStates(base);
  const machine = machineId(base).id;
  return split.filter(row => states.get(row.key) !== "forgotten").map(row => {
    const known = dirs.get(row.key) ?? [];
    const dir = known.find(candidate => candidate.endsWith(`/${machine}`)) ?? known[0];
    if (!dir) throw new Error(`shard ${row.key} has no machine directory on this machine; nothing to write`);
    return { key: row.key, dir, current: readCaptureConfigFile(join(dir, "config.json")), target: { capMb: row.capMb, retentionDays: row.retentionDays }, reason: row.reason };
  });
}

export function previewSplit(base: string, opts: { diskShare?: number } = {}): SplitPreview & { confirm: string } {
  const report = capacityReport({ memoryDir: base, ...(opts.diskShare !== undefined ? { diskShare: opts.diskShare } : {}) });
  const preview: SplitPreview = { split: targets(base, report.split) };
  writeFileSync(previewPath(base), JSON.stringify(preview) + "\n", { mode: 0o600 });
  return { ...preview, confirm: "re-run with --confirm to write each shard's share" };
}

export function applySplit(base: string, opts: { diskShare?: number } = {}): { split: SplitTarget[]; written: { key: string; cap_mb: number; retention_days: number }[] } {
  const file = previewPath(base);
  let approved: SplitPreview;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    approved = JSON.parse(readFileSync(file, "utf8")) as SplitPreview;
  } catch { throw new Error("capacity apply --split needs a preview first; re-run without --confirm"); }
  const report = capacityReport({ memoryDir: base, ...(opts.diskShare !== undefined ? { diskShare: opts.diskShare } : {}) });
  const now: SplitPreview = { split: targets(base, report.split) };
  // What was previewed is what is written: the same shards, each with the config the person saw replaced.
  const identity = (rows: SplitTarget[]) => JSON.stringify(rows.map(({ key, dir, current }) => ({ key, dir, current })));
  if (!Array.isArray(approved.split) || identity(approved.split) !== identity(now.split)) throw new Error("capacity preview changed (a shard appeared or went, or a shard's config moved); re-run without --confirm");
  const written = now.split.map(row => {
    const next = writeCaptureConfigFile(join(row.dir, "config.json"), row.target);
    return { key: row.key, cap_mb: next.capMb ?? row.target.capMb, retention_days: next.retentionDays ?? row.target.retentionDays };
  });
  rmSync(file, { force: true });
  return { split: now.split, written };
}

