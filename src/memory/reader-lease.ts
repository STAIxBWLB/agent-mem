import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readProfileJSON, writeProfileJSON } from "./generation.ts";
import { readerAdmissionDatabase } from "./mutation.ts";
import { processLiveness, processSignature } from "./platform.ts";

const READER_LEASE_SCHEMA = "agent-mem.reader-lease/v1";
const RENEW_MS = 25_000;
interface Lease { schema: typeof READER_LEASE_SCHEMA; pid: number; signature: string; renewedAt: string }
export interface ReaderLease { (): void; verify(): void }
interface OpenLease { refs: number; timer: ReturnType<typeof setInterval> }
const open = new Map<string, OpenLease>();
let activeIdentity: { pid: number; signature: string } | undefined;

const fileFor = (memoryDir: string, pid: number, signature: string) => join(memoryDir, "readers", `${pid}-${signature}.json`);
const record = (pid: number, signature: string): Lease => ({ schema: READER_LEASE_SCHEMA, pid, signature, renewedAt: new Date().toISOString() });

function withFence<T>(memoryDir: string, work: () => T): T {
  const db = readerAdmissionDatabase(memoryDir);
  try { return db.transaction(work).immediate(); } finally { db.close(); }
}

function checkReadersDir(memoryDir: string): string {
  const dir = join(memoryDir, "readers");
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("reader lease directory is not a regular directory");
  return dir;
}

function readLease(memoryDir: string, file: string): Lease | undefined {
  try {
    const value = readProfileJSON(file) as Partial<Lease> | undefined;
    if (value === undefined) return undefined;
    if (!value || value.schema !== READER_LEASE_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid! <= 0
      || typeof value.signature !== "string" || !/^[0-9a-f]{64}$/.test(value.signature)
      || fileFor(memoryDir, value.pid!, value.signature) !== file || typeof value.renewedAt !== "string" || Number.isNaN(Date.parse(value.renewedAt))) throw new Error();
    return value as Lease;
  } catch { throw new Error("reader lease is unreadable or unverifiable"); }
}

function ownedLease(memoryDir: string, file: string, signature: string): void {
  checkReadersDir(memoryDir);
  const lease = readLease(memoryDir, file);
  if (!lease || lease.pid !== process.pid || lease.signature !== signature) throw new Error("reader lease ownership is unavailable");
}

function admitReader(memoryDir: string): void {
  // The profile lock is created under the same reader admission fence, then held across migration awaits.
  // Even a malformed or stale marker refuses admission; only the profile-lock owner may reclaim it.
  try {
    if (lstatSync(join(memoryDir, "profile.lock"), { throwIfNoEntry: false })) throw new Error("profile lock prevents reader admission; finish or resume the migration with amem migrate --resume");
  } catch { throw new Error("profile lock prevents reader admission; finish or resume the migration with amem migrate --resume"); }
}

/** One lease per process, reference-counted across handles; an unref'd timer does not keep the process resident. */
export function registerReaderLease(memoryDir: string): ReaderLease {
  const pid = process.pid;
  // A live reference already established this process lifetime; nested readers keep the same identity.
  // Ownership and admission are still checked under the fence for every registration.
  const signature = open.size > 0 && activeIdentity?.pid === pid ? activeIdentity.signature : processSignature(pid);
  if (!signature) throw new Error("cannot establish reader lease identity");
  const file = fileFor(memoryDir, process.pid, signature);
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  withFence(memoryDir, () => {
    admitReader(memoryDir);
    const current = open.get(file);
    if (current) {
      ownedLease(memoryDir, file, signature);
      current.refs++;
      return;
    }
    const dir = checkReadersDir(memoryDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A failed earlier close may have retained evidence. Never overwrite an unverifiable replacement.
    const existing = readLease(memoryDir, file);
    if (existing && (existing.pid !== process.pid || existing.signature !== signature)) throw new Error("reader lease ownership is unavailable");
    writeProfileJSON(file, record(process.pid, signature));
    const timer = setInterval(() => {
      if (!open.has(file)) return;
      try {
        withFence(memoryDir, () => {
          ownedLease(memoryDir, file, signature);
          writeProfileJSON(file, record(process.pid, signature));
        });
      } catch { /* keep unknown evidence; migration admission remains fail-closed */ }
    }, RENEW_MS);
    timer.unref();
    open.set(file, { refs: 1, timer });
    activeIdentity = { pid, signature };
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const held = open.get(file);
    if (!held) return;
    held.refs--;
    if (held.refs > 0) return;
    clearInterval(held.timer);
    open.delete(file);
    try {
      withFence(memoryDir, () => {
        ownedLease(memoryDir, file, signature);
        rmSync(file);
      });
    } catch { /* another actor replaced it: never remove its lease */ }
  };
  return Object.assign(release, {
    verify(): void {
      if (released || process.pid !== pid || !open.has(file)) throw new Error("reader lease ownership is unavailable");
      // The held lifetime lease blocks legitimate migration. Verification reads only: no ps, DB fence or refcount mutation.
      // ponytail: no atomic same-user concurrent path-swap claim; descriptor-relative ownership checks are the upgrade path.
      admitReader(memoryDir);
      ownedLease(memoryDir, file, signature);
    },
  });
}

/** Fail closed on a live or unverifiable lease; remove only a pid confirmed gone, never by TTL. */
export function assertNoLiveReaders(memoryDir: string, options: { onDeadLeaseRemoved?: (event: { pid: number; lease: string }) => void } = {}): { removed: number } {
  return withFence(memoryDir, () => {
    const dir = checkReadersDir(memoryDir);
    let names: string[] = [];
    try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0 }; throw new Error("reader lease directory is unreadable"); }
    let removed = 0;
    for (const name of names) {
      if (!/^[1-9][0-9]*-[0-9a-f]{64}\.json$/.test(name)) throw new Error("unverifiable reader lease filename");
      const file = join(dir, name);
      const lease = readLease(memoryDir, file);
      if (!lease) throw new Error("reader lease is unreadable or unverifiable");
      const liveness = processLiveness(lease.pid, lease.signature);
      if (liveness === "live") throw new Error(`legacy reader is live (pid ${lease.pid}); close it before migration`);
      if (liveness === "unknown") throw new Error(`legacy reader liveness is unknown (pid ${lease.pid})`);
      rmSync(file);
      removed++;
      options.onDeadLeaseRemoved?.({ pid: lease.pid, lease: name });
    }
    return { removed };
  });
}
