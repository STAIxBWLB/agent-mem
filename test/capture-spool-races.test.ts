import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
