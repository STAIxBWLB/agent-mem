import { measuredBudgetHookRss } from "./hook-rss-check.ts";
/** Every real hook call, including bounded resumptions, is an R2 sample. */
import { readTranscriptCursorOffset } from "./transcript-cursor-read.ts";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import { HOOK_TRANSCRIPT_BYTES } from "../src/hook-transcript.ts";
import { stallAdvisory, budgetFailureAdvisory, reportBudgetAdvisory } from "./hook-timing-check.ts";
import { budgetGroup, R2_WALL_MAX_MS, r2Verdict, runnerFingerprint, TRANSCRIPT_WALL_MAX_ENFORCED } from "./budget-attempt.ts";

let stallWarned = false;
const RUNS = 40, MAX_FOLLOW_UPS = 64;
/** #226 ruling (Q1): R1 judges the hook's owned children after a fixed post-exit window. Within it a SIGKILLed child still
 * leaving uninterruptible I/O may exist; after it any survivor fails R1. Per invocation the harness records the count of
 * children alive at hook exit (the hook's own `abandonedChildren`) and how long the last one survived. Owned children are
 * found by this checkout's absolute helper paths, so nothing outside this run is judged; the hook itself is never polled. */
const R1_POST_EXIT_WINDOW_MS = 2000;
const OWNED_HELPERS = ["session-brief-worker.ts"].map(name => join(import.meta.dir, "..", "src", name));
function ownedHelpers(): number[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,command="], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  if (result.exitCode !== 0) throw new Error("R1 process table unavailable");
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && OWNED_HELPERS.some(path => match[3]!.includes(path)) ? [Number(match[1])] : [];
  });
}
const r1 = { invocations: 0, aliveAtExit: 0, maxSurvivalMs: 0 };
async function judgeR1(aliveAtExit: number, diagnostic: Record<string, unknown>) {
  r1.invocations++; r1.aliveAtExit += aliveAtExit;
  const exitAt = performance.now();
  let alive = ownedHelpers();
  while (alive.length && performance.now() - exitAt < R1_POST_EXIT_WINDOW_MS) { await Bun.sleep(10); alive = ownedHelpers(); }
  const survivalMs = performance.now() - exitAt;
  if (aliveAtExit) r1.maxSurvivalMs = Math.max(r1.maxSurvivalMs, survivalMs);
  if (aliveAtExit || alive.length) console.log(JSON.stringify({ diagnostic: "transcript-R1", ...diagnostic, aliveAtExit, postExitSurvivalMs: Math.round(survivalMs), survivors: alive.length }));
  if (alive.length) throw new Error(`R1 owned hook children retained ${alive.length} processes after the ${R1_POST_EXIT_WINDOW_MS} ms post-exit window`);
}
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
const key = (row: { event: string; excerpt: string }) => JSON.stringify([row.event, row.excerpt]);
const summary = (row: { event: string }) => ["Title", "Recap", "Compact"].includes(row.event);
function durable(f: ReturnType<typeof hookFixture>, digest: string) {
  const stored = f.rows().filter(row => row.session === digest && summary(row));
  if (new Set(stored.map(key)).size !== stored.length) throw Error("duplicate stored transcript summary");
  const pending = [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir)
    .filter(name => /^hook-(?:v[23]-)?[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json(?:\.draining-[a-f0-9]{24})?$/.test(name))
    .flatMap(name => {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
      return value.capture?.session === digest && summary(value.capture) ? [value.capture as { event: string; excerpt: string }] : [];
    }) : []);
  return new Set([...stored, ...pending].map(key));
}
async function verifyReplay(f: ReturnType<typeof hookFixture>, digest: string, expected: ReadonlySet<string>) {
  const previousHome = process.env.HOME;
  // Replay under the same HOME binding that admitted this fixture's real CLI records.
  let closeStore: (() => void) | undefined;
  try {
    process.env.HOME = f.env.HOME;
    const store = new CaptureStore({ memoryDir: f.base, project: f.project, cwd: f.cwd });
    closeStore = () => store.close();
    // No additional hook calls: replay only already-durable receipts to verify idempotence.
    for (let pass = 0; pass < Math.ceil(expected.size / 32) + 1; pass++) await drainHookCaptures({
      cwd: f.cwd, base: f.base, project: f.project, expectedScope: hookCaptureScope(f.cwd, f.base), timeRemaining: () => 2000,
    }, (row, receipt) => store.append(row, { receipt }));
    const rows = store.rows({ project: f.project, limit: 1000 }).filter(row => row.session === digest && summary(row));
    if (rows.length !== expected.size || new Set(rows.map(key)).size !== expected.size || rows.some(row => !expected.has(key(row)))) {
      const counts = new Map<string, number>(); for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
      throw Error("transcript summary replay lost or duplicated a row: " + JSON.stringify({ stored: rows.length, unique: counts.size, expected: expected.size,
        duplicateCounts: [...counts].filter(([, count]) => count > 1).map(([value, count]) => ({ key: createHash("sha256").update(value).digest("hex"), count })),
        missingCount: [...expected].filter(value => !counts.has(value)).length, durable: durable(f, digest).size }));
    }
  } finally {
    try { closeStore?.(); }
    finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
  }
}
async function measure() {
  let f = hookFixture();
  runnerFingerprint();
  const incompleteRuns: Record<string, number> = {};
  const handlerWalls: { event: string; metricWallMs: number }[] = [];
  const samples: (ReturnType<typeof measuredBudgetHookRss> & { event: string; run: number; logicalRun: number; followUp: number; wallMs: number; offset: number; offsetSource: "cursor" | "uncreated" | "rollback_pending"; newSummaries: number; durableSummaries: number; reasonOnlyStreak: number; firstUncommittedSummaryEnd?: number; stopReason?: string })[] = [];
  try {
    await f.seed();
    for (const event of ["Stop", "SessionEnd", "StopBurst"]) for (let logicalRun = 1; logicalRun <= RUNS; logicalRun++) {
      if (event === "StopBurst") { f.close(); f = hookFixture(); await f.seed(); }
      const transcript = join(f.root, "transcript.jsonl"), session = event + "-" + logicalRun, at = new Date().toISOString(), marker = "summary " + session;
      const lines = [JSON.stringify({ type: "assistant", timestamp: at }), JSON.stringify({ type: "ai-title", aiTitle: marker }),
        JSON.stringify({ type: "system", subtype: "away_summary", timestamp: at, content: marker }),
        JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at, message: { content: marker } })];
      const expected = new Set(["Title", "Recap", "Compact"].map(event => key({ event, excerpt: marker })));
      const summaryEnds = new Map<string, number>();
      let summaryEnd = Buffer.byteLength(lines[0]!) + 1;
      for (const [index, event] of ["Title", "Recap", "Compact"].entries()) {
        summaryEnd += Buffer.byteLength(lines[index + 1]!) + 1;
        summaryEnds.set(key({ event, excerpt: marker }), summaryEnd);
      }
      if (event === "StopBurst") for (let index = 0; index < 100; index++) {
        const title = marker + " revision " + index;
        lines.push(JSON.stringify({ type: "ai-title", aiTitle: title })); expected.add(key({ event: "Title", excerpt: title }));
        summaryEnd += Buffer.byteLength(lines[lines.length - 1]!) + 1;
        summaryEnds.set(key({ event: "Title", excerpt: title }), summaryEnd);
      }
      const prefix = lines.join("\n") + "\n", ordinary = JSON.stringify({ type: "assistant", timestamp: at, text: "x".repeat(800) }) + "\n";
      writeFileSync(transcript, prefix + ordinary.repeat(Math.ceil((HOOK_TRANSCRIPT_BYTES - Buffer.byteLength(prefix)) / ordinary.length)));
      const digest = createHash("sha256").update("amem-session\0" + session).digest("hex").slice(0, 16);
      const file = join(f.base, "hook-transcripts", digest + ".db");
      let previous = 0, previousSummaries = 0, reasonOnlyStreak = 0, complete = false;
      let previousAvailable = new Set<string>();
      for (let followUp = 0; followUp <= MAX_FOLLOW_UPS; followUp++) {
        Bun.gc(true);
        const started = performance.now(), result = f.run(event === "StopBurst" ? "Stop" : event, { session_id: session, transcript_path: transcript });
        const wallMs = performance.now() - started, metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
        await judgeR1(metric?.abandonedChildren ?? 0, { event, logicalRun, followUp });
        console.log(JSON.stringify({ diagnostic: "transcript-budget-invocation", event, logicalRun, followUp, wallMs,
          exitCode: result.exitCode, stdoutBytes: result.stdout.length, cliRssMB: result.resourceUsage.maxRSS / 1048576, metric }));
        if (result.exitCode !== 0 || result.stdout.length || !metric || !Number.isFinite(metric.wallMs) || metric.wallMs! < 0) throw Error("transcript budget hook unavailable");
        const stopReason = metric.transcriptStopReason;
        let offset = 0, offsetSource: "cursor" | "uncreated" | "rollback_pending" = "uncreated";
        if (existsSync(file)) {
          try { offset = readTranscriptCursorOffset(file); offsetSource = "cursor"; }
          catch (error) {
            // #221: cursorDatabase creates the file before its one init commit; a hook killed at its deadline in
            // between leaves a schema-less file that the next call initializes. Uncreated, but only with a deadline stop.
            const schemaless = /no such table: cursor/.test(String((error as Error).message)) && stopReason === "deadline" && metric.transcriptOffset === undefined && previous === 0;
            if (schemaless) { offset = 0; offsetSource = "uncreated"; }
            else {
            if ((error as { code?: string }).code !== "SQLITE_READONLY_ROLLBACK" || stopReason !== "deadline" || metric.transcriptOffset !== undefined) throw error;
            // This serial fixture has one offset-advancing transaction per call. Do not
            // heal its hot journal here: the next measured hook owns the recovery cost.
            offset = previous; offsetSource = "rollback_pending";
            }
          }
        }
        let rss: ReturnType<typeof measuredBudgetHookRss>;
        try { rss = measuredBudgetHookRss(metric, result.resourceUsage.maxRSS / 1048576, { survivors: 0, abandonedOwnedWorkers: metric.abandonedChildren ?? 0 }, `transcript:${event}:${logicalRun}:${followUp}`); }
        catch (error) { console.error(JSON.stringify({ diagnostic: "transcript-budget-failure", event, logicalRun, followUp, wallMs, offset, metric })); throw error; }
        let available: Set<string>;
        try { available = durable(f, digest); }
        catch (error) { console.error(JSON.stringify({ diagnostic: "transcript-budget-failure", event, logicalRun, followUp, wallMs, offset, ...rss })); throw error; }
        const durableSummaries = [...expected].filter(value => available.has(value)).length, newSummaries = durableSummaries - previousSummaries;
        const firstUncommittedSummaryEnd = [...summaryEnds].find(([value]) => !previousAvailable.has(value))?.[1];
        reasonOnlyStreak = newSummaries > 0 ? 0 : reasonOnlyStreak + 1;
        const sample = { event, run: samples.filter(row => row.event === event).length + 1, logicalRun, followUp, wallMs, ...rss, offset, offsetSource, newSummaries, durableSummaries, reasonOnlyStreak, firstUncommittedSummaryEnd, ...(stopReason ? { stopReason } : {}) };
        samples.push(sample); console.log(JSON.stringify({ diagnostic: "transcript-budget-sample", ...sample }));
        const metricWallMs = typeof metric.wallMs === "number" && Number.isFinite(metric.wallMs) ? metric.wallMs : Number.NaN;
        handlerWalls.push({ event, metricWallMs });
        if (!(metricWallMs <= R2_WALL_MAX_MS)) {
          const advisory = budgetFailureAdvisory("transcript-wall-max", { telemetryValid: Number.isFinite(metricWallMs) && metricWallMs >= 0, survivors: 0, wallMs: metricWallMs });
          console.log(JSON.stringify({ diagnostic: "transcript-wall-max", enforced: TRANSCRIPT_WALL_MAX_ENFORCED && !advisory, advisory, event, logicalRun, followUp, metricWallMs, outerWallMs: wallMs }));
        }
        if (!Number.isSafeInteger(offset) || offset < previous || offset - previous > HOOK_TRANSCRIPT_BYTES
          || metric.transcriptOffset !== undefined && metric.transcriptOffset !== offset
          || newSummaries < 0 || offset === previous && !["cap", "deadline", "spool_full"].includes(stopReason ?? "")
          || newSummaries === 0 && (!["deadline", "spool_full"].includes(stopReason ?? "") || firstUncommittedSummaryEnd === undefined || offset >= firstUncommittedSummaryEnd)
          || [...summaryEnds].some(([value, end]) => end <= offset && !available.has(value))) {
          throw Error("transcript budget scan progress unavailable: " + JSON.stringify(sample));
        }
        if (reasonOnlyStreak >= 3) {
          const message = "transcript summary progress stalled after three reason-only invocations: " + JSON.stringify(sample);
          // ponytail: on hosted macOS only, this one clause (#221 finding B, worker start cost) is advisory (owner decision
          // 2026-11-02, #226; restored after the #226 redesign still stalled on the 3-vCPU hosted macOS runner, run 41489559964).
          // Ceiling: that runner and this clause; every other progress, no-loss, RSS and wall clause, and this clause on dgx02,
          // local runs and hosted ubuntu, stay hard failures. Upgrade path: the post-0.20.0 early-receipt follow-up (send the
          // drain receipt early when a cached identity exists, Refs #226), then delete this branch.
          if (!stallAdvisory(process.env)) throw Error(message);
          if (!stallWarned) { console.warn(`::warning title=Transcript stall (advisory on hosted macOS, #226)::${message}`); stallWarned = true; }
          console.log(JSON.stringify({ diagnostic: "transcript-budget-stall-advisory", ...sample }));
          reasonOnlyStreak = 0;
        }
        previous = offset; previousSummaries = durableSummaries; previousAvailable = available;
        if ([...expected].every(value => available.has(value))) { complete = true; break; }
      }
      if (!complete) {
        const last = samples.at(-1)!;
        const message = "transcript summaries not durable within " + MAX_FOLLOW_UPS + " follow-up invocations";
        if (!reportBudgetAdvisory("not-durable", `${event}:${logicalRun}: ${message}`, { telemetryValid: Number.isFinite(last.wallMs) && Number.isFinite(last.rssMB), survivors: 0 })) throw Error(message);
        incompleteRuns[event] = (incompleteRuns[event] ?? 0) + 1;
        continue;
      }
      await verifyReplay(f, digest, expected);
    }
    const groups = ["Stop", "SessionEnd", "StopBurst"].map(event => {
      const rows = samples.filter(row => row.event === event), wallP95Ms = p95(rows.map(row => row.wallMs)), firstInvocationWallP95Ms = p95(rows.filter(row => row.followUp === 0).map(row => row.wallMs)), peakRssMB = Math.max(...rows.map(row => row.rssMB));
      const rss = rows.map(row => row.rssMB).sort((a, b) => a - b), medianRssMB = (rss[Math.floor((rss.length - 1) / 2)]! + rss[Math.floor(rss.length / 2)]!) / 2;
      // #228: one value per logical run (its peak over every follow-up), so the fixed count is RUNS and resumed bursts cannot dilute it.
      const runPeaksMB = Array.from({ length: RUNS }, (_, index) => Math.max(...rows.filter(row => row.logicalRun === index + 1).map(row => row.rssMB)));
      // #228 reset: 150 MB ceiling and baseline regression on the 40 run peaks; the 300 ms handler maximum is enforced (#226, task 107).
      const rssGate = r2Verdict("transcript:" + event, { rssMB: runPeaksMB, wallMs: handlerWalls.filter(row => row.event === event).map(row => row.metricWallMs) }, { wallEnforced: TRANSCRIPT_WALL_MAX_ENFORCED });
      if (rssGate.regression.message && !rssGate.regression.enforced) console.warn(`::warning title=R2 regression (reported, not enforced on ${rssGate.runner})::${rssGate.regression.message}`);
      const wallMaxAdvisory = rssGate.wallMax.overMax > 0 && reportBudgetAdvisory("transcript-wall-max", `transcript:${event}`, {
        telemetryValid: handlerWalls.filter(row => row.event === event).every(row => Number.isFinite(row.metricWallMs) && row.metricWallMs >= 0),
        survivors: 0, wallMs: rssGate.wallMax.maxMs,
      });
      if (rssGate.wallMax.overMax && !wallMaxAdvisory) console.warn(`::warning title=R2 300 ms maximum (enforced)::transcript ${event}: ${rssGate.wallMax.overMax} invocation(s), max ${rssGate.wallMax.maxMs} ms`);
      return { event, incompleteRuns: incompleteRuns[event] ?? 0, rssCoverageComplete: rows.every(row => row.rssProvenanceKnown), rssProvenanceAdvisories: rows.filter(row => !row.rssProvenanceKnown).length, wallMaxAdvisory, wallMaxPass: rssGate.wallMax.pass || wallMaxAdvisory, logicalRuns: RUNS, runs: rows.length, followUpInvocations: rows.filter(row => row.followUp > 0).length,
        maxFollowUps: MAX_FOLLOW_UPS, maxFollowUpsObserved: Math.max(...rows.map(row => row.followUp)), firstInvocationWallP95Ms, summariesPerCall: { min: Math.min(...rows.map(row => row.newSummaries)), max: Math.max(...rows.map(row => row.newSummaries)), total: rows.reduce((n, row) => n + row.newSummaries, 0) },
        maxReasonOnlyStreak: Math.max(...rows.map(row => row.reasonOnlyStreak)), wallP95Ms, medianRssMB, peakRssMB, wallPass: wallP95Ms < 150 && firstInvocationWallP95Ms < 150, rssGate, rssPass: rssGate.ceiling.pass && rssGate.regression.pass };
    });
    return { groups, samples };
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = ["Stop", "SessionEnd", "StopBurst"].map(event => {
        const values = samples.filter(row => row.event === event && row.rssProvenanceKnown).map(row => row.rssMB).sort((a, b) => a - b);
        const median = values.length ? ((values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2).toFixed(2) : "-";
        return "| " + event + " | " + values.length + " | " + median + " | " + (values.at(-1)?.toFixed(2) ?? "-") + " |";
      });
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\nCandidate transcript source-known owned-image RSS (unknown-envelope samples remain in the numeric gates and invocation logs)\n\n| Event | Source-known calls | Median MB | Max MB |\n|---|---:|---:|---:|\n" + rows.join("\n") + "\n");
    }
    f.close();
  }
}
// #228/#226: a wall-max miss is its own non-retryable outcome; the ceiling and regression stay the RSS verdict.
const result = await budgetGroup("transcript-hooks", measure, report => ({ wallPass: report.groups.every(row => row.wallPass),
  rssPass: report.groups.every(row => row.rssGate.ceiling.pass && row.rssGate.regression.pass), wallMaxPass: report.groups.every(row => row.wallMaxPass) }));
console.log(JSON.stringify({ diagnostic: "transcript-R1-summary", windowMs: R1_POST_EXIT_WINDOW_MS, ...r1 }));
console.log(JSON.stringify(result, null, 2));
