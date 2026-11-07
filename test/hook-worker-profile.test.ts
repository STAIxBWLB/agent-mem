import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHookWorkerProfile } from "./fakes/hooks-worker-profile.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import { HookWorkerPhase, instrumentHookWorkerPhases, instrumentTranscriptPhaseSource, instrumentProfileCaptureSource, instrumentProfileTranscriptSource, instrumentProfileWorkerSource } from "./fakes/hooks-worker-phases.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
const sourceRoot = resolve(import.meta.dir,"..");

test("profiling anchors are exact and default source transforms do not add profiling phases", () => {
  const worker=readFileSync(join(sourceRoot,"src/session-brief-worker.ts"),"utf8"), transcript=readFileSync(join(sourceRoot,"src/hook-transcript.ts"),"utf8"),capture=readFileSync(join(sourceRoot,"src/memory/capture.ts"),"utf8");
  expect(instrumentHookWorkerPhases(worker)).not.toContain("emit')](48)");
  expect(instrumentTranscriptPhaseSource(transcript)).not.toContain("emit')](40)");
  expect(instrumentProfileTranscriptSource(transcript)).toContain("emit')](40)");
  expect(instrumentProfileCaptureSource(capture)).toContain("emit')](46)");
  expect(instrumentProfileWorkerSource(worker)).toContain("emit')](48)");
  expect(() => instrumentProfileTranscriptSource(transcript.replace("function cursorDatabase(","function changedDatabase("))).toThrow("anchor changed");
  expect(() => instrumentProfileCaptureSource(capture.replace("const db = new Database(file, { create: true });","const db = changed();"))).toThrow("anchor changed");
  expect(() => instrumentProfileWorkerSource(worker.replace("return { options, expectedScope, project };","return undefined;"))).toThrow("anchor changed");
});

test("default observer does not add profile-body while LIGHT has no worker preload or timer proxy", () => {
  const root=mkdtempSync(join(tmpdir(),"amem-profile-mode-")), other=mkdtempSync(join(tmpdir(),"amem-profile-default-"));
  try {
    const ordinary=hookProcessObserver(other,false,sourceRoot,true,false),light=createHookWorkerProfile(root,sourceRoot,"light");
    expect(readFileSync(ordinary.preload,"utf8")).not.toContain("profile-body");
    const preload=readFileSync(light.observer.preload,"utf8");
    expect(preload).toContain("profile-body"); expect(preload).not.toContain("worker-phases/preload.ts");
    expect(preload).not.toContain("globalThis.setTimeout=new Proxy");
    const entry=readFileSync(light.entry,"utf8");
    expect(entry).not.toMatch(/^import /m);
    expect(entry.indexOf("process.uptime() * 1000")).toBeLessThan(entry.indexOf("await import("));
    expect(entry).toContain("deadlineMs:1000"); expect(readFileSync(light.clockFile,"utf8")).toBe("");
  } finally { rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true}); }
});

for(const mode of ["light","detailed"] as const)test("functional real-worker profiling acknowledges final body: "+mode,async()=>{
  const f=hookFixture();
  try {
    await f.seed();
    const profile=createHookWorkerProfile(f.root,sourceRoot,mode),transcript=join(f.root,"profile-transcript.jsonl");
    writeFileSync(transcript,JSON.stringify({type:"system",subtype:"away_summary",timestamp:new Date().toISOString(),content:"isolated profile recap"})+"\n");
    const child=Bun.spawn([process.execPath,"--smol",profile.entry,"Stop"],{cwd:f.cwd,env:{...f.env,BUN_OPTIONS:`--preload=${profile.observer.preload}`},stdin:Buffer.from(JSON.stringify({cwd:f.cwd,hook_event_name:"Stop",session_id:"profile-fixture",transcript_path:transcript})),stdout:"pipe",stderr:"pipe"});
    const stderr=await new Response(child.stderr).text();expect(await child.exited,stderr).toBe(0);
    const lifecycle=profile.observer.lifecycle(child.pid),body=lifecycle.filter(row=>row.phase==="profile-body");
    expect(body).toHaveLength(1);expect(body[0]?.complete).toBe(1);expect(body[0]?.valid).toBe(1);
    expect(profile.observer.read().some(row=>row.kind==="worker"&&row.pid===body[0]?.childPid)).toBe(true);
    const clocks=readFileSync(profile.clockFile,"utf8").trim().split("\n").map(line=>JSON.parse(line) as {phase:number;atMs:number;observedAtMs:number;hostDeadlineMs:number});
    expect(clocks.map(row=>row.phase)).toEqual([1,2,3]);expect(clocks.every(row=>row.hostDeadlineMs===1000&&row.observedAtMs>=row.atMs)).toBe(true);
    expect(clocks[1]!.atMs).toBeLessThanOrEqual(body[0]!.atMs);expect(body[0]!.atMs).toBeLessThanOrEqual(clocks[2]!.atMs);
    const phases=profile.observer.workerPhases(child.pid);
    if(mode==="light")expect(phases).toEqual([]);
    else {
      const ids=phases.map(row=>row.phase);
      for(const id of [HookWorkerPhase.CursorInitBegin,HookWorkerPhase.CursorInitReady,HookWorkerPhase.CursorFinishBegin,HookWorkerPhase.CursorFinalCommitBegin,HookWorkerPhase.CursorFinalCommitReturn,HookWorkerPhase.CursorClosed,HookWorkerPhase.CaptureDbOpenBegin,HookWorkerPhase.CaptureDbOpened,HookWorkerPhase.IdentityReady,HookWorkerPhase.StoreClosed])expect(ids).toContain(id);
      expect(ids).not.toContain(HookWorkerPhase.AnchorRefused);
      expect(phases.find(row=>row.phase===HookWorkerPhase.StoreClosed)!.atMs).toBeLessThanOrEqual(body[0]!.atMs);
    }
  } finally { f.close(); }
},15000);
