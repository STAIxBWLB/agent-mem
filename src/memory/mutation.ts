import { Database } from "bun:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";

export const MUTATION_BUSY_TIMEOUT_MS = 3000;
// ponytail: older hubs (before consuming this agent-mem), raw/legacy log writers and any segment editor
// that bypasses this lock are not serialized. Require every writer to take it, or make segment appends API-only.
/** An empty, machine-local SQLite file used only for crash-safe writer exclusion, never for memory data. */
export function mutationDatabase(dir: string): Database {
  const file = join(dir, "mutation-lock.db"), db = new Database(file, { create: true });
  chmodSync(file, 0o600);
  db.run(`PRAGMA busy_timeout = ${MUTATION_BUSY_TIMEOUT_MS}`);
  return db;
}

/** Sync holds a separate connection across awaits; an unrelated call on the same MemoryStore cannot bypass it. */
export function acquireMutation(dir: string): (() => void) | undefined {
  const db = mutationDatabase(dir);
  try { db.run("BEGIN IMMEDIATE"); }
  catch { db.close(); return undefined; }
  return () => { try { db.run("ROLLBACK"); } finally { db.close(); } };
}

/** Short local admission fence, never held across sync/network or data mutations. */
export function readerAdmissionDatabase(dir: string): Database {
  const file = join(dir, "reader-admission.db");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = lstatSync(file + suffix, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("reader admission fence is not a regular file");
  }
  const db = new Database(file, { create: true });
  try { chmodSync(file, 0o600); db.run(`PRAGMA busy_timeout = ${MUTATION_BUSY_TIMEOUT_MS}`); return db; }
  catch (error) { db.close(); throw error; }
}
