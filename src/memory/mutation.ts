import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";

export const MUTATION_BUSY_TIMEOUT_MS = 3000;
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
