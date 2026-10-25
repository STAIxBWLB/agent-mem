/**
 * Issue #13 AC2: measures the R1-R3 resource budgets of the capture tier and the FTS5 search path and prints a
 * machine-readable verdict per budget. Runs in CI on macOS and Linux; the Linux leg doubles as the FTS5
 * availability evidence for that platform (R5).
 *
 * - R2 (hook cost): a hook-like child process appends one capture row and exits. p95 wall time must stay under
 *   150 ms and peak RSS under 100 MB, both for a plain append and for the spool-and-exit path under lock contention.
 * - R3 (search cost): idle RSS under 100 MB, peak under 200 MB across ten searches over a seeded home.
 * - R1 (no resident process): after every child exits, no budget child process remains.
 *
 * Every sample is also appended to the seeded home's rolling `metrics.jsonl` (#13 R7): the format the capacity
 * advisor reads, written here until the P3 hooks become the steady-state writers.
 */
import { budgetGroup } from "./budget-attempt.ts";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { memoryBase } from "../src/memory/home.ts";
import { appendMetrics, type MetricSample } from "../src/memory/capacity.ts";
import { fts5Available } from "../src/memory/search-fts.ts";

const R2_WALL_P95_MS = 150, RSS_HOOK_MB = 100, RSS_IDLE_MB = 100, RSS_SEARCH_MB = 200;
const HOOK_RUNS = 40, CONTENTION_RUNS = 15;

/** Bun 1.4.2's resourceUsage().maxRSS is in kilobytes on macOS and Linux alike (probed: 80 MB touched -> 92304). */
const rssMB = (maxRSS: number): number => maxRSS / 1024;
const mb = (bytes: number): number => bytes / 1048576;
const p95 = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * 0.95) - 1)]!;
const round = (n: number): number => Math.round(n * 100) / 100;

function child(script: string, home: string, extraEnv: Record<string, string> = {}): { wallMs: number; out: Record<string, unknown> } {
  const start = performance.now();
  const r = spawnSync(process.execPath, [join(import.meta.dir, script)], { env: { ...process.env, AMEM_BUDGET_HOME: home, ...extraEnv }, encoding: "utf8", timeout: 10_000 });
  const wallMs = performance.now() - start;
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}: ${r.stderr?.slice(0, 400)}`);
  return { wallMs, out: JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, unknown> };
}

async function measureCapture() {
const home = mkdtempSync(join(tmpdir(), "amem-budget-"));
const memory = new MemoryStore({ home, screen: () => "keep" });
const samples: MetricSample[] = [];
try {
  // A seeded home, so the measurements cover a store with content rather than an empty one.
  for (let i = 0; i < 200; i++) memory.note({ op: "note", project: "budget", scope: "project", tier: "long", kind: "finding", peer: "measure", source: "hub", text: `note ${i} about bounded capture tiers, eviction order and the storage engine`, about: [] });
  const capture = new CaptureStore({ home, project: "budget" });
  for (let i = 0; i < 2000; i++) capture.append({ project: "budget", agent: "measure", event: "PostToolUse", tool: "Edit", paths: ["src/memory/store.ts"], status: "ok", excerpt: `capture row ${i} ${"y".repeat(220)}` });
  const capDir = capture.dir;
  capture.close();

  // R2, uncontended: p95 wall and peak RSS per hook invocation.
  const plain = Array.from({ length: HOOK_RUNS }, () => child("budget-hook-child.ts", home));
  const plainWall = p95(plain.map((r) => r.wallMs)), plainRss = Math.max(...plain.map((r) => rssMB(Number(r.out.maxRSS))));
  for (const r of plain) samples.push({ at: new Date().toISOString(), kind: "hook", wallMs: round(r.wallMs), rssMB: round(rssMB(Number(r.out.maxRSS))) });

  // R2 under contention: the writer spools and exits; afterwards one uncontended hook drains the spool.
  const holder = new Database(join(capDir, "capture.db"));
  holder.run("PRAGMA busy_timeout = 0");
  holder.run("BEGIN EXCLUSIVE");
  const spooled = Array.from({ length: CONTENTION_RUNS }, () => child("budget-hook-child.ts", home));
  holder.run("ROLLBACK");
  holder.close();
  const spoolWall = p95(spooled.map((r) => r.wallMs)), spoolRss = Math.max(...spooled.map((r) => rssMB(Number(r.out.maxRSS))));
  for (const r of spooled) samples.push({ at: new Date().toISOString(), kind: "hook", wallMs: round(r.wallMs), rssMB: round(rssMB(Number(r.out.maxRSS))) });
  if (!spooled.every((r) => "spooled" in r.out)) throw new Error("a contended hook wrote instead of spooling");
  const drain = child("budget-hook-child.ts", home); // an uncontended hook replays the spool inside the same budget
  const capCheck = new CaptureStore({ home, project: "budget" });
  const captureRows = capCheck.stats().rows;
  capCheck.close();
  if (existsSync(join(capDir, "spool.jsonl"))) throw new Error("the spool did not drain after contention");

  // R2 after a cap shrink: the shard is seeded over its cap, then a hook child appends with the shrunken cap and
  // eviction must stay time-bounded inside the same budget.
  {
    const big = new CaptureStore({ home, project: "budget-evict" });
    for (let i = 0; i < 6000; i++) big.append({ project: "budget-evict", agent: "measure", event: "PostToolUse", excerpt: `eviction row ${i} ${"z".repeat(1100)}` });
    big.close();
  }
  const evictRuns = Array.from({ length: 10 }, () => child("budget-hook-child.ts", home, { AMEM_BUDGET_CAP_MB: "1", AMEM_BUDGET_PROJECT: "budget-evict" }));
  const evictWall = p95(evictRuns.map((r) => r.wallMs)), evictRss = Math.max(...evictRuns.map((r) => rssMB(Number(r.out.maxRSS))));
  for (const r of evictRuns) samples.push({ at: new Date().toISOString(), kind: "hook", wallMs: round(r.wallMs), rssMB: round(rssMB(Number(r.out.maxRSS))) });

  // R3: idle RSS and peak RSS during searches.
  const search = child("budget-search-child.ts", home);
  const idleRss = mb(Number(search.out.idle)), searchRss = rssMB(Number(search.out.maxRSS));
  samples.push({ at: new Date().toISOString(), kind: "search", wallMs: round(Number(search.out.p95Ms)), rssMB: round(searchRss), idleMB: round(idleRss) });
  // Benchmark samples stay in this synthetic home. Only real hook/search invocations may feed the advisor's metrics.
  appendMetrics(memoryBase(home), samples);

  // R1: no budget child remains after every invocation ended (each was spawnSync-reaped; verify the process table).
  const ps = spawnSync("ps", ["-axo", "args="], { encoding: "utf8" }).stdout;
  const leftover = ps.split("\n").filter((line) => /budget-(hook|search)-child/.test(line)).length;

  const wallTimingPass = plainWall < R2_WALL_P95_MS && spoolWall < R2_WALL_P95_MS && evictWall < R2_WALL_P95_MS;
  const peakPass = plainRss > 0 && spoolRss > 0 && evictRss > 0 && plainRss < RSS_HOOK_MB && spoolRss < RSS_HOOK_MB && evictRss < RSS_HOOK_MB;
  const budgets = {
    R1: { pass: leftover === 0, leftoverProcesses: leftover },
    R2: {
      wallTimingPass, peakPass, pass: wallTimingPass && peakPass,
      budgetMs: R2_WALL_P95_MS, budgetRssMB: RSS_HOOK_MB,
      append: { runs: HOOK_RUNS, wallP95Ms: round(plainWall), wallMaxMs: round(Math.max(...plain.map((r) => r.wallMs))), peakRssMB: round(plainRss) },
      spoolAndExit: { runs: CONTENTION_RUNS, wallP95Ms: round(spoolWall), wallMaxMs: round(Math.max(...spooled.map((r) => r.wallMs))), peakRssMB: round(spoolRss), drainedRows: captureRows, drainWallMs: round(drain.wallMs) },
      evictionAfterShrink: { runs: evictRuns.length, wallP95Ms: round(evictWall), wallMaxMs: round(Math.max(...evictRuns.map((r) => r.wallMs))), peakRssMB: round(evictRss) },
    },
    R3: { pass: idleRss < RSS_IDLE_MB && searchRss < RSS_SEARCH_MB, idleRssMB: round(idleRss), peakRssMB: round(searchRss), budgetIdleMB: RSS_IDLE_MB, budgetPeakMB: RSS_SEARCH_MB, engine: search.out.engine },
  };
  const report = { platform: process.platform, bun: Bun.version, fts5Available: fts5Available(), budgets, metricsWritten: samples.length, pass: Object.values(budgets).every((b) => b.pass) };
  if (!budgets.R1.pass) throw Error("capture R1 budget failed");
  return report;
} finally {
  memory.close();
  rmSync(home, { recursive: true, force: true });
}

}
// A fresh suite restores the original contention, drain and over-cap eviction workloads on retry.
const measured = await budgetGroup("capture-workloads", measureCapture, report => ({
  wallPass: report.budgets.R2.wallTimingPass,
  rssPass: report.budgets.R3.pass && report.budgets.R2.peakPass,
}));

console.log(JSON.stringify({ ...measured.result, groupAttempts: measured.attempts }, null, 2));
