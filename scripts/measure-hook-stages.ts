/** Diagnostic only: numeric cold-path milestones for actual runner failures. No budget overrides. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "../test/fakes/hooks-fixture.ts";

const f = hookFixture(), preload = join(f.root, "hook-stages.ts"), trace = join(f.root, "hook-stages.jsonl");
const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
try {
  await f.seed();
  // Both preloads and each append count toward the real unchanged deadline. No payload/path is logged.
  writeFileSync(preload, `import {appendFileSync} from 'node:fs';
const child=process.argv[1]===${JSON.stringify(worker)},file=${JSON.stringify(trace)};
const note=(stage)=>appendFileSync(file,JSON.stringify({child,stage,at:performance.timeOrigin+performance.now()})+'\\n');
note('loaded');const spawn=Bun.spawn.bind(Bun),sync=Bun.spawnSync.bind(Bun),kill=process.kill.bind(process);
Bun.spawn=(argv,options)=>{if(!Array.isArray(argv)||argv[2]!==${JSON.stringify(worker)})return spawn(argv,options);note('spawn');const p=spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options);p.exited.then(()=>note('reaped'));return p;};
Bun.spawnSync=(argv,options)=>{const kind=argv.includes('remote')?'git-origin':argv.includes('rev-parse')?'git-metadata':argv[0]==='ps'?'lease-signature':'native';note(kind+'-start');const r=sync(argv,options);note(kind+'-end');return r;};
process.kill=(pid,signal)=>{note('stop');return kill(pid,signal);};`, { mode: 0o600 });
  for (let attempt = 0; attempt < 5; attempt++) {
    writeFileSync(trace, "", { mode: 0o600 });
    const started = performance.timeOrigin + performance.now();
    const result = f.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    const rows = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { child: boolean; stage: string; at: number });
    console.log(JSON.stringify({ diagnostic: "cold-session-stages", attempt, exit: result.exitCode, outputBytes: result.stdout.length,
      stages: rows.map(row => ({ process: row.child ? "worker" : "cli", stage: row.stage, ms: Math.round((row.at - started) * 100) / 100 })) }));
  }
} finally { f.close(); }
