import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProfileLock, writeProfileJSON } from "../src/memory/generation.ts";
import { registerReaderLease } from "../src/memory/reader-lease.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "amem-reader-admission-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function register(dir: string, scope?: "shard"): () => void {
  const close = registerReaderLease(dir, scope ? { scope } : {}); cleanup.push(close); return close;
}
function renewable(dir: string, scope?: "shard") {
  const timer = setInterval(() => {}, 1_000_000); clearInterval(timer);
  let renew: (() => void) | undefined;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => { renew = callback; return timer; }) as typeof setInterval);
  cleanup.push(() => interval.mockRestore());
  const close = register(dir, scope);
  expect(renew).toBeDefined();
  return { close, renew: () => renew!() };
}

test("D9 new reader registration refuses while the actual migration profile lock is held", async () => {
  const dir = fixture();
  await withProfileLock(dir, () => {
    expect(() => register(dir)).toThrow(/profile lock/i);
  });
  const close = register(dir); expect(readdirSync(join(dir, "readers"))).toHaveLength(1); close();
  expect(readdirSync(join(dir, "readers"))).toEqual([]);
});

test("D9 a second reader handle cannot bypass profile-lock admission through the process refcount", async () => {
  const dir = fixture(), close = register(dir);
  await withProfileLock(dir, () => {
    expect(() => register(dir)).toThrow(/profile lock/i);
  });
  close(); expect(readdirSync(join(dir, "readers"))).toEqual([]);
});

test("D9 an unverifiable profile lock refuses new reader admission without replacing it", () => {
  const dir = fixture(), lock = join(dir, "profile.lock");
  writeProfileJSON(lock, { pid: process.pid, signature: "unverifiable", token: "retained" });
  const before = readFileSync(lock, "utf8");
  expect(() => register(dir)).toThrow(/profile lock/i);
  expect(readFileSync(lock, "utf8")).toBe(before);
});

test("D9 lease renewal never follows a replaced readers directory into another fixture directory", () => {
  const dir = fixture(), lease = renewable(dir), readers = join(dir, "readers"), other = join(dir, "other");
  mkdirSync(other); renameSync(readers, join(dir, "retained-readers")); symlinkSync(other, readers, "dir");
  lease.renew(); expect(readdirSync(other)).toEqual([]);
  expect(readdirSync(join(dir, "retained-readers"))).toHaveLength(1);
});

test("D9 last-reader close retains a replacement record whose schema cannot be verified", () => {
  const dir = fixture(), close = register(dir), readers = join(dir, "readers");
  const file = join(readers, readdirSync(readers)[0]!);
  const original = JSON.parse(readFileSync(file, "utf8"));
  writeProfileJSON(file, { ...original, schema: "unverifiable-replacement" });
  const before = readFileSync(file, "utf8"); close();
  expect(existsSync(file)).toBe(true); expect(readFileSync(file, "utf8")).toBe(before);
});

test("shard registration and nested shard handles honor the same root profile lock", async () => {
  const dir = fixture(), legacy = register(dir), shard = register(dir, "shard");
  await withProfileLock(dir, () => {
    expect(() => register(dir, "shard")).toThrow(/profile lock/i);
    expect(() => register(dir)).toThrow(/profile lock/i);
  });
  expect(readdirSync(join(dir, "readers"))).toHaveLength(1); expect(readdirSync(join(dir, "shard-readers"))).toHaveLength(1);
  shard(); expect(readdirSync(join(dir, "shard-readers"))).toEqual([]); expect(readdirSync(join(dir, "readers"))).toHaveLength(1); legacy();
});

test("shard renewal and release never overwrite a replacement or touch the legacy namespace", () => {
  const dir = fixture(), legacy = register(dir), lease = renewable(dir, "shard"), folder = join(dir, "shard-readers");
  const path = join(folder, readdirSync(folder)[0]!), original = JSON.parse(readFileSync(path, "utf8"));
  const legacyPath = join(dir, "readers", readdirSync(join(dir, "readers"))[0]!), oldLegacy = readFileSync(legacyPath, "utf8");
  writeProfileJSON(path, { ...original, renewedAt: "2000-01-01T00:00:00.000Z" });
  lease.renew(); expect(JSON.parse(readFileSync(path, "utf8")).renewedAt).not.toBe("2000-01-01T00:00:00.000Z");
  writeProfileJSON(path, { ...original, schema: "UNVERIFIABLE-SHARD-REPLACEMENT" }); const replacement = readFileSync(path, "utf8");
  lease.renew(); lease.close();
  expect(readFileSync(path, "utf8")).toBe(replacement); expect(readFileSync(legacyPath, "utf8")).toBe(oldLegacy); legacy();
});

test("shard renewal refuses a replaced shard-readers directory without following its symlink", () => {
  const dir = fixture(), lease = renewable(dir, "shard"), folder = join(dir, "shard-readers"), other = join(dir, "other-shards");
  mkdirSync(other); renameSync(folder, join(dir, "retained-shards")); symlinkSync(other, folder, "dir");
  lease.renew(); lease.close(); expect(readdirSync(other)).toEqual([]); expect(readdirSync(join(dir, "retained-shards"))).toHaveLength(1);
});
