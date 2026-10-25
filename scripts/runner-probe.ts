import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

export interface RunnerProbe { cpuMs: number; spawnMs: number; checksum: string }
export interface RunnerBaseline { cpuMs: number; spawnMs: number; factor: number; source?: string }
export const RUNNER_CHECKSUM = "55c7e25571a69216de25162f191bb2847201a09ee7efe46b5bada034acc695d5";
// ponytail: a fixed 2x healthy-hosted baseline factor permits one re-measure, not a budget multiplier.
// Upgrade to versioned hardware-specific baselines when enough probe history exists.
// Hosted run 40201976781, Bun 1.4.2 (2026-10-25): Linux job attempt 2, macOS job attempt 1.
// Each selected healthy job has five probes before and five after unchanged main workloads,
// with no sample retries or advisory wall misses. The first, unhealthy Linux job is excluded.
// Use the maximum of ten CPU/spawn readings per platform, rounded up to 0.01 ms.
export const RUNNER_BASELINES: Record<string, RunnerBaseline> = {
  linux: { cpuMs: 10.73, spawnMs: 17.17, factor: 2, source: "https://github.com/STAIxBWLB/agent-mem/actions/runs/40201976781/job/121195407149" },
  darwin: { cpuMs: 8.87, spawnMs: 23.92, factor: 2, source: "https://github.com/STAIxBWLB/agent-mem/actions/runs/40201976781/job/121194870826" },
};

/** Fixed 16 MiB SHA-256 CPU work plus one provider-free Bun spawn; no application modules. */
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
  return { cpuMs, spawnMs, checksum };
}

export function runnerIsSlow(before: RunnerProbe, after: RunnerProbe, baseline: RunnerBaseline): boolean {
  if (![baseline.cpuMs, baseline.spawnMs, baseline.factor].every(value => Number.isFinite(value) && value > 0) || baseline.factor <= 1) throw Error("invalid runner baseline");
  for (const probe of [before, after]) if (![probe.cpuMs, probe.spawnMs].every(value => Number.isFinite(value) && value > 0) || probe.checksum !== RUNNER_CHECKSUM) throw Error("invalid runner probe");
  return [before, after].some(probe => probe.cpuMs > baseline.cpuMs * baseline.factor || probe.spawnMs > baseline.spawnMs * baseline.factor);
}

if (import.meta.main) console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, samples: Array.from({ length: 5 }, probeRunnerSpeed) }));
