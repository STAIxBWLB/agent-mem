/** Report-only paired diagnostic. The strict measure-transcript-budget.ts command is untouched. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMetrics } from "../src/memory/metrics.ts";
import { processGroupLiveness, processLiveness } from "../src/memory/platform.ts";
import { HOOK_TRANSCRIPT_BYTES } from "../src/hook-transcript.ts";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";
import { transcriptPhasePreload, readTranscriptPhases, transcriptPhases, type TranscriptPhaseRow } from "../test/fakes/transcript-phase-preload.ts";

// ponytail: two paired logical runs/event, 64 resumptions, two minutes total and
// 64 fixed 512-byte numeric slots/process. Expand only with measured observer cost.
export const TRANSCRIPT_PHASE_LIMITS = { runs: 2, followUps: 64, wallMs: 120_000, cleanupMs: 2000 } as const;
type Event = "Stop" | "SessionEnd" | "StopBurst";
const key = (row: { event: string; excerpt: string }) => JSON.stringify([row.event, row.excerpt]);
export function phaseWorkload(f: ReturnType<typeof hookFixture>, event: Event, logicalRun: number, at: string) {
  const session = event + "-" + logicalRun, marker = "summary " + session, file = join(f.root, "transcript.jsonl");
  const lines = [JSON.stringify({ type: "assistant", timestamp: at }), JSON.stringify({ type: "ai-title", aiTitle: marker }),
    JSON.stringify({ type: "system", subtype: "away_summary", timestamp: at, content: marker }),
    JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at, message: { content: marker } })];
  const expected = new Set(["Title", "Recap", "Compact"].map(event => key({ event, excerpt: marker })));
  if (event === "StopBurst") for (let index = 0; index < 100; index++) {
    const title = marker + " revision " + index; lines.push(JSON.stringify({ type: "ai-title", aiTitle: title })); expected.add(key({ event: "Title", excerpt: title }));
  }
  const prefix = lines.join("\n") + "\n", ordinary = JSON.stringify({ type: "assistant", timestamp: at, text: "x".repeat(800) }) + "\n";
  writeFileSync(file, prefix + ordinary.repeat(Math.ceil((HOOK_TRANSCRIPT_BYTES - Buffer.byteLength(prefix)) / ordinary.length)));
  return { file, session, expected, digest: createHash("sha256").update("amem-session\0" + session).digest("hex").slice(0, 16) };
}
function durable(f: ReturnType<typeof hookFixture>, digest: string) {
  const summary = (row: { event: string }) => ["Title", "Recap", "Compact"].includes(row.event);
  const stored = f.rows().filter(row => row.session === digest && summary(row));
  const pending = [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")].flatMap(dir => existsSync(dir) ? readdirSync(dir)
    .filter(name => /^hook-(?:v[23]-)?[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json(?:\.draining-[a-f0-9]{24})?$/.test(name))
    .flatMap(name => { const value = JSON.parse(readFileSync(join(dir, name), "utf8")); return value.capture?.session === digest && summary(value.capture) ? [value.capture as { event: string; excerpt: string }] : []; }) : []);
  return new Set([...stored, ...pending].map(key));
}
export function phaseProjection(rows: readonly TranscriptPhaseRow[], origin: number, parentPid: number) {
  const parent = rows.filter(row => row.pid === parentPid && row.role === 0), worker = rows.filter(row => row.role === 1);
  const drain = worker.find(row => row.phase === 55), metric = parent.find(row => row.phase === 46);
  return {
    firstDrainToMetricMs: drain && metric ? metric.lastAt - drain.firstAt : null,
    truncated: rows.some(row => row.phase === 52),
    processes: [...new Set(rows.map(row => row.pid))].map(pid => {
      const own = rows.filter(row => row.pid === pid);
      return { pid, role: own[0]!.role, exitObserved: own.some(row => row.phase === 49),
        observerMsLowerBound: Math.max(...own.map(row => row.observerMs)), loaderMsLowerBound: Math.max(...own.map(row => row.loaderMs)) };
    }),
    intervals: [...new Set(rows.map(row => row.pid))].flatMap(pid => {
      const own = rows.filter(row => row.pid === pid);
      return [[3,4],[7,8],[10,11],[12,13],[14,15],[16,17],[18,19],[20,21],[22,23],[24,25],[26,27],[28,29],[31,32],[33,34],[35,36],[37,38],[40,41],[42,43],[44,45],[47,48],[53,54]].flatMap(([a,b]) => {
        const start = own.find(row => row.phase === a), end = own.find(row => row.phase === b);
        if (!start) return [];
        const firstComplete = !!end && end.firstAt >= start.firstAt;
        const lastComplete = !!end && end.count === start.count && end.lastAt >= start.lastAt;
        return [{ pid, start: transcriptPhases[a!], end: transcriptPhases[b!], calls: start.count,
          firstMs: firstComplete ? end!.firstAt-start.firstAt : null, lastMs: lastComplete ? end!.lastAt-start.lastAt : null,
          firstUserUs: firstComplete ? end!.firstUser-start.firstUser : null, firstSystemUs: firstComplete ? end!.firstSystem-start.firstSystem : null,
          lastUserUs: lastComplete ? end!.lastUser-start.lastUser : null, lastSystemUs: lastComplete ? end!.lastSystem-start.lastSystem : null }];
      });
    }),
    phases: rows.map(row => ({ phase: transcriptPhases[row.phase], pid: row.pid, role: row.role, count: row.count,
      firstMs: row.firstAt - origin, lastMs: row.lastAt - origin, spanMs: row.lastAt - row.firstAt,
      cpuUserUs: row.lastUser - row.firstUser, cpuSystemUs: row.lastSystem - row.firstSystem,
      firstUserUs: row.firstUser, lastUserUs: row.lastUser, firstSystemUs: row.firstSystem, lastSystemUs: row.lastSystem,
      value: row.value, observerMsLowerBound: row.observerMs })),
  };
}
function helperPids(): number[] {
  const worker = join(import.meta.dir, "../src/session-brief-worker.ts");
  const ps = Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
  if (ps.exitCode !== 0 || ps.signalCode) throw Error("transcript diagnostic helper census unavailable");
  return ps.stdout.toString().split("\n").flatMap(line => { const m = /^\s*(\d+)\s+(.+)$/.exec(line); return m && m[2]!.includes(worker) ? [Number(m[1])] : []; });
}
async function run() {
  const started = performance.now(), samples: { event: Event; logicalRun: number; followUp: number; observed: boolean; wallMs: number }[] = [];
  const arms = { control: hookFixture(), observed: hookFixture() }, retained = new Set<ReturnType<typeof hookFixture>>();
  const details: { id: number; score: number; data: Record<string, unknown> }[] = [], printed = new Set<number>();
  console.log(JSON.stringify({ diagnostic: "transcript-phase-protocol/v1", reportOnly: true, limits: TRANSCRIPT_PHASE_LIMITS,
    observer: "fixed-slot numeric writes + resourceUsage per mark; costs are lower bounds; preload/compile and work differences also affect paired wall deltas", strictControl: "separate unchanged measure-transcript-budget.ts remains the gate", detailPolicy: "all numeric sample summaries; full first observed invocation/logical run and largest eight observed wall/drain intervals" }));
  try {
    await arms.control.seed(); await arms.observed.seed();
    for (const event of ["Stop", "SessionEnd", "StopBurst"] as const) for (let logicalRun = 1; logicalRun <= TRANSCRIPT_PHASE_LIMITS.runs; logicalRun++) {
      const at = new Date().toISOString();
      for (const arm of logicalRun % 2 ? ["control", "observed"] as const : ["observed", "control"] as const) {
        if (event === "StopBurst") { arms[arm].close(); arms[arm] = hookFixture(); await arms[arm].seed(); }
        const f = arms[arm], workload = phaseWorkload(f, event, logicalRun, at);
        let complete = false;
        for (let followUp = 0; followUp <= TRANSCRIPT_PHASE_LIMITS.followUps; followUp++) {
          if (performance.now() - started >= TRANSCRIPT_PHASE_LIMITS.wallMs) {
            console.log(JSON.stringify({ diagnostic: "transcript-phase-bound/v1", reportOnly: true, event, logicalRun, followUp, arm, coverageComplete: false })); return;
          }
          const observed = arm === "observed", invocationRoot = join(f.root, `phase-${event}-${logicalRun}-${followUp}`);
          let observer: ReturnType<typeof transcriptPhasePreload> | undefined;
          if (observed) { mkdirSync(invocationRoot); observer = transcriptPhasePreload(invocationRoot); }
          Bun.gc(true);
          const origin = performance.timeOrigin + performance.now(), result = f.run(event === "StopBurst" ? "Stop" : event,
            { session_id: workload.session, transcript_path: workload.file }, observer ? { BUN_OPTIONS: `--preload=${observer.preload}` } : {});
          const wallMs = performance.timeOrigin + performance.now() - origin;
          const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
          let rows = observer ? readTranscriptPhases(observer.directory, result.pid) : [];
          if (observer && !rows.some(row => row.phase === 1 && row.pid === result.pid)) throw Error("transcript phase preload was not observed");
          const children = rows.filter(row => row.pid === result.pid && row.phase === 8).map(row => row.value);
          const until = performance.now() + TRANSCRIPT_PHASE_LIMITS.cleanupMs;
          const survivors = () => observed ? children.filter(pid => processLiveness(pid) !== "gone" || processGroupLiveness(pid) !== "gone") : helperPids();
          while (survivors().length && performance.now() < until) await Bun.sleep(10);
          const remaining = survivors().length;
          if (remaining) retained.add(f);
          if (observer && !remaining) {
            rows = readTranscriptPhases(observer.directory);
            const failure = readFileSync(observer.failure, "utf8").trim(); if (failure) throw Error(failure);
          }
          const pending = durable(f, workload.digest), durableSummaries = [...workload.expected].filter(value => pending.has(value)).length;
          samples.push({ event, logicalRun, followUp, observed, wallMs });
          const projection = observer ? phaseProjection(rows, origin, result.pid) : undefined, sampleId = samples.length;
          console.log(JSON.stringify({ diagnostic: "transcript-phase-sample/v1", sampleId, reportOnly: true, event, logicalRun, followUp, observed,
            wallMs, metricWallMs: metric?.wallMs ?? null, afterMetricAndLaunchMs: metric?.wallMs === undefined ? null : wallMs - metric.wallMs,
            exitCode: result.exitCode, stdoutBytes: result.stdout.length, signal: result.signalCode ?? null,
            abandoned: metric ? metric.abandonedChildren ?? 0 : null, drainStartMs: metric?.drainStartMs ?? null, drained: metric?.drained ?? null,
            metricDrainToMetricMs: metric?.drainStartMs === undefined || metric.wallMs === undefined ? null : metric.wallMs - metric.drainStartMs,
            durableSummaries, expectedSummaries: workload.expected.size, remainingOwnedProcesses: observed ? remaining : null, helperCommandSurvivors: observed ? null : remaining,
            cleanupScope: observed ? "recorded-worker-pid-and-group" : "same-checkout-helper-commands",
            phaseCount: rows.length, firstDrainToMetricMs: projection?.firstDrainToMetricMs ?? null,
            truncated: projection?.truncated ?? false, observerCost: projection?.processes ?? null }));
          if (projection) {
            const data = { diagnostic: "transcript-phase-detail/v1", reportOnly: true, sampleId, event, logicalRun, followUp, ...projection };
            if (followUp === 0) { console.log(JSON.stringify(data)); printed.add(sampleId); }
            details.push({ id: sampleId, score: Math.max(wallMs, projection.firstDrainToMetricMs ?? 0), data });
            details.sort((a,b) => b.score-a.score); if (details.length > 8) details.pop();
          }
          if (remaining) throw Error("transcript phase owned cleanup unproven; retain diagnostic fixture");
          if (durableSummaries === workload.expected.size) { complete = true; break; }
        }
        console.log(JSON.stringify({ diagnostic: "transcript-phase-logical/v1", reportOnly: true, event, logicalRun, arm, complete }));
      }
    }
  } finally {
    for (const f of [arms.control, arms.observed]) if (!retained.has(f)) f.close();
    for (const detail of details) if (!printed.has(detail.id)) console.log(JSON.stringify({ ...detail.data, retainedBy: "largest-eight-wall-or-drain-span" }));
    for (const event of ["Stop", "SessionEnd", "StopBurst"]) for (let logicalRun = 1; logicalRun <= TRANSCRIPT_PHASE_LIMITS.runs; logicalRun++) {
      const first = samples.filter(row => row.event === event && row.logicalRun === logicalRun && row.followUp === 0);
      const control = first.find(row => !row.observed), observed = first.find(row => row.observed);
      if (control && observed) console.log(JSON.stringify({ diagnostic: "transcript-phase-observer-cost/v1", reportOnly: true, event, logicalRun,
        controlWallMs: control.wallMs, observedWallMs: observed.wallMs, pairedWallDeltaMs: observed.wallMs - control.wallMs,
        costIsNotCausalEstimate: true, note: "timing-dependent completed work differs; never subtract this delta from a strict result" }));
    }
  }
}
if (import.meta.main) await run();
