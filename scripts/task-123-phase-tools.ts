/** Temporary measurement controls, never used by native registrations. Keep mapped files until every subprocess exits. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PHASE_BYTES, PHASE_MAGIC } from "../src/hook-phase-diagnostic.ts";
export function phaseTraceEnv(): NodeJS.ProcessEnv {
  const dir = process.env.TASK123_TRACE_DIR;
  if (!dir) return {};
  if (!isAbsolute(dir)) throw Error("task123 trace directory must be absolute; fix the measurement setup before running it");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw Error("task123 trace directory must be private; fix its mode before running it");
  const file = join(dir, randomUUID() + ".trace"), bytes = Buffer.alloc(PHASE_BYTES);
  bytes.writeUInt32LE(PHASE_MAGIC, 0); bytes.writeUInt32LE(1, 4);
  writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  return { AMEM_TASK123_TRACE: file };
}
export function phaseDiagnostics(stderr: Uint8Array): unknown[] {
  return Buffer.from(stderr).toString().split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return value?.diagnostic === "task123-worker" ? [value] : []; }
    catch { return []; }
  });
}
