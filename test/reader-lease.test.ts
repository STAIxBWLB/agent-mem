import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoLiveReaders, registerReaderLease } from "../src/memory/reader-lease.ts";
import { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-reader-lease-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const leaseNames = (dir: string) => readdirSync(join(dir, "readers"));

test("cooperating readers share one process lease and close removes only the last handle", () => {
  const dir = home();
  const first = registerReaderLease(dir), second = registerReaderLease(dir);
  cleanup.push(first, second);
  expect(leaseNames(dir)).toHaveLength(1);
  expect(() => assertNoLiveReaders(dir)).toThrow("legacy reader is live");
  first();
  expect(leaseNames(dir)).toHaveLength(1);
  second();
  expect(leaseNames(dir)).toHaveLength(0);
  expect(assertNoLiveReaders(dir)).toEqual({ removed: 0 });
});

test("a dead-pid lease is removed and an unverifiable lease fails closed", () => {
  const dir = home();
  mkdirSync(join(dir, "readers"), { recursive: true });
  const dead = join(dir, "readers", `999999-${"0".repeat(64)}.json`);
  writeFileSync(dead, JSON.stringify({ schema: "agent-mem.reader-lease/v1", pid: 999999, signature: "0".repeat(64), renewedAt: new Date().toISOString() }) + "\n");
  expect(assertNoLiveReaders(dir)).toEqual({ removed: 1 });
  writeFileSync(dead, "{}\n");
  expect(() => assertNoLiveReaders(dir)).toThrow("unverifiable");
});

test("MemoryStore announces a legacy reader and releases it on close", () => {
  const dir = home(), memory = join(dir, "memory");
  const store = new MemoryStore({ home: dir });
  expect(leaseNames(memory)).toHaveLength(1);
  store.close();
  expect(leaseNames(memory)).toHaveLength(0);
});


test("reader refs in two memory homes close independently and allow fresh registration after both close", () => {
  const a=home(),b=home(),firstA=registerReaderLease(a),secondA=registerReaderLease(a),firstB=registerReaderLease(b);
  cleanup.push(firstA,secondA,firstB);
  expect(leaseNames(a)).toHaveLength(1);expect(leaseNames(b)).toHaveLength(1);
  expect(()=>assertNoLiveReaders(a)).toThrow("legacy reader is live");expect(()=>assertNoLiveReaders(b)).toThrow("legacy reader is live");
  firstA();expect(leaseNames(a)).toHaveLength(1);secondA();
  expect(leaseNames(a)).toHaveLength(0);expect(assertNoLiveReaders(a)).toEqual({removed:0});
  expect(leaseNames(b)).toHaveLength(1);firstB.verify();expect(()=>assertNoLiveReaders(b)).toThrow("legacy reader is live");
  firstB();expect(leaseNames(b)).toHaveLength(0);expect(assertNoLiveReaders(b)).toEqual({removed:0});
  const freshA=registerReaderLease(a),freshB=registerReaderLease(b);cleanup.push(freshA,freshB);
  freshA.verify();freshB.verify();expect(leaseNames(a)).toHaveLength(1);expect(leaseNames(b)).toHaveLength(1);
  freshA();expect(leaseNames(a)).toHaveLength(0);expect(leaseNames(b)).toHaveLength(1);freshB.verify();
  freshB();expect(leaseNames(b)).toHaveLength(0);
});

test("shard readers use a separate reference-counted namespace with the same process identity", () => {
  const dir = home(), legacy = registerReaderLease(dir), first = registerReaderLease(dir, { scope: "shard" }), second = registerReaderLease(dir, { scope: "shard" });
  cleanup.push(legacy, first, second);
  const shards = () => readdirSync(join(dir, "shard-readers"));
  expect(shards()).toHaveLength(1); expect(leaseNames(dir)).toHaveLength(1); expect(shards()).toEqual(leaseNames(dir));
  const record = JSON.parse(readFileSync(join(dir, "shard-readers", shards()[0]!), "utf8"));
  expect(Object.keys(record).sort()).toEqual(["pid", "renewedAt", "schema", "signature"]);
  expect(record.schema).toBe("agent-mem.reader-lease/v1"); expect(record.pid).toBe(process.pid);
  expect(() => assertNoLiveReaders(dir)).toThrow("legacy reader is live"); legacy();
  expect(assertNoLiveReaders(dir)).toEqual({ removed: 0 }); expect(() => assertNoLiveReaders(dir, { includeShards: true })).toThrow("reader is live");
  first(); expect(shards()).toHaveLength(1); second.verify();
  second(); expect(shards()).toEqual([]); expect(leaseNames(dir)).toEqual([]);
  expect(assertNoLiveReaders(dir, { includeShards: true })).toEqual({ removed: 0 });
});

test("the default migration check does not inspect an unknown shard lease; activation still refuses it", () => {
  const dir = home(); mkdirSync(join(dir, "shard-readers"));
  const file = join(dir, "shard-readers", `999999-${"0".repeat(64)}.json`); writeFileSync(file, "{}\n");
  expect(assertNoLiveReaders(dir)).toEqual({ removed: 0 });
  expect(() => assertNoLiveReaders(dir, { includeShards: true })).toThrow("unverifiable");
  expect(readFileSync(file, "utf8")).toBe("{}\n");
});
