import { expect, test } from "bun:test";
import { createPairMetrics } from "../scripts/hook-pair-metrics.ts";

const row={diagnostic:"hook-child-reap/v1",variant:"phase-hooks",phaseInstrumentation:true,parentPid:11,event:"PostToolUse",workload:"plain",run:1,logicalRun:1,
  epochOriginMs:1000,outerStartedAtMs:1000,outerFinishedAtMs:1040,outerWallMs:40,wallMs:38,drainSkipped:1,deferred:false,rssSources:{unavailable:2},
  children:[{pid:22,kind:"worker",reaped:false,phaseInstrumentation:true,phaseTracePartial:false,phaseTraceTruncated:false,phaseTraceMissing:false,killRequestMs:30,
    workerPhases:[{id:1,seq:1,atMs:1},{id:9,seq:2,atMs:2},{id:10,seq:3,atMs:4},{id:11,seq:4,atMs:10}]}]};
test("P carries completed write and censored close metrics without inventing an end",()=>{
  const metrics=createPairMetrics("P");metrics.add(row);const report=metrics.summarize([{startMs:995,endMs:1045}]);
  expect(report.all).toMatchObject({invocations:1,workers:1,parentKillRequested:1,reapMisses:1,drainSkipped:1,
    durations:{available:true,close:{started:1,completed:0,censored:1,allStarted:{bounds:{max:{lowerMs:20,upperMs:null,upperUnbounded:true}}}},write:{completed:1,completedMs:{max:2}}}});
  expect(report.overlap[0]).toMatchObject({inProbeSpan:true,probeWorkerOverlapMs:40,kills:[{epochMs:1030,inProbeWorkerWindow:true}]});
});
test("C close and write durations stay unavailable, never fabricated zeroes",()=>{
  const metrics=createPairMetrics("C");metrics.add({...row,phaseInstrumentation:false,children:row.children.map(child=>({...child,phaseInstrumentation:false,workerPhases:[]}))});
  expect(metrics.summarize().all.durations).toEqual({available:false,reason:"No worker phase preload in parent-only control"});
  expect(metrics.summarize().overlapSummary.unknown).toBe(1);
});
test("repeated summaries do not double-count invocations and overlap gaps remain visible",()=>{
  const metrics=createPairMetrics("P");metrics.add(row);metrics.add(row);
  metrics.add({diagnostic:"budget-attempt",check:"plain-1",attempt:1,outcome:"stall"});
  metrics.add({diagnostic:"budget-attempt",check:"plain-1",attempt:2,outcome:"stall"});
  const report=metrics.summarize([{startMs:1000,endMs:1010},{startMs:1005,endMs:1020},{startMs:1025,endMs:1040}]);
  expect(report.all).toMatchObject({invocations:1,stalls:2});expect(report.overlap[0]?.probeWorkerOverlapMs).toBe(35);
});
test("partial P traces report missing coverage and a contaminated C is explicit",()=>{
  const metrics=createPairMetrics("P");metrics.add({...row,children:row.children.map(child=>({...child,phaseTracePartial:true}))});
  expect(metrics.summarize().all.durations).toMatchObject({available:true,coverageUnknownWorkers:1,close:{started:0}});
  const control=createPairMetrics("C");control.add(row);expect(control.summarize().metadataInvalid).toBe(1);
});
