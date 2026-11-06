/** Owned native crash fixture. Its arguments always name a test-created memory home and install. */
import { writeSync } from "node:fs";
import { migrateShards } from "../../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../../src/memory/public-prune-activation.ts";
import { activateSyncPlacement } from "../../src/memory/sync-placement-activation.ts";

const [home,ownRoot,family,phase,rawRoots]=process.argv.slice(2);
if(!home||!ownRoot||!family||!phase)throw Error("isolated profile crash arguments missing");
function crash(current:string):void {
  if(current!==phase)return;
  writeSync(1,JSON.stringify({family,phase:current})+"\n");process.kill(process.pid,"SIGKILL");
}
if(family==="shards"&&phase==="after-shard"){
  await migrateShards({memoryDir:home,generation:"c".repeat(32),mode:"apply",authorizedPerson:true,tty:true,checkpoint:crash});
}else if(family==="public-prune"&&phase==="after-intent"){
  await activatePublicPruneView({memoryDir:home,mode:"apply",authorizedPerson:true,tty:true,checkpoint:crash});
}else if(family==="placement"&&phase==="after-intent"){
  await activateSyncPlacement({memoryDir:home,ownRoot,mode:"apply",writerRoots:[ownRoot],authorize:()=>true,checkpoint:crash});
}else if(family==="renewal"&&["intent-published","revision-fsync","intent-started"].includes(phase)){
  if(!rawRoots)throw Error("isolated renewal roots missing");
  const roots:unknown=JSON.parse(rawRoots);if(!Array.isArray(roots)||!roots.every(value=>typeof value==="string"))throw Error("invalid isolated renewal roots");
  await activateSyncPlacement({memoryDir:home,ownRoot,mode:"apply",writerRoots:roots,authorize:()=>true,renewalCheckpoint:crash});
}else throw Error("unknown isolated profile crash family or phase");
throw Error("isolated profile crash checkpoint was not reached");
