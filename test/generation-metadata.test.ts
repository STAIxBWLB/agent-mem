import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON, LOCAL_METADATA_MAX_BYTES, readProfileJSON, writeProfileJSON } from "../src/memory/generation.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "amem-generation-metadata-")); dirs.push(dir); return { dir, file: join(dir, "metadata.json") }; }

test("oversized local metadata refuses before creating a destination or temporary file", () => {
  const f = fixture();
  expect(() => writeProfileJSON(f.file, { sources: "x".repeat(LOCAL_METADATA_MAX_BYTES) })).toThrow("memory profile metadata unavailable or invalid");
  expect(existsSync(f.file)).toBe(false); expect(readdirSync(f.dir)).toEqual([]);
});

test("local metadata byte limit includes multibyte UTF-8 and the trailing newline", () => {
  const f = fixture(), overhead = Buffer.byteLength(canonicalJSON({ body: "" }) + "\n", "utf8");
  const exact = { body: "x".repeat(LOCAL_METADATA_MAX_BYTES - overhead) };
  writeProfileJSON(f.file, exact);
  expect(statSync(f.file).size).toBe(LOCAL_METADATA_MAX_BYTES); expect(readProfileJSON(f.file)).toEqual(exact);
  const before = readFileSync(f.file);
  expect(() => writeProfileJSON(f.file, { body: exact.body + "x" })).toThrow("memory profile metadata unavailable or invalid");
  const multibyte = { body: "가".repeat(Math.ceil(LOCAL_METADATA_MAX_BYTES / 3)) };
  expect(canonicalJSON(multibyte).length).toBeLessThan(LOCAL_METADATA_MAX_BYTES);
  expect(() => writeProfileJSON(f.file, multibyte)).toThrow("memory profile metadata unavailable or invalid");
  expect(readFileSync(f.file)).toEqual(before); expect(readdirSync(f.dir)).toEqual(["metadata.json"]);
});

test("refused local metadata preserves prior valid bytes and never leaks the value or path", () => {
  const f = fixture(), previous = { schema: "synthetic/metadata/v1", sources: ["retained"] };
  writeProfileJSON(f.file, previous); const before = readFileSync(f.file);
  let message = "";
  try { writeProfileJSON(f.file, { privateValue: "SYNTHETIC-PRIVATE-MARKER".repeat(20_000) }); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("memory profile metadata unavailable or invalid; inspect the local profile before continuing");
  expect(message).not.toContain("SYNTHETIC-PRIVATE-MARKER"); expect(message).not.toContain(f.file);
  expect(readFileSync(f.file)).toEqual(before); expect(readProfileJSON(f.file)).toEqual(previous); expect(readdirSync(f.dir)).toEqual(["metadata.json"]);
});

test("non-JSON or cyclic metadata refuses before any filesystem effect", () => {
  const f = fixture(), cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [undefined, () => "invalid", cyclic]) expect(() => writeProfileJSON(f.file, value)).toThrow("memory profile metadata unavailable or invalid");
  expect(readdirSync(f.dir)).toEqual([]);
});
