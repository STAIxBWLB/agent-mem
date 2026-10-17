import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readProfileJSON, writeProfileJSON } from "./generation.ts";
import { mutationDatabase } from "./mutation.ts";
import { processLiveness, processSignature } from "./platform.ts";

const READER_LEASE_SCHEMA = "agent-mem.reader-lease/v1";
const RENEW_MS = 25_000;
interface Lease { schema: typeof READER_LEASE_SCHEMA; pid: number; signature: string; renewedAt: string }
interface OpenLease { refs: number; timer: ReturnType<typeof setInterval> }
const open = new Map<string, OpenLease>();

const fileFor = (memoryDir: string, pid: number, signature: string) => join(memoryDir, "readers", `${pid}-${signature}.json`);
const record = (pid: number, signature: string): Lease => ({ schema: READER_LEASE_SCHEMA, pid, signature, renewedAt: new Date().toISOString() });

function withFence<T>(memoryDir: string, work: () => T): T {
  const db = mutationDatabase(memoryDir);
  try { return db.transaction(work).immediate(); } finally { db.close(); }
}

function checkReadersDir(memoryDir: string): string {
  const dir = join(memoryDir, "readers");
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error("reader lease directory is not a regular directory");
  return dir;
}

/** One lease per process, reference-counted across handles; an unref'd timer does not keep the process resident. */
export function registerReaderLease(memoryDir: string): () => void {
  const signature = processSignature(process.pid);
  if (!signature) throw new Error("cannot establish reader lease identity");
  const file = fileFor(memoryDir, process.pid, signature);
  const current = open.get(file);
  if (current) {
    current.refs++;
  } else {
    const dir = checkReadersDir(memoryDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    withFence(memoryDir, () => writeProfileJSON(file, record(process.pid, signature)));
    const timer = setInterval(() => {
      if (!open.has(file)) return;
      try { writeProfileJSON(file, record(process.pid, signature)); } catch { /* the next renewal or migration admission decides */ }
    }, RENEW_MS);
    timer.unref();
    open.set(file, { refs: 1, timer });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const held = open.get(file);
    if (!held) return;
    held.refs--;
    if (held.refs > 0) return;
    clearInterval(held.timer);
    open.delete(file);
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Lease;
      if (value.pid === process.pid && value.signature === signature) rmSync(file);
    } catch { /* another actor replaced it: never remove its lease */ }
  };
}

/** Fail closed on a live or unverifiable lease; remove only a pid confirmed gone, never by TTL. */
export function assertNoLiveReaders(memoryDir: string): { removed: number } {
  return withFence(memoryDir, () => {
    const dir = checkReadersDir(memoryDir);
    let names: string[] = [];
    try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch { return { removed: 0 }; }
    let removed = 0;
    for (const name of names) {
      if (!/^[1-9][0-9]*-[0-9a-f]{64}\.json$/.test(name)) throw new Error("unverifiable reader lease filename");
      const file = join(dir, name);
      let lease: Lease;
      try {
        const value = readProfileJSON(file) as Partial<Lease> | undefined;
        if (!value || value.schema !== READER_LEASE_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid! <= 0
          || typeof value.signature !== "string" || !/^[0-9a-f]{64}$/.test(value.signature)
          || fileFor(memoryDir, value.pid!, value.signature) !== file || typeof value.renewedAt !== "string" || Number.isNaN(Date.parse(value.renewedAt))) throw new Error();
        lease = value as Lease;
      } catch { throw new Error("reader lease is unreadable or unverifiable"); }
      const liveness = processLiveness(lease.pid, lease.signature);
      if (liveness === "live") throw new Error(`legacy reader is live (pid ${lease.pid}); close it before migration`);
      if (liveness === "unknown") throw new Error(`legacy reader liveness is unknown (pid ${lease.pid})`);
      rmSync(file);
      removed++;
    }
    return { removed };
  });
}
