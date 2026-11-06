/** Numeric post-exit accounting for the nonshipping C/P experiment. Never changes a verdict. */
import { addWorkerPhaseDurations, emptyPhaseDurations, summarizePhaseDurations } from "./hook-phase-durations.ts";

export type PairArm = "C" | "P";
export interface ProbeWindow { startMs: number; endMs: number }
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const number=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const groups=new Set(["plain","spoolAndExit","drain","sessionStart","sessionStartRepoLog","jcode","Stop","SessionEnd","StopBurst"]);
function bucket(){return{frames:0,workers:0,parentKillRequested:0,reapMisses:0,reapUnknown:0,withoutParentKillRequest:0,drainSkipped:0,drainSkippedUnknown:0,deferred:0,deferredUnknown:0,
  stalls:0,unknownRss:0,rssMetadataUnknown:0,missingWall:0,outerWall:[] as number[],handlerWall:[] as number[],durationCoverageUnknown:0,durations:emptyPhaseDurations()};}
type Bucket=ReturnType<typeof bucket>;
const p95=(values:readonly number[])=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]!:null;

export function createPairMetrics(arm:PairArm){
  const all=bucket(),byGroup=new Map<string,Bucket>(),seen=new Set<string>();
  const invocations:{parentPid:number;group:string;startMs:number|null;endMs:number|null;kills:{pid:number;epochMs:number|null;reaped:boolean|null}[]}[]=[];
  let metadataInvalid=0;
  const group=(key:string)=>{let result=byGroup.get(key);if(!result){result=bucket();byGroup.set(key,result);}return result;};
  const add=(input:unknown)=>{
    const row=object(input);if(!row)return;
    if(row.diagnostic==="budget-attempt"&&row.outcome==="stall"&&typeof row.check==="string"){
      const key=row.check.replace(/-\d+$/,"");if(groups.has(key)){all.stalls++;group(key).stalls++;}return;
    }
    if(row.diagnostic!=="hook-child-reap/v1"||!number(row.parentPid)||!Array.isArray(row.children)
      ||!["baseline","phase-hooks","phase-transcript"].includes(String(row.variant)))return;
    const key=typeof row.workload==="string"?row.workload:String(row.event);
    if(!groups.has(key)||!Number.isSafeInteger(row.parentPid)||row.parentPid<=0){metadataInvalid++;return;}
    const identity=`${row.parentPid}:${row.variant}:${row.run}:${row.logicalRun}`;if(seen.has(identity))return;seen.add(identity);
    if(row.phaseInstrumentation!==(arm==="P"))metadataInvalid++;
    const targets=[all,group(key)],kills:{pid:number;epochMs:number|null;reaped:boolean|null}[]=[];
    for(const target of targets){
      target.frames++;if(number(row.outerWallMs))target.outerWall.push(row.outerWallMs);else target.missingWall++;
      if(number(row.wallMs))target.handlerWall.push(row.wallMs);else target.missingWall++;
      if(number(row.drainSkipped)&&row.drainSkipped>=0)target.drainSkipped+=row.drainSkipped;else target.drainSkippedUnknown++;
      if(row.deferred===true)target.deferred++;else if(row.deferred!==false)target.deferredUnknown++;
      const rss=object(row.rssSources);if(rss&&number(rss.unavailable)){if(rss.unavailable>0)target.unknownRss++;}else target.rssMetadataUnknown++;
    }
    for(const inputChild of row.children){
      const child=object(inputChild);if(!child||child.kind!=="worker")continue;
      if(!number(child.pid)||!Number.isSafeInteger(child.pid)||child.pid<=0){metadataInvalid++;continue;}
      const requested=number(child.killRequestMs),killMs=requested?child.killRequestMs as number:null;
      if(requested)kills.push({pid:child.pid,epochMs:number(row.epochOriginMs)&&killMs!==null?row.epochOriginMs+killMs:null,reaped:typeof child.reaped==="boolean"?child.reaped:null});
      for(const target of targets){
        target.workers++;if(requested)target.parentKillRequested++;else target.withoutParentKillRequest++;
        if(child.reaped===false)target.reapMisses++;
        else if(child.reaped!==true)target.reapUnknown++;
        if(arm!=="P")continue;
        if(child.phaseInstrumentation!==true||child.phaseTracePartial||child.phaseTraceTruncated||!Array.isArray(child.workerPhases)||child.phaseTraceMissing){target.durationCoverageUnknown++;continue;}
        const rows=child.workerPhases.map(object);
        if(rows.some(item=>!item||!number(item.id)||!number(item.seq)||!number(item.atMs))){target.durationCoverageUnknown++;continue;}
        addWorkerPhaseDurations(target.durations,rows.map(item=>({id:item!.id as number,seq:item!.seq as number,atMs:item!.atMs as number})),killMs);
      }
    }
    invocations.push({parentPid:row.parentPid,group:key,startMs:number(row.outerStartedAtMs)?row.outerStartedAtMs:null,endMs:number(row.outerFinishedAtMs)?row.outerFinishedAtMs:null,kills});
  };
  const summarize=(probeWindows:readonly ProbeWindow[]=[])=>{
    const valid=probeWindows.filter(window=>number(window.startMs)&&number(window.endMs)&&window.endMs>=window.startMs).sort((a,b)=>a.startMs-b.startMs);
    const first=valid[0]?.startMs,last=valid.at(-1)?.endMs;
    const overlap=invocations.map(row=>{
      const measurable=row.startMs!==null&&row.endMs!==null&&row.endMs>=row.startMs;
      const union:ProbeWindow[]=[];
      if(measurable)for(const window of valid){
        const startMs=Math.max(row.startMs!,window.startMs),endMs=Math.min(row.endMs!,window.endMs);if(endMs<=startMs)continue;
        const previous=union.at(-1);if(previous&&startMs<=previous.endMs)previous.endMs=Math.max(previous.endMs,endMs);else union.push({startMs,endMs});
      }
      return{...row,inProbeSpan:measurable&&first!==undefined&&last!==undefined?row.startMs!>=first&&row.endMs!<=last:null,
        probeWorkerOverlapMs:measurable?union.reduce((sum,window)=>sum+window.endMs-window.startMs,0):null,
        kills:row.kills.map(kill=>({...kill,inProbeSpan:kill.epochMs===null||first===undefined||last===undefined?null:kill.epochMs>=first&&kill.epochMs<=last,
          inProbeWorkerWindow:kill.epochMs===null?null:valid.some(window=>kill.epochMs!>=window.startMs&&kill.epochMs!<=window.endMs)}))};
    });
    const output=(value:Bucket)=>{const durations=summarizePhaseDurations(value.durations);return{invocations:value.frames,workers:value.workers,parentKillRequested:value.parentKillRequested,reapMisses:value.reapMisses,reapUnknown:value.reapUnknown,
      withoutParentKillRequest:value.withoutParentKillRequest,allPhysicalOuterWallP95Ms:p95(value.outerWall),allPhysicalHandlerWallP95Ms:p95(value.handlerWall),missingWall:value.missingWall,
      drainSkipped:value.drainSkipped,drainSkippedUnknown:value.drainSkippedUnknown,deferred:value.deferred,deferredUnknown:value.deferredUnknown,stalls:value.stalls,unknownRss:value.unknownRss,rssMetadataUnknown:value.rssMetadataUnknown,
      durations:arm==="C"?{available:false as const,reason:"No worker phase preload in parent-only control"}:{available:true as const,coverageUnknownWorkers:value.durationCoverageUnknown,
        scope:"all observed phase starts; unknown worker coverage is separate",coverageComplete:value.durationCoverageUnknown===0&&!durations.incomplete,...durations}};};
    return{arm,metadataInvalid,all:output(all),groups:Object.fromEntries([...byGroup].map(([name,value])=>[name,output(value)])),overlap,
      overlapSummary:{known:valid.length>0,probeWorkers:valid.length,invocations:overlap.length,fullyInProbeSpan:overlap.filter(row=>row.inProbeSpan===true).length,
        outsideOrPartial:overlap.filter(row=>row.inProbeSpan===false).length,unknown:overlap.filter(row=>row.inProbeSpan===null).length}};
  };
  return{add,summarize};
}
