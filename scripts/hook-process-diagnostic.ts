import type { HookLifecycleReceipt, HookProcessEvidence, HookWorkerProcess } from "../test/fakes/hooks-process-observer.ts";
import type { MetricSample } from "../src/memory/metrics.ts";
import { HOOK_RSS_COVERAGE } from "../src/hook-resources.ts";
import { HookWorkerPhase, type HookWorkerPhaseReceipt } from "../test/fakes/hooks-worker-phases.ts";

interface HookDiagnosticInput {
  event: "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd";
  run: number; logicalRun: number; parentPid: number;
  variant?: "linux" | "darwin-codepath" | "baseline" | "timeout-functional" | "timeout-native" | "phase-hooks" | "phase-transcript";
  expectedWorkerChildren?: number;
  expectedOwnedChildren: number | null;
  expectation: "fixture-contract" | "observed-spawn-attempts";
  workers: readonly HookWorkerProcess[]; evidence: readonly HookProcessEvidence[];
  lifecycle: readonly HookLifecycleReceipt[]; metric?: MetricSample; cliRawRssMB?: number;
  phaseInstrumentation?: boolean; workerPhases?: readonly HookWorkerPhaseReceipt[]; phaseTracePartial?: boolean;
}
const numeric=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
/** Diagnostic projection only: no argv, paths, source bodies or caller error text. No field grants cleanup authority. */
// ponytail: output caps128 children/256 admission rows with explicit truncation; a reviewed streamed diagnostic is needed for larger invocations.
export function hookProcessDiagnostic(input:HookDiagnosticInput) {
  const rows=input.lifecycle.filter(row=>row.parentPid===input.parentPid), evidence=input.evidence.filter(row=>row.pid===input.parentPid);
  const window=rows.find(row=>row.phase==="reap-start"&&row.kind==="worker"), origin=rows.find(row=>row.phase==="spawn-attempt")?.atMs;
  const time=(row:HookLifecycleReceipt|undefined)=>row&&origin!==undefined?numeric(row.atMs-origin):null;
  const relative=(row:HookLifecycleReceipt|undefined)=>row&&window?numeric(row.atMs-window.atMs):null;
  const ids=[...new Set([...input.workers.map(row=>row.pid),...rows.filter(row=>row.childPid>0).map(row=>row.childPid)])];
  const sources=input.metric?.rssSources;
  const phases=(input.workerPhases??[]).filter(row=>row.parentPid===input.parentPid);
  const phaseLabel=(phase:number)=>Number.isSafeInteger(phase)&&typeof HookWorkerPhase[phase]==="string"?HookWorkerPhase[phase]:null;
  const timerSnapshot=(row:HookLifecycleReceipt|undefined)=>row?{id:numeric(row.timerId),lagMs:numeric(row.timerLagMs),delayMs:numeric(row.timerDelayMs),
    dueMs:origin!==undefined&&typeof row.timerDueMs==="number"?numeric(row.timerDueMs-origin):null,
    callbackMs:origin!==undefined&&typeof row.timerCallbackAtMs==="number"?numeric(row.timerCallbackAtMs-origin):null,windowChildPid:numeric(row.timerWindowChildPid)}:null;
  // Hook metrics omit a zero abandoned count; an absent metric still provides no count at all.
  const abandoned=input.metric?.kind==="hook"?(input.metric.abandonedChildren===undefined?0:numeric(input.metric.abandonedChildren)):null;
  const children=ids.slice(0,128).map(pid=>{
    const owned=input.workers.find(row=>row.pid===pid), receipts=rows.filter(row=>row.childPid===pid);
    const find=(phase:HookLifecycleReceipt["phase"])=>receipts.find(row=>row.phase===phase);
    const spawn=find("spawn"),exit=find("exit"),kill=find("kill-request"),reapStart=find("reap-start"),reapEnd=find("reap-end"),output=find("output-end"),rss=find("rss-finish");
    const childPhases=phases.filter(row=>row.pid===pid).sort((a,b)=>a.seq-b.seq);
    const phaseApplies=input.phaseInstrumentation===true&&(owned?.kind??receipts[0]?.kind)==="worker";
    const beforeKill=kill?childPhases.filter(row=>row.atMs<=kill.atMs).at(-1):undefined;
    const exitTimers=receipts.filter(row=>row.phase==="timer-fired"&&row.timerWindowChildPid===pid);
    return {pid,kind:owned?.kind??receipts[0]?.kind??null,detached:owned?.detached??null,
      spawnMs:time(spawn),exitPromiseMs:time(exit),killRequestMs:time(kill),reapStartMs:time(reapStart),reapEndMs:time(reapEnd),outputEndMs:time(output),
      reaped:reapEnd?.reaped===1?true:reapEnd?.reaped===0?false:null,outputLate:output?.late===1?true:output?.late===0?false:null,
      outputAvailable:output?.outputAvailable===1?true:output?.outputAvailable===0?false:null,
      parentTimerAtReapStart:timerSnapshot(reapStart),parentTimerAtReapEnd:timerSnapshot(reapEnd),
      observedReapElapsedMs:reapStart&&reapEnd?numeric(reapEnd.atMs-reapStart.atMs):null,
      exitedWindowTimerFirings:exitTimers.slice(0,16).map(timerSnapshot),
      phaseInstrumentation:phaseApplies,
      bootReceiptPresent:childPhases.some(row=>row.phase===HookWorkerPhase.Boot),
      phaseTraceMissing:phaseApplies&&childPhases.length===0,
      phaseTracePartial:phaseApplies&&input.phaseTracePartial===true,
      phaseTraceTruncated:childPhases.length>512||childPhases.some(row=>row.phase===HookWorkerPhase.Truncated),
      lastWorkerPhaseBeforeKill:beforeKill?{phase:phaseLabel(beforeKill.phase),id:numeric(beforeKill.phase),seq:numeric(beforeKill.seq),
        msBeforeKill:kill?numeric(kill.atMs-beforeKill.atMs):null}:null,
      noPhaseReceiptMeaning:phaseApplies&&childPhases.length===0?(input.phaseTracePartial?"partial trace; preload entry unknown":"preload-entry-not-observed (exec/boot or missing trace)"):null,
      workerPhases:childPhases.slice(0,512).map(row=>({phase:phaseLabel(row.phase),id:numeric(row.phase),seq:numeric(row.seq),atMs:origin===undefined?null:numeric(row.atMs-origin)})),
      rss:rss?{source:["VmHWM","vmpeak-bound","platform-rusage","raw-fallback","unavailable"].includes(rss.source??"")?rss.source:null,known:numeric(rss.known),kb:numeric(rss.kb),rawKB:numeric(rss.rawKB),observationFailed:numeric(rss.observationFailed),
        counters:{vmhwm:numeric(rss.vmhwm),vmpeakBound:numeric(rss.vmpeakBound),platformRusage:numeric(rss.platformRusage),rawFallback:numeric(rss.rawFallback),unavailable:numeric(rss.unavailable)}}:null,
      relativeToWorkerExitedWindowMs:{spawn:relative(spawn),exitPromise:relative(exit),reapStart:relative(reapStart),reapEnd:relative(reapEnd)},
      receiptComplete:!!spawn&&!!exit&&!!reapEnd};
  });
  return {diagnostic:"hook-child-reap/v1",instrumented:true,event:input.event,variant:input.variant??null,run:input.run,logicalRun:input.logicalRun,parentPid:input.parentPid,
    expectedOwnedChildren:input.expectedOwnedChildren,expectation:input.expectation,observedOwnedChildren:input.workers.length,lifecycleChildren:ids.length,
    expectedWorkerChildren:input.expectedWorkerChildren??null,
    spawnAttempts:rows.filter(row=>row.phase==="spawn-attempt").length,spawnFailures:rows.filter(row=>row.phase==="spawn-failed").length,
    abandonedChildren:abandoned,metricPresent:!!input.metric,rssCoverage:HOOK_RSS_COVERAGE,rssScope:input.metric?.rssScope==="owned-images"?"owned-images":null,
    drainSkipped:input.metric?.kind==="hook"?(input.metric.drainSkipped===undefined?0:numeric(input.metric.drainSkipped)):null,
    drainStartMs:numeric(input.metric?.drainStartMs),drained:numeric(input.metric?.drained),
    workerExitedWindow:{boundMs:10,startMs:time(window),observedBoundMs:numeric(window?.boundMs),present:!!window},
    rssSources:sources?{vmhwm:numeric(sources.vmhwm),vmpeakBound:numeric(sources.vmpeakBound),platformRusage:numeric(sources.platformRusage),rawFallback:numeric(sources.rawFallback),unavailable:numeric(sources.unavailable)}:null,
    cliRawRssMB:numeric(input.cliRawRssMB),productionRssMB:numeric(input.metric?.rssMB),rawRssMB:numeric(input.metric?.rawRssMB),wallMs:numeric(input.metric?.wallMs),
    admission:evidence.slice(0,256).map(row=>({phase:row.phase,loads:row.loads,exact:numeric(row.exact),native:numeric(row.native),childPid:numeric(row.childPid),remainingUs:numeric(row.remainingUs),host:numeric(row.host)})),
    phaseInstrumentation:input.phaseInstrumentation===true,
    lifecyclePresent:rows.length>0,truncated:ids.length>128||evidence.length>256||rows.some(row=>row.phase==="truncated")||phases.some(row=>row.phase===HookWorkerPhase.Truncated),children};
}
