import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOOK_REPLAY_MAX_BYTES, HOOK_REPLAY_MAX_FILES, stageHookCapture } from "../src/hook-spool.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { interleaveDiagnosticPreload, saveInterleaveDiagnostic } from "../scripts/diagnose-interleave.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

type Fixture = ReturnType<typeof hookFixture>;
interface ReplayRead { pid: number; bytes: number; event: string; excerpt: string }

async function backlog(f: Fixture, count: number): Promise<string[]> {
  const previous = process.env.HOME, at = Date.now() - 120_000, excerpts: string[] = [];
  process.env.HOME = f.env.HOME;
  try {
    for (let index = 0; index < count; index++) {
      const excerpt = `interleave backlog ${index}`, staged = await stageHookCapture("PostToolUse", { tool_name: "Read", tool_response: excerpt }, { cwd: f.cwd, base: f.base });
      expect(staged).toBeDefined(); excerpts.push(excerpt);
      // Replay is oldest-first by publication mtime. Pin it so same-tick writes and
      // random nonce order cannot turn this assertion into an unrelated flake.
      const file = join(f.base, "hook-spool", staged!.name), time = new Date(at + index);
      utimesSync(file, time, time);
    }
    return excerpts;
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}

function summaries(file: string): { recap: string; compact: string } {
  const recap = "interleaved current Recap", compact = "interleaved current Compact", at = new Date().toISOString();
  writeFileSync(file, [
    { type: "system", subtype: "away_summary", timestamp: at, content: recap },
    { type: "user", isCompactSummary: true, timestamp: at, message: { content: compact } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return { recap, compact };
}

/** Observe replay body inspections inside the owned worker only. This is functional
 * proof of the shared bound, not a native R2 timing measurement. */
function observeReplay(f: Fixture) {
  const phaseTrace = join(f.root, "scan-phases.jsonl");
  const preload = join(f.root, "observe-replay.ts"), trace = join(f.root, "replay-reads.jsonl"), worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  writeFileSync(trace, "");
  if (process.env.AMEM_INTERLEAVE_DIAGNOSTIC_DIR) writeFileSync(phaseTrace, "");
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
if(process.argv[1]===${JSON.stringify(worker)}){
${interleaveDiagnosticPreload(phaseTrace)}
 (globalThis as any).__replayRead=(bytes,event,excerpt)=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,bytes,event,excerpt})+'\\n');
 Bun.plugin({name:'shared-replay-read-bound',setup(builder){builder.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
  const source=readFileSync(path,'utf8'),anchor='      const record = decoded(claim);';
  if(source.split(anchor).length!==2)throw Error('replay body-read anchor changed');
  return {loader:'ts',contents:source.replace(anchor,anchor+'(globalThis as any).__replayRead(claim.initial.size,record?.value.capture?.event,record?.value.capture?.excerpt);')};
 });}});
}
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);
`);
  return { phaseTrace, env: { BUN_OPTIONS: `--preload=${preload}` }, clear: () => writeFileSync(trace, ""), reads: (): ReplayRead[] => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

function bounded(reads: ReplayRead[]): void {
  expect(reads.length).toBeGreaterThan(0);
  expect(new Set(reads.map(row => row.pid)).size).toBe(1);
  expect(reads.length).toBeLessThanOrEqual(32);
  expect(reads.reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(256 * 1024);
}
function pending(f: Fixture): { event: string; excerpt: string }[] {
  const dir = join(f.base, "hook-spool");
  return [dir, join(dir, ".capacity")].flatMap(folder => existsSync(folder) ? readdirSync(folder).filter(name => name.startsWith("hook-")).map(name => {
    const record = JSON.parse(readFileSync(join(folder, name), "utf8")) as { capture: { event: string; excerpt: string } }; return record.capture;
  }) : []);
}

for (const event of ["Stop", "SessionEnd"] as const) test("a final hook commits a 16+ backlog and its just-scanned Recap/Compact in the same replay budget: " + event, async () => {
  const f = hookFixture(), transcript = join(f.root, "interleave.jsonl"), observed = observeReplay(f), summary = summaries(transcript);
  try {
    await f.seed(); const accepted = await backlog(f, 20), current = "interleave current native";
    const result = f.runFunctional(event, { prompt: current, transcript_path: transcript }, observed.env);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const rows = f.rows(), selected = rows.filter(row => row.excerpt.startsWith("interleave backlog ") || row.excerpt === current || row.excerpt === summary.recap || row.excerpt === summary.compact);
    // This fails the old drain-first/deferred-scan path: staging a new summary
    // after the only drain is not sufficient to satisfy the freshness contract.
    expect(selected.map(row => row.excerpt)).toEqual([...accepted, current, summary.recap, summary.compact]);
    expect(new Set(selected.map(row => `${row.event}:${row.excerpt}`)).size).toBe(selected.length);
    expect(rows.filter(row => row.event === "Recap" && row.excerpt === summary.recap)).toHaveLength(1);
    expect(rows.filter(row => row.event === "Compact" && row.excerpt === summary.compact)).toHaveLength(1);
    expect(pending(f).filter(row => selected.some(saved => row.event === saved.event && row.excerpt === saved.excerpt))).toHaveLength(0);
    const reads = observed.reads(); bounded(reads);
    expect(reads.map(row => row.excerpt)).toEqual(selected.map(row => row.excerpt));
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.drained).toBe(selected.length); expect(metric.transcriptOffset).toBeGreaterThan(0); expect(metric.captureDrops).toBeUndefined();
  } finally {
    try { if (process.env.AMEM_INTERLEAVE_DIAGNOSTIC_DIR) saveInterleaveDiagnostic(f, event, transcript, observed.phaseTrace, observed.reads()); }
    finally { f.close(); }
  }
});

test("repeated publication callbacks share one 32-file replay allowance and resume all accepted backlog without duplicates", async () => {
  const f = hookFixture(), transcript = join(f.root, "shared-budget.jsonl"), observed = observeReplay(f), summary = summaries(transcript);
  try {
    await f.seed(); const accepted = await backlog(f, 40);
    const first = f.runFunctional("Stop", { prompt: "shared-budget first native", transcript_path: transcript }, observed.env);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const firstReads = observed.reads(); bounded(firstReads);
    expect(firstReads).toHaveLength(32);
    expect(firstReads.map(row => row.excerpt)).toEqual(accepted.slice(0, 32));
    const firstRows = f.rows(), held = pending(f);
    for (const excerpt of accepted) expect(firstRows.filter(row => row.excerpt === excerpt).length + held.filter(row => row.excerpt === excerpt).length).toBe(1);
    expect(readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!.drained).toBe(32);
    observed.clear();
    const next = f.runFunctional("Stop", { prompt: "shared-budget continuation native", transcript_path: transcript }, observed.env);
    expect(next.exitCode, next.stderr.toString()).toBe(0); bounded(observed.reads());
    const rows = f.rows();
    expect(rows.filter(row => row.excerpt.startsWith("interleave backlog ")).map(row => row.excerpt)).toEqual(accepted);
    for (const excerpt of [...accepted, summary.recap, summary.compact]) expect(rows.filter(row => row.excerpt === excerpt)).toHaveLength(1);
    expect(pending(f).filter(row => [...accepted, summary.recap, summary.compact].includes(row.excerpt))).toHaveLength(0);
    expect(readMetrics(f.base).some(row => row.captureDrops !== undefined)).toBe(false);
  } finally { f.close(); }
});

test("a second replay call cannot restart the shared byte allowance while file slots and pending records remain", async () => {
  const f = hookFixture(), probe = join(f.root, "shared-byte-budget.ts"), source = resolve(import.meta.dir, "../src/hook-spool.ts"), captureSource = resolve(import.meta.dir, "../src/memory/capture.ts");
  writeFileSync(probe, `import {existsSync,lstatSync,readFileSync,readdirSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
(globalThis as any).__byteReadSizes=[];
Bun.plugin({name:'shared-byte-budget-body-reads',setup(builder){builder.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='      const record = decoded(claim);';
 if(source.split(anchor).length!==2)throw Error('shared byte-budget read anchor changed');
 return {loader:'ts',contents:source.replace(anchor,anchor+'(globalThis as any).__byteReadSizes.push(claim.initial.size);')};
});}});
const {stageHookCapture,drainHookCaptures,hookReplayBudget,HOOK_REPLAY_MAX_BYTES}=await import(${JSON.stringify(source)});
const {CaptureStore}=await import(${JSON.stringify(captureSource)});
const cwd=${JSON.stringify(f.cwd)},base=${JSON.stringify(f.base)},project=${JSON.stringify(f.project)},options={cwd,base,project,timeRemaining:()=>60_000};
const at=Date.now()-120_000,sizes=[];
for(let index=0;index<30;index++){
 const paths=Array.from({length:32},(_,pathIndex)=>'src/public-'+pathIndex+'-'+ 'p'.repeat(380));
 const staged=await stageHookCapture('PostToolUse',{tool_name:'Read',tool_input:{paths},tool_response:'byte-budget-record-'+index+' '+ 'x'.repeat(1900)},{cwd,base});
 if(!staged)throw Error('large real hook record was not staged');
 const file=join(base,'hook-spool',staged.name);sizes.push(lstatSync(file).size);utimesSync(file,new Date(at+index),new Date(at+index));
}
const pending=()=>[join(base,'hook-spool'),join(base,'hook-spool','.capacity')].reduce((count,folder)=>count+(existsSync(folder)?readdirSync(folder).filter(name=>name.startsWith('hook-')).length:0),0);
const readSizes=()=>((globalThis as any).__byteReadSizes as number[]),sum=(values:number[])=>values.reduce((a,b)=>a+b,0);
(globalThis as any).__byteReadSizes=[];
const store=new CaptureStore({memoryDir:base,project}),shared=hookReplayBudget();
try{
 const append=(input,receipt)=>store.append(input,{receipt});
 const first=await drainHookCaptures({...options,replayBudget:shared},append);
 const firstReadFiles=readSizes().length,firstReadBytes=sum(readSizes());
 const firstReport={captured:first.captured.length,readFiles:firstReadFiles,readBytes:firstReadBytes,budgetFiles:shared.files,budgetBytes:shared.bytes,pending:pending(),nextBytes:sizes[first.captured.length]??null};
 const second=await drainHookCaptures({...options,replayBudget:shared},append);
 const secondReport={captured:second.captured.length,extraReadFiles:readSizes().length-firstReadFiles,extraReadBytes:sum(readSizes())-firstReadBytes,budgetFiles:shared.files,budgetBytes:shared.bytes,pending:pending()};
 const later=await drainHookCaptures({...options,replayBudget:hookReplayBudget()},append);
 const laterReport={captured:later.captured.length,readFiles:readSizes().length-firstReadFiles,readBytes:sum(readSizes())-firstReadBytes,pending:pending()};
 const again=await drainHookCaptures({...options,replayBudget:hookReplayBudget()},append);
 const ids=store.rows().flatMap(row=>{const match=/^byte-budget-record-(\\d+) /.exec(row.excerpt);return match?[Number(match[1])]:[];});
 console.log(JSON.stringify({first:firstReport,second:secondReport,later:laterReport,again:again.captured.length,ids,maxBytes:HOOK_REPLAY_MAX_BYTES}));
}finally{store.close();}
`);
  try {
    await f.seed();
    const result = Bun.spawnSync([process.execPath, "--smol", probe], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = JSON.parse(result.stdout.toString()) as {
      first: { captured: number; readFiles: number; readBytes: number; budgetFiles: number; budgetBytes: number; pending: number; nextBytes: number };
      second: { captured: number; extraReadFiles: number; extraReadBytes: number; budgetFiles: number; budgetBytes: number; pending: number };
      later: { captured: number; readFiles: number; readBytes: number; pending: number }; again: number; ids: number[]; maxBytes: number;
    };
    expect(report.maxBytes).toBe(HOOK_REPLAY_MAX_BYTES);
    expect(report.first.captured).toBeGreaterThan(0); expect(report.first.captured).toBeLessThan(30);
    expect(report.first.readFiles).toBe(report.first.captured); expect(report.first.readFiles).toBeLessThan(HOOK_REPLAY_MAX_FILES);
    expect(report.first.budgetFiles).toBeGreaterThan(0); expect(report.first.pending).toBeGreaterThan(0);
    expect(report.first.readBytes).toBeLessThanOrEqual(HOOK_REPLAY_MAX_BYTES);
    expect(report.first.readBytes + report.first.nextBytes).toBeGreaterThan(HOOK_REPLAY_MAX_BYTES); // the byte ceiling actually bound this pass
    expect(report.first.budgetBytes).toBe(HOOK_REPLAY_MAX_BYTES - report.first.readBytes);
    expect(report.second).toEqual({ captured: 0, extraReadFiles: 0, extraReadBytes: 0, budgetFiles: report.first.budgetFiles,
      budgetBytes: report.first.budgetBytes, pending: report.first.pending });
    expect(report.later.readFiles).toBe(report.later.captured); expect(report.later.readBytes).toBeLessThanOrEqual(HOOK_REPLAY_MAX_BYTES);
    expect(report.first.captured + report.later.captured).toBe(30); expect(report.later.pending).toBe(0); expect(report.again).toBe(0);
    expect(report.ids).toEqual(Array.from({ length: 30 }, (_,index) => index)); // actual store rows, oldest-first and exactly once
    expect(readMetrics(f.base).some(row => row.captureDrops !== undefined)).toBe(false);
  } finally { f.close(); }
});

test("publication callbacks stage both summaries before the worker waits for the parent's delayed native receipt", async () => {
  const f = hookFixture(), transcript = join(f.root, "receipt-barrier.jsonl"), preload = join(f.root, "receipt-barrier.ts"), barrier = join(f.root, "receipt-barrier-result.json"), summary = summaries(transcript);
  // A native receipt is withheld until BOTH publications exist. Awaiting that
  // receipt from the first publication callback deadlocks the second one. The
  // failed-barrier receipt makes the regression fail even if intake resumes later.
  writeFileSync(preload, `import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const base=${JSON.stringify(f.base)},cwd=${JSON.stringify(f.cwd)},home=${JSON.stringify(f.env.HOME)},barrier=${JSON.stringify(barrier)};
if(process.env.HOME!==home)throw Error('receipt barrier requires its fixture HOME');
(globalThis as any).__waitForSummaryPair=async(timeRemaining)=>{
 const started=performance.now(),until=started+Math.min(750,Math.max(0,timeRemaining()-200));
 let events=[];
 do{
  const found=new Set();
  for(const folder of [join(base,'hook-spool'),join(base,'hook-spool','.capacity')]){
   if(!existsSync(folder))continue;
   for(const name of readdirSync(folder).filter(name=>name.startsWith('hook-v3-'))){
    try{
     const row=JSON.parse(readFileSync(join(folder,name),'utf8'));
     if(row.cwd===cwd&&((row.capture?.event==='Recap'&&row.capture.excerpt===${JSON.stringify(summary.recap)})||(row.capture?.event==='Compact'&&row.capture.excerpt===${JSON.stringify(summary.compact)})))found.add(row.capture.event);
    }catch{/* A concurrent publication is observed on the next bounded poll. */}
   }
  }
  events=[...found].sort();
  if(found.has('Recap')&&found.has('Compact')){writeFileSync(barrier,JSON.stringify({ready:true,events,parentPid:process.pid,waitMs:performance.now()-started}));return;}
  if(performance.now()>=until)break;
  await Bun.sleep(5);
 }while(performance.now()<until);
 writeFileSync(barrier,JSON.stringify({ready:false,events,parentPid:process.pid,waitMs:performance.now()-started}));
 throw Error('both summaries must be staged before the native receipt is released');
};
Bun.plugin({name:'parent-receipt-after-summary-pair',setup(builder){builder.onLoad({filter:/[/]hook-project\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='options.onResolved?.(prepared.receipt(result)); return result;';
 if(source.split(anchor).length!==2)throw Error('native receipt barrier anchor changed');
 return {loader:'ts',contents:source.replace(anchor,'await (globalThis as any).__waitForSummaryPair(options.timeRemaining); '+anchor)};
});}});
`);
  try {
    await f.seed();
    const result = f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` }, 1000);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(barrier), "the parent native resolver reached the receipt barrier").toBe(true);
    const released = JSON.parse(readFileSync(barrier, "utf8")) as { ready: boolean; events: string[]; parentPid: number };
    expect(released.ready, "both publications must precede release of the parent receipt").toBe(true);
    expect(released.events).toEqual(["Compact", "Recap"]); expect(released.parentPid).toBe(result.pid);
    const rows = f.rows();
    expect(rows.filter(row => row.event === "Recap" && row.excerpt === summary.recap)).toHaveLength(1);
    expect(rows.filter(row => row.event === "Compact" && row.excerpt === summary.compact)).toHaveLength(1);
    expect(pending(f).filter(row => row.excerpt === summary.recap || row.excerpt === summary.compact)).toHaveLength(0);
  } finally { f.close(); }
});

for (const existing of [false, true]) test("an unavailable worker scope silently leaves publications and cursor untouched: " + (existing ? "existing cursor" : "new cursor"), async () => {
  const f = hookFixture(), transcript = join(f.root, "scope-unavailable.jsonl"), preload = join(f.root, "scope-unavailable.ts");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts"), scopeSeen = join(f.root, "scope-seen"), scanImported = join(f.root, "scan-imported");
  const summary = { recap: "scope retry Recap", compact: "scope retry Compact" }, at = new Date().toISOString();
  writeFileSync(transcript, "");
  const cursor = () => {
    const dir = join(f.base, "hook-transcripts"), file = existsSync(dir) ? readdirSync(dir).find(name => name.endsWith(".db")) : undefined;
    if (!file) return undefined;
    const db = new Database(join(dir, file), { readonly: true });
    try { return db.query("SELECT * FROM cursor").get(); } finally { db.close(); }
  };
  // Only the owned worker loses scope. Native admission remains valid, as it can
  // when identity becomes unavailable between parent admission and worker scan.
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
if(process.argv[1]===${JSON.stringify(worker)})Bun.plugin({name:'unavailable-worker-scope',setup(builder){
 builder.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
  const source=readFileSync(path,'utf8'),anchor='  return captureScope(cwd, base, cacheValidity, extraGitConfig, false);';
  if(source.split(anchor).length!==2)throw Error('scope refusal anchor changed');
  return {loader:'ts',contents:source.replace(anchor,${JSON.stringify("writeFileSync(" + JSON.stringify(scopeSeen) + ", 'entered'); return undefined;")})};
 });
 builder.onLoad({filter:/[/]hook-transcript\\.ts$/},({path})=>{
  writeFileSync(${JSON.stringify(scanImported)},'imported');return {loader:'ts',contents:readFileSync(path,'utf8')};
 });
}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);
`);
  try {
    await f.seed();
    if (existing) {
      appendFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "prior valid title", timestamp: at }) + "\n");
      expect(f.runFunctional("Stop", { transcript_path: transcript }).exitCode).toBe(0);
      expect(cursor()).toBeDefined();
    }
    const before = cursor();
    appendFileSync(transcript, [
      { type: "system", subtype: "away_summary", timestamp: at, content: summary.recap },
      { type: "user", isCompactSummary: true, timestamp: at, message: { content: summary.compact } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const blocked = f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(blocked.exitCode, blocked.stderr.toString()).toBe(0); expect(blocked.stdout.length).toBe(0);
    expect(existsSync(scopeSeen), "the owned worker reached the unavailable scope").toBe(true);
    expect(existsSync(scanImported), "scope refusal happens before the scan import").toBe(false);
    expect(cursor()).toEqual(before);
    expect(pending(f).filter(row => row.event === "Recap" || row.event === "Compact")).toHaveLength(0);
    expect(f.rows().filter(row => row.excerpt === summary.recap || row.excerpt === summary.compact)).toHaveLength(0);
    expect(f.runFunctional("Stop", { transcript_path: transcript }).exitCode).toBe(0);
    const rows = f.rows();
    expect(rows.filter(row => row.event === "Recap" && row.excerpt === summary.recap)).toHaveLength(1);
    expect(rows.filter(row => row.event === "Compact" && row.excerpt === summary.compact)).toHaveLength(1);
  } finally { f.close(); }
});
