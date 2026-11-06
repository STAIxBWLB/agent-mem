import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { inspectSyncPlacement } from "../src/memory/sync-placement-inspection.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { readPlacementJournal } from "../src/memory/sync-placement-journal-storage.ts";
import { readPlacementProjection } from "../src/memory/sync-placement-journal.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { readSyncPlacementWriterRoots } from "../src/memory/sync-placement-writer-roots.ts";
import { createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";
import { syncPlacementMemory } from "../src/memory/sync-placement-transport.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { appendPlacementEvent } from "../src/memory/sync-placement-journal-storage.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { realPath } from "../src/memory/platform.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function install(root:string,name:string){
  const dir=join(root,name);for(const p of [dir,join(dir,"src"),join(dir,"bin")])mkdirSync(p,{mode:0o755});
  writeFileSync(join(dir,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.22.0"}),{mode:0o644});
  writeFileSync(join(dir,"src","index.ts"),"// measured fixture\n",{mode:0o644});writeFileSync(join(dir,"bin","amem.js"),"// not executed\n",{mode:0o755});return dir;
}
async function fixture(){
  const f=await placementActivationFixture();cleanup.push(f.close);const extra=install(f.root,"initial writer");
  const initial=f.options("apply");initial.writerRoots=[activationOwnRoot,extra];await activateSyncPlacement(initial);
  const profile=JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")),epoch=profile.placementHead as string;
  return{...f,extra,epoch};
}
function floor(home:string){writeFileSync(join(home,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.22.0",since:"2026-11-06"}])+"\n",{mode:0o600});}
function records(home:string,epoch:string){const dir=join(home,"sync-placement","epochs",epoch);return Object.fromEntries(readdirSync(dir).filter(n=>!n.startsWith("writer-")).map(n=>[n,readFileSync(join(dir,n)).toString("base64")]));}

test("root retirement renews the same epoch and resumes publication with unchanged holds/receipts",async()=>{
  const f=await fixture(),remote=createInspectionRemote(f.root);let store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
  const attest=()=>activePlacementWriterContext(f.base,activationOwnRoot).attest();
  let beforeInspection:Awaited<ReturnType<typeof inspectSyncPlacement>>;
  try{
    const first=await syncMemory(store,{remote,visibility:async()=>"private",placementAttestation:attest});expect(first.ok,JSON.stringify(first)).toBe(true);
    beforeInspection=await inspectSyncPlacement(store,{placementAttestation:attest});expect(beforeInspection.complete).toBe(true);
  }finally{store.close();}
  const old=records(f.base,f.epoch),initialMap=readFileSync(join(f.base,"sync-placement-writer-roots.json")),fence=readFileSync(join(f.base,"sync-placement","active.json"));
  const previousJournal=readPlacementJournal(f.base,f.epoch),previousProjection=readPlacementProjection(f.base,f.epoch);
  const next=install(f.root,"upgraded writer");rmSync(f.extra,{recursive:true});
  expect(()=>activePlacementWriterContext(f.base,activationOwnRoot)).toThrow();
  floor(f.base);const options=f.options("apply");options.writerRoots=[activationOwnRoot,next];
  expect(await activateSyncPlacement(options)).toMatchObject({active:true,renewed:true,epochHash:f.epoch,sequence:1,remainingRevisions:63});
  expect(records(f.base,f.epoch)).toEqual(old);expect(readPlacementJournal(f.base,f.epoch).records).toEqual(previousJournal.records);expect(readPlacementProjection(f.base,f.epoch)).toEqual(previousProjection);
  expect(readFileSync(join(f.base,"sync-placement-writer-roots.json"))).toEqual(initialMap);expect(readFileSync(join(f.base,"sync-placement","active.json"))).toEqual(fence);
  expect(readSyncPlacementWriterRoots(f.base)).toContain(f.extra);expect(readEffectiveSyncPlacementWriters(f.base).roots).toEqual([realPath(activationOwnRoot),next].sort());
  store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
  try{
    const after=await inspectSyncPlacement(store,{placementAttestation:attest});expect(after.complete).toBe(true);expect(after).toEqual(beforeInspection!);
    const fresh=store.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text:"permitted after renewal",about:[]});
    const result=await syncMemory(store,{remote,visibility:async()=>"private",placementAttestation:attest});expect(result.ok,JSON.stringify(result)).toBe(true);
    expect(reachableInspectionRowIds(remote)).toEqual([f.allowed,fresh].sort());expect(store.get(f.declined,f.project)?.text).toBe("NEVER_PUBLIC_ACTIVATION_BODY");
    expect(readPlacementJournal(f.base,f.epoch).records.slice(0,previousJournal.records.length)).toEqual(previousJournal.records);
    const proof=readEffectiveSyncPlacementWriters(f.base);proof.assertCurrent();
    const dir=join(f.base,"sync-placement","epochs",f.epoch),chunk=readdirSync(dir).filter(n=>/^records-/.test(n)).sort()[0]!;
    const file=join(dir,chunk),original=readFileSync(file,"utf8"),changed=original.replace(/"effectHash":"([a-f0-9])/,(_,first:string)=>'"effectHash":"'+(first==="a"?"b":"a"));
    expect(changed.length).toBe(original.length);expect(changed).not.toBe(original);
    writeFileSync(file,changed,{mode:0o600});expect(()=>proof.assertCurrent()).toThrow();writeFileSync(file,original,{mode:0o600});
  }finally{store.close();}
},60_000);

test("renewal requires the person floor and explicit complete roots without creating another epoch",async()=>{
  const f=await fixture(),before=records(f.base,f.epoch);
  const options=f.options("apply");options.writerRoots=[activationOwnRoot,f.extra];
  await expect(activateSyncPlacement(options)).rejects.toThrow("0.22.0");expect(records(f.base,f.epoch)).toEqual(before);
  floor(f.base);await expect(activateSyncPlacement({...options,writerRoots:[]})).rejects.toThrow("explicit complete --writer-root");
  expect(readdirSync(join(f.base,"sync-placement","epochs"))).toEqual([f.epoch]);expect(existsSync(join(f.base,"sync-placement-writer-renewal.json"))).toBe(false);
},60_000);

test("a precommit renewal can be abandoned after pin drift and retried explicitly",async()=>{
  const f=await fixture();floor(f.base);const next=install(f.root,"next writer"),options=f.options("apply");options.writerRoots=[activationOwnRoot,next];
  options.renewalCheckpoint=phase=>{if(phase==="revision-fsync")throw Error("isolated precommit interruption");};
  await expect(activateSyncPlacement(options)).rejects.toThrow();
  const ordinary=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});try{expect(ordinary.get(f.allowed,f.project)).toBeDefined();}finally{ordinary.close();}
  writeFileSync(join(next,"src","index.ts"),"// moved again\n",{mode:0o644});await expect(activateSyncPlacement(f.options("resume"))).rejects.toThrow();
  expect(await activateSyncPlacement(f.options("abandon"))).toMatchObject({active:true,abandoned:true,sequence:0});
  const reviewed=f.options("apply");reviewed.writerRoots=[activationOwnRoot,next];expect(await activateSyncPlacement(reviewed)).toMatchObject({renewed:true,sequence:1});
},60_000);

for(const pending of ["publication","append","source"] as const)test("renewal refuses existing "+pending+" recovery before any effect",async()=>{
  const f=await fixture();floor(f.base);
  if(pending==="publication"){
    const store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
    try{
      const result=await syncPlacementMemory(store,{remote:createInspectionRemote(f.root),visibility:async()=>"private",placementAttestation:()=>activePlacementWriterContext(f.base,activationOwnRoot).attest()},phase=>{if(phase==="plan-fsynced")throw Error("isolated retained publication");});
      expect(result.ok).toBe(false);expect(readPlacementJournal(f.base,f.epoch).publicationReservation).toBeDefined();
    }finally{store.close();}
  }else if(pending==="append"){
    const capture=captureSyncPlacementContext(f.base,{attest:()=>activePlacementWriterContext(f.base,activationOwnRoot).attest()}),row=[...capture.rows.values()].find(r=>r.key.id===f.declined)!;
    const mutation=acquireMutation(f.base);if(!mutation)throw Error("fixture mutation unavailable");
    try{expect(()=>appendPlacementEvent(f.base,f.epoch,{kind:"hold",requestId:"a".repeat(64),effectHash:"b".repeat(64),key:row.key,sourcePlacement:"synced",reason:"personal-data"},f.epoch,{mutation,assertCurrent(){},phase(stage){if(stage==="intent-fsync")throw Error("isolated retained append");}})).toThrow();}finally{mutation();}
    expect(readPlacementJournal(f.base,f.epoch).pending).toBe(true);
  }else{
    const dir=join(f.base,"projects",shardKeyHash(f.project),"prune-plans");mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,"pending-log-"+"a".repeat(16)+".json"),"{}",{mode:0o600});
  }
  const before=inspectionFilesystemSnapshot(f.base),options=f.options("apply");options.writerRoots=[activationOwnRoot,f.extra];
  await expect(activateSyncPlacement(options)).rejects.toThrow("restore the inventoried install");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect(existsSync(join(f.base,"sync-placement-writer-renewal.json"))).toBe(false);
},60_000);

for(const phase of ["intent-started","intent-written","intent-fsync","intent-published","revision-written","revision-fsync","commit-started","commit-written","commit-fsync","intent-cleared"] as const)
test("native renewal SIGKILL recovers the same epoch: "+phase,async()=>{
  const f=await fixture();floor(f.base);const next=install(f.root,"native next writer"),old=records(f.base,f.epoch);
  const child=Bun.spawnSync([process.execPath,join(import.meta.dir,"fakes/sync-placement-renewal-crash.ts"),f.base,activationOwnRoot,phase,JSON.stringify([activationOwnRoot,next])],{cwd:f.cwd,env:f.env,stdout:"pipe",stderr:"pipe",timeout:30_000});
  expect(child.exitCode).not.toBe(0);expect(child.stdout.toString(),child.stderr.toString()).toContain(phase);
  let result:Awaited<ReturnType<typeof activateSyncPlacement>>;
  if(["intent-started","intent-written","intent-fsync"].includes(phase)){
    await expect(activateSyncPlacement(f.options("resume"))).rejects.toThrow("--abandon");
    expect(await activateSyncPlacement(f.options("abandon"))).toMatchObject({abandoned:true});
    const reviewed=f.options("apply");reviewed.writerRoots=[activationOwnRoot,next];result=await activateSyncPlacement(reviewed);
  }else result=await activateSyncPlacement(f.options("resume"));
  expect(result?.active).toBe(true);
  expect(readEffectiveSyncPlacementWriters(f.base).revisionSequence).toBe(1);expect(records(f.base,f.epoch)).toEqual(old);
  expect(readdirSync(join(f.base,"sync-placement","epochs"))).toEqual([f.epoch]);expect(existsSync(join(f.base,"sync-placement-writer-renewal.json"))).toBe(false);
},60_000);
