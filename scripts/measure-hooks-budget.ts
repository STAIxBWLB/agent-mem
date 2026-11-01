import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
/** #13 P3 actual executable R1/R2 receipt. Never invokes a model, account, personal config or plugin installer.
 * Run serially after resource admission: bun scripts/measure-hooks-budget.ts.
 * P1's measure-budget.ts remains its separate hook-like baseline; this measures bin/amem.js hook itself.
 */
import { Database } from "bun:sqlite";
import { budgetGroup, budgetSample, BudgetStall, budgetGroupRecorder } from "./budget-attempt.ts";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CaptureStore } from "../src/memory/capture.ts";
import { readMetrics } from "../src/memory/capacity.ts";
import { hookBin, hookFixture, workMarker } from "../test/fakes/hooks-fixture.ts";
import { REPO_SCHEMA, repoEntryId } from "../src/memory/repo-scope.ts";
import { hookProcessObserver } from "../test/fakes/hooks-process-observer.ts";
import { hookTimeoutProbe } from "../test/fakes/hooks-timeout-probe.ts";
import { verifyHookProcessObservation, verifyPlainHookDeferrals } from "./hook-process-check.ts";
import { singleAttemptTiming, workloadBudget } from "./hook-timing-check.ts";

const RUNS = { plain: 40, contention: 15, sessionStart: 20 }, WALL_MS = 150, RSS_MB = 100;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
const round = (value: number) => Math.round(value * 100) / 100;
interface Sample { wallMs: number; rssMB: number; cliRssMB: number; recordedRssMB: number; rawRssMB: number }
async function measureHooks() {
const f = hookFixture(), observer = hookProcessObserver(f.root);
const stalledAttempts = new Map<string, number>();
const ownedGroups = new Set<number>(), ownedWorkers = new Map<number, boolean>();
const deferredWorkers = { plain: 0, spoolAndExit: 0, drain: 0, sessionStart: 0, sessionStartRepoLog: 0 }, MAX_PLAIN_DEFERRED = Math.floor(RUNS.plain / 4);
let invocations = 0, leftoverProcesses = 0, checkedWorkers = 0, checkedBunWorkers = 0, checkedNativeSupervisors = 0;
function members(pgid: number): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  if (result.exitCode !== 0) throw new Error("R1 process table unavailable");
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match && Number(match[2]) === pgid ? [Number(match[1])] : [];
  });
}
function pendingInvocation(event: string, excerpt: string): boolean {
  const dir = join(f.base, "hook-spool");
  for (const folder of [dir, join(dir, ".capacity")]) for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    if (!/^hook-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json(?:\.draining-[a-f0-9]{24})?$/.test(name)) continue;
    try {
      const file = join(folder, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 72 * 1024) continue;
      const row = JSON.parse(readFileSync(file, "utf8")), after = lstatSync(file);
      if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) continue;
      if (row.schema === "agent-mem.hook-capture/v1" && row.cwd === f.cwd && row.capture?.agent === "claude" && row.capture?.event === event && row.capture?.excerpt === excerpt) return true;
    } catch { /* Incomplete/unreadable evidence is never the positive deferral exception. */ }
  }
  return false;
}
function invocationExcerpt(event: "PostToolUse" | "SessionStart", response: string): string {
  return event === "PostToolUse" ? `src/public.ts\n${response}` : response;
}
function invocationId(event: string, excerpt: string): number {
  const prefix = event === "PostToolUse" ? "src/public.ts\n" : event === "SessionStart" ? "" : undefined;
  if (prefix === undefined || !excerpt.startsWith(prefix)) return 0;
  const match = /^budget public result (\d+)$/.exec(excerpt.slice(prefix.length));
  return match ? Number(match[1]) : 0;
}
function invoke(event: "PostToolUse" | "SessionStart", group: keyof typeof deferredWorkers, expectRepoSection = false): Sample {
  const before = readMetrics(f.base).filter(row => row.kind === "hook").length, beforeWorkers = observer.read().length, beforeEvidence = observer.evidence().length;
  const input = { hook_event_name: event, cwd: f.cwd, session_id: "p3-budget", tool_name: "Read", tool_input: { file_path: "src/public.ts" }, tool_response: `budget public result ${++invocations}` };
  const start = performance.now();
  // Observe each fixed owned child as well as the outer CLI group; native metadata supervisors also own detached groups.
  // The test preload and its append overhead conservatively count inside actual CLI wall/RSS measurements.
  const result = Bun.spawnSync([hookBin, "hook", event], { cwd: f.cwd, env: { ...f.env, BUN_OPTIONS: `--preload=${observer.preload}` }, stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe", detached: true, timeout: 3000, maxBuffer: 16 * 1024 });
  const wallMs = performance.now() - start;
  ownedGroups.add(result.pid);
  const workers = observer.read().slice(beforeWorkers);
  // Register every observed group before any assertion, including a malformed/extra-worker observation.
  for (const worker of workers) ownedWorkers.set(worker.pid, worker.detached);
  const evidence = observer.evidence().slice(beforeEvidence).filter(row => row.pid === result.pid);
  const pending = workers.length === 0 && pendingInvocation(event, invocationExcerpt(event, input.tool_response));
  try {
    const observation = verifyHookProcessObservation(event, workers, evidence, pending);
    if (observation.deferred) {
      deferredWorkers[group]++;
      if (group === "plain") verifyPlainHookDeferrals(deferredWorkers.plain, RUNS.plain);
    }
  } catch (error) {
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
    throw new Error(`${(error as Error).message}; ${JSON.stringify({ event, invocation: invocations, group, wallMs: round(wallMs), exit: result.exitCode, signal: Number(!!result.signalCode), stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, metricWallMs: metric?.wallMs ?? null, deferred: deferredWorkers, plainCap: MAX_PLAIN_DEFERRED })}`);
  }
  const alive = members(result.pid); leftoverProcesses += alive.length;
  if (alive.length) throw new Error(`R1 owned hook group retained ${alive.length} processes`);
  ownedGroups.delete(result.pid);
  for (const worker of workers) {
    let running = false;
    try { process.kill(worker.pid, 0); running = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const retained = worker.detached ? members(worker.pid).length : Number(running);
    leftoverProcesses += retained; checkedWorkers++;
    if (worker.kind === "worker") checkedBunWorkers++; else checkedNativeSupervisors++;
    if (running || retained) throw new Error("R1 observed worker PID or owned group survived the invocation");
    ownedWorkers.delete(worker.pid);
  }
  if (result.exitCode !== 0 || result.signalCode) throw new Error(`hook executable failed: ${event}, exit=${result.exitCode}`);
  const metrics = readMetrics(f.base).filter(row => row.kind === "hook"), metric = metrics.at(-1);
  if (metrics.length !== before + 1 || !metric || !Number.isFinite(metric.rssMB) || !Number.isFinite(metric.wallMs) || metric.rssMB! <= 0 || metric.wallMs! < 0) throw new Error("actual hook failed to append a valid production metrics sample");
  // Bun child rusage maxRSS is bytes; process.resourceUsage().maxRSS uses a different unit.
  const cliRssMB = result.resourceUsage.maxRSS / 1048576, recordedRssMB = metric.rssMB!;
  if (!Number.isFinite(cliRssMB) || cliRssMB <= 0) throw new Error("hook process RSS unavailable");
  if (!(Math.max(cliRssMB, recordedRssMB) < RSS_MB)) throw new Error(`actual hook exceeded R2 peak RSS: ${JSON.stringify({ event, group, invocation: invocations, wallMs: round(wallMs), cliRssMB, recordedRssMB, rawRssMB: metric.rawRssMB })}`);
  if (event === "SessionStart") {
    const stall = (reason: string) => new BudgetStall(reason, { wallMs, metricWallMs: metric.wallMs!, rssMB: Math.max(cliRssMB, recordedRssMB), wallLimitMs: WALL_MS });
    if (/"(?:decision|permissionDecision|updatedInput|block)"\s*:|"continue"\s*:\s*false/.test(result.stdout.toString())) throw new Error("context hook emitted a control directive");
    if (result.stdout.length > 8192) throw new Error("SessionStart output exceeded 8 KiB");
    if (!result.stdout.length) {
      if (wallMs >= 140 || metric.wallMs! >= 140) throw stall("SessionStart deadline produced empty context");
      throw new Error(`SessionStart empty output: wall=${wallMs}, metric=${metric.wallMs}, stderrBytes=${result.stderr.length}`);
    }
    const output = JSON.parse(result.stdout.toString()), context = output.hookSpecificOutput?.additionalContext;
    if (output.hookSpecificOutput?.hookEventName !== "SessionStart" || typeof context !== "string" || !/coverage|complete|partial/i.test(context) || Buffer.byteLength(context) > 1200) throw new Error(`SessionStart fixture lacked bounded known work and coverage: wall=${wallMs}, metric=${metric.wallMs}, context=${JSON.stringify(context)}`);
    if (!context.includes(workMarker)) {
      if (/work=(?:partial|unavailable)/.test(context) && (wallMs >= 140 || metric.wallMs! >= 140 || /work: deadline exhausted/.test(context))) throw stall("SessionStart deadline omitted fixture work");
      throw new Error("SessionStart fixture lacked known work without deadline evidence");
    }
    // With a repo log the brief names the repo section in its coverage line, whatever its state: inside the hook's own 140 ms the optional sections
    // (curated, capture, repo) are dropped as "deadline exhausted" when under 80 ms is left, which is the fail-open design and not a repo fault.
    if (expectRepoSection && !/repo=(?:complete|partial|unavailable)/.test(context)) throw new Error(`SessionStart with a repo log named no repo coverage: ${context.slice(0, 160)}`);
    if (!expectRepoSection && /repo=/.test(context)) throw new Error("SessionStart without a repo log reported a repo section");
  }
  // Production metrics sum each exec-image peak; raw inherited-rusage peaks remain separate diagnostics. CLI rusage independently covers the executable.
  return { wallMs, cliRssMB, recordedRssMB, rawRssMB: metric.rawRssMB ?? recordedRssMB, rssMB: Math.max(cliRssMB, recordedRssMB) };
}
async function samples(name: string, count: number, run: () => Sample): Promise<Sample[]> {
  const rows: Sample[] = [];
  for (let index = 0; index < count; index++) rows.push(await budgetSample(`${name}-${index + 1}`, run, budgetGroupRecorder<Sample>(name, stalledAttempts)));
  return rows;
}
function summarize(name: string, samples: Sample[]) {
  const wallP95Ms = p95(samples.map(sample => sample.wallMs)), peakRssMB = Math.max(...samples.map(sample => sample.rssMB));
  const verdict = workloadBudget(name, { wallP95Ms, peakRssMB, wallLimitMs: WALL_MS, rssLimitMB: RSS_MB });
  return { runs: samples.length, stalledAttempts: stalledAttempts.get(name) ?? 0, wallP95Ms: round(wallP95Ms), wallMaxMs: round(Math.max(...samples.map(sample => sample.wallMs))), peakRssMB: round(peakRssMB), cliPeakRssMB: round(Math.max(...samples.map(sample => sample.cliRssMB))), productionCombinedPeakRssMB: round(Math.max(...samples.map(sample => sample.recordedRssMB))), rawCombinedPeakRssMB: round(Math.max(...samples.map(sample => sample.rawRssMB))), ...verdict };
}
try {
  await f.seed();
  if (process.argv.includes("--public-prune-view")) {
    await migrateShards({ memoryDir: f.base, mode: "apply", authorizedPerson: true, tty: true });
    await activatePublicPruneView({ memoryDir: f.base, mode: "apply", authorizedPerson: true, tty: true });
  }
  const capture = new CaptureStore({ memoryDir: f.base, project: f.project });
  const dir = capture.dir, baseline = capture.stats().rows; capture.close();
  const plain = await samples("plain", RUNS.plain, () => invoke("PostToolUse", "plain"));
  const holder = new Database(join(dir, "capture.db"));
  let contended: Sample[];
  try {
    holder.run("PRAGMA busy_timeout=0"); holder.run("BEGIN IMMEDIATE");
    contended = await samples("spoolAndExit", RUNS.contention, () => invoke("PostToolUse", "spoolAndExit"));
    const spool = join(dir, "spool");
    // A drainer claims a segment before its SQLite transaction; contention retains the renamed immutable receipt.
    const segmentName = /^spool-[0-9a-f-]+\.jsonl(?:\.offset-\d+(?:-skip)?)?(?:\.draining-[0-9a-f]+)?$/;
    const entries = existsSync(spool) ? readdirSync(spool, { withFileTypes: true }) : [];
    const receipts = entries.filter(entry => entry.isFile() && segmentName.test(entry.name));
    const pendingDir = join(f.base, "hook-spool");
    const pending = existsSync(pendingDir) ? readdirSync(pendingDir).filter(name => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)).length : 0;
    if (receipts.length + pending < RUNS.contention) throw new Error(`contention did not retain its capture receipts (spool=${receipts.length}, pending=${pending})`);
  } finally { try { holder.run("ROLLBACK"); } finally { holder.close(); } }
  const drains: Sample[] = [], acceptedWorkload = invocations;
  // Capture is durable before optional work; a bounded series of real invocations observes replay.
  // Every barrier is included in R1 and R2, and every accepted event must appear exactly once.
  for (let pass = 0; pass < 4; pass++) {
    drains.push(await budgetSample(`drain-${pass + 1}`, () => invoke("PostToolUse", "drain"), budgetGroupRecorder<Sample>("drain", stalledAttempts)));
    const check = new CaptureStore({ memoryDir: f.base, project: f.project });
    let rows: number[];
    try { rows = check.rows().flatMap(row => {
      const id = invocationId(row.event, row.excerpt);
      return id >= 1 && id <= acceptedWorkload ? [id] : [];
    }); } finally { check.close(); }
    if (new Set(rows).size !== rows.length) throw new Error("capture replay duplicated a workload event");
    if (rows.length === acceptedWorkload) break;
    if (pass === 3) {
      // Failure-only fixture evidence: collection does not enter an R1/R2 sample or retry correctness.
      const inventory = (folder: string) => (existsSync(folder) ? readdirSync(folder) : []).map(name => {
        const file = join(folder, name), stat = lstatSync(file);
        return { name, bytes: stat.size, regular: stat.isFile() && !stat.isSymbolicLink() };
      });
      const pending = [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(folder => inventory(folder).filter(row => /^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(row.name)).map(row => {
        let invocation: number | null = null, scopeKnown = false;
        if (row.regular && row.bytes <= 72 * 1024) try {
          const value = JSON.parse(readFileSync(join(folder, row.name), "utf8")), id = invocationId(value.capture?.event ?? "", value.capture?.excerpt ?? "");
          invocation = id || null; scopeKnown = typeof value.scope === "string";
        } catch (error) { console.error(JSON.stringify({ diagnostic: "hook-drain-unreadable", name: row.name, code: (error as NodeJS.ErrnoException).code ?? "invalid_record" })); }
        return { ...row, invocation, scopeKnown };
      }));
      console.error(JSON.stringify({ diagnostic: "hook-drain-state", observed: rows.length, expected: acceptedWorkload,
        pending, captureSpool: inventory(join(dir, "spool")), identityCache: inventory(join(f.base, "hook-project")),
        workers: observer.read().map(({ pid, kind, detached }) => ({ pid, kind, detached })), evidence: observer.evidence().slice(-16) }));
      throw new Error(`contended rows did not drain losslessly: observed=${rows.length}, expected=${acceptedWorkload}`);
    }
  }
  const sessionStart = await samples("sessionStart", RUNS.sessionStart, () => invoke("SessionStart", "sessionStart"));
  const finalStore = new CaptureStore({ memoryDir: f.base, project: f.project });
  const recorded = new Map<number, string>(), pending = new Map<number, string>();
  try {
    for (const row of finalStore.rows()) {
      const id = invocationId(row.event, row.excerpt); if (!id) continue;
      if (recorded.has(id)) throw new Error("capture duplicated an accepted invocation");
      recorded.set(id, row.at);
    }
  } finally { finalStore.close(); }
  const pendingDir = join(f.base, "hook-spool");
  for (const dir of [pendingDir, join(pendingDir, ".capacity")]) for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/^hook-.*\.json(?:\.draining-[a-f0-9]+)?$/.test(name)) continue;
    const value = JSON.parse(readFileSync(join(dir, name), "utf8")), id = invocationId(value.capture?.event ?? "", value.capture?.excerpt ?? "");
    if (!id || value.cwd !== f.cwd) throw new Error("pending fixture capture unavailable");
    if (pending.has(id)) throw new Error("pending fixture capture duplicated");
    pending.set(id, value.capture.at);
  }
  for (let id = 1; id <= invocations; id++) {
    if (!recorded.has(id) && !pending.has(id)) throw new Error(`accepted invocation has neither capture nor pending receipt (id=${id}, of ${invocations}, recorded=${recorded.size}, pending=${pending.size})`);
    if (recorded.has(id) && pending.has(id) && recorded.get(id) !== pending.get(id)) throw new Error("pending acknowledgement changed capture identity");
  }
  // #15 T4 (after the capture accounting above, which counts PostToolUse and plain SessionStart runs only): the same real `bin/amem.js hook SessionStart`, with a 1 MiB `.amem/log.jsonl` (the repo scope's read cap) in the repository. The repo section must be bounded by the
  // hook's own deadline, so a log at the cap costs the hook no more than the budget it already has. This is a wall-time and RSS guard, not proof of the bounded read:
  // inside the native hook's 140 ms the optional sections are usually dropped before the repo read starts. The bounded read is proven in test/repo-scope.test.ts (1 MiB brief test).
  const repoLog = join(f.cwd, ".amem", "log.jsonl");
  mkdirSync(join(f.cwd, ".amem"), { recursive: true });
  // Built without garbage: on Linux a child's maxRSS includes the parent's RSS at fork, so a harness that churns megabytes of strings (a `join` per loop turn did) inflates the hook's measured peak.
  const repoLines: string[] = []; let repoBytes = 0;
  for (let i = 0; repoBytes < 1_000_000; i++) {
    const body = { schema: REPO_SCHEMA as typeof REPO_SCHEMA, op: "note" as const, at: "2026-10-20T10:00:00.000Z", kind: "decision" as const, text: `shared decision ${i} ${"y".repeat(3000)}`, about: [] as string[], actor: "person" as const };
    const line = JSON.stringify({ ...body, id: repoEntryId(body) }); repoLines.push(line); repoBytes += line.length + 1;
  }
  writeFileSync(repoLog, `${repoLines.join("\n")}\n`); repoLines.length = 0; Bun.gc(true);
  if (statSync(repoLog).size < 1_000_000) throw new Error("repo log fixture is smaller than 1 MB");
  const sessionStartRepoLog = await samples("sessionStartRepoLog", RUNS.sessionStart, () => invoke("SessionStart", "sessionStartRepoLog", true));
  const groups = { plain: summarize("plain", plain), spoolAndExit: summarize("spoolAndExit", contended), sessionStart: summarize("sessionStart", sessionStart), sessionStartRepoLog: summarize("sessionStartRepoLog", sessionStartRepoLog), drain: summarize("drain", drains) };
  // Timeout legs keep hard R1/RSS checks and retry one evidenced wall stall under the same limit.
  // Logical sample counts and limits stay unchanged; physical stalls are counted separately.
  const timeoutPaths = [];
  for (const event of ["SessionStart", "PreToolUse"] as const) {
    const sample = await budgetSample(`actual-${event}-timeout`, async () => {
      const timeoutFixture = hookFixture();
      try {
        const value = await hookTimeoutProbe(timeoutFixture, event, false);
        if (!(value.rssMB < RSS_MB)) throw new Error(`actual ${event} timeout exceeded R2 peak: wall=${value.wallMs}, rss=${value.rssMB}`);
        if (!(value.wallMs < WALL_MS)) throw new BudgetStall(`actual ${event} timeout wall below 150 ms`, { wallMs: value.wallMs, rssMB: value.rssMB, limitMs: WALL_MS });
        return value;
      } finally { timeoutFixture.close(); }
    }, budgetGroupRecorder<Awaited<ReturnType<typeof hookTimeoutProbe>>>(`actual-${event}-timeout`, stalledAttempts));
    singleAttemptTiming(`actual ${event} timeout wall below 150 ms`, sample.wallMs < WALL_MS,
      { wallMs: round(sample.wallMs), rssMB: round(sample.rssMB), limitMs: WALL_MS });
    const { pending: _pending, ...numeric } = sample;
    timeoutPaths.push({ ...numeric, stalledAttempts: stalledAttempts.get(`actual-${event}-timeout`) ?? 0, wallMs: round(sample.wallMs), rssMB: round(sample.rssMB) });
  }
  const report = { timeoutPaths, capture: { baselineRows: baseline, replayedWorkload: acceptedWorkload, drainInvocations: drains.length, capturedInvocations: recorded.size, pendingAcknowledgements: pending.size }, platform: process.platform, bun: Bun.version, executable: "bin/amem.js hook", budgets: { R1: { pass: leftoverProcesses === 0, leftoverProcesses, checkedInvocations: invocations, checkedWorkers, checkedOwnedChildren: checkedWorkers, checkedBunWorkers, checkedNativeSupervisors, zeroWorkerDeferrals: deferredWorkers, maxPlainZeroWorkers: MAX_PLAIN_DEFERRED, scope: "outer executable groups plus every observed owned Bun-worker or native-supervisor PID and detached group" }, R2: { pass: Object.values(groups).every(group => group.pass), wallP95BudgetMs: WALL_MS, peakRssBudgetMB: RSS_MB, groups } }, pass: leftoverProcesses === 0 && Object.values(groups).every(group => group.pass) };
  if (!report.budgets.R1.pass) throw Error("hook R1 budget failed");
  return report;
} finally {
  const deferralReport = { diagnostic: "R1-worker-deferrals", stalledAttemptsByGroup: Object.fromEntries(stalledAttempts), ...deferredWorkers, maxPlain: MAX_PLAIN_DEFERRED };
  console.error(JSON.stringify(deferralReport));
  if (process.env.GITHUB_STEP_SUMMARY) try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `R1 optional-worker deadline deferrals: plain ${deferredWorkers.plain}/${RUNS.plain} (maximum ${MAX_PLAIN_DEFERRED}), contention ${deferredWorkers.spoolAndExit}, drain ${deferredWorkers.drain}, SessionStart ${deferredWorkers.sessionStart}.\n`); } catch { /* The console retains the same numeric receipt if the summary is unavailable. */ }
  // Only groups created by this script, and only while a fresh process-table read still shows members.
  for (const group of ownedGroups) if (members(group).length) try { process.kill(-group, "SIGKILL"); } catch { /* an already-ended group is clean */ }
  for (const [pid, detached] of ownedWorkers) {
    if (detached && members(pid).length) try { process.kill(-pid, "SIGKILL"); } catch { /* Already ended owned group. */ }
    else try { process.kill(pid, "SIGKILL"); } catch { /* Already ended owned child. */ }
  }
  f.close();
}

}
// ponytail: repeat the complete fresh fixture suite once, not already-drained subgroups.
// Upgrade to isolated per-workload fixtures before narrowing the retry unit.
const measured = await budgetGroup("hook-workloads", measureHooks, report => ({
  wallPass: Object.values(report.budgets.R2.groups).every(group => group.pass),
  rssPass: Object.values(report.budgets.R2.groups).every(group => group.peakPass),
}));

console.log(JSON.stringify({ ...measured.result, groupAttempts: measured.attempts }, null, 2));
