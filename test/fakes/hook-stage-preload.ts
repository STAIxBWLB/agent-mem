import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Literal source witnesses, validated before measuring even paths that a deadline may never load. */
export const hookStageAnchors = {
  "bin/amem.js": [["output-ready", "if (output) console.log(output);"]],
  "src/hooks.ts": [
    ["parent-entry", "  let pending: PendingHookCapture | undefined, full = false;"],
    ["parent-scope-start", "  const cwd = realPath(options.cwd), scope = hookCaptureScope(cwd, base);"],
    ["parent-scope-done", "  const remaining = () => deadline"],
    ["parent-project-start", "    const metadata = await Promise.allSettled("],
    ["parent-project-done", "    const project = resolveAlias(base, identity.value);"],
    ["parent-recovery-deferred", "    const { dropNotice, contextLimit, instruction } = sessionNoticeAndLimit(base, cwd, options, !pending, unavailable, (input as { session_id?: unknown } | null)?.session_id);"],
    ["parent-brief-start", "    const brief = await sessionStartBrief"],
    ["parent-brief-done", "    result.pending = !!pending && !result.captured;"],
    ["parent-context-ready", "    const context = joinedContext(brief.context, dropNotice, contextLimit);"],
  ],
  "src/hook-native.ts": [["native-spawn", "  const child = Bun.spawn"]],
  "src/session-brief-worker.ts": [
    ["input-start", "const options = JSON.parse"],
    ["input-done", "if (options.ownedGroup !== true || options.deadlineAt !== end"],
    ["scope-start", "const expectedScope = hookCaptureScope"],
    ["project-start", "let project: string | undefined;"],
    ["project-done", "return { options, expectedScope, project };"],
    ["capture-import", "const { CaptureStore } = await captureModule;"],
    ["capture-done", 'await emit({ context: "", captured'],
  ],
  "src/hook-project.ts": [
    ["git-path-start", "const cwd = realPath"],
    ["git-path-done", "if (scope !== undefined && (!scope"],
    ["project-validity-start", "const validity = scope === undefined ? undefined : hookCaptureScope"],
    ["project-validity-done", "const dir = join(base"],
    ["project-completion-start", "const currentValidity = hookCaptureScope"],
    ["project-completion-read-done", "if (currentValidity !== validity"],
    ["cache-maintenance-start", "const scan = opendirSync(dir);"],
    ["cache-publication-start", "const text = JSON.stringify(value);"],
    ["project-cache-hit", "return cached.project;"],
    ["project-cache-miss", "const project = memoryProjectKey"],
  ],
  "src/session-brief.ts": [
    ["work-store-start", "const work = new WorkListStore"],
    ["work-store-open", "const views = await work.read"],
    ["work-read-done", "        let selected = 0;"],
    ["brief-cleanup-start", "    for (const close of closers.reverse())"],
  ],
} as const;

export type HookStageFile = keyof typeof hookStageAnchors;

export function instrumentHookStageSource(file: HookStageFile, source: string): string {
  // Validate the original source, so inserted markers cannot conceal an overlapping/stale anchor.
  for (const [name, needle] of hookStageAnchors[file]) {
    const count = source.split(needle).length - 1;
    if (count !== 1) throw new Error(`hook stage anchor ${name} in ${file}: expected exactly once, found ${count}`);
  }
  let contents = source;
  for (const [name, needle] of hookStageAnchors[file]) {
    const mark = `globalThis.__amemHookStage('${name}');`;
    contents = contents.replace(needle, file === "bin/amem.js" ? `if (output) { ${mark} console.log(output); }` : mark + needle);
  }
  if (file === "bin/amem.js") contents = contents.replace(/^#![^\n]*\n/, "");
  if (file === "src/session-brief-worker.ts") contents = "globalThis.__amemHookStage('entry');" + contents;
  return contents;
}

export function validateHookStageSources(root: string): void {
  for (const file of Object.keys(hookStageAnchors) as HookStageFile[]) {
    instrumentHookStageSource(file, readFileSync(join(root, file), "utf8"));
  }
}

/** Checked before exit/output/timing handling: the published bin deliberately catches hook import errors. */
export function assertHookStageAnchorsHealthy(receipt: string): void {
  const failure = readFileSync(receipt, "utf8").trim();
  if (failure) throw new Error(`hook stage preload failed: ${failure}`);
}

// ponytail: retain the existing 256 numeric marks per process; expand only with measured observer-cost evidence.
export function hookStagePreload(worker: string, trace: string, preload: string, anchorFailure: string): string {
  return `import {appendFileSync,readFileSync} from 'node:fs';
import {instrumentHookStageSource} from ${JSON.stringify(resolve(import.meta.dir, 'hook-stage-preload.ts'))};
const child=process.argv[1]===${JSON.stringify(worker)},file=${JSON.stringify(trace)};
const samples=[];const note=(stage)=>{if(samples.length>=256)throw new Error('diagnostic sample bound');samples.push({child,stage,at:performance.timeOrigin+performance.now()});};
process.on('exit',()=>appendFileSync(file,samples.map(row=>JSON.stringify(row)).join('\\n')+'\\n'));
globalThis.__amemHookStage=note;
Bun.plugin({name:'hook-stage-markers',setup(b){b.onLoad({filter:/(session-brief-worker|hook-project|session-brief|hooks|hook-native)\\.ts$|[/]bin[/]amem\\.js$/},({path})=>{
 const file=path.endsWith('/bin/amem.js')?'bin/amem.js':'src/'+path.slice(path.lastIndexOf('/')+1);
 let contents;
 try { contents=instrumentHookStageSource(file,readFileSync(path,'utf8')); }
 catch(error){appendFileSync(${JSON.stringify(anchorFailure)},String(error)+'\\n');throw error;}
 return {loader:path.endsWith('.js')?'js':'ts',contents};});}});
note('loaded');const spawn=Bun.spawn.bind(Bun),sync=Bun.spawnSync.bind(Bun),kill=process.kill.bind(process);
Bun.spawn=(argv,options)=>{if(!Array.isArray(argv)||argv[2]!==${JSON.stringify(worker)})return spawn(argv,options);note('spawn');const p=spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options);p.exited.then(()=>note('reaped'));return p;};
Bun.spawnSync=(argv,options)=>{const kind=Array.isArray(argv)&&argv.includes('remote')?'git-origin':Array.isArray(argv)&&argv.includes('rev-parse')?'git-metadata':Array.isArray(argv)&&argv[0]==='ps'?'lease-signature':'native';note(kind+'-start');const r=sync(argv,options);note(kind+'-end');return r;};
process.kill=(pid,signal)=>{note('stop');return kill(pid,signal);};`;
}
