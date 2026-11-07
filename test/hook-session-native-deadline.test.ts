import { expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import { sessionNativeDeadlineSource } from "./fakes/hooks-process-lifecycle.ts";
import { verifyHookProcessObservation } from "../scripts/hook-process-check.ts";

const hooks=resolve(import.meta.dir,"../src/hooks.ts"),native=resolve(import.meta.dir,"../src/hook-native.ts");
test("SessionStart's expired initial guard records its one decision sample after durable staging", () => {
  const f=hookFixture(),observer=hookProcessObserver(f.root,false,undefined,false,true),marker="session already expired";
  try {
    const code=`import {runHook} from ${JSON.stringify(hooks)};const output=await runHook('SessionStart',{cwd:${JSON.stringify(f.cwd)},prompt:${JSON.stringify(marker)}},{cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)},startedAt:performance.now()-1000});console.log(JSON.stringify(output));`;
    const result=Bun.spawnSync([process.execPath,"--preload",observer.preload,"-e",code],{cwd:f.cwd,env:f.env,stdout:"pipe",stderr:"pipe",timeout:3000});
    expect(result.exitCode,result.stderr.toString()).toBe(0);expect(JSON.parse(result.stdout.toString()).pending).toBe(true);
    const evidence=observer.evidence().filter(row=>row.pid===result.pid),workers=observer.read();
    const skips=evidence.filter(row=>row.phase==="session-native-deadline-skip");expect(skips).toHaveLength(1);expect(skips[0]!.remainingUs!).toBeLessThanOrEqual(0);
    expect(workers).toEqual([]);expect(evidence.filter(row=>row.phase==="attempt"||row.phase==="returned")).toEqual([]);
    const spool=join(f.base,"hook-spool"),rows=[spool,join(spool,".capacity")].flatMap(dir=>existsSync(dir)?readdirSync(dir).filter(name=>name.endsWith(".json")).map(name=>JSON.parse(readFileSync(join(dir,name),"utf8"))):[]);
    const pending=rows.some(row=>row.capture?.event==="SessionStart"&&row.capture?.excerpt===marker);
    expect(pending).toBe(true);expect(verifyHookProcessObservation("SessionStart",workers,evidence,pending)).toEqual({deferred:true});
  } finally {f.close();}
});

test("the initial guard uses one clock decision, and both exact source anchors fail closed on drift", () => {
  const source=readFileSync(hooks,"utf8"),transformed=sessionNativeDeadlineSource(source,"hooks");
  const start=transformed.indexOf("  const observedSessionRemaining = remaining();"),end=transformed.indexOf('\n  if (sessionSource',start);
  const code=transformed.slice(start,end);
  for (const first of [-0.001,0,0.001]) {
    let reads=0;const notes:number[]=[];
    const decision=new Function("remaining","result","pending","globalThis",code+';return "continue";');
    const result={dropped:false};
    const actual=decision(()=>{reads++;return first;},result,true,{__hookSessionNativeSkip:(remaining:number)=>notes.push(remaining)});
    expect(reads).toBe(1);expect(notes).toEqual(first<=0?[first]:[]);expect(actual).toBe(first<=0?result:"continue");
  }
  expect(transformed).toContain("__hookSessionNativeCallbacks.add(nativeRemaining)");
  expect(()=>sessionNativeDeadlineSource(source.replace("if (remaining() <= 0)","if (remaining() < 0)"),"hooks")).toThrow("anchor changed");
  expect(()=>sessionNativeDeadlineSource(readFileSync(native,"utf8").replace('remaining <= 1','remaining < 1'),"native")).toThrow("anchor changed");
});

test("the real native pre-spawn guard scopes and deduplicates finite SessionStart receipts without another clock read", () => {
  const f=hookFixture(),observer=hookProcessObserver(f.root,false,undefined,false,true);
  try {
    const code=`import {hookNative} from ${JSON.stringify(native)};
Bun.spawn=()=>{throw Error('positive-time-spawn-control');};
const results=[];
for(const [label,value,tagged,aborted,calls] of [['pair',1,true,false,2],['ordinary',0,false,false,1],['positive',1.001,true,false,1],['nonfinite',NaN,true,false,1],['abort',0,true,true,1],['negative',-1,true,false,1]]){
 let reads=0;const remaining=()=>{reads++;return value;};if(tagged)globalThis.__hookSessionNativeCallbacks.add(remaining);
 const signal=aborted?AbortSignal.abort():undefined;
 const outcomes=await Promise.allSettled(Array.from({length:calls},()=>hookNative(['unused'],{},remaining,{rssKB:0,rawRssKB:0},signal)));
 results.push({label,reads,messages:outcomes.map(row=>row.status==='rejected'?row.reason.message:'fulfilled')});
}
console.log(JSON.stringify(results));`;
    const result=Bun.spawnSync([process.execPath,"--preload",observer.preload,"-e",code],{cwd:f.cwd,env:f.env,stdout:"pipe",stderr:"pipe",timeout:3000});
    expect(result.exitCode,result.stderr.toString()).toBe(0);
    const rows=JSON.parse(result.stdout.toString());
    expect(rows.map((row:{reads:number})=>row.reads)).toEqual([2,1,1,1,0,1]);
    expect(rows[0].messages).toEqual(["native metadata deadline","native metadata deadline"]);expect(rows[2].messages).toEqual(["positive-time-spawn-control"]);
    expect(observer.read()).toEqual([]);
    expect(observer.evidence().filter(row=>row.phase==="session-native-deadline-skip").map(row=>row.remainingUs)).toEqual([1000,-1000]);
  } finally {f.close();}
});

test("SessionStart's ordinary native-positive path still has exact observed children", () => {
  const f=hookFixture(),observer=hookProcessObserver(f.root,false,undefined,true,true);
  try {
    const result=f.runFunctional("SessionStart",{prompt:"native-positive session"},{BUN_OPTIONS:`--preload=${observer.preload}`});
    expect(result.exitCode,result.stderr.toString()).toBe(0);
    const workers=observer.read(),evidence=observer.evidence().filter(row=>row.pid===result.pid);
    expect(workers.length).toBeGreaterThan(0);expect(workers.every(row=>row.kind==="native")).toBe(true);
    expect(evidence.filter(row=>row.phase==="session-native-deadline-skip")).toEqual([]);
    expect(verifyHookProcessObservation("SessionStart",workers,evidence,false)).toEqual({deferred:false});
  }finally{f.close();}
});
