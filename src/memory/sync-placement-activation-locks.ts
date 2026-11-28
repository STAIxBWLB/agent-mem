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
type PlacementMutationSurface = "checkpoint" | "admit" | "renewal";
export class PlacementInventoryFenceError extends Error {
  constructor(readonly causeClass: "readers" | "busy", surface?: PlacementMutationSurface) {
    const message = causeClass === "readers"
      ? "Sync placement migration is blocked by live readers; close cooperating readers/writers, then run amem migrate --sync-placement --dry-run before retrying."
      : surface === "checkpoint" ? PLACEMENT_CHECKPOINT_BUSY_MESSAGE
      : surface === "admit" ? "Sync placement realm admission is busy; wait for the operation holding its lock (amem sync --status), then run amem migrate --sync-placement --admit <project> --dry-run."
      : surface === "renewal" ? "Sync placement writer renewal is busy; wait for the operation holding its lock (amem sync --status), then run amem migrate --sync-placement --dry-run before retrying."
      : "Sync placement migration is busy; close cooperating readers/writers, then run amem migrate --sync-placement --dry-run before retrying.";
    super(message);
    this.name = "PlacementInventoryFenceError";
  }
}
type FenceWork<T> = (mutation: MutationHandle, owner: ReturnType<typeof createPlacementActivationOwner>) => Promise<T>;
async function withFences<T>(home: string, directories: readonly string[], work: FenceWork<T>, surface?: PlacementMutationSurface): Promise<T> {
  const fail = (cause: "readers" | "busy"): never => { throw new PlacementInventoryFenceError(cause, surface); };
  return withProfileLock(home,async()=>{
    const releases:(()=>void)[]=[];
    try {
      const transports=["shard-sync","shard-sync-placement"].map(name=>join(home,name)).filter(dir=>lstatSync(dir,{throwIfNoEntry:false})!==undefined);
      const dirs=[...new Set([home,...directories,...transports])].sort();let mutation:MutationHandle|undefined;
      for(const dir of dirs){
        if(surface === undefined){try{assertNoLiveReaders(dir,{includeShards:true});}catch{fail("readers");}}
        const handle=acquireMutation(dir);if(!handle)fail("busy");releases.push(handle!);if(dir===home)mutation=handle!;
      }
      if(!mutation)fail("busy");
      for(const dir of [home,...transports]){const release=generationSyncLock(dir);if(!release)fail("busy");releases.push(release!);}
      const owner=createPlacementActivationOwner(home,mutation!);return await work(mutation!,owner);
    }finally{for(const release of releases.reverse())release();}
  });
}
/** Initial activation changes the markers that readers bind to when opening a store. */
export function withPlacementActivationFences<T>(home: string, directories: readonly string[], work: FenceWork<T>): Promise<T> {
  return withFences(home, directories, work);
}

/** Active placement mutations leave store bindings intact. The profile lock still blocks new readers. */
export function withPlacementMutationFences<T>(home: string, directories: readonly string[], work: FenceWork<T>, options: { surface: PlacementMutationSurface }): Promise<T> {
  return withFences(home, directories, work, options.surface);
}

export function withPlacementCheckpointFences<T>(home: string, directories: readonly string[], work: FenceWork<T>): Promise<T> {
  return withPlacementMutationFences(home, directories, work, { surface: "checkpoint" });
}
