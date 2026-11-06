import { expect, test } from "bun:test";
import { addWorkerPhaseDurations, emptyPhaseDurations, summarizePhaseDurations, type PhaseDurationRow } from "../scripts/hook-phase-durations.ts";
const rows = (...values: [number, number][]): PhaseDurationRow[] => values.map(([id,atMs],i) => ({id,atMs,seq:i+1}));

test("empty duration metrics have no fake zero quantiles", () => {
  const result = summarizePhaseDurations(emptyPhaseDurations());
  expect(result.close.started).toBe(0); expect(result.close.completedMs).toBeNull();
  expect(result.close.allStarted.bounds).toBeNull(); expect(result.write.completedMs).toBeNull();
});
test("close bounds include the censored start and use kill time, never exit/reap time", () => {
  const acc = emptyPhaseDurations();
  addWorkerPhaseDurations(acc,rows([11,100],[12,102]),null);
  addWorkerPhaseDurations(acc,rows([11,200],[12,204]),null);
  addWorkerPhaseDurations(acc,rows([11,300]),315); // No return; hypothetical exit at 900 is deliberately not an input.
  const s = summarizePhaseDurations(acc).close;
  expect(s.started).toBe(3); expect(s.completed).toBe(2); expect(s.censored).toBe(1);
  expect(s.completedMs).toEqual({p50:2,p95:4,p99:4,max:4,over10:0});
  expect(s.allStarted.bounds?.p50).toEqual({lowerMs:4,upperMs:4,upperUnbounded:false});
  expect(s.allStarted.bounds?.p99).toEqual({lowerMs:15,upperMs:null,upperUnbounded:true});
  expect(s.allStarted.over10Minimum).toBe(1); expect(s.allStarted.over10Maximum).toBe(1);
});
test("repeated writes count every interval, including an unreturned final write", () => {
  const acc = emptyPhaseDurations();
  addWorkerPhaseDurations(acc,rows([9,0],[16,1],[17,2],[18,3],[10,4],[9,10],[10,22],[9,30],[17,31]),35);
  const s = summarizePhaseDurations(acc).write;
  expect(s.started).toBe(3); expect(s.completed).toBe(2); expect(s.censored).toBe(1);
  expect(s.completedMs?.max).toBe(12); expect(s.completedMs?.over10).toBe(1);
  expect(s.allStarted.over10Minimum).toBe(1); expect(s.allStarted.over10Maximum).toBe(2);
  expect(acc.write.intervals).toHaveLength(3);
});
test("throw, Stop, next start and incompatible transition are unknown, not automatic right censoring", () => {
  for (const middle of [19,15,6,11,13]) {
    const acc = emptyPhaseDurations(); addWorkerPhaseDurations(acc,rows([9,10],[middle,11]),20);
    expect(summarizePhaseDurations(acc).write.censored).toBe(0);
    expect(summarizePhaseDurations(acc).write.unknown).toBe(1);
  }
  const acc = emptyPhaseDurations(); addWorkerPhaseDurations(acc,rows([9,0],[9,2],[10,3]),10);
  expect(summarizePhaseDurations(acc).write.started).toBe(2);
  expect(summarizePhaseDurations(acc).write.unknownReasons["next-start"]).toBe(1);
  const recovered = emptyPhaseDurations(); addWorkerPhaseDurations(recovered,rows([9,0],[19,1],[10,2]),null);
  expect(summarizePhaseDurations(recovered).write.completed).toBe(1);
});
test("orphan returns and malformed or overflowing workers are explicitly incomplete", () => {
  const acc = emptyPhaseDurations(); addWorkerPhaseDurations(acc,rows([12,1]),null);
  addWorkerPhaseDurations(acc,[{id:11,seq:2,atMs:1}],null);
  addWorkerPhaseDurations(acc,Array.from({length:513},(_,i)=>({id:1,seq:i+1,atMs:i})),null);
  const s = summarizePhaseDurations(acc);
  expect(s.incomplete).toBe(true); expect(s.close.orphanReturns).toBe(1);
  expect(s.validation).toEqual({malformedWorkers:1,overBoundWorkers:1,truncatedWorkers:0,anchorRefusedWorkers:0});
  expect(s.close.started).toBe(0); // Whole invalid/overflow inputs rejected, never silently trimmed into fake intervals.
});
test("explicit truncation and missing kill do not create an invented lower bound", () => {
  const acc = emptyPhaseDurations(); addWorkerPhaseDurations(acc,rows([11,10],[30,11]),50);
  addWorkerPhaseDurations(acc,rows([11,20]),null);
  const s = summarizePhaseDurations(acc);
  expect(s.incomplete).toBe(true); expect(s.validation.truncatedWorkers).toBe(1);
  expect(s.close.unknown).toBe(2); expect(s.close.censored).toBe(0);
  expect(s.close.allStarted.bounds?.max).toEqual({lowerMs:0,upperMs:null,upperUnbounded:true});
  expect(s.close.allStarted.over10Minimum).toBe(0); expect(s.close.allStarted.over10Maximum).toBe(2);
});
