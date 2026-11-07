/** Task158: nonshipping, longer-window profiling. Never changes a native hook limit or declares native acceptance. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { completionFit, feasibilityObservation, type FitInterval } from "./hook-feasibility-fit.ts";
import type { FeasibilityState } from "../test/fakes/worker-feasibility-recovery.ts";

const obj=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const ORDER=[["light","detailed"],["detailed","light"],["detailed","light"],["light","detailed"]] as const;

async function logged(root:string,args:string[],stdoutFile:string,stderrFile:string,onRecord:(row:unknown)=>void){
  const startedAtMs=performance.timeOrigin+performance.now();
  const child=Bun.spawn([process.execPath,...args],{cwd:root,env:{...process.env,NO_COLOR:"1"},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  let malformed=0;
  const drain=async(stream:ReadableStream<Uint8Array>,file:string)=>{
    const fd=openSync(file,"wx",0o600),reader=stream.getReader(),decoder=new TextDecoder();let pending="",overflow=false;
    const line=(text:string)=>{if(!text.startsWith('{"diagnostic":'))return;try{onRecord(JSON.parse(text));}catch{malformed++;}};
    try{for(;;){const part=await reader.read();if(part.done)break;writeFileSync(fd,part.value);
      const pieces=decoder.decode(part.value,{stream:true}).split("\n");
      for(let index=0;index<pieces.length;index++){
        if(!overflow){pending+=pieces[index]!;if(pending.length>512*1024){malformed++;pending="";overflow=true;}}
        if(index<pieces.length-1){if(!overflow)line(pending);pending="";overflow=false;}
      }
    }const tail=decoder.decode();if(!overflow&&(pending||tail))line(pending+tail);
    }finally{reader.releaseLock();closeSync(fd);}
  };
  await Promise.all([drain(child.stdout,stdoutFile),drain(child.stderr,stderrFile)]);
  const exit=await child.exited;
  return{pid:child.pid,exit,signal:child.signalCode??null,malformed,startedAtMs,finishedAtMs:performance.timeOrigin+performance.now()};
}

export async function runWorkerFeasibility(out:string,state:FeasibilityState,event:"PostToolUse"|"Stop",smoke=false){
  const root=resolve(import.meta.dir,".."),directory=resolve(out);mkdirSync(directory,{recursive:true,mode:0o700});
  if(process.env.BUN_OPTIONS?.trim()||process.env.NODE_OPTIONS?.trim())throw Error("Feasibility runner has inherited preloads; clear CI runtime preloads before profiling");
  const git=(...args:string[])=>{const value=Bun.spawnSync(["git",...args],{cwd:root,stdout:"pipe",stderr:"pipe"});
    if(value.exitCode!==0)throw Error("Profiling checkout identity is unavailable; restore the full-history committed checkout");return value.stdout.toString().trim();};
  const prior="f99df9db79e89ff6d6143c4d6657f75aba3320ce";
  for(const name of ["src","bin"])if(git("rev-parse",`HEAD:${name}`)!==git("rev-parse",`${prior}:${name}`))throw Error("Frozen product tree changed; review the profiling protocol before collecting");
  const manifest={diagnostic:"worker-feasibility-cohort/v1",head:git("rev-parse","HEAD"),sourceTree:git("rev-parse","HEAD:src"),state,event,
    platform:process.platform,bun:Bun.version,runner:{cpuModel:cpus()[0]?.model??"unknown",nproc:cpus().length,totalMemMB:Math.round(totalmem()/1048576),
      image:process.env.ImageOS&&process.env.ImageVersion?`${process.env.ImageOS} ${process.env.ImageVersion}`:null},
    profilingWindowMs:1000,profilingWorkerEndMs:972,nativeRequestedWorkEndMs:115,nativeActualWorkEndMs:112,
    nativeAcceptance:false,smoke,samplesPerMode:smoke?2:200,samplesPerBlock:smoke?2:50,order:smoke?[ORDER[0]]:ORDER,
    fixedLoad:smoke?null:{script:"scripts/probe-hook-reap.ts",phase:"cpu",samples:200},legacyGlobalMigrationProfiled:false};
  writeFileSync(join(directory,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify(manifest));
  const samples:(ReturnType<typeof feasibilityObservation>&{overlap:boolean|null;sampleFile:string;driverExit:number})[]=[],blocks:Record<string,unknown>[]=[];
  let unsafe=false;const counters={light:0,detailed:0},began=performance.now();
  const save=()=>{
    const modes=(["light","detailed"] as const).map(mode=>{
      const rows=samples.filter(row=>row.mode===mode),coverage=rows.length===manifest.samplesPerMode&&rows.every(row=>row.overlap===true)&&!unsafe;
      const values=rows.map(row=>row.joint),requested=completionFit(values,115),actual=completionFit(values,112);
      const quality=rows.every(row=>row.clockKnown&&row.joint.kind!=="unknown"&&(row.protocolComplete||row.joint.kind==="censored"));
      const components:Record<string,ReturnType<typeof completionFit>>={};
      if(mode==="detailed"){
        for(const key of ["workerBootToFirstOperation","bootToFirstOperation","bootToIdentityReady","bootToCaptureAdmission","cursorInit","cursorFinalCommit","cursorFinish","captureConstructor","captureSqliteOpen","close"] as const){
          const intervals=rows.flatMap(row=>row.detailed?.[key]?[row.detailed[key] as FitInterval]:[]);components[key]=completionFit(intervals,112);
        }
        components.appendPlusMaintenance=completionFit(rows.flatMap(row=>row.detailed?.appendPlusMaintenance??[]),112);
      }
      return{mode,samples:rows.length,completeUseful:rows.filter(row=>row.useful).length,underLoad:rows.filter(row=>row.overlap===true).length,
        outsideOrPartial:rows.filter(row=>row.overlap===false).length,unknownOverlap:rows.filter(row=>row.overlap===null).length,coverage,
        quality,requested115:requested,actual112:actual,components,fitStatus:!coverage?"not-established-coverage":!quality?"not-established-quality":actual.verdict};
    });
    const light=modes.find(row=>row.mode==="light")!;
    const report={...manifest,blocks,samples,modes,unsafe,wallMs:performance.now()-began,
      cohortFit:smoke?"functional-smoke-only":light.fitStatus,decisionBasis:"joint LIGHT boot-to-valid-body+verified-row completion; never sum independent phase p99s"};
    writeFileSync(join(directory,"fit-table.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});return report;
  };
  schedule:for(let index=0;index<manifest.order.length;index++)for(const mode of manifest.order[index]!){
    const folder=join(directory,`block-${index+1}-${mode}`);mkdirSync(folder,{mode:0o700});
    let epoch:number|undefined,probeSummary:Record<string,unknown>|undefined,probeInvalid=0,readyResolve:(()=>void)|undefined;
    const windows:{startMs:number;endMs:number}[]=[];
    const ready=new Promise<void>(resolve=>{readyResolve=resolve;});
    let loadFinished:Awaited<ReturnType<typeof logged>>|undefined;
    const load=smoke?undefined:logged(root,["scripts/probe-hook-reap.ts","--phase=cpu","--series=contended"],join(folder,"load.stdout.log"),join(folder,"load.stderr.log"),input=>{
      const row=obj(input);if(!row)return;
      if(row.diagnostic==="hook-reap-probe-start/v1"){
        if(!finite(row.epochStartedMs)||row.phase!=="cpu"||row.count!==200){probeInvalid++;return;}epoch=row.epochStartedMs;
      }else if(row.diagnostic==="hook-reap-probe-sample/v1"){
        if(epoch===undefined||!finite(row.spawnMs)||!finite(row.exitMs)||row.accepted!==true||row.reaped!==true){probeInvalid++;return;}
        windows.push({startMs:epoch+row.spawnMs,endMs:epoch+row.exitMs});readyResolve?.();
      }else if(row.diagnostic==="hook-reap-probe-summary/v1")probeSummary=row;
    }).then(result=>{loadFinished=result;return result;});
    if(load)await Promise.race([ready,load]);
    if(load&&windows.length===0){const failed=await load;unsafe=true;blocks.push({block:index+1,mode,load:failed,loadComplete:false,reason:"load never became ready"});save();break schedule;}
    const blockSamples:typeof samples=[];
    for(let offset=0;offset<manifest.samplesPerBlock;offset++){
      if(loadFinished&&(loadFinished.exit!==0||loadFinished.signal)){unsafe=true;break;}
      const sample=++counters[mode],sampleOut=join(folder,`sample-${sample}`),input={state,event,mode,sample,out:sampleOut};
      const driver=await logged(root,[join(root,"test/fakes/worker-feasibility-sample.ts"),JSON.stringify(input)],join(folder,`sample-${sample}.stdout.log`),join(folder,`sample-${sample}.stderr.log`),()=>{});
      const sampleFile=join(sampleOut,"sample.json");
      if(!existsSync(sampleFile)||driver.signal||driver.malformed){unsafe=true;break;}
      const stat=JSON.parse(readFileSync(sampleFile,"utf8")) as Record<string,unknown>;
      if(stat.state!==state||stat.event!==event||stat.mode!==mode||stat.sample!==sample||stat.profilingWindowMs!==1000){unsafe=true;break;}
      const observation=feasibilityObservation(stat);
      const entry={...observation,overlap:null as boolean|null,sampleFile:join(`block-${index+1}-${mode}`,`sample-${sample}`,"sample.json"),driverExit:driver.exit};
      samples.push(entry);blockSamples.push(entry);save();
      if(stat.safe!==true){unsafe=true;break;}
    }
    const loaded=load?await load:null;
    const loadComplete=smoke||!!loaded&&loaded.exit===0&&loaded.malformed===0&&probeInvalid===0&&windows.length===200&&probeSummary?.complete===true;
    const first=windows[0]?.startMs,last=windows.at(-1)?.endMs;
    for(const sample of blockSamples){const observedEnd=sample.bodyAtMs??sample.commandFinishedAtMs;
      sample.overlap=smoke?null:first!==undefined&&last!==undefined&&sample.commandStartedAtMs!==null&&observedEnd!==null?
        sample.commandStartedAtMs>=first&&observedEnd<=last:null;
    }
    blocks.push({block:index+1,mode,load:loaded,loadComplete,probeInvalid,probeSummary,probeWindows:windows,samples:blockSamples.length});save();
    if(unsafe||!loadComplete){unsafe=true;break schedule;}
  }
  const report=save();console.log(JSON.stringify({diagnostic:"worker-feasibility-cohort-result/v1",state,event,cohortFit:report.cohortFit,unsafe,
    modes:report.modes.map(({mode,samples,coverage,actual112,requested115})=>({mode,samples,coverage,actual112,requested115}))}));
  if(unsafe||counters.light!==manifest.samplesPerMode||counters.detailed!==manifest.samplesPerMode)process.exitCode=1;
}

if(import.meta.main){
  const [out,state,event,flag]=process.argv.slice(2),smoke=flag==="--smoke";
  if(!out||!["cold","warm","wal-recovery","partial-recovery"].includes(state??"")||!["PostToolUse","Stop"].includes(event??"")||process.argv.length!==(smoke?6:5))
    throw Error("Feasibility cohort arguments are invalid; pass output directory, declared state and event, optionally Linux --smoke");
  if(!smoke&&(process.platform!=="darwin"||process.env.GITHUB_ACTIONS!=="true"||process.env.RUNNER_OS!=="macOS"))
    throw Error("Full feasibility profiling requires hosted macOS; use the dedicated workflow, not a heavy local Mac run");
  if(smoke&&process.platform==="darwin")throw Error("Functional smoke belongs on dgx02; do not run this heavy profiling controller on the local Mac");
  await runWorkerFeasibility(out,state as FeasibilityState,event as "PostToolUse"|"Stop",smoke);
}
