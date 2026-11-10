import { createHash } from "node:crypto";

type Data = Record<string, unknown>;
interface Entry { generation: number; data: Data; revision: string; cursor: number; until: number; bytes: number }
export interface SnapshotValue { data: Data; until: number }

/** Provider-local screened snapshots. No disk cache, timer, watcher or retained store. */
export class SnapshotCache {
  private entries = new Map<string, Entry>();
  private flights = new Map<string, Promise<Entry>>();
  private active = new Set<Promise<Entry>>();
  private generation = 0;
  private bytes = 0;
  private closed = false;
  constructor(private readonly revision: () => string, private readonly now: () => number = Date.now) {}
  invalidate(): void { this.generation++; this.entries.clear(); this.bytes = 0; this.flights.clear(); }
  async close(): Promise<void> { this.closed = true; this.invalidate(); await Promise.allSettled([...this.active]); }
  async snapshot(key: string, after: number, read: () => Promise<SnapshotValue>): Promise<Data> {
    if (this.closed) throw Error("console snapshots are closed");
    const revision = this.revision(), cached = this.entries.get(key);
    if (cached && cached.revision === revision && this.now() < cached.until) {
      this.entries.delete(key); this.entries.set(key, cached);
      return this.reply(cached, after);
    }
    // Revision is part of the flight key: a new write never joins an older read.
    const flightKey = JSON.stringify([this.generation, revision, key]);
    let flight = this.flights.get(flightKey);
    if (!flight) {
      if (this.active.size >= 16) throw Error("console snapshot concurrency limit");
      const generation = this.generation;
      flight = (async () => {
        const value = await read();
        if (this.closed || generation !== this.generation || this.revision() !== revision || !(this.now() < value.until))
          throw Error("console snapshot inputs changed");
        if (value.data.error !== undefined) throw Error("console snapshot unavailable");
        const data = structuredClone(value.data), bytes = Buffer.byteLength(JSON.stringify(data));
        const cursor = Number.parseInt(createHash("sha256").update(JSON.stringify([key, revision, value.until])).digest("hex").slice(0, 13), 16) + 1;
        const entry = { generation, data, revision, cursor, until: value.until, bytes };
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
      this.active.add(flight);
      void flight.then(() => this.active.delete(flight!), () => this.active.delete(flight!));
    }
    try {
      const entry = await flight;
      if (this.closed || entry.generation !== this.generation || this.revision() !== entry.revision || !(this.now() < entry.until))
        throw Error("console snapshot inputs changed");
      return this.reply(entry, after);
    }
    finally { if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey); }
  }
  private reply(entry: Entry, after: number): Data {
    // acon's no-op contract requires exactly these two keys.
    return after === entry.cursor ? { changed: false, cursor: entry.cursor } : { ...structuredClone(entry.data), cursor: entry.cursor };
  }
}
