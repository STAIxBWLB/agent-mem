import { createHash } from "node:crypto";

type Data = Record<string, unknown>;
interface Entry { sampledAt: number; generation: number; epoch: number; data: Data; revision: string; cursor: number; until: number; bytes: number }
export interface SnapshotValue { data: Data; until: number }

/** Provider-local screened snapshots. No disk cache, timer, watcher or retained store. */
export class SnapshotCache {
  private entries = new Map<string, Entry>();
  private flights = new Map<string, Promise<Entry>>();
  private active = new Set<Promise<unknown>>();
  private generation = 0;
  private epoch = 0;
  private reuseUnavailable = false;
  // Cached digests occupy the lower 52 bits; fresh replies have distinct safe-integer cursors above them.
  private freshCursor = 2 ** 52;
  private bytes = 0;
  private closed = false;
  constructor(private readonly revision: () => string, private readonly now: () => number = Date.now) {}
  private clearReusable(): void { this.epoch++; this.entries.clear(); this.bytes = 0; this.flights.clear(); }
  invalidate(): void { this.generation++; this.clearReusable(); }
  async close(): Promise<void> { this.closed = true; this.invalidate(); await Promise.allSettled([...this.active]); }
  private disableReuse(): void {
    if (!this.reuseUnavailable) this.clearReusable();
    this.reuseUnavailable = true;
  }
  private sourceRevision(): string | undefined {
    let revision: string;
    try { revision = this.revision(); }
    catch { this.disableReuse(); return undefined; }
    this.reuseUnavailable = false;
    return revision;
  }
  private current(generation: number, sampledAt: number, until: number): void {
    const now = this.now();
    if (this.closed || generation !== this.generation || !(now >= sampledAt && now < until))
      throw Error("console snapshot inputs changed");
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }
  /** A request with no complete revision always computes independently and never publishes a reusable entry. */
  async fresh(read: () => Promise<SnapshotValue>): Promise<Data> {
    if (this.closed) throw Error("console snapshots are closed");
    this.disableReuse();
    if (this.active.size >= 16) throw Error("console snapshot concurrency limit");
    const generation = this.generation, sampledAt = this.now();
    return this.track((async () => {
      const value = await read();
      this.current(generation, sampledAt, value.until);
      if (value.data.error !== undefined) throw Error("console snapshot unavailable");
      if (this.freshCursor >= Number.MAX_SAFE_INTEGER) throw Error("console fresh cursor limit");
      const data = structuredClone(value.data);
      delete data.changed; // Fresh data must never carry the unchanged transport marker.
      return { ...data, cursor: ++this.freshCursor };
    })());
  }
  async snapshot(key: string, after: number, read: () => Promise<SnapshotValue>): Promise<Data> {
    if (this.closed) throw Error("console snapshots are closed");
    const revision = this.sourceRevision();
    if (revision === undefined) return this.fresh(read);
    const cached = this.entries.get(key);
    if (cached && cached.revision === revision && this.now() >= cached.sampledAt && this.now() < cached.until) {
      this.entries.delete(key); this.entries.set(key, cached);
      return this.reply(cached, after);
    }
    // Revision is part of the flight key: a new write never joins an older read.
    const flightKey = JSON.stringify([this.generation, revision, key]);
    let flight = this.flights.get(flightKey);
    if (!flight) {
      if (this.active.size >= 16) throw Error("console snapshot concurrency limit");
      const generation = this.generation, epoch = this.epoch, sampledAt = this.now();
      flight = (async () => {
        const value = await read();
        this.current(generation, sampledAt, value.until);
        if (value.data.error !== undefined) throw Error("console snapshot unavailable");
        const observed = this.sourceRevision();
        this.current(generation, sampledAt, value.until);
        if (observed === undefined) throw REVISION_UNAVAILABLE;
        if (observed !== revision) throw Error("console snapshot inputs changed");
        if (epoch !== this.epoch) throw REVISION_UNAVAILABLE;
        const data = structuredClone(value.data), serialized = JSON.stringify(data), bytes = Buffer.byteLength(serialized);
        const cursor = Number.parseInt(createHash("sha256").update(JSON.stringify([key, revision, value.until])).update(serialized).digest("hex").slice(0, 13), 16) + 1;
        const entry = { sampledAt, generation, epoch, data, revision, cursor, until: value.until, bytes };
        // ponytail: 16 selections and 4 MiB per provider. Larger views are served once;
        // upgrade with paged panel results rather than retaining an unbounded corpus.
        if (bytes <= 4 * 1024 * 1024) {
          const old = this.entries.get(key); if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
          while (this.entries.size >= 16 || this.bytes + bytes > 4 * 1024 * 1024) {
            const first = this.entries.keys().next().value!; this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first);
          }
          this.entries.set(key, entry); this.bytes += bytes;
        }
        return entry;
      })();
      this.flights.set(flightKey, flight);
      this.track(flight);
    }
    try {
      let entry: Entry;
      try { entry = await flight; }
      catch (error) { if (error !== REVISION_UNAVAILABLE) throw error; return this.fresh(read); }
      this.current(entry.generation, entry.sampledAt, entry.until);
      const observed = this.sourceRevision();
      this.current(entry.generation, entry.sampledAt, entry.until);
      if (observed === undefined) return this.fresh(read);
      if (observed !== entry.revision) throw Error("console snapshot inputs changed");
      if (entry.epoch !== this.epoch) return this.fresh(read);
      return this.reply(entry, after);
    }
    finally { if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey); }
  }
  private reply(entry: Entry, after: number): Data {
    // acon's no-op contract requires exactly these two keys.
    return after === entry.cursor ? { changed: false, cursor: entry.cursor } : { ...structuredClone(entry.data), cursor: entry.cursor };
  }
}

const REVISION_UNAVAILABLE = Symbol("console revision unavailable");
