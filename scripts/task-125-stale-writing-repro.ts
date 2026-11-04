#!/usr/bin/env bun
// NONSHIPPING. Synthetic fixtures only. Functional recovery proof, never native R2 acceptance.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const repoArg = option("--repo");
if (!repoArg) throw Error("usage: bun stale-writing-repro.ts --repo /absolute/measurement-checkout");
const repo = resolve(repoArg), self = fileURLToPath(import.meta.url);
const out = resolve(option("--out") ?? mkdtempSync(join(tmpdir(), "task125-repro-output-")));
checkOutsideRepo();
mkdirSync(out, { recursive: true, mode: 0o700 });
function checkOutsideRepo() { if (out === repo || out.startsWith(repo + "/")) throw Error("output must be outside the checkout"); }
writeFileSync(join(out, "source-receipt.json"), JSON.stringify({ bun: Bun.version, source: Object.fromEntries([
  "src/hook-spool.ts", "src/hook-transcript.ts", "src/session-brief-worker.ts", "src/hooks.ts", "test/fakes/hooks-fixture.ts",
].map(name => [name, createHash("sha256").update(readFileSync(join(repo, name))).digest("hex")])) }) + "\n", { mode: 0o600 });
// Set before importing target modules. Child fixtures additionally supply their own isolated environment.
const syntheticHome = join(out, "driver-home"); mkdirSync(syntheticHome, { recursive: true, mode: 0o700 });
Object.assign(process.env, { HOME: syntheticHome, AMEM_HOME: join(out, "driver-memory"), AGENTHUB_HOME: join(out, "driver-hub"),
  XDG_CONFIG_HOME: join(syntheticHome, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const allowedCodes = new Set(["EEXIST", "EACCES", "EPERM", "ENOSPC", "EIO", "ENOENT", "EISDIR", "ENOTDIR", "SQLITE_BUSY", "SQLITE_READONLY_ROLLBACK"]);
function classify(e: unknown) { const x = e as { name?: unknown; code?: unknown; syscall?: unknown; errno?: unknown }; return {
  name: ["Error", "SystemError", "SQLiteError", "TypeError"].includes(String(x?.name)) ? String(x.name) : "other",
  code: allowedCodes.has(String(x?.code)) ? String(x.code) : "other",
  syscall: ["open", "write", "unlink", "rename", "rmdir"].includes(String(x?.syscall)) ? String(x.syscall) : "other",
  errno: typeof x?.errno === "number" ? x.errno : null,
}; }
function check(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(reason); }
const mode = option("--case");
if (!mode) {
  const modes = ["api-normal", "api-stale-empty", "api-stale-partial", "api-stale-full", "kill-before-write", "kill-after-write", "kill-before-rename", "kill-after-rename", "parent-admission-delay"];
  let failures = 0;
  for (const current of modes) {
    const dir = join(out, current); mkdirSync(dir, { mode: 0o700 });
    const child = Bun.spawnSync([process.execPath, "--smol", self, "--repo", repo, "--out", dir, "--case", current], {
      env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: syntheticHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 256 * 1024,
    });
    writeFileSync(join(dir, "stdout.log"), child.stdout, { mode: 0o600 });
    writeFileSync(join(dir, "stderr.log"), child.stderr, { mode: 0o600 });
    failures += Number(child.exitCode !== 0);
    console.log(JSON.stringify({ case: current, exitCode: child.exitCode, signal: child.signalCode, passed: child.exitCode === 0 }));
  }
  console.log(JSON.stringify({ failures, acceptance: false, note: "Functional injected experiment; no hosted cause or native budget claim" }));
  process.exit(failures ? 1 : 0);
}

const { hookFixture } = await import(pathToFileURL(join(repo, "test/fakes/hooks-fixture.ts")).href);
const { stageTranscriptCapture } = await import(pathToFileURL(join(repo, "src/hook-spool.ts")).href);
const f = hookFixture();
// Retain every synthetic home for inspection; do not call f.close(). Never load an existing person's home.
writeFileSync(join(out, "fixture-location.json"), JSON.stringify({ root: f.root, synthetic: true }) + "\n", { mode: 0o600 });
await f.seed();
const spool = join(f.base, "hook-spool"), at = "2026-11-04T00:00:00.000Z";
if (mode.startsWith("api-")) {
  const input = { agent: "claude", event: "Title", excerpt: "task125 deterministic public title", at, session: "a".repeat(16) };
  const opts = { cwd: f.cwd, base: f.base, deferAtCapacity: true as const };
  const first = await stageTranscriptCapture(input, opts, "title:0"); check(first, "fixture publication declined");
  const temporary = join(spool, ".writing", first.name), published = join(spool, first.name);
  const bytes = readFileSync(published), receipt = first.receipt;
  if (mode !== "api-normal") {
    renameSync(published, temporary);
    if (mode === "api-stale-empty") writeFileSync(temporary, Buffer.alloc(0));
    if (mode === "api-stale-partial") writeFileSync(temporary, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
  }
  const before = { temporary: existsSync(temporary), temporaryBytes: existsSync(temporary) ? statSync(temporary).size : 0, published: existsSync(published) };
  let caught: ReturnType<typeof classify> | null = null, next: { name: string; receipt: string } | undefined;
  try { next = await stageTranscriptCapture(input, opts, "title:0"); } catch (e) { caught = classify(e); }
  if (mode === "api-normal") check(next?.receipt === receipt && caught === null, "normal duplicate did not acknowledge original receipt");
  else {
    check(caught?.code === "EEXIST", "stale temporary did not expose EEXIST");
    check(!existsSync(temporary) && !existsSync(published), "post-error temporary/publication state changed unexpectedly");
    next = await stageTranscriptCapture(input, opts, "title:0");
    check(next?.receipt === receipt, "retry receipt changed");
  }
  console.log(JSON.stringify({ case: mode, before, caught, receiptStable: next?.receipt === receipt,
    temporaryAfter: existsSync(temporary), publishedAfter: existsSync(published), acceptance: false }));
  process.exit(0);
}

const preload = join(out, "injection-preload.ts"), events = join(out, "events.jsonl"), worker = join(repo, "src/session-brief-worker.ts");
writeFileSync(events, "", { mode: 0o600 });
// A fresh anchored loader, no task123 helper, mmap, source copy, or production edit.
const config = { mode, events, preload, worker };
writeFileSync(preload, `import {readFileSync,appendFileSync} from 'node:fs';
const cfg=${JSON.stringify(config)};
let sequence=0,writes=0,published=0,admissions=0;const started=performance.now();
const role=process.argv.some(x=>x===cfg.worker)?'worker':'parent';
const codes=new Set(['EEXIST','EACCES','EPERM','ENOSPC','EIO','ENOENT','EISDIR','ENOTDIR','SQLITE_BUSY','SQLITE_READONLY_ROLLBACK']);
function record(phase,error){if(sequence>=160)return;const e=error;appendFileSync(cfg.events,JSON.stringify({pid:process.pid,role,seq:++sequence,phase,ms:performance.now()-started,epochMs:performance.timeOrigin+performance.now(),write: writes,publication:published,...(e?{name:['Error','SystemError','SQLiteError','TypeError'].includes(String(e.name))?String(e.name):'other',code:codes.has(String(e.code))?String(e.code):'other',syscall:['open','write','unlink','rename','rmdir'].includes(String(e.syscall))?String(e.syscall):'other',errno:typeof e.errno==='number'?e.errno:null}:{})})+'\\n');}
globalThis.__t125record=record;
globalThis.__t125admit=()=>{admissions++;record('admission.enter');if(role==='parent'&&cfg.mode==='parent-admission-delay'&&admissions===1){record('delay.enter');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,220);record('delay.return');}};
globalThis.__t125op=(phase,fn)=>{record(phase+'.enter');try{const r=fn();record(phase+'.return');return r;}catch(e){record(phase+'.error',e);throw e;}};
globalThis.__t125write=()=>{writes++;if(role==='worker'&&writes===5&&cfg.mode==='kill-before-write'){record('injected.kill.before-write');process.kill(process.pid,'SIGKILL');}};
globalThis.__t125afterwrite=()=>{if(role==='worker'&&writes===5&&['kill-after-write','kill-before-rename'].includes(cfg.mode)){record('injected.kill.after-write');process.kill(process.pid,'SIGKILL');}};
globalThis.__t125afterrename=()=>{published++;if(role==='worker'&&writes===5&&cfg.mode==='kill-after-rename'){record('injected.kill.after-rename');process.kill(process.pid,'SIGKILL');}};
function replaceOnce(s,a,b){if(s.split(a).length!==2)throw Error('task125 anchor mismatch');return s.replace(a,b);}
Bun.plugin({name:'task125-nonshipping-observer',setup(b){
b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{let s=readFileSync(path,'utf8');
s=replaceOnce(s,'  const { cwd, base } = options;','  (globalThis as any).__t125admit();\\n  const { cwd, base } = options;');
s=replaceOnce(s,'  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, join(destination, name)); }',
'  try { (globalThis as any).__t125write(); (globalThis as any).__t125op("write",()=>writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" })); (globalThis as any).__t125afterwrite(); (globalThis as any).__t125op("rename",()=>renameSync(temporary, join(destination, name))); (globalThis as any).__t125afterrename(); }');
s=replaceOnce(s,'\\n  finally { rmSync(temporary, { force: true }); }\\n  return { name, cwd, receipt: hash(bytes)', '\\n  finally { (globalThis as any).__t125op("cleanup",()=>rmSync(temporary, { force: true })); }\\n  return { name, cwd, receipt: hash(bytes)');return {loader:'ts',contents:s};});
b.onLoad({filter:/[/]session-brief-worker\\.ts$/},({path})=>{let s=readFileSync(path,'utf8');s=replaceOnce(s,'        } catch { progress({ stopReason: "unavailable" }); }','        } catch (e) { (globalThis as any).__t125record("scan.catch",e); progress({ stopReason: "unavailable" }); }');return {loader:'ts',contents:s};});
}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===cfg.worker?spawn([argv[0],argv[1],'--preload',cfg.preload,...argv.slice(2)],options):spawn(argv,options);
`, { mode: 0o600 });

const session = "task125-five-title", transcript = join(f.root, "transcript.jsonl");
const titles = Array.from({ length: 5 }, (_, i) => ({ type: "ai-title", aiTitle: `task125 title ${i}` }));
writeFileSync(transcript, [{ type: "assistant", timestamp: at }, ...titles].map(x => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
const cursorFile = join(f.base, "hook-transcripts", createHash("sha256").update("amem-session\0" + session).digest("hex").slice(0, 16) + ".db");
function snapshot() {
  let cursor: unknown = null, cursorError: ReturnType<typeof classify> | null = null;
  if (existsSync(cursorFile)) { let db: Database | undefined; try { db = new Database(cursorFile, { readonly: true }); cursor = db.query("SELECT offset,readStart,readAt,at,title,skipping FROM cursor WHERE id=1").get(); } catch (e) { cursorError = classify(e); } finally { db?.close(); } }
  const writing = join(spool, ".writing");
  const files = existsSync(writing) ? readdirSync(writing).map(name => ({ name, bytes: statSync(join(writing, name)).size })) : [];
  const active = existsSync(spool) ? readdirSync(spool).filter(x => x.startsWith("hook-") && x.endsWith(".json")).map(name => ({ name, receipt: createHash("sha256").update(readFileSync(join(spool, name))).digest("hex") })) : [];
  return { cursor, cursorError, writing: files, active, titlesDurable: f.rows().filter((r: { event: string; excerpt?: string }) => r.event === "Title" && r.excerpt?.startsWith("task125 title ")).map((r: { event: string; excerpt: string; at: string }) => ({ event: r.event, excerpt: r.excerpt, at: r.at })) };
}
const { readMetrics } = await import(pathToFileURL(join(repo, "src/memory/metrics.ts")).href);
const calls: unknown[] = [];
const observedReasons: unknown[] = [];
// Injection is present only on the first call. Recovery observer retains error diagnostics but never kills.
for (let call = 0; call < 3; call++) {
  if (call === 1) writeFileSync(preload, readFileSync(preload, "utf8").replace(JSON.stringify(config), JSON.stringify({ ...config, mode: "observe-recovery" })));
  const before = snapshot();
  const result = f.runFunctional("Stop", { session_id: session, transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` }, 2000);
  writeFileSync(join(out, `call-${call}-stdout.log`), result.stdout.subarray(0, 16 * 1024), { mode: 0o600 });
  writeFileSync(join(out, `call-${call}-stderr.log`), result.stderr.subarray(0, 16 * 1024), { mode: 0o600 });
  const after = snapshot(), metric = readMetrics(f.base).filter((r: { kind: string; wallMs?: number }) => r.kind === "hook" && r.wallMs !== undefined).at(-1);
  observedReasons.push(metric?.transcriptStopReason);
  calls.push({ call, exitCode: result.exitCode, before, after, metric });
  writeFileSync(join(out, "calls.json"), JSON.stringify(calls, null, 2) + "\n", { mode: 0o600 });
  check(result.exitCode === 0, "functional hook failed");
}
const log = readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const errorRows = log.filter(x => x.phase === "write.error" || x.phase === "scan.catch" || x.phase === "cleanup.error");
if (["kill-after-write", "kill-before-rename"].includes(mode)) {
  check(errorRows.some(x => x.phase === "write.error" && x.code === "EEXIST"), "kill/recovery did not reproduce write EEXIST");
  check(errorRows.some(x => x.phase === "scan.catch" && x.code === "EEXIST"), "scan catch did not preserve EEXIST");
  check(observedReasons[1] === "unavailable", "recovery did not report unavailable");
} else check(!errorRows.length, "control unexpectedly produced a write/scan/cleanup error");
check(snapshot().titlesDurable.length === 5, "five titles did not eventually become durable");
check(new Set(snapshot().titlesDurable.map((x: { excerpt: string }) => x.excerpt)).size === 5, "duplicate durable title");
check(snapshot().titlesDurable.every((x: { at: string }) => x.at === at), "native predecessor timestamp changed");
writeFileSync(join(out, "result.json"), JSON.stringify({ mode, calls, errorRows, acceptance: false, limits: "2000 ms functional fixture; unchanged production source/budgets" }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ case: mode, errorRows, eventualTitles: snapshot().titlesDurable.length, acceptance: false }));
