/** #13 P3 actual executable R1/R2 receipt. Never invokes a model, account, personal config or plugin installer.
 * Run serially after resource admission: bun scripts/measure-hooks-budget.ts.
 * P1's measure-budget.ts remains its separate hook-like baseline; this measures bin/amem.js hook itself.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { readMetrics } from "../src/memory/capacity.ts";
import { hookBin, hookFixture, workMarker } from "../test/fakes/hooks-fixture.ts";
import { hookProcessObserver } from "../test/fakes/hooks-process-observer.ts";

const RUNS = { plain: 40, contention: 15, sessionStart: 20 }, WALL_MS = 150, RSS_MB = 100;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
const round = (value: number) => Math.round(value * 100) / 100;
interface Sample { wallMs: number; rssMB: number; cliRssMB: number; recordedRssMB: number }
const f = hookFixture(), observer = hookProcessObserver(f.root);
const ownedGroups = new Set<number>(), ownedWorkers = new Map<number, boolean>();
let invocations = 0, leftoverProcesses = 0, checkedWorkers = 0;
function members(pgid: number): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  if (result.exitCode !== 0) throw new Error("R1 process table unavailable");
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[2]) === pgid ? [Number(match[1])] : [];
  });
}
function invoke(event: "PostToolUse" | "SessionStart"): Sample {
  const before = readMetrics(f.base).filter(row => row.kind === "hook").length, beforeWorkers = observer.read().length;
  const input = { hook_event_name: event, cwd: f.cwd, session_id: "p3-budget", tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: `budget public result ${++invocations}` };
  const start = performance.now();
  // Observe fixed-worker PIDs as well as the outer CLI group: the worker may own a separate detached group.
  // The test preload and its append overhead conservatively count inside actual CLI wall/RSS measurements.
  const result = Bun.spawnSync([process.execPath, "--preload", observer.preload, hookBin, "hook", event], { cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe", detached: true, timeout: 3000, maxBuffer: 16 * 1024 });
  const wallMs = performance.now() - start;
  ownedGroups.add(result.pid);
  const workers = observer.read().slice(beforeWorkers);
  if (workers.length !== 1) throw new Error("fixed-worker observation did not match the executable event");
  for (const worker of workers) ownedWorkers.set(worker.pid, worker.detached);
  const alive = members(result.pid); leftoverProcesses += alive.length;
  if (alive.length) throw new Error(`R1 owned hook group retained ${alive.length} processes`);
  ownedGroups.delete(result.pid);
  for (const worker of workers) {
    let running = false;
    try { process.kill(worker.pid, 0); running = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const retained = worker.detached ? members(worker.pid).length : Number(running);
    leftoverProcesses += retained; checkedWorkers++;
    if (running || retained) throw new Error("R1 observed worker PID or owned group survived the invocation");
    ownedWorkers.delete(worker.pid);
  }
  if (result.exitCode !== 0 || result.signalCode) throw new Error(`hook executable failed: ${event}, exit=${result.exitCode}`);
  const metrics = readMetrics(f.base).filter(row => row.kind === "hook"), metric = metrics.at(-1);
  if (metrics.length !== before + 1 || !metric || !Number.isFinite(metric.rssMB) || !Number.isFinite(metric.wallMs) || metric.rssMB! <= 0 || metric.wallMs! < 0) throw new Error("actual hook failed to append a valid production metrics sample");
  // Bun child rusage maxRSS is bytes; process.resourceUsage().maxRSS uses a different unit.
  const cliRssMB = result.resourceUsage.maxRSS / 1048576, recordedRssMB = metric.rssMB!;
  if (!Number.isFinite(cliRssMB) || cliRssMB <= 0) throw new Error("hook process RSS unavailable");
  if (event === "SessionStart") {
    if (result.stdout.length > 8192) throw new Error("SessionStart output exceeded 8 KiB");
    if (!result.stdout.length) throw new Error(`SessionStart empty output: wall=${wallMs}, metric=${metric.wallMs}, stderrBytes=${result.stderr.length}`);
    const output = JSON.parse(result.stdout.toString()), context = output.hookSpecificOutput?.additionalContext;
    if (output.hookSpecificOutput?.hookEventName !== "SessionStart" || typeof context !== "string" || !context.includes(workMarker) || !/coverage|complete|partial/i.test(context) || Buffer.byteLength(context) > 1200) throw new Error(`SessionStart fixture lacked bounded known work and coverage: wall=${wallMs}, metric=${metric.wallMs}, context=${JSON.stringify(context)}`);
    if (/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/.test(result.stdout.toString())) throw new Error("context hook emitted a control directive");
  }
  // Production hook metrics include parent peak + brief child peak. CLI rusage independently covers the executable.
  return { wallMs, cliRssMB, recordedRssMB, rssMB: Math.max(cliRssMB, recordedRssMB) };
}
function summarize(samples: Sample[]) {
  const wallP95Ms = p95(samples.map(sample => sample.wallMs)), peakRssMB = Math.max(...samples.map(sample => sample.rssMB));
  return { runs: samples.length, wallP95Ms: round(wallP95Ms), wallMaxMs: round(Math.max(...samples.map(sample => sample.wallMs))), peakRssMB: round(peakRssMB), cliPeakRssMB: round(Math.max(...samples.map(sample => sample.cliRssMB))), productionCombinedPeakRssMB: round(Math.max(...samples.map(sample => sample.recordedRssMB))), pass: wallP95Ms < WALL_MS && peakRssMB < RSS_MB };
}
try {
  await f.seed();
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
  const dir = capture.dir, baseline = capture.stats().rows; capture.close();
  const plain = Array.from({ length: RUNS.plain }, () => invoke("PostToolUse"));
  const holder = new Database(join(dir, "capture.db"));
  let contended: Sample[];
  try {
    holder.run("PRAGMA busy_timeout=0"); holder.run("BEGIN IMMEDIATE");
    contended = Array.from({ length: RUNS.contention }, () => invoke("PostToolUse"));
    const spool = join(dir, "spool");
    // A drainer claims a segment before its SQLite transaction; contention retains the renamed immutable receipt.
    const segmentName = /^spool-[0-9a-f-]+\.jsonl(?:\.offset-\d+(?:-skip)?)?(?:\.draining-[0-9a-f]+)?$/;
    const entries = existsSync(spool) ? readdirSync(spool, { withFileTypes: true }) : [];
    const receipts = entries.filter(entry => entry.isFile() && segmentName.test(entry.name));
    if (receipts.length < RUNS.contention) throw new Error(`contention did not produce per-writer spool receipts (valid=${receipts.length}, claimed=${receipts.filter(entry => entry.name.includes(".draining-")).length}, ignored=${entries.length - receipts.length})`);
  } finally { try { holder.run("ROLLBACK"); } finally { holder.close(); } }
  const drain = invoke("PostToolUse");
  const check = new CaptureStore({ memoryDir: f.base, project: f.project });
  try { if (check.stats().rows !== baseline + RUNS.plain + RUNS.contention + 1) throw new Error("contended rows did not drain losslessly"); } finally { check.close(); }
  const sessionStart = Array.from({ length: RUNS.sessionStart }, () => invoke("SessionStart"));
  const groups = { plain: summarize(plain), spoolAndExit: summarize(contended), sessionStart: summarize(sessionStart), drain: summarize([drain]) };
  const report = { platform: process.platform, bun: Bun.version, executable: "bin/amem.js hook", budgets: { R1: { pass: leftoverProcesses === 0, leftoverProcesses, checkedInvocations: invocations, checkedWorkers, scope: "outer executable groups plus every observed fixed-worker PID and detached group" }, R2: { pass: Object.values(groups).every(group => group.pass), wallP95BudgetMs: WALL_MS, peakRssBudgetMB: RSS_MB, groups } }, pass: leftoverProcesses === 0 && Object.values(groups).every(group => group.pass) };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  // Only groups created by this script, and only while a fresh process-table read still shows members.
  for (const group of ownedGroups) if (members(group).length) try { process.kill(-group, "SIGKILL"); } catch { /* an already-ended group is clean */ }
  for (const [pid, detached] of ownedWorkers) {
    if (detached && members(pid).length) try { process.kill(-pid, "SIGKILL"); } catch { /* Already ended owned group. */ }
    else try { process.kill(pid, "SIGKILL"); } catch { /* Already ended owned child. */ }
  }
  f.close();
}
