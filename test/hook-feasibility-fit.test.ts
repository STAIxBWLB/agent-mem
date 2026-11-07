import { expect,test } from "bun:test";
import { completionFit,feasibilityObservation,type FitInterval } from "../scripts/hook-feasibility-fit.ts";

test("p99 includes every censor, reports its bound, and keeps the actual112ms ceiling",()=>{
  const rows:FitInterval[]=Array.from({length:197},()=>({kind:"complete",ms:110}));
  rows.push({kind:"censored",lowerMs:1000},{kind:"censored",lowerMs:1000},{kind:"censored",lowerMs:1000});
  expect(completionFit(rows,112)).toMatchObject({samples:200,censored:3,verdict:"does-not-fit",allSamples:{p99:{lowerMs:1000,upperMs:null,upperUnbounded:true}}});
  expect(completionFit([{kind:"complete",ms:114}],115).verdict).toBe("fits-at-p99");
  expect(completionFit([{kind:"complete",ms:114}],112).verdict).toBe("does-not-fit");
});
test("unknown clocks are not zero-cost completed observations",()=>{
  expect(completionFit([{kind:"unknown"}],112)).toMatchObject({complete:0,unknown:1,verdict:"not-established",completedMs:null});
  expect(completionFit([],115).verdict).toBe("not-established");
  expect(()=>completionFit([{kind:"complete",ms:-1}],115)).toThrow("invalid");
});
test("joint fit uses boot-to-valid-final-body completion, never sums component p99s",()=>{
  const observation=feasibilityObservation({mode:"light",state:"warm",event:"PostToolUse",sample:1,safe:true,complete:true,expectedRowVerified:true,
    clocks:[{phase:1,atMs:1000}],parentLifecycle:[{phase:"profile-body",complete:1,valid:1,atMs:1110},{phase:"exit",kind:"worker",atMs:1112}],workerPhases:[]});
  expect(observation.joint).toEqual({kind:"complete",ms:110});expect(observation.detailed).toBeNull();
  expect(observation.jointToWorkerExit).toEqual({kind:"complete",ms:112});
});
test("an early failed operation is unknown, a positive profiling-deadline kill is censored",()=>{
  const base={mode:"detailed",state:"cold",event:"Stop",sample:1,safe:true,complete:false,expectedRowVerified:false,profilingWindowMs:1000,clocks:[{phase:1,atMs:1000}],workerPhases:[]};
  expect(feasibilityObservation({...base,parentLifecycle:[{phase:"kill-request",kind:"worker",atMs:1070}]}).joint.kind).toBe("unknown");
  expect(feasibilityObservation({...base,parentLifecycle:[{phase:"kill-request",kind:"worker",atMs:1973}]}).joint).toEqual({kind:"censored",lowerMs:973});
});
