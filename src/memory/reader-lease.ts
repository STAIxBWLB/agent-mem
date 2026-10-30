import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readProfileJSON, writeProfileJSON } from "./generation.ts";
import { readerAdmissionDatabase } from "./mutation.ts";
import { processLiveness, processSignature } from "./platform.ts";
import { waitForPublicPruneWriter } from "./public-prune-view.ts";

const READER_LEASE_SCHEMA = "agent-mem.reader-lease/v1";
const RENEW_MS = 25_000;
interface Lease { schema: typeof READER_LEASE_SCHEMA; pid: number; signature: string; renewedAt: string }
export interface ReaderLease { (): void; verify(): void }
interface OpenLease { refs: number; timer: ReturnType<typeof setInterval>; busyTimeoutMs: number }
const open = new Map<string, OpenLease>();
let activeIdentity: { pid: number; signature: string } | undefined;

type LeaseScope = "legacy" | "shard";
const leaseFolder = (scope: LeaseScope) => scope === "shard" ? "shard-readers" : "readers";
const fileFor = (memoryDir: string, pid: number, signature: string, scope: LeaseScope) => join(memoryDir, leaseFolder(scope), `${pid}-${signature}.json`);
const record = (pid: number, signature: string): Lease => ({ schema: READER_LEASE_SCHEMA, pid, signature, renewedAt: new Date().toISOString() });

function withFence<T>(memoryDir: string, work: () => T, busyTimeoutMs = 3000): T {
  const db = readerAdmissionDatabase(memoryDir, busyTimeoutMs);
  try { return db.transaction(work).immediate(); } finally { db.close(); }
}

function checkReadersDir(memoryDir: string, scope: LeaseScope): string {
  const dir = join(memoryDir, leaseFolder(scope));
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("reader lease directory is not a regular directory");
  return dir;
}

function readLease(memoryDir: string, file: string, scope: LeaseScope): Lease | undefined {
  try {
    const value = readProfileJSON(file) as Partial<Lease> | undefined;
    if (value === undefined) return undefined;
    if (!value || value.schema !== READER_LEASE_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid! <= 0
      || typeof value.signature !== "string" || !/^[0-9a-f]{64}$/.test(value.signature)
      || fileFor(memoryDir, value.pid!, value.signature, scope) !== file || typeof value.renewedAt !== "string" || Number.isNaN(Date.parse(value.renewedAt))) throw new Error();
    return value as Lease;
  } catch { throw new Error("reader lease is unreadable or unverifiable"); }
}

function ownedLease(memoryDir: string, file: string, signature: string, scope: LeaseScope): void {
  checkReadersDir(memoryDir, scope);
  const lease = readLease(memoryDir, file, scope);
  if (!lease || lease.pid !== process.pid || lease.signature !== signature) throw new Error("reader lease ownership is unavailable");
}

function admitReader(memoryDir: string): void {
  // The profile lock is created under the same reader admission fence, then held across migration awaits.
  // Even a malformed or stale marker refuses admission; only the profile-lock owner may reclaim it.
  try {
    waitForPublicPruneWriter(memoryDir);
    if (lstatSync(join(memoryDir, "profile.lock"), { throwIfNoEntry: false })) throw new Error("profile lock prevents reader admission; finish or resume the migration with amem migrate --resume");
  } catch { throw new Error("profile lock prevents reader admission; finish or resume the migration with amem migrate --resume"); }
}

/** One lease per process/home/namespace, reference-counted across handles.
 * Shard scope shares root admission and native identity; it grants no authority.
 * An unref'd timer does not keep the process resident. */
export function registerReaderLease(memoryDir: string, options: { busyTimeoutMs?: number; signature?: string; scope?: "shard" } = {}): ReaderLease {
  if (options.scope !== undefined && options.scope !== "shard") throw new Error("invalid reader lease scope");
  const scope: LeaseScope = options.scope === "shard" ? "shard" : "legacy";
  const requestedTimeout = options.busyTimeoutMs ?? 3000;
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 0 || requestedTimeout > 3000) throw new Error("invalid reader admission busy timeout");
  if (options.signature !== undefined && (typeof options.signature !== "string" || !/^[a-f0-9]{64}$/.test(options.signature))) throw new Error("invalid reader lease identity");
  const pid = process.pid;
  // A live reference already established this process lifetime; nested readers keep the same identity.
  // Ownership and admission are still checked under the fence for every registration.
  const inherited = open.size > 0 && activeIdentity?.pid === pid ? activeIdentity.signature : undefined;
  if (inherited && options.signature !== undefined && options.signature !== inherited) throw new Error("reader lease identity changed");
  // Host-only: the supplied hash must already describe this process's pinned native ps identity.
  const signature = inherited ?? options.signature ?? processSignature(pid);
  if (!signature) throw new Error("cannot establish reader lease identity");
  const file = fileFor(memoryDir, process.pid, signature, scope);
  const busyTimeoutMs = open.get(file)?.busyTimeoutMs ?? requestedTimeout;
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  withFence(memoryDir, () => {
    admitReader(memoryDir);
    const current = open.get(file);
    if (current) {
      ownedLease(memoryDir, file, signature, scope);
      current.refs++;
      return;
    }
    const dir = checkReadersDir(memoryDir, scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A failed earlier close may have retained evidence. Never overwrite an unverifiable replacement.
    const existing = readLease(memoryDir, file, scope);
    if (existing && (existing.pid !== process.pid || existing.signature !== signature)) throw new Error("reader lease ownership is unavailable");
    writeProfileJSON(file, record(process.pid, signature));
    const timer = setInterval(() => {
      if (!open.has(file)) return;
      try {
        withFence(memoryDir, () => {
          ownedLease(memoryDir, file, signature, scope);
          writeProfileJSON(file, record(process.pid, signature));
        }, busyTimeoutMs);
      } catch { /* keep unknown evidence; migration admission remains fail-closed */ }
    }, RENEW_MS);
    timer.unref();
    open.set(file, { refs: 1, timer, busyTimeoutMs });
    activeIdentity = { pid, signature };
  }, busyTimeoutMs);
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
        ownedLease(memoryDir, file, signature, scope);
        rmSync(file);
      }, held.busyTimeoutMs);
    } catch { /* Contention or replacement keeps evidence; never remove another actor's lease. */ }
  };
  return Object.assign(release, {
    verify(): void {
      if (released || process.pid !== pid || !open.has(file)) throw new Error("reader lease ownership is unavailable");
      // The held lifetime lease blocks legitimate migration. Verification reads only: no ps, DB fence or refcount mutation.
      // ponytail: no atomic same-user concurrent path-swap claim; descriptor-relative ownership checks are the upgrade path.
      admitReader(memoryDir);
      ownedLease(memoryDir, file, signature, scope);
    },
  });
}

/** Default migration checks legacy readers only; v2 activation opts into both
 * namespaces under the same root admission fence. Scope is cooperation, not authentication. */
export function assertNoLiveReaders(memoryDir: string, options: { includeShards?: boolean; onDeadLeaseRemoved?: (event: { pid: number; lease: string }) => void } = {}): { removed: number } {
  return withFence(memoryDir, () => {
    let removed = 0;
    const scopes: LeaseScope[] = options.includeShards === true ? ["legacy", "shard"] : ["legacy"];
    for (const scope of scopes) {
      const dir = checkReadersDir(memoryDir, scope);
      let names: string[] = [];
      try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("reader lease directory is unreadable"); }
      for (const name of names) {
        if (!/^[1-9][0-9]*-[0-9a-f]{64}\.json$/.test(name)) throw new Error("unverifiable reader lease filename");
        const file = join(dir, name);
        const lease = readLease(memoryDir, file, scope);
        if (!lease) throw new Error("reader lease is unreadable or unverifiable");
        const liveness = processLiveness(lease.pid, lease.signature);
        if (liveness === "live") throw new Error(`legacy reader is live (pid ${lease.pid}); close it before migration`);
        if (liveness === "unknown") throw new Error(`legacy reader liveness is unknown (pid ${lease.pid})`);
        rmSync(file);
        removed++;
        options.onDeadLeaseRemoved?.({ pid: lease.pid, lease: name });
      }
    }
    return { removed };
  });
}
