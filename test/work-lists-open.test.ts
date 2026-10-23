import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/memory/platform.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";

// #383: open without the write lock when the index is current; close the snapshot connection when COMMIT fails.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function home() {
  const base = realPath(mkdtempSync(join(tmpdir(), "amem-work-open-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test("a second store opens while another connection holds a long write on the index (#383)", async () => {
  const base = home(), policy = () => true;
  const first = new WorkListStore({ base, project: "fixture/open", policy });
  cleanup.push(() => first.close());
  await first.write("plan", { status: "doing" });
  const writer = new Database(join(first.dir, "index.db"));
  writer.run("PRAGMA busy_timeout = 0");
  writer.run("BEGIN IMMEDIATE");
  cleanup.push(() => { try { writer.run("ROLLBACK"); } catch { /* already ended */ } writer.close(); });
  const started = performance.now();
  const second = new WorkListStore({ base, project: "fixture/open", policy });
  cleanup.push(() => second.close());
  expect(performance.now() - started).toBeLessThan(1000);
});

test("a COMMIT failure after the snapshot opens closes the read-only connection (#383)", async () => {
  const base = home();
  const store = new WorkListStore({ base, project: "fixture/commit", policy: () => true });
  cleanup.push(() => store.close());
  await store.write("plan", { status: "doing" });
  const index = join(store.dir, "index.db");
  const closed: string[] = [];
  const close = Database.prototype.close;
  Database.prototype.close = function (this: Database, ...args: unknown[]) { closed.push(this.filename); return (close as (...a: unknown[]) => void).apply(this, args); };
  cleanup.push(() => { Database.prototype.close = close; });
  const real = (store as any).mutation;
  (store as any).mutation = { transaction: (run: () => unknown) => ({ immediate: () => real.transaction(() => { run(); throw new Error("commit failed"); }).immediate() }) };
  await expect(store.read("plan")).rejects.toThrow("commit failed");
  (store as any).mutation = real;
  expect(closed.filter(name => name === index)).toHaveLength(1);
});
