import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readCursorOffset } from "../scripts/task-127-read-cursor.ts";

test("task127 cursor retry caps five BUSY reads, closes each connection and preserves the first error", async () => {
  const first = Object.assign(new Error("first busy"), { code: "SQLITE_BUSY" }); let clock = 0, reads = 0, closes = 0;
  const events: number[] = [];
  await expect(readCursorOffset("synthetic", { onBusy: event => events.push(event.attempt), ports: {
    now: () => clock, sleep: async ms => { clock += ms; }, open: () => ({ offset() { reads++; throw reads === 1 ? first : Object.assign(new Error("later busy"), { code: "SQLITE_BUSY" }); }, close() { closes++; } }),
  } })).rejects.toBe(first);
  expect(reads).toBe(5); expect(closes).toBe(5); expect(events).toEqual([1, 2, 3, 4, 5]); expect(clock).toBeLessThanOrEqual(25);
});
test("task127 retry checks the absolute deadline before reopening and propagates non-BUSY", async () => {
  let clock = 0, reads = 0;
  const busy = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
  await expect(readCursorOffset("synthetic", { onBusy() {}, onFirstBusy: async () => { clock = 26; }, ports: {
    now: () => clock, sleep: async ms => { clock += ms; }, open: () => ({ offset() { reads++; throw busy; }, close() {} }),
  } })).rejects.toBe(busy); expect(reads).toBe(1);
  const corrupt = Object.assign(new Error("corrupt"), { code: "SQLITE_CORRUPT" }); reads = 0;
  await expect(readCursorOffset("synthetic", { onBusy() { throw Error("must not retry"); }, ports: {
    now: () => 0, sleep: async () => {}, open: () => ({ offset() { reads++; throw corrupt; }, close() {} }),
  } })).rejects.toBe(corrupt); expect(reads).toBe(1);
});
test("task127 functional transient locker returns the actual readonly offset after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "task127-transient-lock-")), file = join(root, "cursor.db");
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    const db = new Database(file); db.run("CREATE TABLE cursor(offset INTEGER)"); db.run("INSERT INTO cursor VALUES(7)"); db.close();
    child = Bun.spawn([process.execPath, "-e", "import{Database}from'bun:sqlite';import{writeSync}from'node:fs';const d=new Database(process.argv.at(-1));d.run('BEGIN EXCLUSIVE');writeSync(1,'ready');await Bun.stdin.text();d.run('ROLLBACK');d.close();", file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const ready = await Promise.race([reader.read(), Bun.sleep(3000).then(() => { throw Error("locker not ready"); })]); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready");
    let clock = 0; const observed: number[] = [];
    const offset = await readCursorOffset(file, { onBusy: event => observed.push(event.attempt),
      onFirstBusy: async () => { child!.stdin.end(); expect(await child!.exited).toBe(0); },
      // Functional concurrency proof uses a controlled observation clock; retry-cap tests above prove the25ms scheduling rule.
      ports: { now: () => clock, sleep: async ms => { clock += ms; }, open: file => {
        const db = new Database(file, { readonly: true }); return { offset: () => (db.query("SELECT offset FROM cursor").get() as { offset: number }).offset, close: () => db.close() };
      } },
    });
    expect(offset).toBe(7); expect(observed).toEqual([1]);
  } finally { if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } rmSync(root, { recursive: true, force: true }); }
});
test("task127 actual readonly schema-less and real hot-journal observations never heal files", async () => {
  const root = mkdtempSync(join(tmpdir(), "task127-hot-journal-")), file = join(root, "cursor.db");
  const hash = (name: string) => createHash("sha256").update(readFileSync(name)).digest("hex");
  try {
    new Database(file).close(); const empty = hash(file);
    await expect(readCursorOffset(file, { onBusy() {} })).rejects.toThrow("no such table"); expect(hash(file)).toBe(empty);
    const db = new Database(file); db.run("CREATE TABLE cursor(id INTEGER PRIMARY KEY,offset INTEGER)"); db.run("INSERT INTO cursor VALUES(1,0)"); db.run("CREATE TABLE fallback(digest TEXT PRIMARY KEY,at TEXT)"); db.close();
    writeFileSync(join(root, "ffi-fixture-marker.json"), "{}");
    const killed = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "fakes/cursor-crash.ts"), "--db", file, "--out", root], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(killed.signalCode, killed.stderr.toString()).toBe("SIGKILL");
    expect(readFileSync(file + "-journal").subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
    const before = [hash(file), hash(file + "-journal")];
    await expect(readCursorOffset(file, { onBusy() {} })).rejects.toBeDefined();
    expect([hash(file), hash(file + "-journal")]).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
