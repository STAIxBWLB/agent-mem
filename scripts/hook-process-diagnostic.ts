import type { HookLifecycleReceipt, HookProcessEvidence, HookWorkerProcess } from "../test/fakes/hooks-process-observer.ts";
import type { MetricSample } from "../src/memory/metrics.ts";
import { HOOK_RSS_COVERAGE } from "../src/hook-resources.ts";

interface HookDiagnosticInput {
  event: "SessionStart" | "PreToolUse" | "Stop" | "SessionEnd";
  run: number; logicalRun: number; parentPid: number;
  variant?: "linux" | "darwin-codepath" | "baseline" | "timeout-functional" | "timeout-native";
  expectedWorkerChildren?: number;
  expectedOwnedChildren: number | null;
  expectation: "fixture-contract" | "observed-spawn-attempts";
  workers: readonly HookWorkerProcess[]; evidence: readonly HookProcessEvidence[];
  lifecycle: readonly HookLifecycleReceipt[]; metric?: MetricSample; cliRawRssMB?: number;
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
  const children=ids.slice(0,128).map(pid=>{
    const owned=input.workers.find(row=>row.pid===pid), receipts=rows.filter(row=>row.childPid===pid);
    const find=(phase:HookLifecycleReceipt["phase"])=>receipts.find(row=>row.phase===phase);
    const spawn=find("spawn"),exit=find("exit"),kill=find("kill-request"),reapStart=find("reap-start"),reapEnd=find("reap-end"),output=find("output-end"),rss=find("rss-finish");
    return {pid,kind:owned?.kind??spawn?.kind??null,detached:owned?.detached??null,
      spawnMs:time(spawn),exitPromiseMs:time(exit),killRequestMs:time(kill),reapStartMs:time(reapStart),reapEndMs:time(reapEnd),outputEndMs:time(output),
      reaped:reapEnd?.reaped===1?true:reapEnd?.reaped===0?false:null,outputLate:output?.late===1?true:output?.late===0?false:null,
      outputAvailable:output?.outputAvailable===1?true:output?.outputAvailable===0?false:null,
      rss:rss?{source:["VmHWM","vmpeak-bound","platform-rusage","raw-fallback","unavailable"].includes(rss.source??"")?rss.source:null,known:numeric(rss.known),kb:numeric(rss.kb),rawKB:numeric(rss.rawKB),observationFailed:numeric(rss.observationFailed),
        counters:{vmhwm:numeric(rss.vmhwm),vmpeakBound:numeric(rss.vmpeakBound),platformRusage:numeric(rss.platformRusage),rawFallback:numeric(rss.rawFallback),unavailable:numeric(rss.unavailable)}}:null,
      relativeToWorkerExitedWindowMs:{spawn:relative(spawn),exitPromise:relative(exit),reapStart:relative(reapStart),reapEnd:relative(reapEnd)},
      receiptComplete:!!spawn&&!!exit&&!!reapEnd};
  });
  return {diagnostic:"hook-child-reap/v1",instrumented:true,event:input.event,variant:input.variant??null,run:input.run,logicalRun:input.logicalRun,parentPid:input.parentPid,
    expectedOwnedChildren:input.expectedOwnedChildren,expectation:input.expectation,observedOwnedChildren:input.workers.length,
    expectedWorkerChildren:input.expectedWorkerChildren??null,
    spawnAttempts:rows.filter(row=>row.phase==="spawn-attempt").length,spawnFailures:rows.filter(row=>row.phase==="spawn-failed").length,
    abandonedChildren:numeric(input.metric?.abandonedChildren),metricPresent:!!input.metric,rssCoverage:HOOK_RSS_COVERAGE,rssScope:input.metric?.rssScope==="owned-images"?"owned-images":null,
    workerExitedWindow:{boundMs:10,startMs:time(window),observedBoundMs:numeric(window?.boundMs),present:!!window},
    rssSources:sources?{vmhwm:numeric(sources.vmhwm),vmpeakBound:numeric(sources.vmpeakBound),platformRusage:numeric(sources.platformRusage),rawFallback:numeric(sources.rawFallback),unavailable:numeric(sources.unavailable)}:null,
    cliRawRssMB:numeric(input.cliRawRssMB),productionRssMB:numeric(input.metric?.rssMB),rawRssMB:numeric(input.metric?.rawRssMB),wallMs:numeric(input.metric?.wallMs),
    admission:evidence.slice(0,256).map(row=>({phase:row.phase,loads:row.loads,exact:numeric(row.exact),native:numeric(row.native),childPid:numeric(row.childPid),remainingUs:numeric(row.remainingUs),host:numeric(row.host)})),
    lifecyclePresent:rows.length>0,truncated:ids.length>128||evidence.length>256||rows.some(row=>row.phase==="truncated"),children};
}
