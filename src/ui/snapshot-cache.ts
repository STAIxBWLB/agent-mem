import { createHash } from "node:crypto";

type Data = Record<string, unknown>;
interface Entry { sampledAt: number; generation: number; epoch: number; data: Data; revision: string; cursor: number; until: number; bytes: number }
export interface SnapshotValue { data: Data; until: number }
interface Reading extends SnapshotValue { sampledAt: number; generation: number; entry?: Entry }

/** Provider-local screened snapshots. No disk cache, timer, watcher or retained store. */
export class SnapshotCache {
  private entries = new Map<string, Entry>();
  private flights = new Map<string, Promise<Reading>>();
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
  private timely(sampledAt: number, until: number): boolean {
    const now = this.now();
    return now >= sampledAt && now < until;
  }
  private readable(value?: SnapshotValue): void {
    if (this.closed) throw Error("console snapshots are closed");
    if (value?.data.error !== undefined) throw Error("console snapshot unavailable");
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }
  private freshReply(data: Data): Data {
    this.readable();
    if (this.freshCursor >= Number.MAX_SAFE_INTEGER) throw Error("console fresh cursor limit");
    const copy = structuredClone(data);
    delete copy.changed;
    return { ...copy, cursor: ++this.freshCursor };
  }
  private readFresh(read: () => Promise<SnapshotValue>, retryAction: boolean): Promise<Data> {
    this.readable();
    if (this.active.size >= 16) throw Error("console snapshot concurrency limit");
    const generation = this.generation;
    return this.track((async () => {
      let value = await read();
      this.readable(value);
      // One post-action reread only. Further changes still yield full uncached data, never a retry loop.
      if (retryAction && generation !== this.generation) { value = await read(); this.readable(value); }
      return this.freshReply(value.data);
    })());
  }
  /** A request with no complete revision computes independently without consulting another revision or retaining data. */
  async fresh(read: () => Promise<SnapshotValue>): Promise<Data> {
    this.readable(); this.disableReuse();
    return this.readFresh(read, true);
  }
  private dropEntry(key: string, entry: Entry | undefined): void {
    if (entry && this.entries.get(key) === entry) { this.entries.delete(key); this.bytes -= entry.bytes; }
  }
  async snapshot(key: string, after: number, read: () => Promise<SnapshotValue>): Promise<Data> {
    this.readable();
    const revision = this.sourceRevision();
    this.readable();
    if (revision === undefined) return this.fresh(read);
    const cached = this.entries.get(key);
    if (cached && cached.revision === revision && this.timely(cached.sampledAt, cached.until)) {
      this.entries.delete(key); this.entries.set(key, cached);
      return this.reply(cached, after);
    }
    // Revision is part of the flight key: a new write never joins an older read.
    const flightKey = JSON.stringify([this.generation, this.epoch, revision, key]);
    let flight = this.flights.get(flightKey);
    if (!flight) {
      if (this.active.size >= 16) throw Error("console snapshot concurrency limit");
      const generation = this.generation, epoch = this.epoch, sampledAt = this.now();
      flight = (async () => {
        const value = await read();
        this.readable(value);
        const observed = this.sourceRevision();
        this.readable(value);
        const data = structuredClone(value.data); delete data.changed;
        const reading: Reading = { data, until: value.until, sampledAt, generation };
        if (observed !== revision || epoch !== this.epoch || generation !== this.generation || !this.timely(sampledAt, value.until)) {
          this.dropEntry(key, cached);
          if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey);
          return reading;
        }
        const serialized = JSON.stringify(data), bytes = Buffer.byteLength(serialized);
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
        reading.entry = entry;
        return reading;
      })();
      this.flights.set(flightKey, flight);
      this.track(flight);
    }
    try {
      const reading = await flight;
      this.readable(reading);
      if (reading.generation !== this.generation) { this.dropEntry(key, reading.entry); return this.readFresh(read, false); }
      const entry = reading.entry;
      if (!entry) return this.freshReply(reading.data);
      const observed = this.sourceRevision();
      this.readable(reading);
      if (reading.generation !== this.generation) { this.dropEntry(key, entry); return this.readFresh(read, false); }
      if (observed !== entry.revision || entry.epoch !== this.epoch || !this.timely(entry.sampledAt, entry.until)) {
        this.dropEntry(key, entry); return this.freshReply(reading.data);
      }
      return this.reply(entry, after);
    }
    finally { if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey); }
  }
  private reply(entry: Entry, after: number): Data {
    // acon's no-op contract requires exactly these two keys.
    return after === entry.cursor ? { changed: false, cursor: entry.cursor } : { ...structuredClone(entry.data), cursor: entry.cursor };
  }
}
