import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { RecordInstructionMode } from "../hook-record.ts";

/** Person-written selection, separate from the configuration older readers parse. Core never writes it. */
export const RECORD_INSTRUCTION_FILE = "record-instruction.json";
const MAX_BYTES = 64 * 1024;
export function readRecordInstruction(base: string): { mode: RecordInstructionMode; invalid: boolean } {
  let fd: number | undefined;
  try {
    try { fd = openSync(join(base, RECORD_INSTRUCTION_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "a", invalid: false };
      return { mode: "a", invalid: true };
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) return { mode: "a", invalid: true };
    const bytes = Buffer.alloc(MAX_BYTES + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_BYTES) return { mode: "a", invalid: true };
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "instruction")) return { mode: "a", invalid: true };
    const mode = (value as { instruction: unknown }).instruction;
    return mode === "a" || mode === "b" || mode === "alternate" ? { mode, invalid: false } : { mode: "a", invalid: true };
  } catch { return { mode: "a", invalid: true }; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Selection never refuses a hook. */ } }
}
