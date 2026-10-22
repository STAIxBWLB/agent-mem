import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureStore } from "../src/memory/capture.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amem-spool-races-")); roots.push(root);
  const store = new CaptureStore({ home: root, project: "proj", machine: "race-machine", busyTimeoutMs: 1 });
  const lock = new Database(join(store.dir, "capture.db"));
  lock.run("PRAGMA busy_timeout = 0");
  return { root, store, lock };
}
function child(root: string, mode: string, barrier: string) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/capture-spool-race.ts"), root, mode, barrier],
    { env: { ...process.env, HOME: root, AMEM_HOME: join(root, "isolated-amem"), AGENTHUB_HOME: join(root, "isolated-hub") }, stdout: "pipe", stderr: "pipe" });
  children.push(proc);
  return proc;
}
async function ready(root: string, barrier: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(join(root, `${barrier}.ready`))) {
    if (Date.now() > deadline) throw new Error(`barrier ${barrier} not reached`);
    await Bun.sleep(5);
  }
}
const go = (root: string, barrier: string) => writeFileSync(join(root, `${barrier}.go`), "go");
function spool(store: CaptureStore, lock: Database, excerpt: string) {
  lock.run("BEGIN IMMEDIATE");
  try { expect(store.append({ project: "proj", agent: "race", event: "Stop", excerpt })).toEqual({ spooled: true }); }
  finally { lock.run("ROLLBACK"); }
}

test("an older drainer cannot remove a newer drainer's claimed spool", async () => {
  const f = fixture();
  try {
    spool(f.store, f.lock, "first row");
    const older = child(f.root, "drain", "older");
    await ready(f.root, "older"); // Older owns a snapshot of the first draining file.
    f.store.drain(); // A second drainer commits it and removes its claim.
    spool(f.store, f.lock, "newer row");
    const newer = child(f.root, "drain", "newer");
    await ready(f.root, "newer"); // Third drainer holds the next claim before its insert.
    go(f.root, "older");
    expect(await older.exited).toBe(0);
    newer.kill(); await newer.exited; // A crash must leave that newer claim recoverable.
    f.store.drain();
    expect(f.store.rows().map(row => row.excerpt)).toEqual(["first row", "newer row"]);
  } finally { f.lock.close(); f.store.close(); }
}, 15000);

test("a writer opened before a drain publishes a complete recoverable segment", async () => {
  const f = fixture();
  try {
    f.lock.run("BEGIN IMMEDIATE");
    const writer = child(f.root, "writer", "writer");
    await ready(f.root, "writer"); // The real writer has opened its spool inode but has not written yet.
    f.lock.run("ROLLBACK");
    f.store.drain(); // Must neither consume an unpublished segment nor unlink an active writer.
    go(f.root, "writer");
    expect(await writer.exited).toBe(0);
    f.store.drain();
    expect(f.store.rows().map(row => row.excerpt)).toEqual(["open writer row"]);
  } finally { if (f.lock.inTransaction) f.lock.run("ROLLBACK"); f.lock.close(); f.store.close(); }
}, 15000);

test("two contended subprocess writers and two drainers retain identical events exactly once", async () => {
  const f = fixture();
  try {
    f.lock.run("BEGIN IMMEDIATE");
    const writers = [child(f.root, "publish", "one"), child(f.root, "publish", "two")];
    expect(await Promise.all(writers.map(proc => proc.exited))).toEqual([0, 0]);
    f.lock.run("ROLLBACK");
    const drainers = [child(f.root, "recover", "one"), child(f.root, "recover", "two")];
    expect(await Promise.all(drainers.map(proc => proc.exited))).toEqual([0, 0]);
    f.store.drain();
    expect(f.store.rows().map(row => row.excerpt)).toEqual(["open writer row", "open writer row"]);
    expect(f.store.drain()).toEqual({ drained: 0, skipped: 0 });
  } finally { if (f.lock.inTransaction) f.lock.run("ROLLBACK"); f.lock.close(); f.store.close(); }
}, 15000);

const legacyLine = (excerpt: string, index: number) => JSON.stringify({ project: "proj", agent: "race", event: "Stop", excerpt,
  at: "2026-10-22T01:00:00.000Z", nonce: String(index) });

test("legacy backlog advances immutable offsets across line and byte budgets without duplicates", () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 1205 }, (_, i) => legacyLine(`row ${i} ` + "한".repeat(120), i));
    writeFileSync(join(f.store.dir, "spool.jsonl"), lines.join("\n") + "\n");
    const first = f.store.drain();
    expect(first.drained).toBeGreaterThan(0);
    expect(first.drained).toBeLessThanOrEqual(1000);
    expect(first.drained).toBeLessThan(1205);
    expect(readdirSync(join(f.store.dir, "spool")).some(name => name.includes(".offset-"))).toBe(true);
    for (let i = 0; i < 20 && f.store.rows({ limit: 2000 }).length < 1205; i++) f.store.drain();
    expect(f.store.rows({ limit: 2000 }).map(row => row.excerpt)).toEqual(lines.map((_, i) => `row ${i} ` + "한".repeat(120)));
    expect(f.store.drain()).toEqual({ drained: 0, skipped: 0 });
  } finally { f.lock.close(); f.store.close(); }
});

test("an oversized malformed legacy line cannot hide a later valid row across byte windows", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.store.dir, "spool.jsonl.draining"), "x".repeat(600000) + "\n" + legacyLine("after oversized line", 0) + "\n");
    let skipped = 0;
    for (let i = 0; i < 8 && f.store.rows().length === 0; i++) skipped += f.store.drain().skipped;
    expect(skipped).toBe(1);
    expect(f.store.rows().map(row => row.excerpt)).toEqual(["after oversized line"]);
  } finally { f.lock.close(); f.store.close(); }
});

test("a crash after commit before acknowledgement replays without doubling the row", async () => {
  const f = fixture();
  try {
    spool(f.store, f.lock, "committed before crash");
    const drainer = child(f.root, "ack", "ack");
    await ready(f.root, "ack");
    expect(f.store.rows().map(row => row.excerpt)).toEqual(["committed before crash"]);
    drainer.kill(); await drainer.exited;
    expect(f.store.drain()).toEqual({ drained: 0, skipped: 0 });
    expect(f.store.rows().map(row => row.excerpt)).toEqual(["committed before crash"]);
  } finally { f.lock.close(); f.store.close(); }
}, 15000);

test("the line budget acknowledges exactly its prefix and resumes the same immutable legacy file", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.store.dir, "spool.jsonl"), Array.from({ length: 1005 }, (_, i) => legacyLine(`short ${i}`, i)).join("\n") + "\n");
    expect(f.store.drain()).toEqual({ drained: 1000, skipped: 0 });
    expect(f.store.drain()).toEqual({ drained: 5, skipped: 0 });
    expect(f.store.rows({ limit: 2000 })).toHaveLength(1005);
  } finally { f.lock.close(); f.store.close(); }
});

function paddedSpoolLine(excerpt: string, index: number, bytes: number): string {
  const row = { project: "proj", agent: "race", event: "Stop", excerpt, at: "2026-10-22T01:00:00.000Z", nonce: String(index), padding: "" };
  const paddingBytes = bytes - 1 - Buffer.byteLength(JSON.stringify(row));
  if (paddingBytes < 0) throw new Error("fixture line is too short");
  const line = JSON.stringify({ ...row, padding: " ".repeat(paddingBytes) }) + "\n";
  expect(Buffer.byteLength(line)).toBe(bytes);
  return line;
}

test("a leftover byte window defers a complete multibyte row instead of marking it oversized", () => {
  const f = fixture();
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const directory = join(f.store.dir, "spool");
    mkdirSync(directory);
    writeFileSync(join(directory, "spool-0001.jsonl"), Array.from({ length: 100 }, (_, index) => paddedSpoolLine(`before ${index}`, index, 2620)).join(""));
    const target = "leftover 한글🙂 row";
    writeFileSync(join(directory, "spool-0002.jsonl"), paddedSpoolLine(target, 100, 600));
    const first = f.store.drain();
    expect(first).toEqual({ drained: 100, skipped: 0 });
    let skipped = first.skipped;
    for (let invocation = 0; invocation < 3; invocation++) skipped += f.store.drain().skipped;
    expect(skipped).toBe(0);
    expect(f.store.rows({ limit: 2000 }).map(row => row.excerpt)).toEqual([...Array.from({ length: 100 }, (_, index) => `before ${index}`), target]);
  } finally { clock.mockRestore(); f.lock.close(); f.store.close(); }
});

test("the 32-file claim cap includes both legacy inputs as well as ready segments", () => {
  const f = fixture();
  const clock = spyOn(performance, "now").mockReturnValue(0);
  try {
    const directory = join(f.store.dir, "spool");
    mkdirSync(directory);
    writeFileSync(join(f.store.dir, "spool.jsonl"), "");
    writeFileSync(join(f.store.dir, "spool.jsonl.draining"), "");
    for (let index = 0; index < 40; index++) writeFileSync(join(directory, `spool-${index.toString(16).padStart(4, "0")}.jsonl`), "");
    expect(f.store.drain()).toEqual({ drained: 0, skipped: 0 });
    const remaining = readdirSync(directory).length
      + Number(existsSync(join(f.store.dir, "spool.jsonl")))
      + Number(existsSync(join(f.store.dir, "spool.jsonl.draining")));
    expect(42 - remaining).toBe(32);
    expect(f.store.drain()).toEqual({ drained: 0, skipped: 0 });
    expect(readdirSync(directory)).toEqual([]);
  } finally { clock.mockRestore(); f.lock.close(); f.store.close(); }
});
