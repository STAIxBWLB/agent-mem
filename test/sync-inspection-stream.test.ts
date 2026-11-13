import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectionBoundReceipt } from "../src/memory/inspection-bound.ts";
import { readInspectionRow, visitInspectionFile, type InspectionLocation } from "../src/memory/inspection-stream.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function source(bytes: Buffer | string) {
  const root = mkdtempSync(join(tmpdir(), "amem-inspection-stream-")); roots.push(root);
  const file = join(root, "source.jsonl"); writeFileSync(file, bytes); return file;
}

test("streaming source inspection verifies prefixes and rereads a 9 MiB row without a source-byte ceiling", () => {
  const text = "x".repeat(9 * 1024 * 1024), bytes = Buffer.from(`first\n${text}\nlast\n`), file = source(bytes);
  const rows: InspectionLocation[] = [];
  const result = visitInspectionFile(file, [{ offset: 0, hash: hash("") }, { offset: 6, hash: hash("first\n") },
    { offset: bytes.length, hash: hash(bytes) }], (_row, location) => rows.push(location));
  expect(result).toMatchObject({ offset: bytes.length, hash: hash(bytes), tailBytes: 0 });
  expect(rows).toEqual([{ offset: 0, length: 5 }, { offset: 6, length: text.length }, { offset: 7 + text.length, length: 4 }]);
  expect(hash(readInspectionRow(file, rows[1]!, result.stamp))).toBe(hash(text));
});

test("physical rows are streamed without imposing the canonical outbound row limit", () => {
  const file = source("row\n".repeat(25_000)); let rows = 0;
  expect(visitInspectionFile(file, [], () => { rows++; }).offset).toBe(100_000);
  expect(rows).toBe(25_000);
});

test("row-memory refusal names a safe bound, while stale prefix, changed source and incomplete tail refuse", () => {
  const file = source("first\nsecond\n");
  let error: unknown;
  try { visitInspectionFile(file, [], () => {}, 4); } catch (value) { error = value; }
  expect(inspectionBoundReceipt(error)).toMatchObject({ kind: "row-bytes", limit: 4, observed: 5, nextStep: expect.any(String) });
  expect(JSON.stringify(inspectionBoundReceipt(error))).not.toContain(file);
  expect(() => visitInspectionFile(file, [{ offset: 6, hash: "0".repeat(64) }], () => {})).toThrow("input-changed");
  expect(() => visitInspectionFile(file, [], () => { writeFileSync(file, "other\nsecond\n"); })).toThrow("input-changed");
  expect(() => visitInspectionFile(source("unfinished"), [], () => {})).toThrow("input-unavailable");
});

test("callback errors retain their identity and incomplete bound diagnostics never invoke caller getters", () => {
  const marker = new Error("private caller error");
  try { visitInspectionFile(source("row\n"), [], () => { throw marker; }); throw Error("expected caller failure"); }
  catch (error) { expect(error).toBe(marker); }
  let reads = 0;
  expect(inspectionBoundReceipt({ get bound() { reads++; throw marker; } })).toBeUndefined();
  expect(inspectionBoundReceipt({ bound: { get kind() { reads++; return "rows"; }, limit: 1, observed: 2 } })).toBeUndefined();
  expect(inspectionBoundReceipt({ bound: { kind: "private pattern", limit: 1, observed: 2 } })).toBeUndefined();
  expect(reads).toBe(0);
});
