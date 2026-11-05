/** Measurement-only cursor observation. Never recover or reopen a hook database writable. */
import { Database } from "bun:sqlite";

export const TRANSCRIPT_CURSOR_BUSY_MS = 2000;
/** One immediate read followed by at most one bounded wait, outside the measured hook interval. */
export function readTranscriptCursorOffset(file: string, onBusy = () => {
  console.log(JSON.stringify({ diagnostic: "transcript-cursor-busy", waitBoundMs: TRANSCRIPT_CURSOR_BUSY_MS }));
}): number {
  const db = new Database(file, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout=0");
    const read = () => (db.query("SELECT offset FROM cursor").get() as { offset: number }).offset;
    try { return read(); }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
      onBusy();
      db.run(`PRAGMA busy_timeout=${TRANSCRIPT_CURSOR_BUSY_MS}`);
      try { return read(); }
      catch (retryError) {
        if ((retryError as { code?: string }).code !== "SQLITE_BUSY") throw retryError;
        throw Error(`transcript budget cursor measurement failed: SQLITE_BUSY persisted through the ${TRANSCRIPT_CURSOR_BUSY_MS} ms read-only wait; retain this failure and rerun the complete budget script after the writer exits`);
      }
    }
  } finally { db.close(); }
}
