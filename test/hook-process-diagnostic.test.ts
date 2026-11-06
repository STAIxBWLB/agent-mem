import { expect, test } from "bun:test";
import { hookProcessDiagnostic } from "../scripts/hook-process-diagnostic.ts";
import type { HookLifecycleReceipt } from "./fakes/hooks-process-observer.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import { readMetrics } from "../src/memory/metrics.ts";

const row=(phase:HookLifecycleReceipt["phase"],atMs:number,extra:Partial<HookLifecycleReceipt>={}):HookLifecycleReceipt=>({phase,atMs,parentPid:10,childPid:20,kind:"worker",...extra});
function input(lifecycle:HookLifecycleReceipt[]){return{event:"Stop" as const,run:12,logicalRun:32,parentPid:10,expectedOwnedChildren:1,expectation:"fixture-contract" as const,
  workers:[{pid:20,kind:"worker" as const,detached:true,argv:["/private/canary-runtime","private row body"]}],evidence:[],lifecycle};}

test("a late worker exit and the actual failed reap are distinct receipts at the unchanged 10ms window",()=>{
  const diagnostic=hookProcessDiagnostic(input([row("spawn-attempt",100,{childPid:0}),row("spawn",101),row("kill-request",120),row("reap-start",121,{boundMs:10}),
    row("reap-end",132,{reaped:0}),row("output-end",132,{late:1}),row("exit",134)]));
  expect(diagnostic).toMatchObject({event:"Stop",run:12,logicalRun:32,expectedOwnedChildren:1,observedOwnedChildren:1,abandonedChildren:null,
    workerExitedWindow:{boundMs:10,startMs:21,observedBoundMs:10,present:true}});
  expect(diagnostic.children[0]).toMatchObject({pid:20,reaped:false,outputLate:true,exitPromiseMs:34,relativeToWorkerExitedWindowMs:{exitPromise:13,reapEnd:11}});
});
test("reaped exit with late output does not become an abandoned worker",()=>{
  const diagnostic=hookProcessDiagnostic(input([row("spawn-attempt",100,{childPid:0}),row("spawn",101),row("exit",120),row("reap-start",121,{boundMs:10}),row("reap-end",121,{reaped:1}),row("output-end",132,{late:1})]));
  expect(diagnostic.children[0]).toMatchObject({reaped:true,outputLate:true,relativeToWorkerExitedWindowMs:{exitPromise:-1}});
});
test("missing observer or metric receipts remain unknown, never fabricated exit or zero abandonment",()=>{
  const diagnostic=hookProcessDiagnostic(input([]));
  expect(diagnostic).toMatchObject({lifecyclePresent:false,abandonedChildren:null,rssSources:null,workerExitedWindow:{present:false,startMs:null}});
  expect(diagnostic.children[0]).toMatchObject({reaped:null,exitPromiseMs:null,receiptComplete:false});
});
test("native receipts share the parent's clock but do not invent a worker window",()=>{
  const diagnostic=hookProcessDiagnostic({...input([row("spawn-attempt",100,{childPid:0,kind:"native"}),row("spawn",101,{kind:"native"}),row("exit",120,{kind:"native"}),row("reap-end",122,{kind:"native",reaped:1})]),
    workers:[{pid:20,kind:"native",detached:true,argv:[]}],event:"SessionStart",expectedOwnedChildren:3});
  expect(diagnostic).toMatchObject({expectedOwnedChildren:3,observedOwnedChildren:1,workerExitedWindow:{present:false}});
  expect(diagnostic.children[0]).toMatchObject({kind:"native",reaped:true,relativeToWorkerExitedWindowMs:{exitPromise:null}});
});
test("failure metadata projects no argv, source body, path or unexpected properties",()=>{
  const value=input([row("spawn-attempt",100,{childPid:0}),row("spawn",101)]);
  Object.assign(value,{text:"PRIVATE_CANARY",path:"PRIVATE_CANARY"});Object.assign(value.workers[0]!,{text:"PRIVATE_CANARY"});Object.assign(value.lifecycle[0]!,{path:"PRIVATE_CANARY"});
  expect(JSON.stringify(hookProcessDiagnostic(value))).not.toMatch(/PRIVATE_CANARY|private\/canary|private row body/);
});
test("diagnostic overflow is explicit and bounded rather than silently claiming complete observation",()=>{
  const value=input([row("truncated",100,{childPid:0})]);
  value.workers=Array.from({length:129},(_,i)=>({pid:i+20,kind:"worker",detached:true,argv:[]}));
  const diagnostic=hookProcessDiagnostic(value);expect(diagnostic.truncated).toBe(true);expect(diagnostic.children).toHaveLength(128);expect(diagnostic.observedOwnedChildren).toBe(129);
});
test("the real preload records spawn, native and worker exit/reap receipts without changing hook assertions",async()=>{
  const f=hookFixture(),observer=hookProcessObserver(f.root);
  try{
    await f.seed();const result=f.runFunctional("Stop",{prompt:"numeric observer fixture"},{BUN_OPTIONS:`--preload=${observer.preload}`});
    expect(result.exitCode,result.stderr.toString()).toBe(0);
    const receipts=observer.lifecycle(result.pid),workers=observer.read();
    expect(workers.some(worker=>worker.kind==="worker")).toBe(true);expect(workers.some(worker=>worker.kind==="native")).toBe(true);
    for(const worker of workers){const events=receipts.filter(row=>row.childPid===worker.pid);expect(events.some(row=>row.phase==="spawn")).toBe(true);expect(events.some(row=>row.phase==="exit")).toBe(true);expect(events.some(row=>row.phase==="reap-end")).toBe(true);}
    expect(receipts.find(row=>row.phase==="reap-start"&&row.kind==="worker")?.boundMs).toBe(10);
    const diagnostic=hookProcessDiagnostic({event:"Stop",run:1,logicalRun:1,parentPid:result.pid,workers,evidence:observer.evidence(),lifecycle:receipts,
      expectedOwnedChildren:null,expectation:"observed-spawn-attempts",metric:readMetrics(f.base).filter(row=>row.kind==="hook").at(-1)});
    expect(diagnostic.children.every(child=>child.receiptComplete)).toBe(true);
  }finally{f.close();}
});
