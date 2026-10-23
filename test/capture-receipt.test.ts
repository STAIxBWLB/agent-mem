import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaptureStore, type CaptureInput } from "../src/memory/capture.ts";

const at = "2026-10-23T01:00:00.000Z";
const input: CaptureInput = { at, project: "receipt-project", agent: "codex", event: "message", excerpt: "public deterministic ingest record" };
type ReceiptStore = { append(input: CaptureInput, options?: { receipt?: string }): { id?: number; already?: true; spooled?: true } };

test("stable ingest receipts dedupe direct and contended spool replays while native appends remain distinct", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-capture-receipt-"));
  const store = new CaptureStore({ home, project: input.project, now: () => Date.parse(at) });
  let queued: CaptureStore | undefined;
  const holder = new Database(join(store.dir, "capture.db"));
  let locked = false;
  try {
    const receipt = "a".repeat(64), first = (store as ReceiptStore).append(input, { receipt });
    expect(first.id).toBeNumber();
    expect((store as ReceiptStore).append(input, { receipt })).toEqual({ id: first.id, already: true });
    holder.run("BEGIN IMMEDIATE"); locked = true;
    queued = new CaptureStore({ home, project: input.project, busyTimeoutMs: 0, now: () => Date.parse(at) });
    const next = { ...input, excerpt: "second public ingest record" }, nextReceipt = "b".repeat(64);
    expect((queued as ReceiptStore).append(next, { receipt: nextReceipt })).toEqual({ spooled: true });
    expect((queued as ReceiptStore).append(next, { receipt: nextReceipt })).toEqual({ spooled: true });
    holder.run("COMMIT"); locked = false;
    expect((store as ReceiptStore).append(next, { receipt: nextReceipt }).already).toBe(true);
    expect(store.rows()).toHaveLength(2);
    store.append(input); store.append(input);
    expect(store.rows()).toHaveLength(4);
  } finally { if (locked) holder.run("ROLLBACK"); queued?.close(); holder.close(); store.close(); rmSync(home, { recursive: true, force: true }); }
});

test("receipt capture requires a stable timestamp and a bounded opaque digest before storing anything", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-capture-receipt-invalid-"));
  const store = new CaptureStore({ home, project: input.project });
  try {
    const { at: _at, ...untimed } = input;
    expect(() => (store as ReceiptStore).append(untimed, { receipt: "a".repeat(64) })).toThrow();
    for (const receipt of ["", "not-a-digest", "a".repeat(65)]) expect(() => (store as ReceiptStore).append(input, { receipt })).toThrow();
    expect(store.rows()).toEqual([]);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});
