import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HookWorkerProcess { pid: number; detached: boolean; argv: string[]; kind: "worker" | "native" }
/** Normal mode only observes. The timeout fixture can preload an owned native sleeper without a production port. */
export function hookProcessObserver(root: string, stallWorker = false) {
  const preload = join(root, "observe-hook-worker.ts"), receipt = join(root, "hook-worker-processes.jsonl");
  const nativePidFile = join(root, "owned-native.pid"), entered = join(root, "owned-native.entered");
  const worker = join(import.meta.dir, "../../src/session-brief-worker.ts");
  writeFileSync(preload, `import {appendFileSync,writeFileSync} from 'node:fs';
const worker=${JSON.stringify(worker)},receipt=${JSON.stringify(receipt)},preload=${JSON.stringify(preload)},stallWorker=${stallWorker};
const original=Bun.spawn.bind(Bun);
Bun.spawn=(command,options)=>{
 const matched=Array.isArray(command)&&command[0]===process.execPath&&command[1]==='--smol'&&command[2]===worker;
 const native=Array.isArray(command)&&command[0]==='/bin/sh'&&command[3]==='amem-hook-native';
 const sleeper='sleep 30 & child=$!; printf \"%s\\n\" \"$child\" > \"$1\"; printf entered > \"$2\"; wait';
 const argv=matched&&stallWorker?[command[0],'--smol','--preload',preload,...command.slice(2)]:native&&stallWorker?[...command.slice(0,6),'/bin/sh','-c',sleeper,'fixture',${JSON.stringify(nativePidFile)},${JSON.stringify(entered)}]:command;
 const child=original(argv,options);
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
