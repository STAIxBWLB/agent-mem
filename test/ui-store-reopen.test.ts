import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../src/memory/candidates.ts";
import { CaptureStore } from "../src/memory/capture.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { snapshotRevision } from "../src/ui/snapshot-revision.ts";

test("identical consolidation upserts preserve total_changes and ctime; every SET column still updates", () => {
  const base = mkdtempSync(join(tmpdir(), "amem-receipt-noop-")), project = "fixture", store = new CandidateStore({ memoryDir: base });
  try {
    const id = store.put({ project, kind: "consolidation", action: "merge", noteKind: "decision", text: "fixture merge", about: [],
      targets: [{ id: "a".repeat(32), revision: "b".repeat(64) }, { id: "c".repeat(32), revision: "d".repeat(64) }] }, "public");
    store.reject(id, { project, actor: "person", verdict: "public" });
    // total_changes is per connection; inspect the actual store connection without adding a product test flag.
    const db = Reflect.get(store, "db") as Database;
    const changes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const stamp = () => ["candidates.db", "candidates.db-wal"].map(name => {
      const file = join(base, name); if (!existsSync(file)) return null;
      const stat = statSync(file, { bigint: true }); return [stat.ctimeNs, stat.mtimeNs, stat.size];
    });
    const before = changes(), times = stamp();
    store.list({ project, status: "all" });
    expect(changes()).toBe(before); expect(stamp()).toEqual(times);
    for (const [status, noteId] of [["accepted", null], ["accepted", "e".repeat(32)], ["accepted", null]] as const) {
      db.query("UPDATE candidates SET status = ?, note_id = ? WHERE id = ?").run(status, noteId, id);
      const start = changes(); store.list({ project, status: "all" });
      expect(changes() - start).toBe(1);
      expect(store.reviewedConsolidation(id, project)).toEqual({ status, acceptedNoteId: noteId });
      const settled = changes(), settledTimes = stamp(); store.list({ project, status: "all" });
      expect(changes()).toBe(settled); expect(stamp()).toEqual(settledTimes);
    }
  } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});

test("reopening warm console stores does not author a false data revision", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-reopen-")), base = join(root, "memory"), project = "fixture";
  try {
    const memory = new MemoryStore({ memoryDir: base }); memory.close();
    const capture = new CaptureStore({ memoryDir: base, project }); capture.close();
    const candidates = new CandidateStore({ memoryDir: base });
    const id = candidates.put({ project, kind: "consolidation", action: "merge", noteKind: "decision", text: "fixture merge", about: [],
      targets: [{ id: "a".repeat(32), revision: "b".repeat(64) }, { id: "c".repeat(32), revision: "d".repeat(64) }] }, "public");
    candidates.reject(id, { project, actor: "person", verdict: "public" }); candidates.close();
    const before = snapshotRevision(base);
    const reopened = new CandidateStore({ memoryDir: base });
    expect(reopened.reviewedConsolidation(id, project)).toMatchObject({ status: "rejected" }); reopened.close();
    const captured = new CaptureStore({ memoryDir: base, project }); captured.close();
    expect(snapshotRevision(base)).toBe(before);
    const file = join(base, "candidates.db"), db = new Database(file);
    try { db.query("UPDATE candidates SET status = 'accepted', note_id = ? WHERE id = ?").run("e".repeat(32), id); } finally { db.close(); }
    const changed = new CandidateStore({ memoryDir: base });
    try { expect(changed.reviewedConsolidation(id, project)).toEqual({ status: "accepted", acceptedNoteId: "e".repeat(32) }); }
    finally { changed.close(); }
    expect(snapshotRevision(base)).not.toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skipping an already-correct chmod preserves hardening of an incorrectly permissioned database", () => {
  const base = mkdtempSync(join(tmpdir(), "amem-reopen-mode-"));
  try {
    const candidates = new CandidateStore({ memoryDir: base }); candidates.close();
    const file = join(base, "candidates.db");
    for (const mode of [0o640, 0o4600, 0o2600, 0o1600]) {
      chmodSync(file, mode);
      const reopened = new CandidateStore({ memoryDir: base }); reopened.close();
      expect(statSync(file).mode & 0o7777).toBe(0o600);
    }
    const memory = new MemoryStore({ memoryDir: base }); memory.close();
    const capture = new CaptureStore({ memoryDir: base, project: "fixture" }), captureFile = join(capture.dir, "capture.db"); capture.close();
    for (const mode of [0o640, 0o4600, 0o2600, 0o1600]) {
      chmodSync(captureFile, mode);
      const hardened = new CaptureStore({ memoryDir: base, project: "fixture" }); hardened.close();
      expect(statSync(captureFile).mode & 0o7777).toBe(0o600);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
