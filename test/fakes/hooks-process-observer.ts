import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HookWorkerProcess { pid: number; detached: boolean; argv: string[] }
/** Normal mode only observes. The timeout fixture can preload an owned native sleeper without a production port. */
export function hookProcessObserver(root: string, stallWorker = false) {
  const preload = join(root, "observe-hook-worker.ts"), receipt = join(root, "hook-worker-processes.jsonl");
  const nativePidFile = join(root, "owned-native.pid"), entered = join(root, "owned-native.entered");
  const worker = join(import.meta.dir, "../../src/session-brief-worker.ts");
  writeFileSync(preload, `import {appendFileSync,writeFileSync} from 'node:fs';
const worker=${JSON.stringify(worker)},receipt=${JSON.stringify(receipt)},preload=${JSON.stringify(preload)},stallWorker=${stallWorker};
const original=Bun.spawn.bind(Bun);
Bun.spawn=(command,options)=>{
 const matched=Array.isArray(command)&&command[0]===process.execPath&&command[1]===worker;
 const argv=matched&&stallWorker?[command[0],'--preload',preload,...command.slice(1)]:command;
 const child=original(argv,options);
 if(matched){
  appendFileSync(receipt,JSON.stringify({pid:child.pid,detached:options?.detached===true,argv:command})+'\\n',{mode:0o600});
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
        if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.detached !== "boolean" || !Array.isArray(row.argv) || row.argv.some(arg => typeof arg !== "string")) throw new Error("invalid worker process receipt");
        return row;
      });
    },
  };
}
