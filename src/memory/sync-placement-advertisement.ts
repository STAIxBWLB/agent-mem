import type { SyncOptions } from "./sync.ts";

/**
 * #626, internal to one placement inventory run: the remote's advertised placement refs by remote URL, read once and
 * shared by the run's publications. Kept off the public SyncOptions type (host API fixture): the inventory driver binds a
 * fresh map to its own options object, and a publication reached with other options reads per run as before.
 * Never authority: each publication still proves every target against it, and a publication that pushes deletes its entry.
 */
const runs = new WeakMap<SyncOptions, Map<string, ReadonlyMap<string, string>>>();

export function bindPlacementAdvertisement(opts: SyncOptions): SyncOptions {
  runs.set(opts, new Map());
  return opts;
}

export function placementAdvertisement(opts: SyncOptions): Map<string, ReadonlyMap<string, string>> | undefined {
  return runs.get(opts);
}
