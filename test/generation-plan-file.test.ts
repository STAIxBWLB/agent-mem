import { afterEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrunePlanFile, type PrunePlanFileIO } from "../src/cli.ts";
import { PRUNE_PLAN_MAX_BYTES } from "../src/memory/prune.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(content: string | Uint8Array = '{"synthetic":"original"}') {
  const dir = mkdtempSync(join(tmpdir(), "amem-plan-file-")); dirs.push(dir);
  const file = join(dir, "plan.json"); writeFileSync(file, content);
  return { dir, file };
}
function observedIO(hooks: { opened?: (file: string, fd: number) => void; firstStat?: (fd: number) => void } = {}) {
  const state = { opens: 0, stats: 0, reads: 0, bytesRead: 0, maximumRequest: 0, closes: 0, fd: -1 };
  const io: PrunePlanFileIO = {
    open: (file, flags) => { state.opens++; const fd = openSync(file, flags); state.fd = fd; hooks.opened?.(file, fd); return fd; },
    stat: fd => { state.stats++; const stat = fstatSync(fd); if (state.stats === 1) hooks.firstStat?.(fd); return stat; },
    read: (fd, buffer, offset, length, position) => {
      state.reads++; state.maximumRequest = Math.max(state.maximumRequest, length);
      const n = readSync(fd, buffer, offset, length, position); state.bytesRead += n; return n;
    },
    close: fd => { state.closes++; closeSync(fd); },
  };
  return { io, state };
}

test("prune plan pathname swapped to a symlink after open still reads only the original descriptor", () => {
  const original = '{"synthetic":"original"}', f = fixture(original), replacement = join(f.dir, "oversized.json");
  writeFileSync(replacement, "x".repeat(PRUNE_PLAN_MAX_BYTES + 100));
  const { io, state } = observedIO({ opened: file => { renameSync(file, join(f.dir, "opened-original.json")); symlinkSync(replacement, file); } });
  expect(readPrunePlanFile(f.file, io)).toBe(original);
  expect(state.opens).toBe(1); expect(state.closes).toBe(1); expect(state.bytesRead).toBe(Buffer.byteLength(original));
  expect(() => fstatSync(state.fd)).toThrow();
});

test("prune plan growth after descriptor fstat is refused with a bounded read and closed descriptor", () => {
  const f = fixture(), { io, state } = observedIO({ firstStat: () => appendFileSync(f.file, "x".repeat(PRUNE_PLAN_MAX_BYTES + 100)) });
  expect(() => readPrunePlanFile(f.file, io)).toThrow("prune plan unavailable or oversized");
  expect(state.opens).toBe(1); expect(state.bytesRead).toBeLessThanOrEqual(PRUNE_PLAN_MAX_BYTES + 1);
  expect(state.maximumRequest).toBeLessThanOrEqual(PRUNE_PLAN_MAX_BYTES + 1); expect(state.closes).toBe(1);
  expect(() => fstatSync(state.fd)).toThrow();
});

test("prune plan truncation after descriptor fstat is refused instead of accepting an incomplete snapshot", () => {
  const f = fixture(), { io, state } = observedIO({ firstStat: () => writeFileSync(f.file, "{}") });
  expect(() => readPrunePlanFile(f.file, io)).toThrow("prune plan unavailable or oversized");
  expect(state.closes).toBe(1); expect(() => fstatSync(state.fd)).toThrow();
});

test("oversized regular plan is refused before any descriptor content is read", () => {
  const f = fixture("x".repeat(PRUNE_PLAN_MAX_BYTES + 1)), { io, state } = observedIO();
  expect(() => readPrunePlanFile(f.file, io)).toThrow("prune plan unavailable or oversized");
  expect(state.opens).toBe(1); expect(state.reads).toBe(0); expect(state.closes).toBe(1);
});

test("plan reader refuses a preexisting symlink and non-regular descriptor without following a path reopen", () => {
  const f = fixture(), alias = join(f.dir, "alias.json"); symlinkSync(f.file, alias);
  expect(() => readPrunePlanFile(alias)).toThrow("prune plan unavailable or oversized");
  const { io, state } = observedIO();
  expect(() => readPrunePlanFile(f.dir, io)).toThrow("prune plan unavailable or oversized");
  expect(state.reads).toBe(0); expect(state.closes).toBe(1);
});

test("plan reader accepts the exact UTF-8 byte limit and rejects invalid UTF-8 with uniform errors", () => {
  const f = fixture("x".repeat(PRUNE_PLAN_MAX_BYTES));
  expect(Buffer.byteLength(readPrunePlanFile(f.file), "utf8")).toBe(PRUNE_PLAN_MAX_BYTES);
  writeFileSync(f.file, Buffer.from([255]));
  let message = ""; try { readPrunePlanFile(f.file); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("prune plan unavailable or oversized"); expect(message).not.toContain(f.file);
});
