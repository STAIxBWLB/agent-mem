import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realPath } from "../../src/memory/platform.ts";
import { instrumentHookLifecycle, instrumentSessionNativeDeadline } from "./hooks-process-lifecycle.ts";

export interface HookLifecycleReceipt {
  phase: "spawn-attempt" | "spawn" | "spawn-failed" | "exit" | "kill-request" | "reap-start" | "reap-end" | "output-end" | "rss-finish" | "truncated";
  parentPid: number; childPid: number; kind: "worker" | "native"; atMs: number;
  boundMs?: number; reaped?: number; late?: number; code?: number; outputAvailable?: number;
  source?: "VmHWM" | "vmpeak-bound" | "platform-rusage" | "raw-fallback" | "unavailable";
  telemetryValid?: number; known?: number; kb?: number; rawKB?: number; observationFailed?: number;
  vmhwm?: number; vmpeakBound?: number; platformRusage?: number; rawFallback?: number; unavailable?: number;
}

export interface HookProcessEvidence { phase: "preload" | "precheck" | "deadline_skip" | "late_check" | "session-native-deadline-skip" | "attempt" | "returned"; pid: number; loads: number; exact?: number; native?: number; childPid?: number; remainingUs?: number; host?: number }
export interface HookWorkerProcess { pid: number; detached: boolean; argv: string[]; kind: "worker" | "native" }
/** Normal mode only observes. The timeout fixture can preload an owned native sleeper without a production port. */
export function hookProcessObserver(root: string, stallWorker = false, sourceRoot = join(import.meta.dir, "../.."), lifecycleEnabled = false, sessionDeadlineEnabled = false) {
  const preload = join(root, "observe-hook-worker.ts"), receipt = join(root, "hook-worker-processes.jsonl"), evidence = join(root, "hook-process-evidence.jsonl");
  const nativePidFile = join(root, "owned-native.pid"), entered = join(root, "owned-native.entered");
  const worker = join(realPath(sourceRoot), "src/session-brief-worker.ts");
  const lifecycle = join(root, "hook-child-lifecycle.jsonl");
  let rendered = `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const worker=${JSON.stringify(worker)},receipt=${JSON.stringify(receipt)},preload=${JSON.stringify(preload)},stallWorker=${stallWorker};
const loads=globalThis[Symbol.for('amem.hook.observer.loads')]=(globalThis[Symbol.for('amem.hook.observer.loads')]??0)+1;
const note=(phase,values={})=>appendFileSync(${JSON.stringify(evidence)},JSON.stringify({phase,pid:process.pid,loads,...values})+'\\n',{mode:0o600});
note('preload');
Bun.plugin({name:'observe-worker-precheck',setup(builder){builder.onLoad({filter:/[/]hooks\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),guard='  if (options.policy?.host || workDeadline - performance.now() < 5) return { context: unavailable, rssKB: 0, rawRssKB: 0, captured: false, valid: false };';
 if(source.split(guard).length!==2)throw new Error('worker precheck observation anchor changed');
 // #221: the post-metadata guard is a second pre-spawn exit; record its measured remaining time and whether identity resolved.
 const late='    if (!early && (!metadata.receipt || workDeadline - performance.now() < 5)) return';
 if(source.split(late).length!==2)throw new Error('worker late-check observation anchor changed');
 // One measurement drives both the evidence and the branch taken, as the first guard's instrumentation does.
 const lateObserved='    const lateRemaining = workDeadline - performance.now();globalThis.__hookProcessNote("late_check",{remainingUs:Math.floor(lateRemaining*1000),host:Number(!!metadata.receipt)});    if (!early && (!metadata.receipt || lateRemaining < 5)) return';
 return {loader:'ts',contents:source.replace(late,lateObserved).replace(guard,'  const observedRemaining = workDeadline - performance.now();globalThis.__hookProcessNote("precheck",{remainingUs:Math.floor(observedRemaining*1000),host:Number(!!options.policy?.host)});if(options.policy?.host||observedRemaining<5){if(!options.policy?.host)globalThis.__hookProcessNote("deadline_skip",{remainingUs:Math.floor(observedRemaining*1000),host:0});return {context:unavailable,rssKB:0,rawRssKB:0,captured:false,valid:false};}')};
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
`;
  if(lifecycleEnabled)rendered=instrumentHookLifecycle(rendered,lifecycle);
  if(sessionDeadlineEnabled)rendered=instrumentSessionNativeDeadline(rendered);
  writeFileSync(preload,rendered,{mode:0o600});
  return { preload, worker, nativePidFile, entered,
    /** Observation only, never signalling authority. A missing exit flush is explicit missing evidence. */
    lifecycle(parentPid?:number): HookLifecycleReceipt[] {
      if(!existsSync(lifecycle))return[];
      if(statSync(lifecycle).size>2*1024*1024)throw Error("child lifecycle diagnostic exceeds 2 MiB; retain the fixture and inspect its bounded observer workload");
      return readFileSync(lifecycle,"utf8").split("\n").filter(Boolean).map(line=>{
        const row=JSON.parse(line) as HookLifecycleReceipt;
        if(!["spawn-attempt","spawn","spawn-failed","exit","kill-request","reap-start","reap-end","output-end","rss-finish","truncated"].includes(row.phase)
          || !Number.isSafeInteger(row.parentPid)||row.parentPid<=0||!Number.isSafeInteger(row.childPid)||row.childPid<0
          || !["worker","native"].includes(row.kind)||!Number.isFinite(row.atMs)||row.atMs<0)throw Error("child lifecycle diagnostic is malformed; retain the fixture and inspect the observer receipts");
        return row;
      }).filter(row=>parentPid===undefined||row.parentPid===parentPid);
    },
    evidence(): HookProcessEvidence[] {
      if (!existsSync(evidence)) return [];
      return readFileSync(evidence, "utf8").split("\n").filter(Boolean).map(line => {
        const row = JSON.parse(line) as HookProcessEvidence;
        if (!["preload", "precheck", "deadline_skip", "late_check", "session-native-deadline-skip", "attempt", "returned"].includes(row.phase) || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.loads) || row.loads <= 0) throw new Error("invalid numeric process evidence");
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
