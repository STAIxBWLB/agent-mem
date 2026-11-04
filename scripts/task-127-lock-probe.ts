/** Nonshipping task127 observer. Never imported by src/, never opens SQLite, never heals a journal.
 * Linux layouts: https://man7.org/linux/man-pages/man5/proc_locks.5.html and proc_pid_stat.5.html.
 * Darwin F_GETLK/layout: Apple XNU bsd/sys/fcntl.h and fcntl(2), verified against the installed SDK.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { endianness } from "node:os";
import { dlopen, FFIType, ptr } from "bun:ffi";

const MAX_PROC_BYTES = 4 * 1024 * 1024, MAX_PIDS = 64, MAX_LOCKS = 256;
export interface ProcessObservation {
  pid: number; available: boolean; source: "proc-stat" | "libproc-bsdinfo";
  startIdentity?: string; startPrecision?: "kernel-clock-ticks" | "microseconds";
  ppid?: number; pgid?: number; state?: string; flags?: number; error?: string;
}
export interface FileIdentity { dev: string; ino: string; nlink: string; size: string; major?: string; minor?: string }
export interface LockObservation {
  source: "proc-locks" | "darwin-f-getlk"; type: string; mode: string; pid: number;
  start: string; end: string; blocked: boolean;
}
export interface CursorLockSnapshot {
  diagnostic: "task127-cursor-locks"; platform: string; observerPid: number; at: string;
  startedMs: number; finishedMs: number; available: boolean; complete: boolean;
  file?: FileIdentity; fileIdentityUnchanged?: boolean;
  lockObservation?: { pid: number; startedMs: number; finishedMs: number };
  locks: LockObservation[]; processes: ProcessObservation[]; unavailable: string[]; limitations: string[];
}
const now = () => performance.timeOrigin + performance.now();
const code = (error: unknown): string => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "observer-error";
function boundedText(file: string, maximum: number): { text: string; truncated: boolean } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(maximum + 1); let at = 0;
    while (at < bytes.length) { const count = readSync(fd, bytes, at, bytes.length - at, null); if (!count) break; at += count; }
    return { text: bytes.subarray(0, Math.min(at, maximum)).toString("utf8"), truncated: at > maximum };
  } finally { closeSync(fd); }
}
export function linuxDevice(dev: bigint): { major: string; minor: string } {
  // glibc gnu_dev_major/minor encoding, preserving wide device numbers without Number rounding.
  return { major: (((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)).toString(),
    minor: ((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)).toString() };
}
export function parseProcStat(text: string, expectedPid: number): ProcessObservation | undefined {
  const match = /^(\d+) \(([\s\S]*)\) ([A-Za-z]) (.*)\s*$/.exec(text.trim());
  if (!match || Number(match[1]) !== expectedPid) return;
  const fields = match[4]!.trim().split(/\s+/), start = fields[18]; // state=field3, tail starts at field4, starttime=field22.
  if (!start || !/^\d+$/.test(start) || !/^\d+$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[1] ?? "")) return;
  return { pid: expectedPid, available: true, source: "proc-stat", startIdentity: `${expectedPid}:${start}`,
    startPrecision: "kernel-clock-ticks", ppid: Number(fields[0]), pgid: Number(fields[1]), state: match[3] };
}
export function parseProcLocks(text: string, identity: Pick<FileIdentity, "ino" | "major" | "minor">): { locks: LockObservation[]; malformed: number } {
  const locks: LockObservation[] = []; let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\d+:\s+(->\s+)?(POSIX|FLOCK|OFDLCK|LEASE)\s+\S+\s+(READ|WRITE|UNLCK)\s+(-?\d+)\s+([a-f\d]+):([a-f\d]+):(\d+)\s+(\d+)\s+(\d+|EOF)\s*$/i.exec(line);
    if (!match) { malformed++; continue; }
    if (BigInt(`0x${match[5]}`).toString() !== identity.major || BigInt(`0x${match[6]}`).toString() !== identity.minor || BigInt(match[7]!).toString() !== identity.ino) continue;
    locks.push({ source: "proc-locks", blocked: !!match[1], type: match[2]!, mode: match[3]!, pid: Number(match[4]), start: match[8]!, end: match[9]! });
  }
  return { locks, malformed };
}
function identity(file: string): FileIdentity {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("not a regular cursor"), { code: "unsafe-cursor-type" });
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), nlink: stat.nlink.toString(), size: stat.size.toString(), ...(process.platform === "linux" ? linuxDevice(stat.dev) : {}) };
}
function linuxProcess(pid: number): ProcessObservation {
  try {
    const raw = boundedText(`/proc/${pid}/stat`, 16 * 1024);
    const parsed = raw.truncated ? undefined : parseProcStat(raw.text, pid);
    return parsed ?? { pid, available: false, source: "proc-stat", error: raw.truncated ? "stat-truncated" : "stat-unparsed" };
  } catch (error) { return { pid, available: false, source: "proc-stat", error: code(error) }; }
}
let processLibrary: ReturnType<typeof openProcessLibrary> | undefined;
function openProcessLibrary() {
  return dlopen("/usr/lib/libproc.dylib", { proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
}
/** Stable within one boot. Darwin ABI is pinned to the installed/published 64-bit proc_bsdinfo layout. */
export function processIdentity(pid: number): ProcessObservation {
  const source = process.platform === "linux" ? "proc-stat" : "libproc-bsdinfo";
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, available: false, source, error: "invalid-pid" };
  if (process.platform === "linux") return linuxProcess(pid);
  if (process.platform !== "darwin" || endianness() !== "LE" || !["arm64", "x64"].includes(process.arch)) return { pid, available: false, source, error: "unsupported-process-abi" };
  try {
    processLibrary ??= openProcessLibrary();
    // Apple sys/proc_info.h: PROC_PIDTBSDINFO=3; 12 uint32 fields + char16 + char32 + 6 uint32 + 2 uint64 =136.
    const info = Buffer.alloc(136);
    const size = processLibrary.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.length);
    if (size !== info.length || info.readUInt32LE(12) !== pid) return { pid, available: false, source, error: "proc-pidinfo-unavailable-or-layout" };
    const seconds = info.readBigUInt64LE(120), useconds = info.readBigUInt64LE(128);
    if (seconds === 0n || useconds >= 1_000_000n) return { pid, available: false, source, error: "proc-pidinfo-invalid-start" };
    return { pid, available: true, source, startIdentity: `${pid}:${seconds}:${useconds}`, startPrecision: "microseconds",
      ppid: info.readUInt32LE(16), pgid: info.readUInt32LE(100), state: `bsd-status-${info.readUInt32LE(4)}`, flags: info.readUInt32LE(0) };
  } catch (error) { return { pid, available: false, source, error: code(error) }; }
}
/** Short-lived isolated child: closing an fd in a SQLite-owning process could release its POSIX locks. */
async function darwinGetlk(file: string): Promise<{ available: boolean; locks: LockObservation[]; error?: string; observerPid?: number; startedMs?: number; finishedMs?: number }> {
  if (process.platform !== "darwin" || endianness() !== "LE" || !["arm64", "x64"].includes(process.arch)) return { available: false, locks: [], error: "unsupported-darwin-abi" };
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), "--darwin-getlk", file], { stdout: "pipe", stderr: "pipe", timeout: 1000 });
  if (child.exitCode !== 0 || child.stdout.byteLength > 16 * 1024) return { available: false, locks: [], error: child.signalCode ? "probe-signal" : "probe-failed" };
  try { return JSON.parse(child.stdout.toString()) as { available: boolean; locks: LockObservation[]; error?: string; observerPid?: number; startedMs?: number; finishedMs?: number }; }
  catch { return { available: false, locks: [], error: "probe-output-invalid" }; }
}
/** Snapshot only, not a final-exit assertion. A released lock or missing PID remains unattributed. */
export async function snapshotCursorLocks(file: string, candidatePids: readonly number[] = []): Promise<CursorLockSnapshot> {
  const result: CursorLockSnapshot = { diagnostic: "task127-cursor-locks", platform: process.platform, observerPid: process.pid, at: new Date().toISOString(),
    startedMs: now(), finishedMs: 0, available: false, complete: false, locks: [], processes: [], unavailable: [], limitations: [
      "Snapshot races with lock release and PID exit/reuse; no observed conflict does not prove no earlier locker.",
      "No writable open, SQLite connection, recovery or lock acquisition is performed.",
      "Observation I/O and process-table calls are not made preemptible by the diagnostic timeout.",
    ] };
  try {
    result.file = identity(file);
    const candidates = [...new Set(candidatePids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    if (candidates.length > MAX_PIDS || candidates.length !== new Set(candidatePids).size) result.unavailable.push("candidate-pid-bound-or-invalid");
    if (process.platform === "linux") {
      const lockStarted = now(), raw = boundedText("/proc/locks", MAX_PROC_BYTES), parsed = parseProcLocks(raw.text, result.file);
      result.lockObservation = { pid: process.pid, startedMs: lockStarted, finishedMs: now() };
      result.locks = parsed.locks.slice(0, MAX_LOCKS);
      if (raw.truncated || parsed.malformed || parsed.locks.length > MAX_LOCKS) result.unavailable.push("proc-lock-list-incomplete");
      const pids = [...new Set([...candidates, ...result.locks.map(lock => lock.pid).filter(pid => pid > 0)])];
      if (pids.length > MAX_PIDS) result.unavailable.push("owner-pid-bound");
      result.processes = pids.slice(0, MAX_PIDS).map(processIdentity); result.available = true;
      result.limitations.push("/proc/locks is PID-namespace scoped; OFD locks may report PID -1. Waiting rows are marked blocked, not owners.");
    } else if (process.platform === "darwin") {
      const observed = await darwinGetlk(file); result.locks = observed.locks; result.available = observed.available;
      if (observed.observerPid !== undefined && observed.startedMs !== undefined && observed.finishedMs !== undefined) result.lockObservation = { pid: observed.observerPid, startedMs: observed.startedMs, finishedMs: observed.finishedMs };
      if (!observed.available) result.unavailable.push(observed.error ?? "getlk-unavailable");
      const pids = [...new Set([...candidates, ...result.locks.map(lock => lock.pid).filter(pid => pid > 0)])];
      if (pids.length > MAX_PIDS) result.unavailable.push("owner-pid-bound");
      result.processes = pids.slice(0, MAX_PIDS).map(processIdentity);
      result.limitations.push("Generic whole-file READ/WRITE F_GETLK queries report at most the first conflict each, not every SQLite lock range.",
        "F_GETLK runs in an isolated observer child; PID identity is a separate timestamped libproc snapshot, not an atomic lock-owner/exit proof.");
    } else result.unavailable.push("unsupported-platform");
    const after = identity(file); result.fileIdentityUnchanged = after.dev === result.file.dev && after.ino === result.file.ino;
    if (!result.fileIdentityUnchanged) result.unavailable.push("cursor-identity-changed");
    if (result.processes.some(item => !item.available)) result.unavailable.push("some-process-identities-unavailable");
    result.complete = result.available && result.unavailable.length === 0;
  } catch (error) { result.unavailable.push(code(error)); }
  result.finishedMs = now(); return result;
}
async function runDarwinGetlk(file: string): Promise<void> {
  const startedMs = now();
  // ponytail: each generic whole-file query reports only its first conflict. Upgrade to version-pinned
  // SQLite lock-range queries if attribution needs more coverage, retaining isolated readonly observation.
  // Darwin 64-bit struct flock: off_t start/len, pid_t pid, short type/whence; 24 bytes.
  // Verified from the installed SDK sys/fcntl.h and Apple XNU's published header. F_GETLK=7, READ=1, UNLOCK=2, WRITE=3.
  const lib = dlopen("/usr/lib/libSystem.B.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
  let fd: number | undefined;
  try {
    const before = identity(file); fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const held = fstatSync(fd, { bigint: true });
    if (held.dev.toString() !== before.dev || held.ino.toString() !== before.ino) throw Object.assign(new Error("changed"), { code: "cursor-identity-changed" });
    const locks: LockObservation[] = [];
    for (const type of [1, 3]) {
      const flock = Buffer.alloc(24); flock.writeInt16LE(type, 20); // SEEK_SET=0, start=0,len=0 query through EOF.
      if (lib.symbols.fcntl(fd, 7, ptr(flock)) !== 0) throw Object.assign(new Error("fcntl failed"), { code: "getlk-failed" });
      const returned = flock.readInt16LE(20);
      if (returned !== 2) locks.push({ source: "darwin-f-getlk", type: "POSIX", mode: returned === 1 ? "READ" : returned === 3 ? "WRITE" : `unknown-${returned}`,
        pid: flock.readInt32LE(16), start: flock.readBigInt64LE(0).toString(), end: flock.readBigInt64LE(8) === 0n ? "EOF" : (flock.readBigInt64LE(0) + flock.readBigInt64LE(8) - 1n).toString(), blocked: false });
    }
    console.log(JSON.stringify({ available: true, observerPid: process.pid, startedMs, finishedMs: now(), locks }));
  } finally { if (fd !== undefined) closeSync(fd); lib.close(); }
}
if (import.meta.main) {
  if (process.argv[2] === "--darwin-getlk" && process.argv[3] && process.platform === "darwin") {
    try { await runDarwinGetlk(process.argv[3]); } catch (error) { console.log(JSON.stringify({ available: false, locks: [], error: code(error), observerPid: process.pid })); }
  } else if (process.argv[2]) console.log(JSON.stringify(await snapshotCursorLocks(process.argv[2], process.argv.slice(3).map(Number))));
  else throw new Error("usage: bun task-127-lock-probe.ts /synthetic/cursor.db [candidatePID...]");
}
