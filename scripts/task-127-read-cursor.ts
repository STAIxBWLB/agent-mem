/** Measurement-only readback. No writable open, hook rerun or journal recovery. */
import { Database } from "bun:sqlite";
interface Reader { offset(): number; close(): void }
interface Options {
  onBusy(event: { attempt: number; elapsedMs: number }): void;
  onFirstBusy?(): Promise<void>;
  /** Isolated control seams; native diagnostics use the defaults. */
  ports?: { now(): number; sleep(ms: number): Promise<void>; open(file: string): Reader };
}
export async function readCursorOffset(file: string, options: Options): Promise<number> {
  const ports = options.ports ?? { now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms), open: (file: string): Reader => {
    const db = new Database(file, { readonly: true });
    return { offset: () => (db.query("SELECT offset FROM cursor").get() as { offset: number }).offset, close: () => db.close() };
  } };
  const started = ports.now(), end = started + 25; let first: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1 && ports.now() >= end) throw first;
    let reader: Reader | undefined;
    try { reader = ports.open(file); return reader.offset(); }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
      first ??= error;
      options.onBusy({ attempt, elapsedMs: ports.now() - started });
      reader?.close(); reader = undefined;
      if (attempt === 1) await options.onFirstBusy?.();
      if (attempt === 5 || ports.now() >= end) throw first;
    } finally { reader?.close(); }
    await ports.sleep(Math.min(5, Math.max(0, end - ports.now())));
  }
  throw first;
}
