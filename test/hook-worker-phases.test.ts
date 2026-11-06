import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHookWorkerPhases, HookWorkerPhase, instrumentHookWorkerPhases, instrumentTranscriptPhaseSource } from "./fakes/hooks-worker-phases.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
const sourceRoot = resolve(import.meta.dir, "..");

test("worker phase transformation refuses unknown or repeated source anchors", () => {
  const source = readFileSync(join(sourceRoot, "src/session-brief-worker.ts"), "utf8");
  expect(instrumentHookWorkerPhases(source)).toContain("amem.test.worker.phases.emit");
  expect(() => instrumentHookWorkerPhases(source.replace("const SCAN_COMMIT_MS = 20;", "const SCAN_COMMIT_MS = 21;"))).toThrow("anchor changed");
  expect(() => instrumentHookWorkerPhases(source + "\nconst SCAN_COMMIT_MS = 20;")).toThrow("anchor changed");
  const transcript = readFileSync(join(sourceRoot, "src/hook-transcript.ts"), "utf8");
  expect(instrumentTranscriptPhaseSource(transcript)).toContain("phases.installSqlite");
  expect(() => instrumentTranscriptPhaseSource(transcript.replace('import { Database } from "bun:sqlite";', ""))).toThrow("anchor changed");
});

test("worker phase reader is numeric, bounded, parent filtered, and never invents a missing boot", () => {
  const root = mkdtempSync(join(tmpdir(), "amem-worker-phases-"));
  try {
    const p = createHookWorkerPhases(root, sourceRoot);
    expect(p.read()).toEqual([]);
    expect(p.readReport()).toEqual({ rows: [], partialTail: false });
    writeFileSync(p.file, JSON.stringify({ phase: HookWorkerPhase.ScanEnter, pid: 10, parentPid: 2, atMs: 123, seq: 1 }) + "\n", { mode: 0o600 });
    expect(p.read(2)).toEqual([{ phase: HookWorkerPhase.ScanEnter, pid: 10, parentPid: 2, atMs: 123, seq: 1 }]);
    expect(p.read(3)).toEqual([]);
    appendFileSync(p.file, '{"phase":');
    expect(p.read()).toHaveLength(1); // Interrupted suffix is absence, not a fabricated receipt.
    expect(p.readReport(2).partialTail).toBe(true);
    expect(p.readReport(3)).toEqual({ rows: [], partialTail: true });
    writeFileSync(p.file, '{"phase":');
    expect(p.readReport()).toEqual({ rows: [], partialTail: true });
    writeFileSync(p.file, JSON.stringify({ phase: "secret-body", pid: 10, parentPid: 2, atMs: 123, seq: 1 }) + "\n");
    expect(() => p.read()).toThrow("receipt invalid");
    writeFileSync(p.file, " ".repeat(8 * 1024 * 1024 + 1));
    expect(() => p.read()).toThrow("receipt unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SQLite observer preserves transaction variants, callback receiver/arguments and native commit order", async () => {
  const root = mkdtempSync(join(tmpdir(), "amem-worker-phases-sqlite-"));
  try {
    const p = createHookWorkerPhases(root, sourceRoot);
    const code = `import {Database} from 'bun:sqlite';
globalThis[Symbol.for('amem.test.worker.phases.installSqlite')](Database);
globalThis[Symbol.for('amem.test.worker.phases.installSqlite')](Database);
const db=new Database(':memory:');db.run('CREATE TABLE t(v INTEGER)');
const receiver={value:3};const tx=db.transaction(function(n){if(this!==receiver)throw Error('receiver');db.run('INSERT INTO t VALUES(?)',n);return this.value+n;});
for(const mode of ['deferred','immediate','exclusive']){if(tx[mode].call(receiver,2)!==5)throw Error('return');}
if(tx.call(receiver,2)!==5||typeof tx.deferred.immediate!=='function')throw Error('properties');
db.run('BEGIN IMMEDIATE');db.run('COMMIT');
try{db.transaction(()=>{throw Error('expected');})();}catch{}
if(db.query('SELECT count(*) n FROM t').get().n!==4)throw Error('rows');db.close();`;
    const child = Bun.spawn([process.execPath, "--preload", p.preload, "--eval", code], { env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const rows = p.read(process.pid);
    expect(rows[0]?.phase).toBe(HookWorkerPhase.Boot);
    expect(rows.filter(r => r.phase === HookWorkerPhase.CommitEnter)).toHaveLength(5);
    expect(rows.filter(r => r.phase === HookWorkerPhase.CommitReturn)).toHaveLength(5);
    expect(rows.filter(r => r.phase === HookWorkerPhase.TransactionThrow)).toHaveLength(1);
    expect(rows.every(r => Object.values(r).every(v => typeof v === "number"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10000);

test("real worker phase preload composes with a capture onLoad fixture without stdout protocol changes", async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const p = createHookWorkerPhases(f.root, sourceRoot), worker = join(sourceRoot, "src/session-brief-worker.ts");
    const parent = join(f.root, "worker-phase-parent.ts"), capture = join(f.root, "capture-observer.ts"), seen = join(f.root, "capture-loaded");
    writeFileSync(capture, `import {readFileSync,writeFileSync} from 'node:fs';Bun.plugin({name:'independent-capture-loader',setup(b){b.onLoad({filter:/[/]memory[/]capture\\.ts$/},({path})=>{writeFileSync(${JSON.stringify(seen)},'1');return {loader:'ts',contents:readFileSync(path,'utf8')};});}});`);
    writeFileSync(parent, `const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv.includes(${JSON.stringify(worker)})?spawn(argv,{...options,env:{...options?.env,BUN_OPTIONS:${JSON.stringify(`--preload=${p.preload} --preload=${capture}`)}}}):spawn(argv,options);`);
    const transcript = join(f.root, "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "phase fixture", timestamp: new Date().toISOString() }) + "\n");
    // Existing explicit functional deadline, not native 140 ms budget evidence.
    const result = f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${parent}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const rows = p.read(result.pid), phases = rows.map(r => r.phase);
    expect(readFileSync(seen, "utf8")).toBe("1");
    for (const phase of [HookWorkerPhase.Boot, HookWorkerPhase.StaticModulesLoaded, HookWorkerPhase.CaptureModuleLoaded, HookWorkerPhase.TranscriptModuleLoaded, HookWorkerPhase.ScanEnter, HookWorkerPhase.ScanReturn, HookWorkerPhase.StoreOpen, HookWorkerPhase.StoreOpened, HookWorkerPhase.DrainWriteEnter, HookWorkerPhase.CommitEnter, HookWorkerPhase.CommitReturn, HookWorkerPhase.DrainWriteReturn, HookWorkerPhase.StoreClose, HookWorkerPhase.StoreClosed, HookWorkerPhase.OutputBegin, HookWorkerPhase.OutputEnd]) expect(phases).toContain(phase);
    expect(phases.indexOf(HookWorkerPhase.Boot)).toBeLessThan(phases.indexOf(HookWorkerPhase.StaticModulesLoaded));
    expect(rows.every(r => r.pid !== result.pid)).toBe(true);
    expect(phases).not.toContain(HookWorkerPhase.AnchorRefused);
    expect(phases).not.toContain(HookWorkerPhase.Truncated);
  } finally { f.close(); }
}, 15000);
