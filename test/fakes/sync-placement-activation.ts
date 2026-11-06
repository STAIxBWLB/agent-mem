/** One fake home prepared through real v2 APIs. V3 is installed only by the activation under test. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../../src/memory/store.ts";
import { migrateShards } from "../../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../../src/memory/public-prune-activation.ts";
import type { PlacementActivationOptions } from "../../src/memory/sync-placement-activation.ts";
import { hookFixture } from "./hooks-fixture.ts";

export const activationOwnRoot = fileURLToPath(new URL("../..",import.meta.url));
export async function placementActivationFixture(){
  const f=hookFixture("https://example.test/placement/activation.git");
  try {
    const seed=new MemoryStore({memoryDir:f.base,deferPromotions:true});
    let allowed:string,declined:string;
    try {
      const note=(text:string)=>seed.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text,about:[]});
      allowed=note("initial activation permitted original");declined=note("NEVER_PUBLIC_ACTIVATION_BODY");
    } finally { seed.close(); }
    const migration=await migrateShards({memoryDir:f.base,generation:"a".repeat(32),mode:"apply",authorizedPerson:true,tty:true});
    if(!migration.active)throw Error("isolated activation fixture shard migration did not complete");
    await activatePublicPruneView({memoryDir:f.base,mode:"apply",authorizedPerson:true,tty:true});
    // Test acts as the person: activation code must never write this floor or change this policy.
    writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.21.0",since:"2026-11-06"}])+"\n",{mode:0o600});
    writeFileSync(join(f.base,"amem.config.json"),JSON.stringify({piiPatterns:["NEVER_PUBLIC_"]})+"\n",{mode:0o600});
    const options=(mode:PlacementActivationOptions["mode"]):PlacementActivationOptions=>({memoryDir:f.base,mode,writerRoots:[activationOwnRoot],ownRoot:activationOwnRoot,authorize:()=>true});
    return{...f,allowed,declined,options};
  }catch(error){f.close();throw error;}
}
