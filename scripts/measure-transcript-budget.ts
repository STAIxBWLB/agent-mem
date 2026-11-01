import { measuredHookRss } from "./hook-rss-check.ts";
/** Every real hook call, including bounded resumptions, is an R2 sample. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { drainHookCaptures, hookCaptureScope } from "../src/hook-spool.ts";
import { HOOK_TRANSCRIPT_BYTES } from "../src/hook-transcript.ts";
import { budgetGroup } from "./budget-attempt.ts";

const RUNS = 40, MAX_FOLLOW_UPS = 64;
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
  const samples: (ReturnType<typeof measuredHookRss> & { event: string; run: number; logicalRun: number; followUp: number; wallMs: number; offset: number; newSummaries: number; durableSummaries: number; reasonOnlyStreak: number; stopReason?: string })[] = [];
  try {
    await f.seed();
    for (const event of ["Stop", "SessionEnd", "StopBurst"]) for (let logicalRun = 1; logicalRun <= RUNS; logicalRun++) {
      if (event === "StopBurst") { f.close(); f = hookFixture(); await f.seed(); }
      const transcript = join(f.root, "transcript.jsonl"), session = event + "-" + logicalRun, at = new Date().toISOString(), marker = "summary " + session;
      const lines = [JSON.stringify({ type: "assistant", timestamp: at }), JSON.stringify({ type: "ai-title", aiTitle: marker }),
        JSON.stringify({ type: "system", subtype: "away_summary", timestamp: at, content: marker }),
        JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at, message: { content: marker } })];
      const expected = new Set(["Title", "Recap", "Compact"].map(event => key({ event, excerpt: marker })));
      if (event === "StopBurst") for (let index = 0; index < 100; index++) {
        const title = marker + " revision " + index;
        lines.push(JSON.stringify({ type: "ai-title", aiTitle: title })); expected.add(key({ event: "Title", excerpt: title }));
      }
      const prefix = lines.join("\n") + "\n", ordinary = JSON.stringify({ type: "assistant", timestamp: at, text: "x".repeat(800) }) + "\n";
      writeFileSync(transcript, prefix + ordinary.repeat(Math.ceil((HOOK_TRANSCRIPT_BYTES - Buffer.byteLength(prefix)) / ordinary.length)));
      const digest = createHash("sha256").update("amem-session\0" + session).digest("hex").slice(0, 16);
      const file = join(f.base, "hook-transcripts", digest + ".db");
      let previous = 0, previousSummaries = 0, reasonOnlyStreak = 0, complete = false;
      for (let followUp = 0; followUp <= MAX_FOLLOW_UPS; followUp++) {
        Bun.gc(true);
        const started = performance.now(), result = f.run(event === "StopBurst" ? "Stop" : event, { session_id: session, transcript_path: transcript });
        const wallMs = performance.now() - started, metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
        if (result.exitCode !== 0 || result.stdout.length || !metric) throw Error("transcript budget hook unavailable");
        let offset = 0;
        if (existsSync(file)) {
          const db = new Database(file, { readonly: true });
          try { offset = (db.query("SELECT offset FROM cursor").get() as { offset: number }).offset; } finally { db.close(); }
        }
        let rss: ReturnType<typeof measuredHookRss>;
        try { rss = measuredHookRss(metric, result.resourceUsage.maxRSS / 1048576); }
        catch (error) { console.error(JSON.stringify({ diagnostic: "transcript-budget-failure", event, logicalRun, followUp, wallMs, offset, metric })); throw error; }
        const stopReason = metric.transcriptStopReason;
        let available: Set<string>;
        try { available = durable(f, digest); }
        catch (error) { console.error(JSON.stringify({ diagnostic: "transcript-budget-failure", event, logicalRun, followUp, wallMs, offset, ...rss })); throw error; }
        const durableSummaries = [...expected].filter(value => available.has(value)).length, newSummaries = durableSummaries - previousSummaries;
        reasonOnlyStreak = newSummaries > 0 ? 0 : reasonOnlyStreak + 1;
        const sample = { event, run: samples.filter(row => row.event === event).length + 1, logicalRun, followUp, wallMs, ...rss, offset, newSummaries, durableSummaries, reasonOnlyStreak, ...(stopReason ? { stopReason } : {}) };
        samples.push(sample); console.log(JSON.stringify({ diagnostic: "transcript-budget-sample", ...sample }));
        if (!Number.isSafeInteger(offset) || offset < previous || offset - previous > HOOK_TRANSCRIPT_BYTES
          || newSummaries < 0 || (newSummaries === 0 || offset === previous) && !["cap", "deadline", "spool_full"].includes(stopReason ?? "")) {
          throw Error("transcript budget scan progress unavailable: " + JSON.stringify(sample));
        }
        if (reasonOnlyStreak >= 3) throw Error("transcript summary progress stalled after three reason-only invocations: " + JSON.stringify(sample));
        previous = offset; previousSummaries = durableSummaries;
        if ([...expected].every(value => available.has(value))) { complete = true; break; }
      }
      if (!complete) throw Error("transcript summaries not durable within " + MAX_FOLLOW_UPS + " follow-up invocations");
      await verifyReplay(f, digest, expected);
    }
    const groups = ["Stop", "SessionEnd", "StopBurst"].map(event => {
      const rows = samples.filter(row => row.event === event), wallP95Ms = p95(rows.map(row => row.wallMs)), firstInvocationWallP95Ms = p95(rows.filter(row => row.followUp === 0).map(row => row.wallMs)), peakRssMB = Math.max(...rows.map(row => row.rssMB));
      return { event, logicalRuns: RUNS, runs: rows.length, followUpInvocations: rows.filter(row => row.followUp > 0).length,
        maxFollowUps: MAX_FOLLOW_UPS, maxFollowUpsObserved: Math.max(...rows.map(row => row.followUp)), firstInvocationWallP95Ms, summariesPerCall: { min: Math.min(...rows.map(row => row.newSummaries)), max: Math.max(...rows.map(row => row.newSummaries)), total: rows.reduce((n, row) => n + row.newSummaries, 0) },
        maxReasonOnlyStreak: Math.max(...rows.map(row => row.reasonOnlyStreak)), wallP95Ms, peakRssMB, wallPass: wallP95Ms < 150 && firstInvocationWallP95Ms < 150, rssPass: peakRssMB < 100 };
    });
    return { groups, samples };
  } finally { f.close(); }
}
const result = await budgetGroup("transcript-hooks", measure, report => ({ wallPass: report.groups.every(row => row.wallPass), rssPass: report.groups.every(row => row.rssPass) }));
console.log(JSON.stringify(result, null, 2));
