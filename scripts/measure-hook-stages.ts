/** Diagnostic only: numeric cold-path milestones for actual runner failures. No budget overrides. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture, workMarker } from "../test/fakes/hooks-fixture.ts";

const f = hookFixture(), preload = join(f.root, "hook-stages.ts"), trace = join(f.root, "hook-stages.jsonl");
const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
try {
  await f.seed();
  // Both preloads and each append count toward the real unchanged deadline. No payload/path is logged.
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
const child=process.argv[1]===${JSON.stringify(worker)},file=${JSON.stringify(trace)};
const note=(stage)=>appendFileSync(file,JSON.stringify({child,stage,at:performance.timeOrigin+performance.now()})+'\\n');
globalThis.__amemHookStage=note;
Bun.plugin({name:'hook-stage-markers',setup(b){b.onLoad({filter:/(session-brief-worker|hook-project|session-brief|hooks|hook-native)\\.ts$|[/]bin[/]amem\\.js$/},({path})=>{
 let contents=readFileSync(path,'utf8'); const mark=(needle,name)=>{if(contents.split(needle).length!==2)throw new Error('diagnostic anchor changed');contents=contents.replace(needle,"globalThis.__amemHookStage('"+name+"');"+needle);};
 if(path.endsWith('/bin/amem.js')){
  contents=contents.replace(/^#![^\\n]*\\n/,'');
  const output='if (output) console.log(output);';
  if(contents.split(output).length!==2)throw new Error('diagnostic output anchor changed');
  contents=contents.replace(output,"if (output) { globalThis.__amemHookStage('output-ready'); console.log(output); }");
 }else if(path.endsWith('/hooks.ts')){
  mark('  let pending: PendingHookCapture | undefined, full = false;','parent-entry');
  mark('  const cwd = realPath(options.cwd), scope = hookCaptureScope(cwd, base);','parent-scope-start');
  mark('  const remaining = () => deadline','parent-scope-done');
  mark('    const project = resolveAlias(base, await resolveHookProjectAsync','parent-project-start');
  mark('    const signature = await hookProcessSignature','parent-project-done');
  mark('    const { sessionStartBrief } = await import','parent-signature-done');
  mark('    const brief = await sessionStartBrief','parent-brief-start');
  mark('    if (full && remaining() > 15)','parent-brief-done');
  mark('    result.context = brief.context','parent-context-ready');
 }else if(path.endsWith('/hook-native.ts')){
  mark('  const child = Bun.spawn','native-spawn');
 }else if(path.endsWith('/session-brief-worker.ts')){
  contents="globalThis.__amemHookStage('entry');"+contents;
  mark('const options = JSON.parse','input-start');mark('if (!Number.isFinite(options.deadlineAt)','input-done');
  mark('const policy = createStandalonePolicy','policy-start');mark('const expectedScope = hookCaptureScope','scope-start');
  mark('let project: string;','scope-done');mark('try { project = resolveAlias','project-start');mark('let captured = false;','project-done');
  mark('const { sessionStartBrief } = await import','brief-import-start');mark('const result = await sessionStartBrief','brief-import-done');
  mark('await emit({ ...result, captured','brief-done');
 }else if(path.endsWith('/hook-project.ts')){
  mark('const cwd = realPath','git-path-start');mark('if (!options.scope','git-path-done');
  mark('const validity = hookCaptureScope','project-validity-start');mark('const dir = join(base','project-validity-done');
  mark('const scan = opendirSync(dir);','cache-maintenance-start');mark('const text = JSON.stringify(value);','cache-publication-start');
  mark('return cached.project;','project-cache-hit');mark('const project = memoryProjectKey','project-cache-miss');
 }else{mark('const work = new WorkListStore','work-store-start');mark('const views = await work.read','work-store-open');}
 return {loader:path.endsWith('.js')?'js':'ts',contents};});}});
note('loaded');const spawn=Bun.spawn.bind(Bun),sync=Bun.spawnSync.bind(Bun),kill=process.kill.bind(process);
Bun.spawn=(argv,options)=>{if(!Array.isArray(argv)||argv[2]!==${JSON.stringify(worker)})return spawn(argv,options);note('spawn');const p=spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options);p.exited.then(()=>note('reaped'));return p;};
Bun.spawnSync=(argv,options)=>{const kind=Array.isArray(argv)&&argv.includes('remote')?'git-origin':Array.isArray(argv)&&argv.includes('rev-parse')?'git-metadata':Array.isArray(argv)&&argv[0]==='ps'?'lease-signature':'native';note(kind+'-start');const r=sync(argv,options);note(kind+'-end');return r;};
process.kill=(pid,signal)=>{note('stop');return kill(pid,signal);};`, { mode: 0o600 });
  let cold: { knownWork: boolean; ms: number | null } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    writeFileSync(trace, "", { mode: 0o600 });
    const started = performance.timeOrigin + performance.now();
    const result = f.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    const rows = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { child: boolean; stage: string; at: number });
    let context: unknown;
    try { context = JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext; } catch { /* Report missing context explicitly. */ }
    const knownWork = typeof context === "string" && context.includes(workMarker);
    const stopped = [...rows].reverse().find(row => !row.child && row.stage === "output-ready");
    const completedMs = stopped ? stopped.at - started : null;
    if (attempt === 0) cold = { knownWork, ms: completedMs };
    console.log(JSON.stringify({ diagnostic: "cold-session-stages", attempt, exit: result.exitCode, outputBytes: result.stdout.length, knownWork, completedMs,
      stages: rows.map(row => ({ process: row.child ? "worker" : "cli", stage: row.stage, ms: Math.round((row.at - started) * 100) / 100 })) }));
  }
  // Reproduce the full foreign tier separately from the cold/plain budget; preparation
  // is outside the measured hook, and these numeric stages diagnose its real deadline.
  const full = hookFixture(), foreign = hookFixture(), oldHome = process.env.HOME;
  try {
    await full.seed(); process.env.HOME = full.env.HOME;
    const { stageHookCapture } = await import("../src/hook-spool.ts");
    for (let i = 0; i < 256; i++) await stageHookCapture("PostToolUse", { prompt: `stage diagnostic ${i}` }, { cwd: foreign.cwd, base: full.base });
    writeFileSync(trace, "", { mode: 0o600 });
    const started = performance.timeOrigin + performance.now();
    const result = full.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    const rows = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { child: boolean; stage: string; at: number });
    let context: unknown; try { context = JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext; } catch { /* Missing output is the diagnostic. */ }
    const stopped = [...rows].reverse().find(row => !row.child && row.stage === "output-ready");
    console.log(JSON.stringify({ diagnostic: "full-foreign-session-stages", exit: result.exitCode, outputBytes: result.stdout.length,
      knownWork: typeof context === "string" && context.includes(workMarker), completedMs: stopped ? stopped.at - started : null,
      stages: rows.map(row => ({ process: row.child ? "worker" : "cli", stage: row.stage, ms: Math.round((row.at - started) * 100) / 100 })) }));
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; full.close(); foreign.close(); }
  if (!cold?.knownWork || cold.ms === null || cold.ms >= 140)
    throw new Error(`cold SessionStart did not return known work before 140 ms: knownWork=${cold?.knownWork}, completedMs=${cold?.ms}`);
} finally { f.close(); }
