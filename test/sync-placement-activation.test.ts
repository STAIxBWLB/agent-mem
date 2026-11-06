import { afterEach, expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { activateSyncPlacement, type PlacementActivationOptions } from "../src/memory/sync-placement-activation.ts";
import { readPlacementProjection } from "../src/memory/sync-placement-journal.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { inspectionFilesystemSnapshot, createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const ownRoot=fileURLToPath(new URL("..",import.meta.url));
async function fixture(){
  const f=hookFixture();cleanup.push(f.close);
  const seed=new MemoryStore({memoryDir:f.base,deferPromotions:true});
  const note=(text:string)=>seed.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text,about:[]});
  const allowed=note("initial activation permitted original"),declined=note("NEVER_PUBLIC_ACTIVATION_BODY");seed.close();
  expect((await migrateShards({memoryDir:f.base,generation:"a".repeat(32),mode:"apply",authorizedPerson:true,tty:true})).active).toBe(true);
  await activatePublicPruneView({memoryDir:f.base,mode:"apply",authorizedPerson:true,tty:true});
  // Test acts as the person: core activation must never write formats.json or change privacy policy.
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.21.0",since:"2026-11-06"}])+"\n",{mode:0o600});
  writeFileSync(join(f.base,"amem.config.json"),JSON.stringify({piiPatterns:["NEVER_PUBLIC_"]})+"\n",{mode:0o600});
  const options=(mode:PlacementActivationOptions["mode"]):PlacementActivationOptions=>({memoryDir:f.base,mode,writerRoots:[ownRoot],ownRoot,authorize:()=>true});
  return{...f,allowed,declined,options};
}

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
