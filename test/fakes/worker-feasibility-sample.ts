import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CaptureStore } from "../../src/memory/capture.ts";
import { readMetrics } from "../../src/memory/metrics.ts";
import { hookFixture } from "./hooks-fixture.ts";
import { createHookWorkerProfile } from "./hooks-worker-profile.ts";
import { observeOwnedGone, prepareWorkerFeasibilityRecovery, type FeasibilityState } from "./worker-feasibility-recovery.ts";
export interface WorkerFeasibilityInput { state:FeasibilityState; event:"PostToolUse"|"Stop"; mode:"light"|"detailed"; sample:number; out:string }
export async function runWorkerFeasibilitySample(input:WorkerFeasibilityInput) {
  if(!input||Object.keys(input).sort().join()!=="event,mode,out,sample,state"||!["cold","warm","wal-recovery","partial-recovery"].includes(input.state)||!["PostToolUse","Stop"].includes(input.event)||!["light","detailed"].includes(input.mode)||!Number.isSafeInteger(input.sample)||input.sample<1||input.sample>200||typeof input.out!=="string"||!isAbsolute(input.out)||existsSync(input.out))throw Error("Feasibility sample arguments or new output directory are invalid; use one declared owned sample");
  const out=resolve(input.out);mkdirSync(out,{mode:0o700});
  if((lstatSync(out).mode&0o777)!==0o700||lstatSync(out).uid!==process.getuid?.())throw Error("Feasibility output ownership is unavailable; stop the schedule and inspect its new output directory");
  const f=hookFixture(),sourceRoot=resolve(import.meta.dir,"../..");
  const sampleFile=join(out,"sample.json");
  let safe=false,complete=false;
  let resultMeta:Record<string,unknown>={diagnostic:"worker-feasibility-sample/v1",state:input.state,event:input.event,mode:input.mode,sample:input.sample,profilingWindowMs:1000,nativeRequestedWindowMs:115,nativeActualWorkerEndMs:112,safe:false,complete:false,expectedRowVerified:false,legacyGlobalMigrationProfiled:false,exit:null,signal:null,commandStartedAtMs:null,commandFinishedAtMs:null,clocks:[],parentLifecycle:[],workerPhases:[],phaseTracePartial:null,profileParentPid:null,recoveryEvidence:null,metric:null};
  const save=()=>writeFileSync(sampleFile,JSON.stringify(resultMeta,null,2)+"\n",{mode:0o600});
  try {
    await f.seed();
    const preparation=await prepareWorkerFeasibilityRecovery(f,input.state,out);
    resultMeta.recoveryEvidence=preparation.evidence;
    if(!preparation.safe){resultMeta={...resultMeta,retainedFixtureRoot:f.root,failureCode:"preparation-unconfirmed"};save();return resultMeta;}
    const profile=createHookWorkerProfile(f.root,sourceRoot,input.mode,1000);
    const priorArtifacts=process.env.AMEM_TEST_PHASE_ARTIFACTS;
    try{process.env.AMEM_TEST_PHASE_ARTIFACTS=join(out,"receipts");profile.observer.preserveBeforeClose(f);}finally{if(priorArtifacts===undefined)delete process.env.AMEM_TEST_PHASE_ARTIFACTS;else process.env.AMEM_TEST_PHASE_ARTIFACTS=priorArtifacts;}
    const marker=(input.sample%2?"profile sample ":"프로필 표본 ")+input.state+" "+input.event+" "+input.sample;
    const payload:Record<string,unknown>={cwd:f.cwd,hook_event_name:input.event,session_id:"worker-profile-"+input.sample,tool_name:"Read",tool_input:{file_path:"src/public.ts"},tool_response:marker};
    if(input.event==="Stop"){
      const transcript=join(f.root,"profile-transcript.jsonl");
      writeFileSync(transcript,JSON.stringify({type:"system",subtype:"away_summary",timestamp:new Date().toISOString(),content:marker})+"\n",{mode:0o600});payload.transcript_path=transcript;
    }
    const commandStartedAtMs=performance.timeOrigin+performance.now();
    resultMeta.commandStartedAtMs=commandStartedAtMs;
    const result=Bun.spawnSync([process.execPath,"--smol",profile.entry,input.event],{cwd:f.cwd,env:{...f.env,BUN_OPTIONS:`--preload=${profile.observer.preload}`},stdin:Buffer.from(JSON.stringify(payload)),stdout:"pipe",stderr:"pipe",detached:true,timeout:4000,maxBuffer:64*1024});
    const commandFinishedAtMs=performance.timeOrigin+performance.now(),exitWindowEnd=Date.now()+2000;
    resultMeta={...resultMeta,commandStartedAtMs,commandFinishedAtMs,exit:result.exitCode,signal:result.signalCode??null,profileParentPid:result.pid};
    writeFileSync(join(out,"profile.stdout.log"),result.stdout,{mode:0o600});writeFileSync(join(out,"profile.stderr.log"),result.stderr,{mode:0o600});
    const workers=profile.observer.read(),ownedIds=[result.pid,...workers.map(row=>row.pid)];
    const gone=await observeOwnedGone(ownedIds,exitWindowEnd);
    safe=gone.gone&&result.exitCode!==null&&(result.signalCode??null)===null;
    // Retain raw numeric bytes even when parsing or owned-process cleanup later fails.
    for(const [source,name]of [[join(f.root,"hook-child-lifecycle.jsonl"),"raw-parent-lifecycle.jsonl"],[join(f.root,"hook-process-evidence.jsonl"),"raw-admission.jsonl"],[join(f.root,"worker-phases","receipts.jsonl"),"raw-worker-phases.jsonl"]])if(existsSync(source!)){const stat=lstatSync(source!);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.nlink!==1||stat.size>8*1024*1024)throw Error("Profile raw evidence is unsafe; retain the fixture and stop");copyFileSync(source!,join(out,name!),constants.COPYFILE_EXCL);}
    const trace=profile.observer.workerPhaseReport(result.pid),parentLifecycle=profile.observer.lifecycle(result.pid);
    const body=parentLifecycle.filter(row=>row.phase==="profile-body"),bodyValid=body.length===1&&body[0]?.complete===1&&body[0]?.valid===1;
    const clockStat=lstatSync(profile.clockFile);
    if(!clockStat.isFile()||clockStat.isSymbolicLink()||clockStat.size>64*1024)throw Error("Profile clock evidence is unavailable; retain the fixture and inspect its numeric clock file");
    copyFileSync(profile.clockFile,join(out,"profile-clock.jsonl"),constants.COPYFILE_EXCL);
    const clocks=readFileSync(profile.clockFile,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line) as {phase:number;pid:number;atMs:number;observedAtMs:number;hostDeadlineMs:number});
    const clocksValid=clocks.length===3&&clocks.every((row,i)=>row.phase===i+1&&row.pid===result.pid&&row.hostDeadlineMs===1000&&Number.isFinite(row.atMs)&&Number.isFinite(row.observedAtMs))&&clocks[0]!.atMs<=clocks[1]!.atMs&&clocks[1]!.atMs<=clocks[2]!.atMs;
    const metrics=readMetrics(f.base).filter(row=>row.kind==="hook"),last=metrics.at(-1);
    // Read-only SDK inspection happens AFTER the measured command, never as recovery preparation.
    let expectedRowVerified=false,rowVerificationUnavailable=false;
    if(safe){try{const store=new CaptureStore({memoryDir:f.base,project:f.project,cwd:f.cwd,readOnly:true,maxReadRows:128});try{const count=store.rows({project:f.project,limit:128}).filter(row=>row.excerpt===(input.event==="PostToolUse"?"src/public.ts\n"+marker:marker)).length;expectedRowVerified=count===1;}finally{store.close();}}catch{rowVerificationUnavailable=true;}}
    const semanticFailure=!last||last.transcriptStopReason==="unavailable"||(last.captureDrops??0)>0||(last.abandonedChildren??0)>0||(last.rssSources?.unavailable??1)>0;
    complete=safe&&result.exitCode===0&&bodyValid&&clocksValid&&!trace.partialTail&&expectedRowVerified&&!semanticFailure;
    const metric=last?Object.fromEntries(Object.entries(last).filter(([key,value])=>key!=="at"&&key!=="kind"&&(typeof value==="number"||key==="rssSources"||key==="transcriptStopReason"))):null;
    resultMeta={...resultMeta,commandStartedAtMs,commandFinishedAtMs,exit:result.exitCode,signal:result.signalCode??null,profileParentPid:result.pid,workerIds:workers.map(row=>({pid:row.pid,detached:row.detached,kind:row.kind})),clocks,parentLifecycle,workerPhases:trace.rows,phaseTracePartial:trace.partialTail,metric,finalBodyAtMs:body.length===1?body[0]!.atMs:null,bootEpochMs:clocks.find(row=>row.phase===1)?.atMs??null,expectedRowVerified,rowVerificationUnavailable,ownership:gone,clockValid:clocksValid,finalBodyValid:bodyValid,semanticFailure,safe,complete};
    if(!safe)resultMeta.retainedFixtureRoot=f.root;
    save();
    if(safe)f.close(); // preserveBeforeClose copies bounded numeric receipts before deleting only this fake fixture.
    return resultMeta;
  } catch {
    resultMeta={...resultMeta,safe:false,complete:false,failureCode:"sample-evidence-or-validation-unavailable",retainedFixtureRoot:f.root};save();return resultMeta;
  }
}
if(import.meta.main){
  if(process.argv.length!==3)throw Error("Feasibility sample needs one closed JSON argument; invoke the bounded controller");
  const result=await runWorkerFeasibilitySample(JSON.parse(process.argv[2]!) as WorkerFeasibilityInput);
  console.log(JSON.stringify({diagnostic:"worker-feasibility-sample/v1",state:result.state,event:result.event,mode:result.mode,sample:result.sample,safe:result.safe,complete:result.complete,out:resolve(JSON.parse(process.argv[2]!).out),sampleFile:join(resolve(JSON.parse(process.argv[2]!).out),"sample.json")}));
  if(result.safe!==true||result.complete!==true)process.exitCode=1;
}
