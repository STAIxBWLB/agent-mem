/** One fake home prepared through real v2 APIs. V3 is installed only by the activation under test. */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryId, MemoryStore } from "../../src/memory/store.ts";
import { migrateShards } from "../../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../../src/memory/public-prune-activation.ts";
import type { PlacementActivationOptions } from "../../src/memory/sync-placement-activation.ts";
import { hookFixture } from "./hooks-fixture.ts";

export const activationOwnRoot = fileURLToPath(new URL("../..",import.meta.url));
/** bulk: extra ~2.2 KB notes spread over four projects so the aggregate grows while each segment stays small (#414). */
export async function placementActivationFixture(bulk=0,bodyRepeat=60){
  const f=hookFixture("https://example.test/placement/activation.git");
  try {
    const seed=new MemoryStore({memoryDir:f.base,deferPromotions:true});
    let allowed:string,declined:string;
    try {
      const note=(text:string)=>seed.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text,about:[]});
      allowed=note("initial activation permitted original");declined=note("NEVER_PUBLIC_ACTIVATION_BODY");
    } finally { seed.close(); }
    if(bulk){
      // Per-note store writes refresh the whole log (O(n^2)); append canonical rows built from a real template instead.
      const log=join(f.base,"log",readdirSync(join(f.base,"log")).find(name=>name.endsWith(".jsonl"))!);
      const {id:_id,...template}=JSON.parse(readFileSync(log,"utf8").trim().split("\n").at(-1)!);let out="";
      for(let i=0;i<bulk;i++){const body={...template,project:`placement-bulk-${i%4}`,text:`bulk row ${i} `+"synthetic placement capture body ".repeat(bodyRepeat)};out+=JSON.stringify({...body,id:entryId(body)})+"\n";}
      appendFileSync(log,out);
    }
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
