import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Nonshipping numeric metadata only. A missing receipt never proves a phase was reached. */
export enum HookWorkerPhase {
  Boot = 1, StaticModulesLoaded, CaptureModuleLoaded, TranscriptModuleLoaded,
  ScanEnter, ScanReturn, StoreOpen, StoreOpened, DrainWriteEnter, DrainWriteReturn,
  StoreClose, StoreClosed, OutputBegin, OutputEnd, Stop,
  TransactionEnter, CommitEnter, CommitReturn, TransactionThrow,
  Truncated = 30, AnchorRefused = 31,
}
export type HookWorkerPhaseReceipt = { phase: HookWorkerPhase; pid: number; parentPid: number; atMs: number; seq: number };
export type HookWorkerPhaseReport = { rows: HookWorkerPhaseReceipt[]; partialTail: boolean };
const MAX_BYTES = 8 * 1024 * 1024;
const mark = (phase: HookWorkerPhase) => `globalThis[Symbol.for('amem.test.worker.phases.emit')](${phase});`;

/** All anchors must match exactly once. No branches, timers, or return values are rewritten. */
export function instrumentHookWorkerPhases(source: string): string {
  const anchors: [string, string][] = [
    ["const SCAN_COMMIT_MS = 20;", `${mark(HookWorkerPhase.StaticModulesLoaded)}const SCAN_COMMIT_MS = 20;`],
    ["captureModule.then(() => { captureReady = true;", `captureModule.then(() => { ${mark(HookWorkerPhase.CaptureModuleLoaded)}captureReady = true;`],
    ['const { scanHookTranscriptTail } = await import("./hook-transcript.ts");', `const { scanHookTranscriptTail } = await import("./hook-transcript.ts");${mark(HookWorkerPhase.TranscriptModuleLoaded)}`],
    ["const scanned = await scanHookTranscriptTail(scan.transcript, {", `${mark(HookWorkerPhase.ScanEnter)}const scanned = await scanHookTranscriptTail(scan.transcript, {`],
    ["if (scanned) progress(scanned);", `${mark(HookWorkerPhase.ScanReturn)}if (scanned) progress(scanned);`],
    ["store ??= new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0, cwd: options.cwd });", `if (!store) { ${mark(HookWorkerPhase.StoreOpen)}store = new CaptureStore({ memoryDir: options.base!, project, busyTimeoutMs: 0, cwd: options.cwd });${mark(HookWorkerPhase.StoreOpened)}if ((store as any).db?.constructor) globalThis[Symbol.for('amem.test.worker.phases.installSqlite')]((store as any).db.constructor); }`],
    ["const appended = store.append(input, { receipt });", `${mark(HookWorkerPhase.DrainWriteEnter)}const appended = store.append(input, { receipt });${mark(HookWorkerPhase.DrainWriteReturn)}`],
    ["} finally { store?.close(); }", `} finally { if (store) { ${mark(HookWorkerPhase.StoreClose)}store.close();${mark(HookWorkerPhase.StoreClosed)} } }`],
    ["await Bun.stdout.write(body.slice(0, -1)", `${mark(HookWorkerPhase.OutputBegin)}await Bun.stdout.write(body.slice(0, -1)`],
    ["    stop();\n  };", `    ${mark(HookWorkerPhase.OutputEnd)}stop();\n  };`],
    ["const stop: () => never = () => {", `const stop: () => never = () => {${mark(HookWorkerPhase.Stop)}`],
  ];
  for (const [anchor, replacement] of anchors) {
    if (source.split(anchor).length !== 2) throw Error("Worker phase anchor changed; update the diagnostic and rerun its controls");
    source = source.replace(anchor, replacement);
  }
  return source;
}

/** Installer runs only when the real transcript module reaches its existing SQLite import. */
export function instrumentTranscriptPhaseSource(source: string): string {
  const anchor = 'import { Database } from "bun:sqlite";';
  if (source.split(anchor).length !== 2) throw Error("Worker transcript SQLite anchor changed; update the diagnostic and rerun its controls");
  return source.replace(anchor, anchor + "\nglobalThis[Symbol.for('amem.test.worker.phases.installSqlite')](Database);");
}

export function createHookWorkerPhases(root: string, sourceRoot: string): { preload: string; file: string; read(parentPid?: number): HookWorkerPhaseReceipt[]; readReport(parentPid?: number): HookWorkerPhaseReport } {
  const dir = join(root, "worker-phases"); mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, "receipts.jsonl"), preload = join(dir, "preload.ts");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); closeSync(fd);
  const target = resolve(sourceRoot, "src/session-brief-worker.ts");
  // ponytail: 512 events per worker plus one truncation marker, and 8 MiB per artifact. A larger schedule needs a reviewed streaming reader.
  const body = `import {openSync,writeSync,readFileSync,lstatSync,fstatSync,constants} from 'node:fs';
const key=Symbol.for('amem.test.worker.phases.emit');
if(!globalThis[key]){
 const directory=lstatSync(${JSON.stringify(dir)});if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o777)!==0o700)throw Error('Worker phase directory unavailable; retain the artifact and inspect the phase observer');
 const file=${JSON.stringify(file)},before=lstatSync(file);
 if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||(before.mode&0o777)!==0o600||before.nlink!==1||before.size>${MAX_BYTES})throw Error('Worker phase receipt unavailable; retain the artifact and inspect the phase observer');
 const fd=openSync(file,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW),opened=fstatSync(fd);
 if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('Worker phase receipt changed; retain the artifact and inspect the phase observer');
 let seq=0,truncated=false;
 const emit=phase=>{if(truncated)return;if(seq>=512){phase=${HookWorkerPhase.Truncated};truncated=true;}const row={phase,pid:process.pid,parentPid:process.ppid,atMs:performance.timeOrigin+performance.now(),seq:++seq};try{writeSync(fd,JSON.stringify(row)+'\\n');}catch{/* Missing evidence stays missing. */}};
 globalThis[key]=emit;emit(${HookWorkerPhase.Boot});
 const installed=new WeakSet();
 globalThis[Symbol.for('amem.test.worker.phases.installSqlite')]=Database=>{
 if(installed.has(Database))return;installed.add(Database);
 const transaction=Database.prototype.transaction,run=Database.prototype.run;
 const wrappers=new WeakMap();
 const wrap=fn=>{if(wrappers.has(fn))return wrappers.get(fn);const wrapped={invoke(...args){emit(${HookWorkerPhase.TransactionEnter});try{const value=Reflect.apply(fn,this,args);emit(${HookWorkerPhase.CommitReturn});return value;}catch(error){emit(${HookWorkerPhase.TransactionThrow});throw error;}}}.invoke;wrappers.set(fn,wrapped);Object.setPrototypeOf(wrapped,Object.getPrototypeOf(fn));for(const key of Reflect.ownKeys(fn)){const descriptor=Object.getOwnPropertyDescriptor(fn,key);if(['deferred','immediate','exclusive'].includes(key)&&'value'in descriptor&&typeof descriptor.value==='function')descriptor.value=wrap(descriptor.value);Object.defineProperty(wrapped,key,descriptor);}return wrapped;};
 Database.prototype.transaction=function(callback,...args){if(typeof callback!=='function')return Reflect.apply(transaction,this,[callback,...args]);const observed=function(...values){const result=Reflect.apply(callback,this,values);emit(${HookWorkerPhase.CommitEnter});return result;};return wrap(Reflect.apply(transaction,this,[observed,...args]));};
 Database.prototype.run=function(sql,...args){const commit=typeof sql==='string'&&/^\\s*COMMIT\\s*;?\\s*$/i.test(sql);if(commit)emit(${HookWorkerPhase.CommitEnter});try{const value=Reflect.apply(run,this,[sql,...args]);if(commit)emit(${HookWorkerPhase.CommitReturn});return value;}catch(error){if(commit)emit(${HookWorkerPhase.TransactionThrow});throw error;}};
 };
 const instrument=${instrumentHookWorkerPhases.toString()};
 const instrumentTranscript=${instrumentTranscriptPhaseSource.toString()};
 const mark=phase=>\`globalThis[Symbol.for('amem.test.worker.phases.emit')](\${phase});\`;
 const HookWorkerPhase=${JSON.stringify(HookWorkerPhase)};
 Bun.plugin({name:'real-worker-numeric-phases',setup(builder){builder.onLoad({filter:/[/]hook-transcript\\.ts$/},({path})=>{if(path!==${JSON.stringify(resolve(sourceRoot, 'src/hook-transcript.ts'))})throw Error('Worker transcript source unavailable; retain the artifact and inspect the phase observer');try{return {loader:'ts',contents:instrumentTranscript(readFileSync(path,'utf8'))};}catch(error){emit(${HookWorkerPhase.AnchorRefused});throw error;}});builder.onLoad({filter:/[/]session-brief-worker\\.ts$/},({path})=>{if(path!==${JSON.stringify(target)})throw Error('Worker phase source unavailable; retain the artifact and inspect the phase observer');try{return {loader:'ts',contents:instrument(readFileSync(path,'utf8'))};}catch(error){emit(${HookWorkerPhase.AnchorRefused});throw error;}});}});
}
`;
  writeFileSync(preload, body, { flag: "wx", mode: 0o600 });
  const readReport = (parentPid?: number): HookWorkerPhaseReport => {
    if (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || parentPid <= 0)) throw Error("Worker phase parent unavailable; retain the artifact and inspect the phase observer");
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw Error("Worker phase directory unavailable; retain the artifact and inspect the phase observer");
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size > MAX_BYTES) throw Error("Worker phase receipt unavailable; retain the artifact and inspect the phase observer");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) throw Error("Worker phase receipt changed; retain the artifact and inspect the phase observer");
      const text = readFileSync(fd, "utf8");
      if (Buffer.byteLength(text) > MAX_BYTES) throw Error("Worker phase receipt bound exceeded; retain the artifact and inspect the phase observer");
      const after = lstatSync(file);
      if (after.dev !== opened.dev || after.ino !== opened.ino) throw Error("Worker phase receipt changed; retain the artifact and inspect the phase observer");
      // A kill can interrupt even the boot write. Retain that uncertainty separately from complete rows.
      const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean), rows: HookWorkerPhaseReceipt[] = [];
      for (const line of lines) {
        let value: HookWorkerPhaseReceipt; try { value = JSON.parse(line); } catch { throw Error("Worker phase receipt invalid; retain the artifact and inspect the phase observer"); }
        if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "atMs,parentPid,phase,pid,seq" || ![1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,30,31].includes(value.phase) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 0 || !Number.isFinite(value.atMs) || value.atMs <= 0 || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > 513) throw Error("Worker phase receipt invalid; retain the artifact and inspect the phase observer");
        if (parentPid === undefined || value.parentPid === parentPid) rows.push(value);
      }
      return { rows, partialTail: text.length > 0 && !text.endsWith("\n") };
    } finally { closeSync(fd); }
  };
  return { preload, file, readReport, read: parentPid => readReport(parentPid).rows };
}
