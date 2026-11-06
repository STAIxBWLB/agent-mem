import { afterEach, expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openShardStore } from "../src/memory/store.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { readPlacementProjection } from "../src/memory/sync-placement-journal.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { inspectionFilesystemSnapshot, createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
import { placementActivationFixture, activationOwnRoot as ownRoot } from "./fakes/sync-placement-activation.ts";
async function fixture(){const f=await placementActivationFixture();cleanup.push(f.close);return f;}

test("initial placement dry-run is authority-free and byte/mtime read-only; apply enables filtered sync",async()=>{
  const f=await fixture(),before=inspectionFilesystemSnapshot(f.base);
  const preview=await activateSyncPlacement(f.options("dry-run"));
  expect(preview).toMatchObject({active:false,forwardOnly:true,quiescence:"deferred-to-apply",source:{declined:1}});
  expect(JSON.stringify(preview)).not.toContain("NEVER_PUBLIC_ACTIVATION_BODY");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  const applied=await activateSyncPlacement(f.options("apply"));expect(applied.active).toBe(true);
  expect(existsSync(join(f.base,"sync-placement-activation.json"))).toBe(false);
  const profile=JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8"));expect(profile.publicationFormat).toBe("agent-mem.sync-placement/v1");
  const remote=createInspectionRemote(f.root),store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
  try{
    const writers=activePlacementWriterContext(f.base,ownRoot);
    const result=await syncMemory(store,{remote,visibility:async()=>"private",placementAttestation:writers.attest});expect(result.ok,JSON.stringify(result)).toBe(true);
    expect(result.placementPublication).toMatchObject({exported:1,withheld:1});
    expect(reachableInspectionRowIds(remote)).toEqual([f.allowed]);expect(store.get(f.declined,f.project)?.text).toBe("NEVER_PUBLIC_ACTIVATION_BODY");
    expect(readPlacementProjection(f.base,profile.placementHead).states.find(row=>row.key.id===f.declined)?.held).toBe(true);
  }finally{store.close();}
},60_000);

test("already-active apply refuses renewal without changing the epoch or evidence",async()=>{
  const f=await fixture();await activateSyncPlacement(f.options("apply"));const before=inspectionFilesystemSnapshot(f.base);
  await expect(activateSyncPlacement(f.options("apply"))).rejects.toThrow("an amem release that supports renewal");
  expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
});

test("a valid marker above policy string limits can resume the frozen precommit intent",async()=>{
  const f=await fixture(),file=join(f.base,"shards.json");
  // Existing v2 readers allow whitespace; its raw bytes remain part of the immutable activation proof.
  writeFileSync(file," ".repeat(20_000)+readFileSync(file,"utf8"),{mode:0o600});
  const apply=f.options("apply");apply.checkpoint=stage=>{if(stage==="after-intent")throw Error("isolated crash after durable intent");};
  await expect(activateSyncPlacement(apply)).rejects.toThrow();
  const intent=JSON.parse(readFileSync(join(f.base,"sync-placement-activation.json"),"utf8"));expect(intent.previousShards.length).toBeGreaterThan(16*1024);
  const resumed=await activateSyncPlacement(f.options("resume"));expect(resumed.active).toBe(true);
  expect(existsSync(join(f.base,"sync-placement-activation.json"))).toBe(false);
},60_000);

for(const phase of ["after-intent","after-epoch","after-root-map","after-shards","after-profile","after-fence","after-remove"] as const)
  test("native SIGKILL resumes only the frozen activation: "+phase,async()=>{
    const f=await fixture(),child=Bun.spawnSync([process.execPath,join(import.meta.dir,"fakes/sync-placement-activation-crash.ts"),f.base,ownRoot,phase],{cwd:f.cwd,env:f.env,stdout:"pipe",stderr:"pipe",timeout:30_000});
    expect(child.exitCode).not.toBe(0);expect(child.stdout.toString(),child.stderr.toString()).toContain(phase);
    if(!["after-fence","after-remove"].includes(phase))expect(()=>openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true})).toThrow();
    const beforeResume=readFileSync(join(f.base,"formats.json"));
    const result=await activateSyncPlacement(f.options("resume"));expect(result.active).toBe(true);
    expect(readFileSync(join(f.base,"formats.json"))).toEqual(beforeResume);
    expect(existsSync(join(f.base,"sync-placement-activation.json"))).toBe(false);
    const store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
    try{expect(store.get(f.allowed,f.project)?.text).toBe("initial activation permitted original");expect(store.get(f.declined,f.project)?.text).toBe("NEVER_PUBLIC_ACTIVATION_BODY");}finally{store.close();}
  },60_000);

test("precommit policy drift refuses resume without a new epoch or source rewrite",async()=>{
  const f=await fixture(),options=f.options("apply");options.checkpoint=stage=>{if(stage==="after-intent")throw Error("isolated precommit crash");};
  await expect(activateSyncPlacement(options)).rejects.toThrow();
  const intent=readFileSync(join(f.base,"sync-placement-activation.json")),profile=readFileSync(join(f.base,"profile.json"));
  writeFileSync(join(f.base,"amem.config.json"),JSON.stringify({piiPatterns:["NEVER_PUBLIC_","additional restriction"]}),{mode:0o600});
  await expect(activateSyncPlacement(f.options("resume"))).rejects.toThrow();
  expect(readFileSync(join(f.base,"sync-placement-activation.json"))).toEqual(intent);expect(readFileSync(join(f.base,"profile.json"))).toEqual(profile);
},60_000);

test("postcommit source and policy progress do not turn cleanup into a stale-plan refusal",async()=>{
  const f=await fixture(),options=f.options("apply");options.checkpoint=stage=>{if(stage==="after-fence")throw Error("isolated committed crash");};
  await expect(activateSyncPlacement(options)).rejects.toThrow();
  const store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});let later:string;
  try{later=store.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text:"later committed source progress",about:[]});}finally{store.close();}
  writeFileSync(join(f.base,"amem.config.json"),JSON.stringify({piiPatterns:["NEVER_PUBLIC_","later committed"]}),{mode:0o600});
  expect((await activateSyncPlacement(f.options("resume"))).active).toBe(true);
  const reopened=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
  try{expect(reopened.get(later!,f.project)?.text).toBe("later committed source progress");}finally{reopened.close();}
},60_000);

test("live reader and person refusal never publish an activation intent",async()=>{
  const f=await fixture(),store=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});
  try{await expect(activateSyncPlacement(f.options("apply"))).rejects.toThrow("readers");}finally{store.close();}
  expect(existsSync(join(f.base,"sync-placement-activation.json"))).toBe(false);
  const options=f.options("apply");options.authorize=()=>false;
  await expect(activateSyncPlacement(options)).rejects.toThrow("authorization");
  expect(existsSync(join(f.base,"sync-placement-activation.json"))).toBe(false);
},60_000);
