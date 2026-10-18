import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
