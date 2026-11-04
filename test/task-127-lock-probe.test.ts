import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxDevice, parseProcLocks, parseProcStat, processIdentity, snapshotCursorLocks } from "../scripts/task-127-lock-probe.ts";

test("task127 proc stat identity uses field22 despite spaces and parentheses in comm", () => {
  const fields = Array.from({ length: 20 }, (_, i) => String(i + 4)); fields[0] = "42"; fields[1] = "77"; fields[18] = "999999999999";
  const parsed = parseProcStat(`321 (name with ) nested (comm)) D ${fields.join(" ")}\n`, 321);
  expect(parsed).toMatchObject({ pid: 321, available: true, ppid: 42, pgid: 77, state: "D", startIdentity: "321:999999999999" });
  expect(parseProcStat(`322 (different PID) S ${fields.join(" ")}`, 321)).toBeUndefined();
  expect(parseProcStat("321 (short) S 1 2 3", 321)).toBeUndefined();
});

test("task127 proc locks matches decimal inode and hexadecimal device without PID-owner guesses", () => {
  const parsed = parseProcLocks([
    "1: POSIX ADVISORY WRITE 123 08:af:9007199254740993 1073741824 1073741825",
    "2: -> POSIX ADVISORY READ 124 08:af:9007199254740993 0 EOF",
    "3: OFDLCK ADVISORY WRITE -1 08:af:9007199254740993 0 EOF",
    "4: POSIX ADVISORY WRITE 125 08:ae:9007199254740993 0 EOF",
    "5: POSIX ADVISORY WRITE 126 08:af:9007199254740994 0 EOF",
    "malformed record",
  ].join("\n"), { major: "8", minor: "175", ino: "9007199254740993" });
  expect(parsed.locks).toHaveLength(3);
  expect(parsed.locks[0]).toMatchObject({ pid: 123, start: "1073741824", end: "1073741825", blocked: false });
  expect(parsed.locks[1]).toMatchObject({ pid: 124, blocked: true });
  expect(parsed.locks[2]).toMatchObject({ pid: -1, type: "OFDLCK" });
  expect(parsed.malformed).toBe(1);
  expect(linuxDevice(0x8afn)).toEqual({ major: "8", minor: "175" });
});

test("task127 PID start identity is repeatable and a missing cursor is explicitly unavailable", async () => {
  const first = processIdentity(process.pid), second = processIdentity(process.pid);
  expect(first.available).toBe(true); expect(first.startIdentity).toBe(second.startIdentity);
  expect(first.startPrecision).toBe(process.platform === "linux" ? "kernel-clock-ticks" : "microseconds");
  const missing = await snapshotCursorLocks(join(tmpdir(), `task127-never-created-${process.pid}-${Date.now()}.db`), [process.pid]);
  expect(missing.available).toBe(false); expect(missing.complete).toBe(false); expect(missing.unavailable).toContain("ENOENT");
});

test("task127 observes a real isolated exclusive SQLite locker without changing cursor bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "task127-lock-observer-")), file = join(root, "cursor.db");
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    const db = new Database(file); db.run("CREATE TABLE cursor (offset INTEGER)"); db.run("INSERT INTO cursor VALUES (7)"); db.close();
    const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex"), before = hash();
    child = Bun.spawn([process.execPath, "-e", "import {Database} from 'bun:sqlite';import {writeSync} from 'node:fs';const db=new Database(process.argv.at(-1));db.run('BEGIN EXCLUSIVE');writeSync(1,'ready\\n');await Bun.stdin.text();db.run('ROLLBACK');db.close();", file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await Promise.race([reader.read(), Bun.sleep(3000).then(() => { throw Error("locker never became ready"); })]); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    const observed = await snapshotCursorLocks(file, [child.pid]);
    expect(observed.available, JSON.stringify(observed)).toBe(true);
    expect(observed.fileIdentityUnchanged).toBe(true);
    expect(observed.locks.some(lock => lock.pid === child!.pid && lock.mode === "WRITE" && !lock.blocked), JSON.stringify(observed)).toBe(true);
    expect(observed.processes.find(item => item.pid === child!.pid)?.available).toBe(true);
    expect(hash()).toBe(before);
    child.stdin!.end(); expect(await child.exited).toBe(0);
    const after = await snapshotCursorLocks(file, [process.pid]);
    expect(after.available).toBe(true); expect(after.locks.some(lock => lock.pid === child!.pid)).toBe(false); expect(hash()).toBe(before);
    const alias = join(root, "alias.db"); symlinkSync(file, alias);
    expect((await snapshotCursorLocks(alias)).unavailable).toContain("unsafe-cursor-type");
  } finally { if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } rmSync(root, { recursive: true, force: true }); }
});
