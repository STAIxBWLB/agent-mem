/** Fixture-only observer. Never imported by capture, and never reads a real memory home. */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readMetrics } from "../src/memory/metrics.ts";
import { captureShardDir } from "../src/memory/shard.ts";

/** Observational source taps only; original callback, cursor commit and clocks remain unchanged. */
export function interleaveDiagnosticPreload(trace: string): string {
  if (process.env.AMEM_INTERLEAVE_DIAGNOSTIC_TRACE !== "1") return "";
  return String.raw`
 (globalThis as any).__interleave327=(value)=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({...value,pid:process.pid,timeMs:performance.now()})+"\n");
 Bun.plugin({name:'interleave327-scan-observer',setup(builder){builder.onLoad({filter:/[/]hook-transcript\.ts$/},({path:file})=>{
  let source=readFileSync(file,'utf8');
  const anchor='            if (staged) await options.onPublication?.(staged);';
  if(source.split(anchor).length!==2)throw Error('interleave diagnostic publication anchor changed; update scripts/diagnose-interleave.ts anchors to the current src/hook-transcript.ts');
  const around='if (staged) { (globalThis as any).__interleave327({phase:"publication-before",event:summary.event,cursorBase:cursor.offset,rowStart:cursor.offset+start,nextOffset:cursor.offset+newline+1,workElapsedMs:performance.now()-workStart,workBudgetMs:options.workBudgetMs,remainingHardMs:options.deadline-performance.now(),stopReason:stopReason??null,pending:staged.name}); const diagnosticReplayStart=performance.now(); await options.onPublication?.(staged); (globalThis as any).__interleave327({phase:"publication-after",event:summary.event,cursorBase:cursor.offset,rowStart:cursor.offset+start,nextOffset:cursor.offset+newline+1,callbackMs:performance.now()-diagnosticReplayStart,workElapsedMs:performance.now()-workStart,workBudgetMs:options.workBudgetMs,remainingHardMs:options.deadline-performance.now(),due:due(),stopReason:stopReason??null,pending:staged.name}); }';
  source=source.replace(anchor,around);
  const finish='    return { offset: cursor.offset + start, ...(stopReason ? { stopReason } : {}) };';
  if(source.split(finish).length!==2)throw Error('interleave diagnostic return anchor changed; update scripts/diagnose-interleave.ts anchors to the current src/hook-transcript.ts');
  source=source.replace(finish,'(globalThis as any).__interleave327({phase:"scan-return",offset:cursor.offset+start,workElapsedMs:performance.now()-workStart,workBudgetMs:options.workBudgetMs,remainingHardMs:options.deadline-performance.now(),stopReason:stopReason??null});'+finish);
  return {loader:'ts',contents:source};
 });}});
`;
}

/** Called after the measured hook and assertions, before fixture cleanup, even on a failing assertion. */
export function saveInterleaveDiagnostic(f: { root: string; base: string; project: string }, event: string,
  transcriptFile: string, traceFile: string, replayReads: unknown): void {
  const output = process.env.AMEM_INTERLEAVE_DIAGNOSTIC_DIR;
  if (!output) return;
  const target = join(output, `${event}-${basename(f.root)}`), errors: string[] = [];
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const query = (file: string, sql: string): Record<string, unknown>[] => {
    let db: Database | undefined;
    try { db = new Database(file, { readonly: true }); db.run("PRAGMA busy_timeout=0"); return db.query(sql).all() as Record<string, unknown>[]; }
    catch (error) { errors.push(`${basename(file)}:${(error as { code?: string }).code ?? "read-error"}`); return []; }
    finally { db?.close(); }
  };
  const cursors = join(f.base, "hook-transcripts");
  const cursorRows: { file: string; rows: Record<string, unknown>[] }[] = [];
  if (existsSync(cursors)) for (const name of readdirSync(cursors).filter(name => /^[a-f0-9]{16}\.db(?:-wal|-shm)?$/.test(name))) {
    const source = join(cursors, name), stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) { errors.push("cursor-copy-refused"); continue; }
    copyFileSync(source, join(target, `cursor-${name}`));
    if (name.endsWith(".db")) cursorRows.push({ file: name, rows: query(source, "SELECT * FROM cursor") });
  }
  let captureRows: Record<string, unknown>[] = [];
  try {
    const machine = JSON.parse(readFileSync(join(f.base, "machine.json"), "utf8")).id as string;
    if (!/^[a-f0-9]{16}$/.test(machine)) throw Error("invalid fixture machine");
    captureRows = query(join(captureShardDir(f.base, f.project, machine), "capture.db"), "SELECT id,event,excerpt,at,spool_id FROM rows ORDER BY id LIMIT 256");
  } catch { errors.push("capture-snapshot-unavailable"); }
  const pending: { name: string; event?: string; excerpt?: string }[] = [];
  for (const folder of [join(f.base, "hook-spool"), join(f.base, "hook-spool", ".capacity")]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(name => name.startsWith("hook-")).slice(0, 256)) {
      try { const value = JSON.parse(readFileSync(join(folder, name), "utf8")); pending.push({ name, event: value.capture?.event, excerpt: value.capture?.excerpt }); }
      catch { errors.push("pending-snapshot-unavailable"); }
    }
  }
  const transcript = readFileSync(transcriptFile), recapEnd = transcript.indexOf(10) + 1;
  if (existsSync(traceFile)) copyFileSync(traceFile, join(target, "trace.jsonl"));
  const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
  writeFileSync(join(target, "snapshot.json"), JSON.stringify({ event, cursorRows,
    transcript: { bytes: transcript.length, recapEnd, compactEnd: transcript.length }, captureRows, pending, metric, replayReads, errors }, null, 2) + "\n", { mode: 0o600 });
}
