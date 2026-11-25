import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync, unlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoLiveReaders, registerReaderLease } from "../src/memory/reader-lease.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { runCli } from "../src/cli.ts";

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

function samePhysicalHome(firstHome: string, secondHome: string, scope: "legacy" | "shard", closeAliasFirst: boolean): void {
  const options = scope === "shard" ? { scope: "shard" as const } : {};
  const first = registerReaderLease(firstHome, options), second = registerReaderLease(secondHome, options);
  cleanup.push(first, second);
  const folder = scope === "shard" ? "shard-readers" : "readers";
  const names = () => readdirSync(join(firstHome, folder));
  expect(names()).toHaveLength(1);
  expect(names()[0]).toMatch(/^[1-9][0-9]*-[a-f0-9]{64}\.json$/);
  const close = closeAliasFirst ? second : first, remaining = closeAliasFirst ? first : second;
  close(); close();
  expect(names()).toHaveLength(1);
  remaining.verify();
  for (const dir of [firstHome, secondHome]) expect(() => assertNoLiveReaders(dir, { includeShards: true })).toThrow("reader is live");
  const third = registerReaderLease(closeAliasFirst ? secondHome : firstHome, options); cleanup.push(third);
  third.verify(); third(); remaining.verify(); expect(names()).toHaveLength(1);
  remaining(); expect(names()).toEqual([]);
  expect(assertNoLiveReaders(secondHome, { includeShards: true })).toEqual({ removed: 0 });
}
for (const scope of ["legacy", "shard"] as const) for (const closeAliasFirst of [false, true]) {
  test(`#353 parent alias shares ${scope} lease until last close (${closeAliasFirst ? "alias" : "canonical"} first)`, () => {
    const root = home(), physical = join(root, "physical"), alias = join(root, "alias");
    mkdirSync(physical); symlinkSync(physical, alias, "dir");
    samePhysicalHome(join(physical, "memory"), join(alias, "memory"), scope, closeAliasFirst);
  });
  test.skipIf(process.platform !== "darwin" || !existsSync("/var/tmp") || !existsSync("/private/var/tmp"))(
    `#353 macOS private-var shares ${scope} lease (${closeAliasFirst ? "alias" : "canonical"} first)`, () => {
    const alias = mkdtempSync("/var/tmp/amem-reader-spelling-"); cleanup.push(() => rmSync(alias, { recursive: true, force: true }));
    const physical = realPath(alias);
    expect(physical).not.toBe(alias);
    samePhysicalHome(physical, alias, scope, closeAliasFirst);
  });
}
test("#353 retargeting a parent alias cannot redirect last-reader cleanup to another home", () => {
  const root = home(), firstHome = join(root, "first"), otherHome = join(root, "other"), alias = join(root, "alias");
  mkdirSync(firstHome); mkdirSync(otherHome); symlinkSync(firstHome, alias, "dir");
  const first = registerReaderLease(alias), other = registerReaderLease(otherHome); cleanup.push(first, other);
  unlinkSync(alias); symlinkSync(otherHome, alias, "dir");
  first(); expect(leaseNames(firstHome)).toEqual([]);
  other.verify(); expect(leaseNames(otherHome)).toHaveLength(1);
  expect(() => assertNoLiveReaders(otherHome)).toThrow("reader is live");
  other(); expect(leaseNames(otherHome)).toEqual([]);
});

/** A pid no kernel hands out, so `kill(pid, 0)` answers ESRCH here. */
const GONE_PID = 2_000_000_000;
const ZERO_SIGNATURE = "0".repeat(64);
const leaseRecord = (pid: number, signature: string) => JSON.stringify({ schema: "agent-mem.reader-lease/v1", pid, signature, renewedAt: new Date().toISOString() }) + "\n";
/** Writes a lease into `folder` (readers or shard-readers); the caller owns the home's cleanup. */
function writeLease(dir: string, folder: string, pid: number, signature: string, body = leaseRecord(pid, signature)): void {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, `${pid}-${signature}.json`), body);
}

test("#632: a registration clears gone leases in its own scope and leaves every other file alone", () => {
  const dir = home(), readers = () => readdirSync(join(dir, "readers"));
  writeLease(dir, "readers", GONE_PID, ZERO_SIGNATURE);
  writeLease(dir, "readers", GONE_PID + 1, "1".repeat(64));
  // A pid that exists is left alone even when its signature cannot be its own (EPERM or a reused pid).
  writeLease(dir, "readers", 1, "f".repeat(64));
  // Unreadable evidence, a link to it, and a non-lease file stay for doctor.
  writeLease(dir, "readers", GONE_PID + 2, "2".repeat(64), "{}\n");
  symlinkSync(join(dir, "readers", `${GONE_PID + 2}-${"2".repeat(64)}.json`), join(dir, "readers", `${GONE_PID + 3}-${"3".repeat(64)}.json`));
  writeFileSync(join(dir, "readers", "notes.txt"), "keep\n");
  const close = registerReaderLease(dir); cleanup.push(close);
  const names = readers().sort();
  expect(names).toHaveLength(5);
  expect(names).toEqual(expect.arrayContaining([
    `${GONE_PID + 2}-${"2".repeat(64)}.json`, `${GONE_PID + 3}-${"3".repeat(64)}.json`, `1-${"f".repeat(64)}.json`, "notes.txt",
  ]));
  expect(names).not.toContain(`${GONE_PID}-${ZERO_SIGNATURE}.json`);
  expect(names).not.toContain(`${GONE_PID + 1}-${"1".repeat(64)}.json`);
  // The registration's own lease is the fifth entry.
  expect(names.some(name => name.startsWith(`${process.pid}-`))).toBe(true);
});

test("#632: the shard scope clears only its own gone leases", () => {
  const dir = home();
  writeLease(dir, "readers", GONE_PID, ZERO_SIGNATURE);
  writeLease(dir, "shard-readers", GONE_PID + 1, "1".repeat(64));
  const shard = registerReaderLease(dir, { scope: "shard" }); cleanup.push(shard);
  expect(readdirSync(join(dir, "shard-readers"))).not.toContain(`${GONE_PID + 1}-${"1".repeat(64)}.json`);
  expect(readdirSync(join(dir, "shard-readers"))).toHaveLength(1);
  expect(readdirSync(join(dir, "readers"))).toEqual([`${GONE_PID}-${ZERO_SIGNATURE}.json`]);
  shard();
  const legacy = registerReaderLease(dir); cleanup.push(legacy);
  expect(readdirSync(join(dir, "readers"))).not.toContain(`${GONE_PID}-${ZERO_SIGNATURE}.json`);
});

test("#632: one registration scans at most 256 lease names and the next reader clears the rest", () => {
  const dir = home(), readers = () => leaseNames(dir).filter(name => name.endsWith(".json"));
  for (let index = 0; index < 300; index++) writeLease(dir, "readers", GONE_PID + index, "a".repeat(64));
  const close = registerReaderLease(dir); cleanup.push(close);
  expect(readers()).toHaveLength(300 - 256 + 1);
  close();
  expect(readers()).toHaveLength(44);
  // The next reader is a new process, so its own first registration scans the remaining names.
  const script = join(dir, "clear-gone-leases.ts");
  writeFileSync(script, `import { registerReaderLease } from ${JSON.stringify(join(import.meta.dir, "../src/memory/reader-lease.ts"))};\nregisterReaderLease(${JSON.stringify(dir)})();\n`);
  const child = spawnSync(process.execPath, [script], { encoding: "utf8", env: process.env });
  expect(child.status).toBe(0);
  expect(readers()).toEqual([]);
}, 60_000);

test("#632: a registration never runs an identity probe on another lease's pid", () => {
  const dir = home();
  for (let index = 0; index < 100; index++) writeLease(dir, "readers", GONE_PID + index, "b".repeat(64));
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const spy = spyOn(childProcess, "execFileSync");
  let close: (() => void) | undefined, calls: [string, readonly string[]][] = [];
  try { close = registerReaderLease(dir); calls = spy.mock.calls as unknown as [string, readonly string[]][]; }
  finally { spy.mockRestore(); }
  if (close) cleanup.push(close);
  const psPids = calls.filter(call => call[0] === "ps").map(call => String(call[1]?.[1]));
  // The positive arm: the registration's own identity probe did run; no lease pid was probed.
  expect(psPids).toContain(String(process.pid));
  expect(psPids.every(pid => pid === String(process.pid))).toBe(true);
  expect(leaseNames(dir)).toHaveLength(1);
});

test("#632: doctor's readers hint is true, a gone lease clears on the next registration", async () => {
  const root = home(), memory = join(root, "memory"), cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  expect(memoryGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
  writeLease(memory, "readers", GONE_PID, ZERO_SIGNATURE);
  const readers = async () => {
    const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = memory;
    try { return JSON.parse(await runCli(["doctor", "--json"], { cwd, env: {}, stdinTTY: false })).sections.readers; }
    finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
  };
  expect(await readers()).toMatchObject({ status: "attention", stale: 1, unreadable: 0, hint: "a reader lease of a process that is gone is cleared by the next reader; an unreadable one needs a look" });
  registerReaderLease(memory)();
  expect(await readers()).toMatchObject({ status: "ok", live: 0, stale: 0, unreadable: 0 });
}, 60_000);
