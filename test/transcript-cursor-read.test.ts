import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTranscriptCursorOffset, TRANSCRIPT_CURSOR_BUSY_MS } from "../scripts/transcript-cursor-read.ts";

function spawnLock(file: string, mode = "lock") {
  return Bun.spawn([process.execPath, join(import.meta.dir, "fakes/transcript-cursor-lock.ts"), file, mode], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function fixture(work: (file: string, child: ReturnType<typeof spawnLock>) => Promise<void>, mode = "lock") {
  const root = mkdtempSync(join(tmpdir(), "amem-cursor-busy-")), file = join(root, "cursor.db");
  const db = new Database(file);
  db.run("PRAGMA journal_mode=DELETE"); db.run("CREATE TABLE cursor(offset INTEGER NOT NULL)"); db.run("INSERT INTO cursor VALUES (1234)");
  if (mode === "hot") { db.run("CREATE TABLE spill(data BLOB)"); for (let i = 0; i < 32; i++) db.run("INSERT INTO spill VALUES (zeroblob(4096))"); }
  db.close();
  const child = spawnLock(file, mode);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("locked\n");
    await work(file, child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.write("release\n"); child.stdin.end(); }
    await child.exited; rmSync(root, { recursive: true, force: true });
  }
}

test("readonly measurement retries BUSY and waits for the actual writer to release", async () => {
  await fixture(async (file, child) => {
    const before = readFileSync(file), mtime = statSync(file).mtimeMs;
    let busy = 0; const started = performance.now();
    const offset = readTranscriptCursorOffset(file, () => { busy++; child.stdin.write("release\n"); child.stdin.flush(); });
    expect(offset).toBe(1234); expect(busy).toBe(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    await child.exited;
    expect(readFileSync(file)).toEqual(before); expect(statSync(file).mtimeMs).toBe(mtime);
  });
});

test("persistent BUSY is an actionable measurement failure, never a fabricated offset", async () => {
  await fixture(async file => {
    let busy = 0; const started = performance.now();
    expect(() => readTranscriptCursorOffset(file, () => { busy++; })).toThrow(`SQLITE_BUSY persisted through the ${TRANSCRIPT_CURSOR_BUSY_MS} ms read-only wait`);
    expect(busy).toBe(1); expect(performance.now() - started).toBeLessThan(5000);
  });
});

test("non-BUSY missing schema propagates without retry or schema initialization", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-cursor-schema-")), file = join(root, "cursor.db");
  const db = new Database(file); db.close();
  try {
    let busy = 0; const before = readFileSync(file);
    expect(() => readTranscriptCursorOffset(file, () => { busy++; })).toThrow("no such table: cursor");
    expect(busy).toBe(0); expect(readFileSync(file)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("hot rollback journal stays unrecovered and non-BUSY is not retried", async () => {
  await fixture(async (file, child) => {
    child.kill("SIGKILL"); await child.exited;
    const journal = file + "-journal", before = readFileSync(file), pending = readFileSync(journal);
    expect([...pending.subarray(0, 8)].some(byte => byte !== 0)).toBe(true);
    let busy = 0;
    let observed: unknown;
    try { readTranscriptCursorOffset(file, () => { busy++; }); } catch (error) { observed = error; }
    expect((observed as { code?: string })?.code).toBe("SQLITE_READONLY_ROLLBACK");
    expect(busy).toBe(0); expect(readFileSync(file)).toEqual(before); expect(readFileSync(journal)).toEqual(pending);
  }, "hot");
});
