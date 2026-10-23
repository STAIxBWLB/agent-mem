import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { mutationDatabase, readerAdmissionDatabase } from "../src/memory/mutation.ts";
import { registerReaderLease } from "../src/memory/reader-lease.ts";
import { processSignature } from "../src/memory/platform.ts";

const fixture = () => mkdtempSync(join(tmpdir(), "amem-hook-read-budget-"));

test("an expired host work-read budget refuses construction before storage work", () => {
  const base = fixture();
  try {
    expect(() => new WorkListStore({ base, project: "budget", policy: () => true, timeRemaining: () => 0, busyTimeoutMs: 0 })).toThrow("work-list read deadline");
    expect(readdirSync(base)).toEqual([]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("expiration across policy await rejects the whole view and closes its cursor", async () => {
  const base = fixture(); let remaining = 1000, expireInPolicy = false;
  const store = new WorkListStore({ base, project: "budget", busyTimeoutMs: 0, timeRemaining: () => remaining,
    policy: () => { if (expireInPolicy) remaining = 0; return true; } });
  try {
    await store.write("open", { task: "one", status: "todo" });
    await store.write("open", { task: "two", status: "doing" });
    expireInPolicy = true;
    await expect(store.read()).rejects.toThrow("work-list read deadline");
    remaining = 1000; expireInPolicy = false;
    expect((await store.read())[0]?.items).toHaveLength(2);
    const lock = mutationDatabase(store.dir, 0);
    try { lock.run("BEGIN IMMEDIATE"); lock.run("ROLLBACK"); } finally { lock.close(); }
  } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});

test("expiration during work-log refresh never commits a partial derived index", async () => {
  const base = fixture(); let checks = 0, limited = false;
  const store = new WorkListStore({ base, project: "budget", busyTimeoutMs: 0,
    timeRemaining: () => !limited || ++checks < 20 ? 1000 : 0, policy: () => true });
  try {
    for (let i = 0; i < 32; i++) await store.write("open", { task: `item-${i}`, status: "todo" });
    const index = new Database(join(store.dir, "index.db"));
    try {
      index.run("DELETE FROM work_ops"); index.run("DELETE FROM work_heads");
      limited = true;
      await expect(store.read()).rejects.toThrow("work-list read deadline");
      expect((index.query("SELECT COUNT(*) AS n FROM work_ops").get() as { n: number }).n).toBe(0);
      limited = false;
      expect((await store.read())[0]?.items).toHaveLength(32);
    } finally { index.close(); }
  } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});

test("zero-wait mutation and admission ports preserve lock refusal and validate their bounds", async () => {
  const base = fixture(), store = new WorkListStore({ base, project: "budget", policy: () => true, busyTimeoutMs: 0 });
  const lock = mutationDatabase(store.dir, 0), admission = readerAdmissionDatabase(base, 0);
  try {
    expect((lock.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(0);
    expect((admission.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(0);
    lock.run("BEGIN IMMEDIATE");
    await expect(store.read()).rejects.toThrow();
    lock.run("ROLLBACK");
    for (const timeout of [-1, 3001, NaN]) {
      expect(() => mutationDatabase(base, timeout)).toThrow("busy timeout");
      expect(() => readerAdmissionDatabase(base, timeout)).toThrow("busy timeout");
    }
    admission.run("BEGIN IMMEDIATE");
    expect(() => registerReaderLease(base, { busyTimeoutMs: 0, signature: processSignature(process.pid)! })).toThrow();
    admission.run("ROLLBACK");
  } finally { lock.close(); admission.close(); store.close(); rmSync(base, { recursive: true, force: true }); }
});

test("nested leases inherit their root zero-wait fence and retain identity and migration checks", () => {
  const base = fixture(), signature = processSignature(process.pid)!;
  const root = registerReaderLease(base, { busyTimeoutMs: 0, signature });
  const nested = registerReaderLease(base, { signature });
  const admission = readerAdmissionDatabase(base, 0);
  try {
    expect(() => registerReaderLease(base, { signature: "not-a-hash" })).toThrow("identity");
    expect(() => registerReaderLease(base, { signature: "0".repeat(64) })).toThrow("identity changed");
    root(); nested.verify();
    writeFileSync(join(base, "profile.lock"), "unverifiable", { mode: 0o600 });
    expect(() => nested.verify()).toThrow("profile lock");
    rmSync(join(base, "profile.lock"));
    admission.run("BEGIN IMMEDIATE");
    // A default nested registration must keep the already-established root's zero wait.
    expect(() => registerReaderLease(base, { signature })).toThrow();
    admission.run("ROLLBACK");
    nested();
    expect(readdirSync(join(base, "readers"))).toEqual([]);
  } finally { try { admission.run("ROLLBACK"); } catch {} root(); nested(); admission.close(); rmSync(base, { recursive: true, force: true }); }
});
