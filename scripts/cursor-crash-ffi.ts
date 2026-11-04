#!/usr/bin/env bun
// NONSHIPPING child factory. All SQLite pointers originate from this child's sqlite3_open.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { endianness } from "node:os";
import { createHash } from "node:crypto";

const arg = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const dbArg = arg("--db"), outArg = arg("--out");
if (!dbArg || !outArg) throw Error("child usage: bun cursor-crash-ffi.ts --db /synthetic/cursor.db --out /synthetic/artifacts");
const file = resolve(dbArg), out = resolve(outArg);
// The companion parent creates this exact synthetic file. Never create or select an arbitrary live store here.
if (file !== join(out, "cursor.db") || !existsSync(join(out, "ffi-fixture-marker.json"))) throw Error("synthetic fixture marker missing");
const named = statSync(file); if (!named.isFile() || named.nlink !== 1 || named.size > 1024 * 1024) throw Error("invalid fixture database");
if (endianness() !== "LE" || !["arm64", "x64"].includes(process.arch)) throw Error("only little-endian 64-bit fixture hosts supported");
const library = process.platform === "darwin" ? "/usr/lib/libsqlite3.dylib" : process.platform === "linux" ? "libsqlite3.so.0" : undefined;
if (!library) throw Error("unsupported fixture platform");
const lib = dlopen(library, {
  sqlite3_open: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_exec: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_db_cacheflush: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_close: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_changes: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_extended_errcode: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_libversion: { args: [], returns: FFIType.cstring },
  sqlite3_sourceid: { args: [], returns: FFIType.cstring },
});
const s = lib.symbols;
let connection: number | null = null, stage = "open", lastRc = 0;
// These remain reachable for the entire sqlite3_open call. The output is a C sqlite3* owned solely by this library.
const filename = Buffer.from(file + "\0"), output = Buffer.alloc(8);
function record(value: object) { writeSync(1, JSON.stringify({ stage, ...value }) + "\n"); }
function checked(rc: number) { lastRc = rc; if (rc !== 0) throw Error("fixture SQLite call failed"); }
function exec(sql: string) {
  if (Buffer.byteLength(sql) > 512 || sql.includes("\0")) throw Error("fixture SQL bound");
  const input = Buffer.from(sql + "\0"); checked(s.sqlite3_exec(connection!, ptr(input), null, null, null));
}
function snapshot(label: string) {
  const info: Record<string, unknown> = {};
  for (const suffix of ["", "-journal"]) {
    const name = file + suffix;
    if (!existsSync(name)) { info[suffix || "db"] = { exists: false }; continue; }
    const size = statSync(name).size; if (size > 1024 * 1024) throw Error("fixture exceeds unchanged 1 MiB ceiling");
    const bytes = readFileSync(name);
    writeFileSync(join(out, label + (suffix ? ".journal" : ".db")), bytes, { mode: 0o600, flag: "wx" });
    info[suffix || "db"] = { exists: true, bytes: size, first64Hex: bytes.subarray(0, 64).toString("hex"), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return info;
}
try {
  const openRc = s.sqlite3_open(ptr(filename), ptr(output));
  const address = output.readBigUInt64LE();
  if (address > 0n && address <= BigInt(Number.MAX_SAFE_INTEGER)) connection = Number(address);
  checked(openRc);
  if (connection === null) throw Error("sqlite3_open returned invalid owned pointer");
  record({ library, sqliteVersion: String(s.sqlite3_libversion()), sqliteSourceId: String(s.sqlite3_sourceid()), pointerOrigin: "sqlite3_open-output-only", openRc });
  // No journal_mode/synchronous/cache/locking changes. Completed sqlite3_exec statements leave no active statement cursor.
  stage = "seed-begin"; exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 1000; i++) { stage = "seed-insert"; exec(`INSERT INTO fallback VALUES ('${i.toString(16).padStart(64, "0")}','2026-11-04T00:00:00.000Z')`); }
  stage = "seed-commit"; exec("COMMIT");
  const committed = snapshot("seed-committed"); record({ committed });
  stage = "crash-begin"; exec("BEGIN IMMEDIATE");
  stage = "cursor-update"; exec("UPDATE cursor SET offset=1 WHERE id=1");
  const cursorChanged = s.sqlite3_changes(connection);
  if (cursorChanged !== 1) throw Error("cursor fixture update count mismatch");
  stage = "fallback-update"; exec("UPDATE fallback SET at='2099-01-01T00:00:00.000Z'");
  const fallbackChanged = s.sqlite3_changes(connection);
  if (fallbackChanged !== 1000) throw Error("fallback fixture update count mismatch");
  const beforeFlush = snapshot("pre-flush");
  stage = "cacheflush"; const flushRc = s.sqlite3_db_cacheflush(connection);
  // db_cacheflush returns its error directly; do not substitute sqlite3_errcode/errmsg for this result.
  record({ cursorChanged, fallbackChanged, flushRc }); checked(flushRc);
  const afterFlush = snapshot("pre-kill");
  writeFileSync(join(out, "ffi-child-state.json"), JSON.stringify({ library, cursorChanged, fallbackChanged, flushRc, committed, beforeFlush, afterFlush }, null, 2) + "\n", { mode: 0o600 });
  stage = "kill-ready"; record({ flushRc, cursorChanged, fallbackChanged });
  process.kill(process.pid, "SIGKILL");
  throw Error("SIGKILL unexpectedly returned");
} catch {
  writeSync(2, JSON.stringify({ stage, rc: lastRc, extendedRc: connection === null ? null : s.sqlite3_extended_errcode(connection) }) + "\n");
  if (connection !== null) s.sqlite3_close(connection);
  lib.close(); process.exit(2);
}
