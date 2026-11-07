import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { rssSourcesKnown, validRssSources } from "../src/hook-resources.ts";
import { HANDLER_MS } from "../src/hooks.ts";
import { R2_WALL_MAX_MS } from "../scripts/budget-attempt.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import { measuredAttributedHookRss } from "../scripts/hook-rss-check.ts";
import { hookProcessDiagnostic } from "../scripts/hook-process-diagnostic.ts";
/** Existing worker-path fixtures below use an explicit functional host deadline where named. Their relative bounds are
 * not native 140/300 ms R2 proof; the hosted budget harness provides that proof. The slow-append regression uses a
 * lightweight child-only CaptureStore stand-in and an explicit host deadline so its blocked append is reached. */
const HOST_DEADLINE_MS = 1000;
const POST_DEADLINE_ALLOWANCE_MS = R2_WALL_MAX_MS - HANDLER_MS;

let metricFixture = 0;
/** Hosted loops retain every native result, not just test failures. These numeric rows contain no source bodies. */
function reportHookMetrics(f: ReturnType<typeof hookFixture>, label: string) {
  const rows = readMetrics(f.base).filter(row => row.kind === "hook" && row.wallMs !== undefined);
  const unknown = rows.filter(row => !validRssSources(row.rssSources) || !rssSourcesKnown(row.rssSources!)).length;
  console.log(JSON.stringify({ diagnostic: "task110-metrics", case: label, fixture: ++metricFixture, calls: rows.length,
    missing: rows.length === 0, abandonedChildren: rows.reduce((sum, row) => sum + (row.abandonedChildren ?? 0), 0),
    unknownProvenanceRows: unknown + Number(rows.length === 0), drainSkipped: rows.reduce((sum, row) => sum + (row.drainSkipped ?? 0), 0),
    metrics: rows.map(({ wallMs, abandonedChildren, drainSkipped, drainStartMs, drained, transcriptOffset, transcriptStopReason, rssSources }) =>
      ({ wallMs, abandonedChildren, drainSkipped, drainStartMs, drained, transcriptOffset, transcriptStopReason, rssSources })) }));
}


for (const mode of ["normal", "identity_failure"] as const) test("native receipts precede transcript work: " + mode, async () => {
  const f = hookFixture(), phases = join(f.root, "phases.jsonl"), preload = join(f.root, "phases.ts"), transcript = join(f.root, "transcript.jsonl");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(phases, "");
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
const phases=${JSON.stringify(phases)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
globalThis.__phase201=(phase,known)=>appendFileSync(phases,JSON.stringify({phase,pid:process.pid,known})+'\\n');
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===worker?spawn([argv[0],argv[1],'--preload',preload,...argv.slice(2)],options):spawn(argv,options);
Bun.plugin({name:'transcript-order',setup(builder){
if(${JSON.stringify(mode === "identity_failure")})builder.onLoad({filter:/[/]hook-project\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='options.onResolved?.(prepared.receipt(result)); return result;';
 if(source.split(anchor).length!==2)throw Error('native refusal anchor changed');
 return {loader:'ts',contents:source.replace(anchor,'throw Error("fixture native refusal");')};
});
builder.onLoad({filter:/[/]hook-native\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='    try { observer?.finished(selected); }';
 if(source.split(anchor).length!==2)throw Error('native receipt order anchor changed');
 return {loader:'ts',contents:source.replace(anchor,"    (globalThis as any).__phase201('native',selected.known);"+anchor)};
});
builder.onLoad({filter:/[/]session-brief-worker\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='    try { project = resolveAlias(options.base!, acceptHookProjectReceipt(';
 if(source.split(anchor).length!==2)throw Error('worker receipt anchor changed');
 return {loader:'ts',contents:source.replace(anchor,"    (globalThis as any).__phase201('worker_receipt');"+anchor)};
});
builder.onLoad({filter:/[/]hook-native\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='  const child = Bun.spawn(["/bin/sh", "-c", SUPERVISOR, "amem-hook-native"';
 if(source.split(anchor).length!==2)throw Error('native spawn anchor changed');
 return {loader:'ts',contents:source.replace(anchor,"  (globalThis as any).__phase201('native_spawn');"+anchor)};
});
builder.onLoad({filter:/[/]hook-transcript\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='  const value = object(input);';
 if(source.split(anchor).length!==2)throw Error('transcript order anchor changed');
 return {loader:'ts',contents:source.replace(anchor,"  (globalThis as any).__phase201('scan');"+anchor)};
});}});
`);
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "worker summary", timestamp: new Date().toISOString() }) + "\n");
  try {
    await f.seed();
    const result = f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const events = readFileSync(phases, "utf8").trim().split("\n").map(line => JSON.parse(line) as { phase: string; pid: number; known?: boolean });
    const scan = events.findIndex(event => event.phase === "scan"), native = events.filter(event => event.phase === "native");
    // #226: the worker boots and scans at hook start, in parallel with native metadata, so the scan may be the first phase.
    expect(scan).toBeGreaterThanOrEqual(0); expect(native.length).toBeGreaterThan(0);
    // #226 ruling (option a, kept for b): the worker now boots and scans at hook start, in parallel with native metadata, so
    // "no native receipt after the scan starts" no longer holds. #211's invariants are what the order protected:
    // 1. every native receipt is issued in the parent and is known;
    expect(native.every(event => event.known && event.pid === result.pid)).toBe(true);
    // 2. the scan runs in the worker, a pid other than the parent, and that pid never spawns a native helper;
    const scanPids = new Set(events.filter(event => event.phase === "scan").map(event => event.pid));
    expect(scanPids.has(result.pid)).toBe(false);
    expect(events.some(event => event.phase === "native_spawn" && scanPids.has(event.pid))).toBe(false);
    expect(events.filter(event => event.phase === "native_spawn").every(event => event.pid === result.pid)).toBe(true);
    // 3. the capture worker revalidates the single-use receipt, and only after every native receipt was issued.
    const receipt = events.findIndex(event => event.phase === "worker_receipt");
    if (mode === "normal") {
      expect(receipt).toBeGreaterThan(0);
      expect(events.slice(receipt).some(event => event.phase === "native")).toBe(false);
      expect(events[receipt]!.pid === result.pid).toBe(false);
      expect(scanPids.has(events[receipt]!.pid)).toBe(true); // one worker scans and then drains
    }
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(rssSourcesKnown(metric.rssSources!)).toBe(true);
    {
      expect(metric.transcriptOffset).toBeGreaterThan(0);
      if (mode === "identity_failure") {
        const pending = readdirSync(join(f.base, "hook-spool")).filter(name => name.startsWith("hook-v3-")).map(name => JSON.parse(readFileSync(join(f.base, "hook-spool", name), "utf8")));
        expect(pending.some(row => row.capture.event === "Title" && row.capture.excerpt === "worker summary")).toBe(true);
        expect(f.runFunctional("PostToolUse", { prompt: "resume public summary" }).exitCode).toBe(0);
      }
      expect(f.rows().some(row => row.event === "Title" && row.excerpt === "worker summary")).toBe(true);
    }
  } finally { reportHookMetrics(f, "native:" + mode); f.close(); }
});

test("a final hook reaps blocked directly owned metadata before writing known RSS", async () => {
  const { hookTimeoutProbe } = await import("./fakes/hooks-timeout-probe.ts");
  const f = hookFixture();
  try { await f.seed(); const result = await hookTimeoutProbe(f, "Stop", true); expect(result.remainingProcesses).toBe(0); }
  finally { reportHookMetrics(f, "blocked-metadata"); f.close(); }
});

for (const platform of ["linux", "darwin-codepath"] as const) for (const event of ["Stop", "SessionEnd"] as const) test("a slow synchronous capture statement remains killable with known child provenance: " + platform + " " + event, async () => {
  const f = hookFixture(), preload = join(f.root, "slow-store.ts"), entered = join(f.root, "slow-store-entered"), transcript = join(f.root, "slow-transcript.jsonl");
  const observer=hookProcessObserver(f.root,false,undefined,true);
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(transcript, JSON.stringify({ type: "system", subtype: "away_summary", timestamp: new Date().toISOString(), content: "summary before slow store" }) + "\n");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
if(${JSON.stringify(platform === "darwin-codepath")})Object.defineProperty(process,'platform',{value:'darwin'});
globalThis.__slowCapture=()=>{writeFileSync(${JSON.stringify(entered)},'entered');const until=performance.now()+3000;while(performance.now()<until){}};
Bun.plugin({name:'slow-store',setup(b){b.onLoad({filter:/[/]memory[/]capture\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='  constructor(opts: CaptureOptions) {';
 if(source.split(anchor).length!==2)throw Error('slow store anchor changed');
 return {loader:'ts',contents:source.replace(anchor,anchor+'(globalThis as any).__slowCapture();')};
});}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);
await import(${JSON.stringify(observer.preload)});`);
  try {
    await f.seed();
    const result = f.runFunctional(event, { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(readFileSync(entered, "utf8")).toBe("entered");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    // Bound relative to the 2000 ms functional host deadline with the contract's post-deadline allowance; the real 140 ms
    // behaviour under kill is the hosted budget harness's (scripts/measure-transcript-budget.ts).
    const evidence=observer.evidence().filter(row=>row.pid===result.pid);
    const processDiagnostic=hookProcessDiagnostic({event,variant:platform,run:1,logicalRun:(platform==="linux"?0:2)+(event==="Stop"?1:2),parentPid:result.pid,expectedWorkerChildren:1,
      expectedOwnedChildren:evidence.some(row=>row.phase==="preload")?evidence.filter(row=>row.phase==="attempt"&&row.exact===1).length:null,expectation:"observed-spawn-attempts",
      workers:observer.read(),evidence,lifecycle:observer.lifecycle(result.pid),metric,cliRawRssMB:result.resourceUsage.maxRSS/1048576});
    const diagnostic=JSON.stringify(processDiagnostic);
    expect(metric.wallMs).toBeLessThan(2000 + POST_DEADLINE_ALLOWANCE_MS); const rss=await measuredAttributedHookRss(metric,result.resourceUsage.maxRSS/1048576,processDiagnostic,`slow-store:${platform}:${event}`);
    if (!rss.rssAdvisory) { expect(rssSourcesKnown(metric.rssSources!),diagnostic).toBe(true); expect(metric.rssSources!.unavailable,diagnostic).toBe(0); }
    else { expect(rss.rssProvenanceKnown).toBe(false); expect(metric.rssSources!.unavailable).toBeGreaterThan(0); }
    if (platform === "darwin-codepath" && !rss.rssAdvisory) expect(metric.rssSources!.platformRusage).toBe(4);
    // Linux rusage under the emulated Darwin path includes launcher peaks: source proof only, never an R2 pass.
    expect(f.runFunctional("PostToolUse", { prompt: "slow-store recovery" }).exitCode).toBe(0);
    expect(f.rows().filter(row => row.excerpt === "summary before slow store")).toHaveLength(1);
  } finally { reportHookMetrics(f, "slow-store:" + platform + ":" + event); f.close(); }
});

for (const event of ["Stop", "SessionEnd"] as const) test("the next SessionStart sees the previous final summary: " + event, async () => {
  const f = hookFixture(), transcript = join(f.root, "fresh-summary.jsonl");
  try {
    await f.seed();
    for (let session = 0; session < 3; session++) {
      const marker = "fresh " + event + " " + session, at = new Date(Date.now() + session * 1000).toISOString();
      writeFileSync(transcript, [ { type: "system", subtype: "away_summary", timestamp: at, content: marker + " recap" },
        { type: "user", isCompactSummary: true, timestamp: at, message: { content: marker + " compact" } } ].map(row => JSON.stringify(row)).join("\n") + "\n");
      const final = f.runFunctional(event, { session_id: "previous-" + session, transcript_path: transcript });
      console.log(JSON.stringify({ diagnostic: "task110-final-hook", event, session, exitCode: final.exitCode,
        metric: readMetrics(f.base).filter(row => row.kind === "hook" && row.wallMs !== undefined).at(-1) }));
      expect(final.exitCode).toBe(0);
      // #215: the freshness contract (#201) is that the final hook leaves both summaries as durable capture rows, whatever
      // the brief's timing. A runtime that leaves them pending in the spool fails here.
      const rows = f.rows();
      expect(rows.some(row => row.event === "Recap" && row.excerpt.includes(marker + " recap")), "final hook committed the Recap row").toBe(true);
      expect(rows.some(row => row.event === "Compact" && row.excerpt.includes(marker + " compact")), "final hook committed the Compact row").toBe(true);
      const next = f.runFunctional("SessionStart", { session_id: "next-" + session });
      expect(next.exitCode, next.stderr.toString()).toBe(0);
      const context = JSON.parse(next.stdout.toString()).hookSpecificOutput.additionalContext as string;
      const capture = /\bcapture=(\w+)/.exec(context)?.[1];
      expect(["complete", "partial"]).toContain(capture!);
      // A bounded capture read that hit its deadline on a slow runner labels itself partial, which the contract allows:
      // brief inclusion is asserted only for a complete read, and a partial one is never retried into a complete one.
      if (capture === "complete") { expect(context).toContain(marker + " recap"); expect(context).toContain(marker + " compact"); }
      else console.warn(`#215: ${event} session ${session} brief read capture=partial; inclusion not asserted`);
    }
  } finally { reportHookMetrics(f, "freshness:" + event); f.close(); }
});

for (const event of ["Stop", "SessionEnd"] as const) test("#226: a worker whose pipe outlives the kill cannot hold the hook past its bound: " + event, async () => {
  // A child stuck in uninterruptible I/O cannot be emulated portably (SIGKILL always lands), so the fixture keeps the worker's
  // stdout open from a descendant that escaped its group (setsid) and blocks the worker. The parent must neither wait on that
  // pipe nor keep its event loop alive for it: the hook returns inside the handler bound and records the stop and the skip.
  const f = hookFixture(), preload = join(f.root, "stuck-worker.ts"), entered = join(f.root, "stuck-worker-entered"), transcript = join(f.root, "stuck.jsonl");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "stuck worker fixture", timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(preload, `import {writeFileSync} from 'node:fs';
if(process.argv[1]===${JSON.stringify(worker)}){
 Bun.spawn(['/usr/bin/env','perl','-e','use POSIX; POSIX::setsid(); sleep 3;'],{stdin:'ignore',stdout:'inherit',stderr:'ignore'});
 writeFileSync(${JSON.stringify(entered)},'entered');
 const until=performance.now()+3000;while(performance.now()<until){}
}
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);`);
  try {
    await f.seed();
    const started = performance.now();
    // Explicit host deadline so the worker reliably reaches the stuck point on a slow runner (task 110); the bound is relative
    // to it. The real 140 ms behaviour under kill is the hosted budget harness's (scripts/measure-transcript-budget.ts).
    const result = f.runFunctional(event, { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` }, HOST_DEADLINE_MS);
    const outerMs = performance.now() - started;
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(readFileSync(entered, "utf8")).toBe("entered");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.wallMs).toBeLessThan(HOST_DEADLINE_MS + POST_DEADLINE_ALLOWANCE_MS);
    expect(outerMs).toBeLessThan(HOST_DEADLINE_MS + 1500); // the CLI process itself exits; the escaped 3 s descendant does not hold it
    expect(metric.transcriptStopReason).toBe("deadline");
    expect(metric.transcriptOffset).toBeUndefined();
    expect(metric.drainSkipped).toBe(1);
    expect(metric.captureDrops).toBeUndefined(); // a skipped drain is not a capture drop (ruling b)
  } finally { reportHookMetrics(f, "pipe-outlives:" + event); f.close(); }
});

async function stagePressure(f: ReturnType<typeof hookFixture>, count: number) {
  const { stageHookCapture } = await import("../src/hook-spool.ts");
  const previous = process.env.HOME; process.env.HOME = f.env.HOME;
  try { for (let index = 0; index < count; index++) await stageHookCapture("PostToolUse", { session_id: "pressure", tool_name: "Read", tool_response: `pressure ${index}` }, { cwd: f.cwd, base: f.base }); }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}

for (const event of ["Stop", "SessionEnd"] as const) test("#226 (#231): the host-relative kill bound holds while an actual replay append is blocked: " + event, async () => {
  const f = hookFixture(), preload = join(f.root, "slow-drain.ts"), entered = join(f.root, "slow-drain-entered"), transcript = join(f.root, "slow-drain.jsonl");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "slow drain title", timestamp: new Date().toISOString() }) + "\n");
  // Replace only the worker's capture module. The append itself blocks, rather than a
  // frame/phase marker before replay, while the parent keeps its real metadata path.
  writeFileSync(preload, `import {writeFileSync} from 'node:fs';
if(process.argv[1]===${JSON.stringify(worker)}){
 globalThis.__slowDrain=()=>{writeFileSync(${JSON.stringify(entered)},'entered');const until=performance.now()+3000;while(performance.now()<until){}};
 Bun.plugin({name:'lightweight-blocking-replay-store',setup(builder){builder.onLoad({filter:/[/]memory[/]capture\\.ts$/},()=>({loader:'ts',contents:'export class CaptureStore { constructor(_opts: unknown) {} append() { (globalThis as any).__slowDrain(); return { id: 1 }; } close() {} }'}));}});
}
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);`);
  try {
    await f.seed(); await stagePressure(f, 20);
    const started = performance.now();
    // Hosted 20x runs at 623a9cf missed this entered point (macOS 3/20, ubuntu 1/20).
    // This fixture proves the explicit host-relative kill bound; native 140/300 ms proof
    // stays in scripts/measure-transcript-budget.ts and the other hosted budget harnesses.
    const result = f.runFunctional(event, { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` }, HOST_DEADLINE_MS);
    const outerMs = performance.now() - started;
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(entered, "utf8")).toBe("entered"); // unconditional: the blocked append must actually be reached
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.wallMs).toBeLessThan(HOST_DEADLINE_MS + POST_DEADLINE_ALLOWANCE_MS);
    expect(outerMs).toBeLessThan(HOST_DEADLINE_MS + 1500); // retain the separate CLI-exit allowance
    expect(rssSourcesKnown(metric.rssSources!)).toBe(true);
    expect(metric.drainSkipped).toBe(1);
    expect(metric.drainStartMs).toBeGreaterThanOrEqual(0);
    expect(metric.drained).toBe(0);
    expect(metric.captureDrops).toBeUndefined();
    const until = performance.now() + 2000;
    const alive = () => Bun.spawnSync(["pgrep", "-f", worker]).stdout.toString().trim();
    while (alive() && performance.now() < until) await Bun.sleep(20);
    expect(alive()).toBe("");
    // A killed append cannot consume any of the original accepted backlog, including its claimed first record.
    const spool = join(f.base, "hook-spool"), retained = [spool, join(spool, ".capacity")].flatMap(folder => existsSync(folder) ? readdirSync(folder)
      .filter(name => name.startsWith("hook-")).map(name => JSON.parse(readFileSync(join(folder, name), "utf8"))) : []);
    for (let index = 0; index < 20; index++) expect(retained.filter(row => row.capture.excerpt === `pressure ${index}`)).toHaveLength(1);
  } finally { reportHookMetrics(f, "slow-drain:" + event); f.close(); }
});
