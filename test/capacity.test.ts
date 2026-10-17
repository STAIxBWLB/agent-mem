import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { appendMetrics, capacityReport, readMetrics, metricsPath, type MetricSample } from "../src/memory/capacity.ts";
import { readCaptureConfigFile } from "../src/memory/capture.ts";
import { runCli, PERSON_ONLY } from "../src/cli.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-capacity-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const MB = 1048576, DAY = 24 * 3600_000, NOW = Date.parse("2026-10-17T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function seed(dir: string, project: string, rows: number, at: string, excerptBytes = 1000): void {
  const store = new CaptureStore({ home: dir, project, now: () => NOW });
  cleanup.push(() => store.close());
  for (let i = 0; i < rows; i++) store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: "y".repeat(excerptBytes), at });
}

const readings = (over: Partial<{ freeBytes: number; metrics: MetricSample[] }> = {}) => ({
  inject: { disk: { freeBytes: over.freeBytes ?? 500 * 1024 * MB, totalBytes: 1024 * 1024 * MB }, memoryPressure: null, metrics: over.metrics ?? [] },
  now: () => NOW,
});

test("the advisor reports load and keeps current bounds when nothing binds", () => {
  const dir = home();
  seed(dir, "proj", 70, iso(NOW - DAY)); // 10 rows/day, about 11 KB/day
  const report = capacityReport({ home: dir, ...readings() });
  expect(report.capture.shards).toBe(1);
  expect(report.capture.rows).toBe(70);
  expect(report.capture.rowsPerDay).toBeCloseTo(10, 1);
  expect(report.capture.bytesPerDay).toBeGreaterThan(0);
  expect(report.projected.bytes).toBeGreaterThan(report.capture.bytes);
  expect(report.disk.totalBytes).toBe(1024 * 1024 * MB);
  expect(report.memory.totalBytes).toBeGreaterThan(0);
  expect(report.proposal).toMatchObject({ capMb: 512, retentionDays: 90 });
  expect(report.proposal.reason).toContain("none");
});

test("a tight disk share binds retention, and a smaller cap binds the cap", () => {
  const dir = home();
  seed(dir, "proj", 70, iso(NOW - DAY), 1000); // about 11 KB/day of growth
  const probe = capacityReport({ home: dir, ...readings() });
  expect(probe.capture.bytesPerDay).toBeGreaterThan(0);
  // A disk share that fits only a few days of growth binds retention, not the cap.
  const freeBytes = Math.ceil((probe.capture.bytesPerDay * 4.5) / 0.02); // the share holds about four days
  const bound = capacityReport({ home: dir, ...readings({ freeBytes }) });
  const budget = 0.02 * freeBytes;
  expect(bound.proposal.retentionDays).toBe(Math.max(1, Math.floor(budget / bound.capture.bytesPerDay)));
  expect(bound.proposal.retentionDays).toBeLessThan(90);
  expect(bound.proposal.retentionDays * bound.capture.bytesPerDay).toBeLessThanOrEqual(budget);
  expect(bound.proposal.reason).toContain("disk-share retention");
  // 2% of 5 GB free is about 102 MB: under the 512 MB default cap.
  const capped = capacityReport({ home: dir, ...readings({ freeBytes: 5 * 1024 * MB }) });
  expect(capped.proposal.capMb).toBe(102);
  expect(capped.proposal.reason).toContain("disk-share cap");
});

test("measured R2/R3 breaches shrink the proposal and name the constraint", () => {
  const dir = home();
  seed(dir, "proj", 7, iso(NOW - DAY));
  const r3 = capacityReport({ home: dir, ...readings({ metrics: [{ at: iso(NOW), kind: "search", rssMB: 250 }] }) });
  expect(r3.proposal.retentionDays).toBe(45);
  expect(r3.proposal.reason).toContain("R3 search RSS");
  const r2 = capacityReport({ home: dir, ...readings({ metrics: [{ at: iso(NOW), kind: "hook", wallMs: 60, rssMB: 140 }] }) });
  expect(r2.proposal.capMb).toBe(256);
  expect(r2.proposal.reason).toContain("R2 hook cost");
  const p95 = capacityReport({ home: dir, ...readings({ metrics: [{ at: iso(NOW), kind: "hook", wallMs: 200, rssMB: 30 }] }) });
  expect(p95.proposal.reason).toContain("R2 hook cost");
});

test("the rolling metrics file keeps the newest samples within its bound", () => {
  const dir = home(), base = join(dir, "memory");
  const samples: MetricSample[] = Array.from({ length: 500 }, (_, i) => ({ at: iso(NOW + i), kind: "hook", wallMs: i, rssMB: 30 }));
  appendMetrics(base, samples);
  const read = readMetrics(base);
  expect(read.length).toBeLessThanOrEqual(200);
  expect(read[read.length - 1]).toMatchObject({ kind: "hook", wallMs: 499 });
  expect(readMetrics(base)[0]!.at >= samples[300]!.at).toBe(true);
  // Without injected metrics the advisor reads the file itself.
  const report = capacityReport({ home: dir, now: () => NOW, inject: { disk: { freeBytes: 500 * 1024 * MB, totalBytes: 1024 * 1024 * MB }, memoryPressure: null } });
  expect(report.metrics.samples).toBe(read.length);
});

test("amem capacity reports, previews, and applies only with --confirm; agents can never apply", async () => {
  const dir = home();
  process.env.AMEM_HOME = join(dir, "memory");
  cleanup.push(() => { delete process.env.AMEM_HOME; });
  const file = join(dir, "memory", "capture-config.json");
  const context = { cwd: dir, env: {}, stdinTTY: true };
  const text = await runCli(["capacity"], context);
  expect(text).toContain("capture:"); expect(text).toContain("proposal:");
  const report = JSON.parse(await runCli(["capacity", "--json"], context)) as { proposal: { capMb: number } };
  expect(report.proposal.capMb).toBe(512);
  // apply previews first and writes nothing without --confirm.
  await expect(runCli(["capacity", "apply"], { ...context, stdinTTY: false })).rejects.toThrow("terminal on stdin");
  await expect(runCli(["capacity", "apply", "--cap-mb", "64"], { ...context, env: { CODEX_THREAD_ID: "x" } })).rejects.toThrow(PERSON_ONLY);
  await expect(runCli(["capacity", "apply", "--cap-mb", "64", "--confirm"], context)).rejects.toThrow("preview first");
  expect(readCaptureConfigFile(file)).toEqual({}); // a first-call --confirm cannot skip the preview
  const preview = JSON.parse(await runCli(["capacity", "apply", "--cap-mb", "64"], context)) as { preview: { target: { capMb: number } } };
  expect(preview.preview.target).toMatchObject({ capMb: 64, retentionDays: 90 });
  expect(readCaptureConfigFile(file)).toEqual({});
  const written = JSON.parse(await runCli(["capacity", "apply", "--cap-mb", "64", "--confirm"], context)) as { written: { cap_mb: number; retention_days: number } };
  expect(written.written).toEqual({ cap_mb: 64, retention_days: 90 }); // the unset value falls to the proposal
  expect(readCaptureConfigFile(file)).toEqual({ capMb: 64, retentionDays: 90 });
});

test("measure-budget keeps synthetic samples out of the real memory home", async () => {
  const source = await Bun.file(join(import.meta.dir, "../scripts/measure-budget.ts")).text();
  expect(source).toContain("appendMetrics(memoryBase(home), samples)");
  expect(source).not.toContain("appendMetrics(memoryBase(), samples)");
});
