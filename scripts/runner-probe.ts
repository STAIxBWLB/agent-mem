import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface RunnerProbe { cpuMs: number; spawnMs: number; ioMs: number; ioSamplesMs: readonly [number, number, number]; checksum: string }
export interface RunnerBaseline { cpuMs: number; spawnMs: number; ioMs: number; factor: number; source?: string }
export const RUNNER_CHECKSUM = "55c7e25571a69216de25162f191bb2847201a09ee7efe46b5bada034acc695d5";
// ponytail: a fixed 2x healthy-hosted baseline factor permits one re-measure, not a budget multiplier.
// Upgrade to versioned hardware-specific baselines when enough probe history exists.
// Same-shape hosted calibration: CPU/spawn maxima, I/O median of ten per-call medians,
// rounded up to 0.01 ms. Mac job attempt 1 passed all workloads without sample retries.
// Linux stays unavailable until an eligible healthy job exists; failed jobs are not calibration evidence.
export const RUNNER_BASELINES: Record<string, RunnerBaseline> = {
  darwin: { cpuMs: 7.19, spawnMs: 12.36, ioMs: 2.65, factor: 2, source: "https://github.com/STAIxBWLB/agent-mem/actions/runs/40209400516/job/121217210762" },
};

/** Fixed CPU, provider-free Bun spawn and fresh durable SQLite work; no application modules. */
export function probeRunnerSpeed(): RunnerProbe {
  const block = Buffer.alloc(64 * 1024, 90), hash = createHash("sha256"), cpuStart = performance.now();
  for (let index = 0; index < 256; index++) hash.update(block);
  const checksum = hash.digest("hex"), cpuMs = performance.now() - cpuStart;
  const start = performance.now();
  const child = spawnSync(process.execPath, ["--smol", "-e", 'process.stdout.write("runner-probe-ok")'], {
    cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, encoding: "utf8", timeout: 5000, maxBuffer: 1024,
  });
  const spawnMs = performance.now() - start;
  if (child.error || child.status !== 0 || child.signal || child.stdout !== "runner-probe-ok" || child.stderr || checksum !== RUNNER_CHECKSUM) throw Error("runner-speed probe failed");
  const ioSamplesMs: [number, number, number] = [durableWriteMs(), durableWriteMs(), durableWriteMs()];
  return { cpuMs, spawnMs, ioMs: median(ioSamplesMs), ioSamplesMs, checksum };
}

/** Every sub-sample is fresh; a failed write fails the probe rather than disappearing from the median. */
function durableWriteMs(): number {
  const dir = mkdtempSync(join(tmpdir(), "amem-runner-io-")), file = join(dir, "probe.db");
  let db: Database | undefined;
  try {
    const ioStart = performance.now();
    db = new Database(file, { create: true });
    const mode = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
    db.run("PRAGMA synchronous = FULL");
    const sync = db.query("PRAGMA synchronous").get() as { synchronous: number };
    if (mode.journal_mode !== "wal" || sync.synchronous !== 2) throw Error("durable-write probe mode unavailable");
    db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    const insert = db.query("INSERT INTO probe VALUES (?, ?)");
    db.transaction(() => { for (let index = 0; index < 16; index++) insert.run(index, "bounded durable runner probe ".repeat(4)); }).immediate();
    const wal = openSync(`${file}-wal`, "r+");
    try { fsyncSync(wal); } finally { closeSync(wal); }
    if ((db.query("SELECT count(*) AS count FROM probe").get() as { count: number }).count !== 16) throw Error("durable-write probe lost rows");
    db.close(); db = undefined;
    return performance.now() - ioStart;
  } finally { try { db?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } }
}

export function median(values: readonly number[]): number {
  const sorted = [...values];
  if (!sorted.length || !sorted.every(value => Number.isFinite(value) && value > 0)) throw Error("invalid median samples");
  sorted.sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function runnerIsSlow(before: RunnerProbe, after: RunnerProbe, baseline: RunnerBaseline): boolean {
  if (![baseline.cpuMs, baseline.spawnMs, baseline.ioMs, baseline.factor].every(value => Number.isFinite(value) && value > 0) || baseline.factor <= 1) throw Error("invalid runner baseline");
  for (const probe of [before, after]) if (![probe.cpuMs, probe.spawnMs, probe.ioMs].every(value => Number.isFinite(value) && value > 0) || probe.checksum !== RUNNER_CHECKSUM || probe.ioSamplesMs?.length !== 3 || median(probe.ioSamplesMs) !== probe.ioMs) throw Error("invalid runner probe");
  return [before, after].some(probe => probe.cpuMs > baseline.cpuMs * baseline.factor || probe.spawnMs > baseline.spawnMs * baseline.factor || probe.ioMs > baseline.ioMs * baseline.factor);
}

if (import.meta.main) console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, samples: Array.from({ length: 5 }, probeRunnerSpeed) }));
