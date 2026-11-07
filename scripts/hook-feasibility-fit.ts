/** Nonshipping fit analysis. Point completions, censored lower bounds and unknowns are never conflated. */
export type FitInterval={kind:"complete";ms:number}|{kind:"censored";lowerMs:number}|{kind:"unknown"};
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const number=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const array=(value:unknown)=>Array.isArray(value)?value.map(object).filter((row):row is Record<string,unknown>=>!!row):[];
export function completionFit(values:readonly FitInterval[],deadlineMs:number){
  if(!number(deadlineMs)||deadlineMs<=0||values.some(value=>value.kind==="complete"?(!number(value.ms)||value.ms<0):value.kind==="censored"?(!number(value.lowerMs)||value.lowerMs<0):value.kind!=="unknown"))
    throw Error("Feasibility intervals or deadline are invalid; retain the raw profiling samples and inspect the parser");
  const complete=values.flatMap(value=>value.kind==="complete"?[value.ms]:[]).sort((a,b)=>a-b);
  const lower=values.map(value=>value.kind==="complete"?value.ms:value.kind==="censored"?value.lowerMs:0).sort((a,b)=>a-b);
  const upper=values.map(value=>value.kind==="complete"?value.ms:Infinity).sort((a,b)=>a-b);
  const rank=(rows:readonly number[],q:number)=>rows[Math.ceil(rows.length*q)-1]!;
  const completed=complete.length?{p50:rank(complete,.5),p95:rank(complete,.95),p99:rank(complete,.99),max:complete.at(-1)!}:null;
  const bound=(q:number)=>lower.length?{lowerMs:rank(lower,q),upperMs:Number.isFinite(rank(upper,q))?rank(upper,q):null,upperUnbounded:!Number.isFinite(rank(upper,q))}:null;
  const p99=bound(.99),verdict=p99===null?"not-established":p99.lowerMs>deadlineMs?"does-not-fit":p99.upperMs!==null&&p99.upperMs<=deadlineMs?"fits-at-p99":"not-established";
  return{samples:values.length,complete:complete.length,censored:values.filter(value=>value.kind==="censored").length,unknown:values.filter(value=>value.kind==="unknown").length,
    deadlineMs,completedMs:completed,allSamples:{p50:bound(.5),p95:bound(.95),p99,max:bound(1)},verdict};
}
function interval(start:unknown,end:unknown,kill:unknown):FitInterval{
  if(!number(start))return{kind:"unknown"};
  if(number(end)&&end>=start)return{kind:"complete",ms:end-start};
  if(number(kill)&&kill>=start)return{kind:"censored",lowerMs:kill-start};
  return{kind:"unknown"};
}
export function feasibilityObservation(input:unknown){
  const row=object(input);if(!row)throw Error("Profiling sample is not an object; retain the sample file and inspect the driver");
  const clocks=array(row.clocks),life=array(row.parentLifecycle),phases=array(row.workerPhases);
  const at=(id:number)=>phases.find(phase=>phase.phase===id)?.atMs;
  const boot=clocks.find(clock=>clock.phase===1)?.atMs;
  const kills=life.filter(receipt=>receipt.kind==="worker"&&receipt.phase==="kill-request"&&number(receipt.atMs)).map(receipt=>receipt.atMs as number).sort((a,b)=>a-b);
  const kill=kills[0],bodies=life.filter(receipt=>receipt.phase==="profile-body"&&receipt.complete===1&&receipt.valid===1),body=bodies.length===1?bodies[0]:undefined;
  const bodyAt=body?.atMs,profilingWindow=number(row.profilingWindowMs)?row.profilingWindowMs:1000;
  // An early semantic failure is unknown, not a fabricated deadline censor. Positive long-window kill remains censored.
  const positiveDeadlineKill=number(boot)&&number(kill)&&kill-boot>=profilingWindow-33;
  const metric=object(row.metric),semanticError=metric?.transcriptStopReason==="unavailable"||(number(metric?.captureDrops)&&metric.captureDrops>0);
  const useful=!!body&&row.expectedRowVerified===true&&row.safe===true&&!semanticError;
  const joint=useful?interval(boot,bodyAt,undefined):positiveDeadlineKill&&!body?interval(boot,undefined,kill):{kind:"unknown" as const};
  const exit=life.find(receipt=>receipt.kind==="worker"&&receipt.phase==="exit")?.atMs;
  const workerBoot=at(1),firstOperation=[at(40),at(7)].filter(number).sort((a,b)=>a-b)[0];
  const detailed=row.mode==="detailed";
  const append:FitInterval[]=[];let pending:unknown;
  if(detailed)for(const phase of phases){if(phase.phase===9){if(pending!==undefined)append.push({kind:"unknown"});pending=phase.atMs;}
    else if(phase.phase===10&&pending!==undefined){append.push(interval(pending,phase.atMs,kill));pending=undefined;}}
  if(pending!==undefined)append.push(interval(pending,undefined,kill));
  return{state:row.state,event:row.event,mode:row.mode,sample:row.sample,safe:row.safe===true,useful,protocolComplete:row.complete===true,clockKnown:number(boot),joint,
    bodyAtMs:number(bodyAt)?bodyAt:null,bootEpochMs:number(boot)?boot:null,commandStartedAtMs:number(row.commandStartedAtMs)?row.commandStartedAtMs:null,
    commandFinishedAtMs:number(row.commandFinishedAtMs)?row.commandFinishedAtMs:null,
    jointToWorkerExit:interval(boot,exit,positiveDeadlineKill?kill:undefined),
    detailed:detailed?{workerBootToFirstOperation:interval(workerBoot,firstOperation,kill),bootToFirstOperation:interval(boot,firstOperation,kill),
      bootToIdentityReady:interval(boot,at(48),kill),bootToCaptureAdmission:interval(boot,at(7),kill),
      cursorInit:row.event==="Stop"?interval(at(40),at(41),kill):null,cursorFinalCommit:row.event==="Stop"?interval(at(43),at(44),kill):null,
      cursorFinish:row.event==="Stop"?interval(at(42),at(45),kill):null,captureConstructor:interval(at(7),at(8),kill),
      captureSqliteOpen:interval(at(46),at(47),kill),appendPlusMaintenance:append,close:interval(at(11),at(12),kill)}:null};
}
