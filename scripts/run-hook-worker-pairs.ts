/** Approved finite, counterbalanced C/P experiment. No product source or budget changes. */
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { attributedWorkerMisses } from "./run-hook-worker-attribution.ts";
import { createPairMetrics, type PairArm, type ProbeWindow } from "./hook-pair-metrics.ts";

const ORDER:readonly(readonly PairArm[])[]=[["C","P"],["P","C"],["P","C"],["C","P"]];
const PRIOR={run:42310662035,authorHead:"f99df9db79e89ff6d6143c4d6657f75aba3320ce",checkout:"8d4482a6e1f458f3fd3faf3cc9f01bab5c98e801",parentPid:1435,childPid:1436,phase:"StoreClose"};
const obj=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);

async function logged(root:string,folder:string,args:string[],arm:PairArm|undefined,onRecord:(row:unknown)=>void){
  mkdirSync(folder,{mode:0o700});
  const startedAtMs=performance.timeOrigin+performance.now();
  const child=Bun.spawn([process.execPath,...args],{cwd:root,env:{...process.env,NO_COLOR:"1",AMEM_TEST_WORKER_PHASES:arm==="P"?"1":"0",
    AMEM_TEST_PHASE_ARTIFACTS:arm?join(folder,"receipts"):""},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  let parserIncomplete=0,ownershipUncertain=false;
  const drain=async(stream:ReadableStream<Uint8Array>,name:string)=>{
    const fd=openSync(join(folder,name),"wx",0o600),reader=stream.getReader(),decoder=new TextDecoder();let pending="",overflow=false;
    const line=(text:string)=>{
      if(/error: R1 .*?(?:surviv|retained|unavailable|identity)/i.test(text))ownershipUncertain=true;
      if(!/^\{"diagnostic":"(?:hook-child-reap\/v1|budget-attempt|hook-reap-probe-(?:start|sample|summary)\/v1)"/.test(text))return;
      try{onRecord(JSON.parse(text));}catch{parserIncomplete++;}
    };
    try{for(;;){const part=await reader.read();if(part.done)break;writeFileSync(fd,part.value);
      const pieces=decoder.decode(part.value,{stream:true}).split("\n");
      for(let index=0;index<pieces.length;index++){
        if(!overflow){pending+=pieces[index]!;if(pending.length>512*1024){parserIncomplete++;pending="";overflow=true;}}
        if(index<pieces.length-1){if(!overflow)line(pending);pending="";overflow=false;}
      }
    }const tail=decoder.decode();if(!overflow&&(pending||tail))line(pending+tail);
    }finally{reader.releaseLock();closeSync(fd);}
  };
  await Promise.all([drain(child.stdout,"stdout.log"),drain(child.stderr,"stderr.log")]);
  const exit=await child.exited;
  return{exit,signal:child.signalCode??null,startedAtMs,finishedAtMs:performance.timeOrigin+performance.now(),parserIncomplete,ownershipUncertain};
}

export async function runHookWorkerPairs(directory:string){
  const root=resolve(import.meta.dir,".."),out=resolve(directory);mkdirSync(out,{recursive:true,mode:0o700});
  if(process.env.BUN_OPTIONS?.trim()||process.env.NODE_OPTIONS?.trim())throw Error("Pair runner has inherited runtime preloads; clear the CI preload before collecting a frozen control");
  const git=(...args:string[])=>{const result=Bun.spawnSync(["git",...args],{cwd:root,stdout:"pipe",stderr:"pipe"});
    if(result.exitCode!==0)throw Error("Pair checkout identity is unavailable; restore the full-history committed checkout before collecting");return result.stdout.toString().trim();};
  for(const path of ["src","bin"])if(git("rev-parse",`HEAD:${path}`)!==git("rev-parse",`${PRIOR.authorHead}:${path}`))
    throw Error("Frozen product source differs from the approved attribution tree; obtain a new protocol review before collecting");
  const manifest={diagnostic:"hook-worker-pairs/v1",head:git("rev-parse","HEAD"),sourceTree:git("rev-parse","HEAD:src"),platform:process.platform,bun:Bun.version,
    priorMiss:PRIOR,order:ORDER,maxPairs:4,targetCumulativePMisses:3,load:{script:"scripts/probe-hook-reap.ts",phase:"cpu",samples:200},
    control:"stage1 parent-only; ordinary worker argv/env; no worker phase preload or parent timer proxy",phaseArm:"current full worker phases and parent timers",
    closeInControl:{available:false,reason:"No worker phase preload in C"},admissionMs:24*60_000,outerWorkflowTimeoutMinutes:30};
  writeFileSync(join(out,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify(manifest));
  const results:{pair:number;arm:PairArm;workload:string;work:Awaited<ReturnType<typeof logged>>;load:Awaited<ReturnType<typeof logged>>;
    loadComplete:boolean;metrics:ReturnType<ReturnType<typeof createPairMetrics>["summarize"]>;newPMisses:ReturnType<typeof attributedWorkerMisses>}[]=[];
  const started=performance.now();let completedPairs=0,stopReason="collecting",unsafe=false;
  const newPMisses=()=>results.flatMap(row=>row.arm==="P"?row.newPMisses.map(miss=>({...miss,pair:row.pair,workload:row.workload})):[]);
  const save=()=>{const misses=newPMisses();const report={...manifest,results,completedPairs,newPMisses:misses,cumulativePMisses:1+misses.length,
    targetMet:1+misses.length>=3,stopReason,unsafe,originalScriptsPassed:results.length>0&&results.every(row=>row.work.exit===0),wallMs:performance.now()-started};
    writeFileSync(join(out,"summary.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});return report;};
  schedule:for(let index=0;index<ORDER.length;index++){
    if(performance.now()-started>=manifest.admissionMs){stopReason="admission bound reached before a new pair";break;}
    const pair=index+1;
    for(const arm of ORDER[index]!){
      for(const workload of ["hooks","baseline"]){
        const folder=join(out,`pair-${pair}-${arm}-${workload}`);mkdirSync(folder,{mode:0o700});
        const metrics=createPairMetrics(arm),found=new Map<string,ReturnType<typeof attributedWorkerMisses>[number]>();
        let epoch:number|undefined,loadSummary:Record<string,unknown>|undefined;const windows:ProbeWindow[]=[];let loadInvalid=0;
        const observeLoad=(input:unknown)=>{const row=obj(input);if(!row)return;
          if(row.diagnostic==="hook-reap-probe-start/v1"){
            if(row.phase!=="cpu"||row.series!=="contended"||row.count!==200||!finite(row.epochStartedMs)){loadInvalid++;return;}epoch=row.epochStartedMs;
          }else if(row.diagnostic==="hook-reap-probe-sample/v1"){
            if(epoch===undefined||row.phase!=="cpu"||row.accepted!==true||row.reaped!==true||!finite(row.spawnMs)||!finite(row.exitMs)){loadInvalid++;return;}
            windows.push({startMs:epoch+row.spawnMs,endMs:epoch+row.exitMs});
          }else if(row.diagnostic==="hook-reap-probe-summary/v1")loadSummary=row;
        };
        const args=workload==="hooks"?["scripts/measure-hooks-budget.ts"]:["scripts/measure-hook-baseline.ts","--root",root];
        args.push(arm==="C"?"--parent-diagnostics":"--phase-diagnostics");
        // Same finite load for both arms. Await both even if a strict workload ends early.
        const workPromise=logged(root,join(folder,"workload"),args,arm,row=>{metrics.add(row);
          if(arm==="P")for(const miss of attributedWorkerMisses([row]))found.set(`${miss.parentPid}:${miss.childPid}`,miss);});
        const loadPromise=logged(root,join(folder,"load"),["scripts/probe-hook-reap.ts","--phase=cpu","--series=contended"],undefined,observeLoad);
        const [work,load]=await Promise.all([workPromise,loadPromise]);
        const loadComplete=load.exit===0&&load.parserIncomplete===0&&loadInvalid===0&&windows.length===200&&loadSummary?.complete===true&&loadSummary.samples===200;
        const result={pair,arm,workload,work,load,loadComplete,metrics:metrics.summarize(windows),newPMisses:[...found.values()]};
        results.push(result);save();console.log(JSON.stringify({diagnostic:"hook-worker-pair-workload/v1",pair,arm,workload,work,load,loadComplete,
          metadataInvalid:result.metrics.metadataInvalid,exposure:result.metrics.all,overlap:result.metrics.overlapSummary,newPMisses:result.newPMisses}));
        if(work.ownershipUncertain||work.signal||load.signal||!loadComplete||result.metrics.metadataInvalid||work.parserIncomplete){
          unsafe=true;stopReason="ownership, frozen-mode or evidence-completeness guard";break schedule;
        }
      }
    }
    completedPairs++;save();
    if(1+newPMisses().length>=manifest.targetCumulativePMisses){stopReason="target reached after complete pair";break;}
  }
  if(stopReason==="collecting")stopReason=completedPairs===ORDER.length?"four-pair cap reached":"schedule incomplete";
  const report=save();console.log(JSON.stringify({diagnostic:"hook-worker-pairs-result/v1",head:manifest.head,completedPairs,cumulativePMisses:report.cumulativePMisses,
    targetMet:report.targetMet,stopReason,unsafe,originalScriptsPassed:report.originalScriptsPassed}));
  if(!report.targetMet||unsafe||!report.originalScriptsPassed){
    console.error("C/P batch has insufficient attribution or a strict workload/guard failure; retain every arm and review the complete evidence before another batch");process.exitCode=1;
  }
}

if(import.meta.main){
  if(process.argv.length!==3||!process.argv[2])throw Error("Pair output directory is missing; pass one fresh CI artifact directory");
  if(process.platform!=="darwin"||process.env.GITHUB_ACTIONS!=="true"||process.env.RUNNER_OS!=="macOS")
    throw Error("C/P collection requires the hosted macOS runner; run the dedicated workflow, not a heavy local Mac experiment");
  await runHookWorkerPairs(process.argv[2]);
}
