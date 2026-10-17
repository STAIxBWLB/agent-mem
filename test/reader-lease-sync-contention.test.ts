import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReaderLease } from "../src/memory/reader-lease.ts";
import { withProfileLock, writeProfileJSON } from "../src/memory/generation.ts";
import { acquireMutation, readerAdmissionDatabase } from "../src/memory/mutation.ts";
import { MemoryStore } from "../src/memory/store.ts";

test("F1 opening and closing a reader stays below 100ms while sync owns the data mutation lock", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-lease-sync-"));
  try {
    const seed = new MemoryStore({ home }); seed.close();
    const release = acquireMutation(join(home, "memory")); expect(release).toBeDefined();
    try {
      const start = performance.now();
      const reader = new MemoryStore({ home }); reader.close();
      expect(performance.now() - start).toBeLessThan(100);
    } finally { release?.(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("F1 renewal and close do not wait on a network-held sync mutation lock", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-lease-renew-"));
  const seed = new MemoryStore({ home }); seed.close();
  const memory = join(home, "memory");
  let renew: (() => void) | undefined;
  const timer = setInterval(() => {}, 1_000_000); clearInterval(timer);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => { renew = callback; return timer; }) as typeof setInterval);
  let close: (() => void) | undefined;
  try {
    close = registerReaderLease(memory); expect(renew).toBeDefined();
    const readers = join(memory, "readers"), path = join(readers, readdirSync(readers)[0]!);
    const prior = JSON.parse(readFileSync(path, "utf8"));
    writeProfileJSON(path, { ...prior, renewedAt: "2000-01-01T00:00:00.000Z" });
    const release = acquireMutation(memory); expect(release).toBeDefined();
    try {
      const start = performance.now(); renew!();
      expect(JSON.parse(readFileSync(path, "utf8")).renewedAt).not.toBe("2000-01-01T00:00:00.000Z");
      close();
      expect(performance.now() - start).toBeLessThan(100);
      expect(readdirSync(readers)).toEqual([]);
    } finally { release?.(); }
  } finally { close?.(); interval.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});

test("F1 migration profile creation uses the same dedicated admission fence as readers", async () => {
  const home = mkdtempSync(join(tmpdir(), "amem-profile-admission-"));
  const fence = readerAdmissionDatabase(home); fence.run("BEGIN IMMEDIATE");
  let entered = false, released = false;
  const pending = withProfileLock(home, () => { entered = true; });
  try {
    await Bun.sleep(40); expect(entered).toBe(false);
    fence.run("ROLLBACK"); released = true;
    await pending; expect(entered).toBe(true);
  } finally { if (!released) fence.run("ROLLBACK"); fence.close(); await pending; rmSync(home, { recursive: true, force: true }); }
});
