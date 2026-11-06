import { afterEach, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
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
