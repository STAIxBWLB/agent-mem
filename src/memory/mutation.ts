import { Database } from "bun:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { realPath } from "./platform.ts";

export const MUTATION_BUSY_TIMEOUT_MS = 3000;
// ponytail: older hubs (before consuming this agent-mem), raw/legacy log writers and any segment editor
// that bypasses this lock are not serialized. Require every writer to take it, or make segment appends API-only.
/** An empty, machine-local SQLite file used only for crash-safe writer exclusion, never for memory data. */
export function mutationDatabase(dir: string, busyTimeoutMs = MUTATION_BUSY_TIMEOUT_MS): Database {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MUTATION_BUSY_TIMEOUT_MS) throw new Error("invalid mutation busy timeout");
  const file = join(dir, "mutation-lock.db"), db = new Database(file, { create: true });
  chmodSync(file, 0o600);
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return db;
}

declare const mutationBrand: unique symbol;
/** Callable for compatibility; authority exists only in the module-private live registry. */
export interface MutationHandle { (): void; readonly [mutationBrand]: true }
const mutations = new WeakMap<MutationHandle, { dir: string; dev: number; ino: number; db: Database; active: boolean }>();
export function assertMutationHandle(handle: MutationHandle, dir: string): void {
  const state = mutations.get(handle), stat = lstatSync(dir);
  if (!state || !state.active || !state.db.inTransaction || stat.isSymbolicLink() || !stat.isDirectory()
    || realPath(dir) !== state.dir || stat.dev !== state.dev || stat.ino !== state.ino) throw new Error("mutation handle unavailable or directory changed");
}
/** Sync holds a separate connection across awaits; an unrelated call cannot bypass it. */
export function acquireMutation(dir: string): MutationHandle | undefined {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("mutation directory unavailable");
  const canonical = realPath(dir), db = mutationDatabase(canonical);
  try { db.run("BEGIN IMMEDIATE"); }
  catch { db.close(); return undefined; }
  const release = (() => {
    const state = mutations.get(release)!;
    if (!state.active) return;
    state.active = false;
    try { db.run("ROLLBACK"); } finally { db.close(); }
  }) as MutationHandle;
  mutations.set(release, { dir: canonical, dev: stat.dev, ino: stat.ino, db, active: true });
  try { assertMutationHandle(release, dir); } catch (error) { release(); throw error; }
  return release;
}

/** Short local admission fence, never held across sync/network or data mutations. */
export function readerAdmissionDatabase(dir: string, busyTimeoutMs = MUTATION_BUSY_TIMEOUT_MS): Database {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MUTATION_BUSY_TIMEOUT_MS) throw new Error("invalid reader admission busy timeout");
  const file = join(dir, "reader-admission.db");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = lstatSync(file + suffix, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("reader admission fence is not a regular file");
  }
  const db = new Database(file, { create: true });
  try { chmodSync(file, 0o600); db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`); return db; }
  catch (error) { db.close(); throw error; }
}
