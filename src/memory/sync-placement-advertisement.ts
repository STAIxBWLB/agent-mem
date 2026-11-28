import type { SyncOptions } from "./sync.ts";

/**
 * #626, internal to one placement inventory run: the remote's advertised placement refs by remote URL, read once and
 * shared by the run's publications. Kept off the public SyncOptions type (host API fixture): the inventory driver binds a
 * fresh map to its own options object, and a publication reached with other options reads per run as before.
 * Never authority: each publication still proves every target against it, and a publication that pushes deletes its entry.
 *
 * #656: the same run scope also holds the remote visibility answer by exact URL (one `gh repo view` per run, not per
 * batch), and tells a publication to leave the placement storage memos for the driver to release in its finally.
 */
interface PlacementRun { advertisement: Map<string, ReadonlyMap<string, string>>; visibility: Map<string, Promise<string>> }
const runs = new WeakMap<SyncOptions, PlacementRun>();

export function bindPlacementAdvertisement(opts: SyncOptions): SyncOptions {
  runs.set(opts, { advertisement: new Map(), visibility: new Map() });
  return opts;
}

/** Ends the run scope: later publications with these options read visibility and release storage memos on their own again. */
export function releasePlacementRun(opts: SyncOptions): void { runs.delete(opts); }

export function placementAdvertisement(opts: SyncOptions): Map<string, ReadonlyMap<string, string>> | undefined {
  return runs.get(opts)?.advertisement;
}

/** Whether a publication with these options runs inside an inventory run that releases the storage memos itself. */
export function placementStorageCacheScope(opts: SyncOptions): boolean { return runs.has(opts); }

/**
 * Remote visibility, read once per exact URL inside one inventory run. Only a "private" answer is kept: any other answer or a
 * failed read is dropped, so the next publication asks again and the refusal stays before any lock or fetch.
 */
export function placementVisibility(opts: SyncOptions, url: string, read: (url: string) => Promise<string>): Promise<string> {
  const run = runs.get(opts); if (!run) return read(url);
  const known = run.visibility.get(url); if (known) return known;
  const pending = read(url).then(value => { if (value !== "private") run.visibility.delete(url); return value; },
    error => { run.visibility.delete(url); throw error; });
  run.visibility.set(url, pending); return pending;
}
