/** Shared person-migration fences. No serialized value grants ownership. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { withProfileLock } from "./generation.ts";
import { acquireMutation, type MutationHandle } from "./mutation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
import { createPlacementActivationOwner } from "./sync-placement-activation-proof.ts";
export class PlacementInventoryFenceError extends Error{
  constructor(readonly causeClass:"readers"|"busy"){super(`Sync placement migration is ${causeClass}; close cooperating readers/writers, then run amem migrate --sync-placement --dry-run before retrying.`);this.name="PlacementInventoryFenceError";}
}
function fail(cause:"readers"|"busy"):never{throw new PlacementInventoryFenceError(cause);}
export async function withPlacementActivationFences<T>(home:string,directories:readonly string[],work:(mutation:MutationHandle,owner:ReturnType<typeof createPlacementActivationOwner>)=>Promise<T>):Promise<T> {
  return withProfileLock(home,async()=>{
    const releases:(()=>void)[]=[];
    try {
      const transports=["shard-sync","shard-sync-placement"].map(name=>join(home,name)).filter(dir=>lstatSync(dir,{throwIfNoEntry:false})!==undefined);
      const dirs=[...new Set([home,...directories,...transports])].sort();let mutation:MutationHandle|undefined;
      for(const dir of dirs){
        try{assertNoLiveReaders(dir,{includeShards:true});}catch{fail("readers");}
        const handle=acquireMutation(dir);if(!handle)fail("busy");releases.push(handle);if(dir===home)mutation=handle;
      }
      if(!mutation)fail("busy");
      for(const dir of [home,...transports]){const release=generationSyncLock(dir);if(!release)fail("busy");releases.push(release);}
      const owner=createPlacementActivationOwner(home,mutation);return await work(mutation,owner);
    }finally{for(const release of releases.reverse())release();}
  });
}
