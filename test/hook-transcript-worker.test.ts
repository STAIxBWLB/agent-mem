import { expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { rssSourcesKnown } from "../src/hook-resources.ts";

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
  } finally { f.close(); }
});

test("a final hook reaps blocked directly owned metadata before writing known RSS", async () => {
  const { hookTimeoutProbe } = await import("./fakes/hooks-timeout-probe.ts");
  const f = hookFixture();
  try { await f.seed(); const result = await hookTimeoutProbe(f, "Stop", true); expect(result.remainingProcesses).toBe(0); }
  finally { f.close(); }
});

for (const platform of ["linux", "darwin-codepath"] as const) for (const event of ["Stop", "SessionEnd"] as const) test("a slow synchronous capture statement remains killable with known child provenance: " + platform + " " + event, async () => {
  const f = hookFixture(), preload = join(f.root, "slow-store.ts"), entered = join(f.root, "slow-store-entered"), transcript = join(f.root, "slow-transcript.jsonl");
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
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);`);
  try {
    await f.seed();
    const result = f.runFunctional(event, { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(readFileSync(entered, "utf8")).toBe("entered");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.wallMs).toBeLessThan(2000); expect(rssSourcesKnown(metric.rssSources!)).toBe(true); expect(metric.rssSources!.unavailable).toBe(0);
    if (platform === "darwin-codepath") expect(metric.rssSources!.platformRusage).toBe(4);
    // Linux rusage under the emulated Darwin path includes launcher peaks: source proof only, never an R2 pass.
    expect(f.runFunctional("PostToolUse", { prompt: "slow-store recovery" }).exitCode).toBe(0);
    expect(f.rows().filter(row => row.excerpt === "summary before slow store")).toHaveLength(1);
  } finally { f.close(); }
});

for (const event of ["Stop", "SessionEnd"] as const) test("the next SessionStart sees the previous final summary: " + event, async () => {
  const f = hookFixture(), transcript = join(f.root, "fresh-summary.jsonl");
  try {
    await f.seed();
    for (let session = 0; session < 3; session++) {
      const marker = "fresh " + event + " " + session, at = new Date(Date.now() + session * 1000).toISOString();
      writeFileSync(transcript, [ { type: "system", subtype: "away_summary", timestamp: at, content: marker + " recap" },
        { type: "user", isCompactSummary: true, timestamp: at, message: { content: marker + " compact" } } ].map(row => JSON.stringify(row)).join("\n") + "\n");
      expect(f.runFunctional(event, { session_id: "previous-" + session, transcript_path: transcript }).exitCode).toBe(0);
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
  } finally { f.close(); }
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
    // The real executable and its unchanged 140 ms handler: the worker is killed at its deadline, not after the 3 s block.
    const result = f.run(event, { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    const outerMs = performance.now() - started;
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(readFileSync(entered, "utf8")).toBe("entered");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.wallMs).toBeLessThan(300);
    expect(outerMs).toBeLessThan(1500); // the CLI process itself exits; the escaped 3 s descendant does not hold it
    expect(metric.transcriptStopReason).toBe("deadline");
    expect(metric.transcriptOffset).toBeUndefined();
    expect(metric.drainSkipped).toBe(1);
    expect(metric.captureDrops).toBeUndefined(); // a skipped drain is not a capture drop (ruling b)
  } finally { f.close(); }
});

async function stagePressure(f: ReturnType<typeof hookFixture>, count: number) {
  const { stageHookCapture } = await import("../src/hook-spool.ts");
  const previous = process.env.HOME; process.env.HOME = f.env.HOME;
  try { for (let index = 0; index < count; index++) await stageHookCapture("PostToolUse", { session_id: "pressure", tool_name: "Read", tool_response: `pressure ${index}` }, { cwd: f.cwd, base: f.base }); }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}

for (const event of ["Stop", "SessionEnd"] as const) test("#226 (#231 macOS livelock): with 16+ pending records the worker drains before it scans and reports the drain: " + event, async () => {
  const f = hookFixture(), transcript = join(f.root, "pressure.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "pressure title", timestamp: new Date().toISOString() }) + "\n");
  try {
    await f.seed(); await stagePressure(f, 20);
    const result = f.runFunctional(event, { transcript_path: transcript });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.drained).toBeGreaterThan(0);                    // the drain ran and committed records
    expect(metric.drainStartMs).toBeGreaterThanOrEqual(0);
    expect(f.rows().filter(row => row.excerpt.includes("pressure ")).length).toBeGreaterThan(0);
    // The deferred scan still runs with what is left (the functional 2 s budget leaves plenty): its title becomes durable.
    expect(metric.transcriptOffset).toBeGreaterThan(0);
  } finally { f.close(); }
});

test("#226 (#231 macOS livelock): below 16 pending the order stays scan-then-drain", async () => {
  // Observed through the worker: the scan phase is recorded before the drain frame when the spool is small.
  const f = hookFixture(), phases = join(f.root, "order.jsonl"), preload = join(f.root, "order.ts"), transcript = join(f.root, "order.jsonl.t");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "order title", timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(phases, "");
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
globalThis.__order=(phase)=>appendFileSync(${JSON.stringify(phases)},phase+'\\n');
Bun.plugin({name:'order',setup(b){
b.onLoad({filter:/[/]hook-transcript\\.ts$/},({path})=>{const s=readFileSync(path,'utf8'),a='  const value = object(input);';if(s.split(a).length!==2)throw Error('scan anchor changed');return{loader:'ts',contents:s.replace(a,"  (globalThis as any).__order('scan');"+a)};});
b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{const s=readFileSync(path,'utf8'),a='  let remaining = DRAIN_BYTES, blocked = 0;';if(s.split(a).length!==2)throw Error('drain anchor changed');return{loader:'ts',contents:s.replace(a,"  (globalThis as any).__order('drain');"+a)};});
}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);`);
  try {
    await f.seed(); await stagePressure(f, 3);
    expect(f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` }).exitCode).toBe(0);
    const small = readFileSync(phases, "utf8").trim().split("\n");
    expect(small.indexOf("scan")).toBeGreaterThanOrEqual(0); expect(small.indexOf("scan")).toBeLessThan(small.indexOf("drain"));
    writeFileSync(phases, ""); await stagePressure(f, 20);
    expect(f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` }).exitCode).toBe(0);
    const pressured = readFileSync(phases, "utf8").trim().split("\n");
    expect(pressured.indexOf("drain")).toBeGreaterThanOrEqual(0); expect(pressured.indexOf("drain")).toBeLessThan(pressured.indexOf("scan"));
  } finally { f.close(); }
});

for (const event of ["Stop", "SessionEnd"] as const) test("#226 (#231): the kill bound holds on the drain-first path with a slow drain: " + event, async () => {
  // Drain-first was rejected before because a blocked first drain starved the scan: the worker was never killed in time and
  // the summary was lost. Here the drain is blocked on purpose (a 3 s synchronous capture append) with 20+ records pending:
  // the real 140 ms hook must still return inside 300 ms, count the skip and what it drained, and leave nothing alive after
  // the 2 s post-exit window. The summary is not lost: the scan only reads; its staged rows stay pending for the next hook.
  const f = hookFixture(), preload = join(f.root, "slow-drain.ts"), entered = join(f.root, "slow-drain-entered"), transcript = join(f.root, "slow-drain.jsonl");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "slow drain title", timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
globalThis.__slowAppend=()=>{writeFileSync(${JSON.stringify(entered)},'entered');const until=performance.now()+3000;while(performance.now()<until){}};
Bun.plugin({name:'slow-drain',setup(b){b.onLoad({filter:/[/]memory[/]capture\\.ts$/},({path})=>{
 const s=readFileSync(path,'utf8'),a='  append(input: CaptureInput, options: CaptureAppendOptions = {}): CaptureAppend {';
 if(s.split(a).length!==2)throw Error('slow append anchor changed');
 return {loader:'ts',contents:s.replace(a,a+'(globalThis as any).__slowAppend();')};
});}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);`);
  try {
    await f.seed(); await stagePressure(f, 20);
    const started = performance.now();
    const result = f.run(event, { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    const outerMs = performance.now() - started;
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(readFileSync(entered, "utf8")).toBe("entered");
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.wallMs).toBeLessThan(300);
    expect(outerMs).toBeLessThan(1500);
    expect(metric.drainSkipped).toBe(1);
    expect(metric.drainStartMs).toBeGreaterThanOrEqual(0);
    expect(metric.drained).toBe(0);                               // killed inside its first append: nothing committed, nothing lost
    expect(metric.captureDrops).toBeUndefined();
    // R1: nothing of this hook is alive after the 2 s post-exit window.
    const until = performance.now() + 2000;
    const alive = () => Bun.spawnSync(["pgrep", "-f", worker]).stdout.toString().trim();
    while (alive() && performance.now() < until) await Bun.sleep(20);
    expect(alive()).toBe("");
    // No loss: every staged record is still durable (pending) for the next hook.
    expect(readdirSync(join(f.base, "hook-spool")).filter(name => name.startsWith("hook-")).length).toBeGreaterThanOrEqual(20);
  } finally { f.close(); }
});
