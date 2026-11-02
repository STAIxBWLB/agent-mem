import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HookProcessEvidence { phase: "preload" | "precheck" | "deadline_skip" | "late_check" | "attempt" | "returned"; pid: number; loads: number; exact?: number; native?: number; childPid?: number; remainingUs?: number; host?: number }
export interface HookWorkerProcess { pid: number; detached: boolean; argv: string[]; kind: "worker" | "native" }
/** Normal mode only observes. The timeout fixture can preload an owned native sleeper without a production port. */
export function hookProcessObserver(root: string, stallWorker = false) {
  const preload = join(root, "observe-hook-worker.ts"), receipt = join(root, "hook-worker-processes.jsonl"), evidence = join(root, "hook-process-evidence.jsonl");
  const nativePidFile = join(root, "owned-native.pid"), entered = join(root, "owned-native.entered");
  const worker = join(import.meta.dir, "../../src/session-brief-worker.ts");
  writeFileSync(preload, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const worker=${JSON.stringify(worker)},receipt=${JSON.stringify(receipt)},preload=${JSON.stringify(preload)},stallWorker=${stallWorker};
const loads=globalThis[Symbol.for('amem.hook.observer.loads')]=(globalThis[Symbol.for('amem.hook.observer.loads')]??0)+1;
const note=(phase,values={})=>appendFileSync(${JSON.stringify(evidence)},JSON.stringify({phase,pid:process.pid,loads,...values})+'\\n',{mode:0o600});
note('preload');
Bun.plugin({name:'observe-worker-precheck',setup(builder){builder.onLoad({filter:/[/]hooks\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),guard='  if (options.policy?.host || workDeadline - performance.now() < 5) return { context: unavailable, rssKB: 0, rawRssKB: 0, captured: false, valid: false };';
 if(source.split(guard).length!==2)throw new Error('worker precheck observation anchor changed');
 // #221: the post-metadata guard is a second pre-spawn exit; record its measured remaining time and whether identity resolved.
 const late='  if (!metadata.receipt && transcript === undefined || workDeadline - performance.now() < 5) return';
 if(source.split(late).length!==2)throw new Error('worker late-check observation anchor changed');
 return {loader:'ts',contents:source.replace(late,'  globalThis.__hookProcessNote("late_check",{remainingUs:Math.floor((workDeadline - performance.now())*1000),host:Number(!!metadata.receipt)});'+late).replace(guard,'  const observedRemaining = workDeadline - performance.now();globalThis.__hookProcessNote("precheck",{remainingUs:Math.floor(observedRemaining*1000),host:Number(!!options.policy?.host)});if(options.policy?.host||observedRemaining<5){if(!options.policy?.host)globalThis.__hookProcessNote("deadline_skip",{remainingUs:Math.floor(observedRemaining*1000),host:0});return {context:unavailable,rssKB:0,rawRssKB:0,captured:false,valid:false};}')};
});}});
globalThis.__hookProcessNote=note;
const original=Bun.spawn.bind(Bun);
Bun.spawn=(command,options)=>{
 const matched=Array.isArray(command)&&command[0]===process.execPath&&command[1]==='--smol'&&command[2]===worker;
 const native=Array.isArray(command)&&command[0]==='/bin/sh'&&command[3]==='amem-hook-native';
 const candidate=Array.isArray(command)&&typeof command[2]==='string'&&command[2].endsWith('/session-brief-worker.ts');
 if(candidate||native)note('attempt',{exact:Number(matched||native),native:Number(native)});
 const sleeper='sleep 30 & child=$!; printf \"%s\\n\" \"$child\" >> \"$1\"; printf entered > \"$2\"; wait';
 const argv=matched&&stallWorker?[command[0],'--smol','--preload',preload,...command.slice(2)]:native&&stallWorker?[...command.slice(0,6),'/bin/sh','-c',sleeper,'fixture',${JSON.stringify(nativePidFile)},${JSON.stringify(entered)}]:command;
 const child=original(argv,options);
 if(candidate||native)note('returned',{exact:Number(matched||native),native:Number(native),childPid:child.pid});
 if(matched||native){
  appendFileSync(receipt,JSON.stringify({pid:child.pid,detached:options?.detached===true,argv:command,kind:native?'native':'worker'})+'\\n',{mode:0o600});
 }
 return child;
};
if(stallWorker&&process.argv[1]===worker){
 const sleeper=Bun.spawn(['/bin/sleep','30'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
 writeFileSync(${JSON.stringify(nativePidFile)},String(sleeper.pid)+'\\n',{mode:0o600});
 writeFileSync(${JSON.stringify(entered)},'entered',{mode:0o600});
 await sleeper.exited;
}
`, { mode: 0o600 });
  return { preload, worker, nativePidFile, entered,
    evidence(): HookProcessEvidence[] {
      if (!existsSync(evidence)) return [];
      return readFileSync(evidence, "utf8").split("\n").filter(Boolean).map(line => {
        const row = JSON.parse(line) as HookProcessEvidence;
        if (!["preload", "precheck", "deadline_skip", "late_check", "attempt", "returned"].includes(row.phase) || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.loads) || row.loads <= 0) throw new Error("invalid numeric process evidence");
        return row;
      });
    },
    read(): HookWorkerProcess[] {
      if (!existsSync(receipt)) return [];
      return readFileSync(receipt, "utf8").split("\n").filter(Boolean).map(line => {
        const row = JSON.parse(line) as HookWorkerProcess;
        if (!["worker", "native"].includes(row.kind) || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.detached !== "boolean" || !Array.isArray(row.argv) || row.argv.some(arg => typeof arg !== "string")) throw new Error("invalid worker process receipt");
        return row;
      });
    },
  };
}
