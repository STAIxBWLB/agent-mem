import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_EVICT_MAX_BATCHES, CaptureStore, captureShardStats, readCaptureConfig } from "./capture.ts";
import { walkShards } from "./catalog.ts";
import { lifecycleResolver } from "./lifecycle.ts";

/**
 * #15 T5 / D3: `amem gc`. Applies each shard's own R6 bounds (its retention window and size cap, the shard config over the home default) across every
 * shard, in the same bounded batches the capture path uses (R2): one `evict()` call is at most CAPTURE_EVICT_MAX_BATCHES batches of 256 rows and 25 ms, so a
 * cap shrink never takes a shard in one pass. The caller repeats it (the report says `remainingOverCap`) until every shard is under its bound.
 *
 * This is the only thing gc opens: the capture store of a shard. It never opens a curated store, a goal or a work list, so none of them can be evicted
 * or rewritten (#13 AC5, #15 D7). An archived project is still bounded (cold shards shrink first); a forgotten one is skipped, never opened.
 */

/** `trimRows`: unexpired rows, oldest first, that must go for the shard to fit its cap once the expired ones are gone. `evict()` removes them in whole batches. */
export interface GcShardPlan { key: string; state: "active" | "archived"; rows: number; bytes: number; capMb: number; retentionDays: number; expiredRows: number; overCap: boolean; trimRows: number }
export interface GcShardResult { key: string; expired: number; trimmed: number; batches: number; remainingOverCap: boolean }
export interface GcSkip { key: string; reason: string }
export interface GcResult { dryRun: boolean; shards: GcShardResult[]; skipped: GcSkip[] }
export interface GcOptions { now?: () => number; dryRun?: boolean; /** Calls to `evict()` per shard in this run (default 1: one R2 batch window). */ maxBatchesPerShard?: number }

/** What gc would do: read-only counts per shard, nothing opened for writing. */
export function planGc(base: string, opts: { now?: () => number } = {}): GcShardPlan[] {
  const now = opts.now ?? Date.now, stateOf = lifecycleResolver(base), out: GcShardPlan[] = [];
  for (const shard of walkShards(base)) {
    const state = stateOf(shard.key);
    if (state === "forgotten") continue;
    let rows = 0, bytes = 0, expiredRows = 0, capMb = 0, retentionDays = 0, trimRows = 0;
    for (const dir of shard.machineDirs) {
      const config = readCaptureConfig(dir, base);
      capMb = config.capMb; retentionDays = config.retentionDays;
      const stats = captureShardStats(dir), cutoff = new Date(now() - config.retentionDays * 24 * 3600_000).toISOString();
      rows += stats.rows; bytes += stats.bytes;
      expiredRows += expiredIn(dir, cutoff);
      trimRows += trimIn(dir, cutoff, config.capMb * 1024 * 1024);
    }
    out.push({ key: shard.key, state, rows, bytes, capMb, retentionDays, expiredRows, overCap: capMb > 0 && bytes > capMb * 1024 * 1024, trimRows });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function expiredIn(dir: string, cutoff: string): number {
  if (!existsSync(join(dir, "capture.db"))) return 0;
  try {
    const db = new Database(join(dir, "capture.db"), { readonly: true });
    try { db.run("PRAGMA busy_timeout = 3000"); return (db.query("SELECT COUNT(*) AS n FROM rows WHERE at < ?").get(cutoff) as { n: number }).n; }
    finally { db.close(); }
  } catch { return 0; }
}

/** Each machine directory has its own cap (evict() runs per store): the unexpired rows, oldest first, that must go to fit it. Read-only. */
function trimIn(dir: string, cutoff: string, capBytes: number): number {
  if (capBytes <= 0 || !existsSync(join(dir, "capture.db"))) return 0;
  try {
    const db = new Database(join(dir, "capture.db"), { readonly: true });
    try {
      db.run("PRAGMA busy_timeout = 3000");
      const kept = db.query("SELECT bytes FROM rows WHERE at >= ? ORDER BY at, id").all(cutoff) as { bytes: number }[];
      let left = kept.reduce((sum, row) => sum + row.bytes, 0), n = 0;
      for (const row of kept) { if (left <= capBytes) break; left -= row.bytes; n++; }
      return n;
    } finally { db.close(); }
  } catch { return 0; }
}

export function runGc(base: string, opts: GcOptions = {}): GcResult {
  const maxBatches = opts.maxBatchesPerShard ?? 1;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) throw new Error("maxBatchesPerShard takes a number from 1 to 1000");
  const now = opts.now ?? Date.now, stateOf = lifecycleResolver(base);
  const result: GcResult = { dryRun: opts.dryRun === true, shards: [], skipped: [] };
  if (opts.dryRun === true) {
    for (const plan of planGc(base, { now })) result.shards.push({ key: plan.key, expired: plan.expiredRows, trimmed: 0, batches: 0, remainingOverCap: plan.overCap });
    for (const shard of walkShards(base)) if (stateOf(shard.key) === "forgotten") result.skipped.push({ key: shard.key, reason: "forgotten" });
    return result;
  }
  for (const shard of walkShards(base)) {
    if (stateOf(shard.key) === "forgotten") { result.skipped.push({ key: shard.key, reason: "forgotten" }); continue; }
    let expired = 0, trimmed = 0, batches = 0, over = false;
    try {
      for (const dir of shard.machineDirs) {
        const machine = dir.slice(dir.lastIndexOf("/") + 1);
        // `ignore`: gc must reach an archived shard, and it never appends.
        const store = new CaptureStore({ memoryDir: base, project: shard.key, machine, now, lifecycle: "ignore" });
        try {
          for (let call = 0; call < maxBatches; call++) {
            const done = store.evict();
            expired += done.expired; trimmed += done.trimmed; batches++;
            if (done.expired + done.trimmed === 0) break;
          }
          const stats = store.stats();
          over ||= stats.bytes > stats.capMb * 1024 * 1024;
        } finally { store.close(); }
      }
      result.shards.push({ key: shard.key, expired, trimmed, batches, remainingOverCap: over });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // A locked, corrupt or unreadable shard is reported and never stops the others; the message carries no row text.
      result.skipped.push({ key: shard.key, reason: /lock|busy/i.test(message) ? "locked" : "unreadable" });
    }
  }
  result.shards.sort((a, b) => a.key.localeCompare(b.key)); result.skipped.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

export const GC_MAX_BATCHES_PER_CALL = CAPTURE_EVICT_MAX_BATCHES;

/** The non-JSON rendering of `amem gc`. */
export function gcText(result: GcResult): string {
  const lines = result.shards.map(s => `${s.key}: ${result.dryRun ? `${s.expired} expired row(s) would go` : `${s.expired} expired, ${s.trimmed} trimmed`}${s.remainingOverCap ? "; still over its cap, run gc again" : ""}`);
  for (const s of result.skipped) lines.push(`${s.key}: skipped (${s.reason})`);
  return (lines.length ? lines : ["no project shards"]).join("\n");
}
