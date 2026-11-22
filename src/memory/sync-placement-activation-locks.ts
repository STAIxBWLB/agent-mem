/** Shared person-migration fences. No serialized value grants ownership. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { withProfileLock } from "./generation.ts";
import { acquireMutation, type MutationHandle } from "./mutation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
import { createPlacementActivationOwner } from "./sync-placement-activation-proof.ts";
/** #578 Q1: a checkpoint fence never refuses for readers; its `busy` means a placement sync, admission or renewal holds a lock. */
export const PLACEMENT_CHECKPOINT_BUSY_MESSAGE = "Sync placement checkpoint is busy: a placement sync, admission or renewal holds its lock; wait for it to finish (amem sync --status shows recorded operations), then rerun the same checkpoint command.";
export class PlacementInventoryFenceError extends Error{
  constructor(readonly causeClass:"readers"|"busy",checkpoint=false){super(checkpoint&&causeClass==="busy"?PLACEMENT_CHECKPOINT_BUSY_MESSAGE:`Sync placement migration is ${causeClass}; close cooperating readers/writers, then run amem migrate --sync-placement --dry-run before retrying.`);this.name="PlacementInventoryFenceError";}
}
type FenceWork<T>=(mutation:MutationHandle,owner:ReturnType<typeof createPlacementActivationOwner>)=>Promise<T>;
async function withFences<T>(home:string,directories:readonly string[],options:{readers:boolean},work:FenceWork<T>):Promise<T> {
  const fail=(cause:"readers"|"busy"):never=>{throw new PlacementInventoryFenceError(cause,!options.readers);};
  return withProfileLock(home,async()=>{
    const releases:(()=>void)[]=[];
    try {
      const transports=["shard-sync","shard-sync-placement"].map(name=>join(home,name)).filter(dir=>lstatSync(dir,{throwIfNoEntry:false})!==undefined);
      const dirs=[...new Set([home,...directories,...transports])].sort();let mutation:MutationHandle|undefined;
      for(const dir of dirs){
        if(options.readers){try{assertNoLiveReaders(dir,{includeShards:true});}catch{fail("readers");}}
        const handle=acquireMutation(dir);if(!handle)fail("busy");releases.push(handle!);if(dir===home)mutation=handle!;
      }
      if(!mutation)fail("busy");
      for(const dir of [home,...transports]){const release=generationSyncLock(dir);if(!release)fail("busy");releases.push(release!);}
      const owner=createPlacementActivationOwner(home,mutation!);return await work(mutation!,owner);
    }finally{for(const release of releases.reverse())release();}
  });
}
/** Activation, renewal and admission: every live reader lease refuses, as before. */
export function withPlacementActivationFences<T>(home:string,directories:readonly string[],work:FenceWork<T>):Promise<T> {
  return withFences(home,directories,{readers:true},work);
}
/**
 * #578 Q1: checkpoint confirm, resume and abandon exclude placement writers only (profile lock, every mutation and sync
 * lock). Live curated readers keep running: the checkpoint writes only under `sync-placement-checkpoints/`, never the
 * binding markers, and an extension-log reader fails closed (`checkpoint-pending`, then `changed`). The held profile
 * lock still refuses new reader admission for the duration.
 */
export function withPlacementCheckpointFences<T>(home:string,directories:readonly string[],work:FenceWork<T>):Promise<T> {
  return withFences(home,directories,{readers:false},work);
}
