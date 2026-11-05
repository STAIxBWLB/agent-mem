/** Offline #268 evidence. Seeding is outside every latency clock; every worker reads only this owned fake home.
 * Run serially after resource admission: bun scripts/measure-ui-inbox.ts [--projects=20] [--candidates=100] [--curated=1000] [--captures=500] [--report-only-timing]. */
import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, fsyncSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, entryId, type NoteEntry, type GoalEntry, type OpEntry } from "../src/memory/store.ts";
import { CandidateStore, candidateInputId, candidateTargetRevision, goalPromotionLinked, type CandidateInput } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { InboxCache, runInboxJob, type InboxSnapshot } from "../src/ui/inbox-cache.ts";
import { INBOX_MAX_BYTES, INBOX_MAX_ITEMS } from "../src/ui/inbox.ts";
import { plugin } from "../src/ui/plugin.ts";

interface Shape { projects: number; candidates: number; curated: number; captures: number }
const p95 = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1] ?? Number.NaN;
const stats = (values: number[]) => ({ count: values.length, p95Ms: p95(values), maxMs: Math.max(...values) });
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
/** Timing-only reporting never downgrades correctness, missing telemetry or cleanup failures. */
export function classifyInboxBenchmark(correctnessPass: boolean, timings: Readonly<Record<string, number>>, reportOnlyTiming = false) {
  const entries = Object.entries(timings), telemetryValid = entries.length > 0 && entries.every(([,value]) => Number.isFinite(value) && value >= 0);
  const timingFailures = entries.filter(([,value]) => Number.isFinite(value) && value >= 1000).map(([name]) => name);
  const timingPass = telemetryValid && timingFailures.length === 0;
  return { correctnessPass: correctnessPass && telemetryValid, timingPass, telemetryValid, reportOnlyTiming, timingFailures,
    pass: correctnessPass && telemetryValid && (timingPass || reportOnlyTiming) };
}

function validate(value: InboxSnapshot, complete = true): void {
  check(!complete || value.complete, "inbox sample was not a complete result");
  check(value.items.length <= INBOX_MAX_ITEMS && Number.isSafeInteger(value.more) && value.more >= 0, "inbox item/more bound failed");
  check(Buffer.byteLength(JSON.stringify(value)) <= INBOX_MAX_BYTES, "inbox envelope exceeds 64 KiB");
}
export async function waitForComplete(snapshot: () => Promise<InboxSnapshot>, limitMs = 70000): Promise<InboxSnapshot> {
  const end = performance.now()+limitMs;
  for (;;) { const value = await snapshot(); validate(value,false); if (value.complete) return value; if (performance.now()>=end) throw Error("inbox refresh never produced a complete result within 70 seconds including refresh cooldown"); await Bun.sleep(10); }
}
/** Valid original rows use core identities and one refresh, not twenty thousand append/reindex transactions.
 * Capture setup batches public append() calls in one private-DB transaction; normalization/index accounting stays core-owned. */
export function seedInboxBenchmark(root: string, shape: Shape) {
  check(Object.values(shape).every(value=>Number.isSafeInteger(value)&&value>0),"fixture dimensions must be positive safe integers");
  const promotionCount=Math.floor((shape.candidates+18)/20);
  check(shape.candidates<=500&&shape.curated>=2&&(promotionCount===0||shape.curated>20*(promotionCount-1)+1),"fixture curated rows do not cover distinct promotion target slots");
  const family=join(root,"family"), base=join(family,"memory"), now=Date.now(), memory=new MemoryStore({memoryDir:base,deferPromotions:true});
  const projects=Array.from({length:shape.projects},(_,index)=>`example.test/ui-inbox/project-${String(index).padStart(3,"0")}`);
  const targets=new Map<string,{correction:string;promotions:string[];goal:string}>(), log:string[]=[], local:string[]=[];
  let authored=0, actualCurated=0, actualCandidates=0, actualCaptures=0;
  try {
    for(const project of projects){
      const ids:string[]=[],promotions:string[]=[],task=`${project}#fixture@1000`;
      for(let index=0;index<shape.curated;index++){
        const short=index%20===1,body:Omit<NoteEntry,"id">={schema:"agent-hub.memory/v1",op:"note",at:new Date(now-(authored++)*1000).toISOString(),machine:memory.machine.id,
          project,scope:"project",tier:short?"short":"long",kind:"finding",peer:"person",source:"person",text:`근거 ${index}: ${"공개 문서와 public context. ".repeat(30)}`,about:[`path:src/public-${index}.ts`],...(short?{task}:{})};
        const row={...body,id:entryId(body)};ids.push(row.id);if(short)promotions.push(row.id);(short?local:log).push(JSON.stringify(row)+"\n");
      }
      const goal:Omit<GoalEntry,"id">={schema:"agent-hub.memory/v1",op:"goal",at:new Date(now).toISOString(),machine:memory.machine.id,project,scope:"project",title:"공개 fixture goal",milestones:[],dependsOn:[],actor:"person"};
      const row={...goal,id:entryId(goal)};log.push(JSON.stringify(row)+"\n");
      const link:Omit<OpEntry,"id">={schema:"agent-hub.memory/v1",op:"goal_link",at:new Date(now).toISOString(),machine:memory.machine.id,target:row.id,by:task,actor:"person"};
      const done:Omit<OpEntry,"id">={...link,op:"goal_state",by:"done"};
      for(const body of [link,done])log.push(JSON.stringify({...body,id:entryId(body)})+"\n");
      targets.set(project,{correction:ids[0]!,promotions,goal:row.id});
    }
    for(const [folder,lines]of [["log",log],["local",local]] as const){const file=join(memory.dir,folder,`${memory.machine.id}.jsonl`);appendFileSync(file,lines.join(""),{mode:0o600});const fd=openSync(file,"r+");try{fsyncSync(fd);}finally{closeSync(fd);}}
    memory.refresh();
    actualCurated=((memory as unknown as {db:Database}).db.query("SELECT (SELECT count(*) FROM entries)+(SELECT count(*) FROM ops)+(SELECT count(*) FROM goals) AS n").get() as {n:number}).n;
    check(actualCurated===authored+3*projects.length,"curated note/goal/link/state fixture counts disagree");
    const candidates=new CandidateStore({memoryDir:base});candidates.close();const db=new Database(join(base,"candidates.db"));
    try{const insert=db.query("INSERT INTO candidates(id,project,kind,payload,at,status) VALUES (?,?,?,?,?,'pending')");
      db.transaction(()=>{for(const [projectIndex,project]of projects.entries())for(let index=0;index<shape.candidates;index++){
        const target=targets.get(project)!,promotion=target.promotions[Math.floor(index/20)];
        if(index%20===1){const view=promotion?memory.get(promotion,project):undefined,goal=memory.goalOf(target.goal,project);check(view?.tier==="short"&&goal?.state==="done"&&goalPromotionLinked(view,goal),"promotion fixture is not a linked short note under a done goal");}
        const input:CandidateInput=index%20===0?{project,kind:"correction",target:{id:target.correction,revision:candidateTargetRevision(memory.get(target.correction,project)!)},proposedText:`확인된 correction ${index}`,reason:"fixture evidence"}
          :index%20===1?{project,kind:"promotion",target:{id:promotion!,revision:candidateTargetRevision(memory.get(promotion!,project)!)},goalId:target.goal}
          :index%5===0?{project,kind:"fail",approach:`fixture approach ${index}`,symptom:"bounded refresh",cause:"known fixture",evidenceRefs:["test:ui-inbox"],retryWhen:"source revision changes"}
          :{project,kind:"memory",title:`Inbox ${projectIndex}/${index}`,text:`공개 memory evidence ${index}: ${"public context 제주 ".repeat(60)}`};
        insert.run(candidateInputId(input),project,input.kind,JSON.stringify(input),now-(projectIndex*shape.candidates+index)*1000);
      }})();
      const counts=db.query("SELECT count(*) AS n,count(DISTINCT id) AS distinctIds,sum(kind='promotion') AS promotions FROM candidates").get() as {n:number;distinctIds:number;promotions:number};
      actualCandidates=counts.n;
      check(counts.n===shape.projects*shape.candidates&&counts.distinctIds===counts.n&&counts.promotions===shape.projects*promotionCount,"candidate fixture count or promotion uniqueness disagrees");
    }finally{db.close();}
  }finally{memory.close();}
  for(const project of projects){
    const capture=new CaptureStore({memoryDir:base,project}), db=(capture as unknown as {db:Database}).db;
    try{
      db.transaction(()=>{for(let index=0;index<shape.captures;index++){const appended=capture.append({project,agent:"fixture",event:"PostToolUse",at:new Date(now-index*1000).toISOString(),excerpt:`capture ${index} ${"public context 제주 ".repeat(70)}`});check(!("spooled" in appended),"capture fixture unexpectedly spooled instead of seeding rows");}})();
      const count=(db.query("SELECT count(*) AS n FROM rows").get() as {n:number}).n;
      check(count===shape.captures,"capture fixture shard count disagrees");actualCaptures+=count;
    }finally{capture.close();}
  }
  check(actualCaptures===shape.projects*shape.captures,"total capture fixture count disagrees");
  return{family,base,projects,curatedRows:actualCurated,candidateRows:actualCandidates,captureRows:actualCaptures};
}
async function main() {
  const option=(key:string,fallback:number)=>{const raw=process.argv.find(arg=>arg.startsWith(`--${key}=`))?.split("=")[1],value=raw===undefined?fallback:Number(raw);check(Number.isSafeInteger(value)&&value>0,`invalid fixture ${key}`);return value;};
  const shape={projects:option("projects",20),candidates:option("candidates",100),curated:option("curated",1000),captures:option("captures",500)};
  check(shape.candidates<=500&&shape.curated>=2,"fixture exceeds candidate cap or lacks required targets");
  const reportOnlyTiming=process.argv.includes("--report-only-timing"), timings:Record<string,number>={};let correctnessPass=false;
  const root=mkdtempSync(join(tmpdir(),"amem-measure-ui-inbox-")), priorAmem=process.env.AMEM_HOME;
  let cache:InboxCache|undefined, provider:Awaited<ReturnType<typeof plugin.open>>|undefined, timer:ReturnType<typeof setInterval>|undefined, server:ReturnType<typeof Bun.serve>|undefined;
  const report:Record<string,unknown>={diagnostic:"ui-inbox-benchmark",fixture:shape,bun:Bun.version,platform:process.platform,arch:process.arch,coldDefinition:"new provider/worker after fixture seeding; OS file cache is not flushed",synthetic:true};
  try{
    const seedAt=performance.now(),fixture=seedInboxBenchmark(root,shape);report.seedMs=performance.now()-seedAt;report.counts={curated:fixture.curatedRows,candidates:fixture.candidateRows,captures:fixture.captureRows};
    process.env.AMEM_HOME=fixture.base;
    let starts=0,active=0,maxActive=0;const startTimes:number[]=[];
    cache=new InboxCache(fixture.base,{runner:(base,capacity)=>{starts++;startTimes.push(performance.now());active++;maxActive=Math.max(active,maxActive);const job=runInboxJob(base,capacity);return{...job,result:job.result.finally(()=>{active--;})};}});
    let last=performance.now(),maxLagMs=0,ticks=0;const control:number[]=[];
    timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-last-10);last=now;ticks++;},10);
    server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:request=>request.headers.get("authorization")==="Bearer offline-fixture"?Response.json({ok:true}):new Response("unauthorized",{status:401})});
    const coldAt=performance.now(),cold=await Promise.all(Array.from({length:20},()=>cache!.snapshot()));report.coldConcurrentMs=performance.now()-coldAt;report.coldComplete=cold.filter(value=>value.complete).length;
    check(starts===1&&maxActive===1,"concurrent inbox calls duplicated background work");
    const waiting=waitForComplete(()=>cache!.snapshot());void waiting.catch(()=>{});
    while(active){const at=performance.now();const response=await fetch(server.url,{headers:{authorization:"Bearer offline-fixture"}});check(response.status===200,"authenticated control request failed");control.push(performance.now()-at);await Bun.sleep(10);}
    const complete=await waiting;report.timeToCompleteMs=performance.now()-coldAt;validate(complete);check(complete.items.length===50&&complete.more>0,"realistic fixture did not yield fifty real rows plus overflow");
    const warm:number[]=[],payloads:number[]=[];
    for(let index=0;index<40;index++){const at=performance.now(),value=await cache.snapshot();validate(value);check(value.items.length===50&&value.more>0,"warm measurement was empty or incomplete");payloads.push(Buffer.byteLength(JSON.stringify(value)));warm.push(performance.now()-at);}
    report.warm=stats(warm);report.maxPayloadBytes=Math.max(...payloads);report.readyItems=complete.items.length;report.more=complete.more;report.singleFlight={starts,maxActive};report.eventLoop={ticks,maxLagMs,authenticatedControl:stats(control)};
    check(ticks>0&&control.length>0,"independent event-loop responsiveness was not actually observed");
    Object.assign(timings,{coldConcurrentMs:report.coldConcurrentMs,warmP95Ms:p95(warm),eventLoopMaxLagMs:maxLagMs,authenticatedControlP95Ms:p95(control)});
    let changedCandidateId="", appended=false;
    const writer=new CandidateStore({memoryDir:fixture.base});try{
      if(shape.candidates<500){changedCandidateId=writer.put({project:fixture.projects[0]!,kind:"memory",text:"new source invalidation fixture"},"public");appended=true;report.invalidationMutation="append";}
      else{const pending=writer.list({project:fixture.projects[0]!,status:"pending",limit:1})[0];check(pending,"fixture at capacity has no pending candidate");changedCandidateId=pending.id;check(complete.items.some(item=>item.id===pending.id),"rejected candidate was not visible before invalidation");writer.reject(pending.id,{project:fixture.projects[0]!,actor:"person",verdict:"public"});report.invalidationMutation="reject-at-cap";}
    }finally{writer.close();}
    const invalidatedAt=performance.now(),invalidated=await cache.snapshot();report.invalidationSnapshotMs=performance.now()-invalidatedAt;report.invalidationComplete=invalidated.complete;
    check(!invalidated.complete,"source invalidation returned a stale complete snapshot");
    const refreshed=await waitForComplete(()=>cache!.snapshot());validate(refreshed);report.invalidationTimeToCompleteMs=performance.now()-invalidatedAt;check(Number(starts)===2&&maxActive===1,"one source invalidation did not produce exactly one refresh");
    check(changedCandidateId.length===64&&refreshed.items.some(item=>item.id===changedCandidateId)===appended,"completed invalidation snapshot did not reflect the actual candidate change");
    report.invalidationFreshness={candidateId:changedCandidateId,present:appended,verified:true};
    report.refreshCadence={minimumIntervalMs:30000,startTimesMs:startTimes,startGapMs:startTimes[1]!-startTimes[0]!};
    check(startTimes[1]!-startTimes[0]!>=29998,"refresh started before minimum interval");
    await cache.close();cache=undefined;
    const openAt=performance.now();provider=await plugin.open({home:fixture.family,log:()=>{}});report.openMs=performance.now()-openAt;
    const publicSnapshot=async()=>await provider!.snapshot({panel:"inbox",after:0}) as unknown as InboxSnapshot;
    const publicAt=performance.now(),first=await publicSnapshot();report.providerColdSnapshotMs=performance.now()-publicAt;report.providerColdComplete=first.complete;
    const final=await waitForComplete(publicSnapshot);report.providerTimeToCompleteMs=performance.now()-publicAt;validate(final);check(final.items.length===50&&final.more>0,"provider completed without real bounded inbox data");
    const providerWarm:number[]=[];
    for(let index=0;index<40;index++){const at=performance.now(),value=await publicSnapshot();validate(value);check(value.items.length===50&&value.more>0,"provider warm sample was incomplete or empty");providerWarm.push(performance.now()-at);}
    report.providerWarm=stats(providerWarm);
    Object.assign(timings,{providerWarmP95Ms:p95(providerWarm),openMs:report.openMs,providerColdSnapshotMs:report.providerColdSnapshotMs,invalidationSnapshotMs:report.invalidationSnapshotMs});
    correctnessPass=true;
  }catch(error){report.error=error instanceof Error?error.message:"benchmark unavailable";}
  finally{
    if(timer)clearInterval(timer);let cleaned=true;
    for(const close of [()=>cache?.close(),()=>provider?.close(),()=>server?.stop(true)])try{await close();}catch{cleaned=false;correctnessPass=false;report.cleanup="owned worker cleanup unavailable";}
    if(priorAmem===undefined)delete process.env.AMEM_HOME;else process.env.AMEM_HOME=priorAmem;
    if(cleaned)try{rmSync(root,{recursive:true,force:true});}catch{cleaned=false;correctnessPass=false;report.cleanup="owned fixture cleanup unavailable";}
    if(!cleaned)report.retainedFixture=root;
    const verdict=classifyInboxBenchmark(correctnessPass,timings,reportOnlyTiming);Object.assign(report,verdict,{timings});
    if(!verdict.pass)process.exitCode=1;
    if(verdict.correctnessPass&&!verdict.timingPass&&reportOnlyTiming){
      console.warn(JSON.stringify({diagnostic:"ui-inbox-timing-warning",timingPass:false,timingFailures:verdict.timingFailures,timings}));
      if(process.env.GITHUB_ACTIONS==="true")console.warn(`::warning title=Console inbox timing::Report-only timing miss: ${verdict.timingFailures.join(", ")}. Correctness remains strict.`);
    }
    console.log(JSON.stringify(report,null,2));
  }
}
if(import.meta.main)await main();
