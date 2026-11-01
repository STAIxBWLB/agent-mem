import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { rssSourcesKnown } from "../src/hook-resources.ts";

for (const stall of [false, true]) test(`native receipts precede transcript work${stall ? " even when its worker is deadline-reaped" : ""}`, async () => {
  const f = hookFixture(), phases = join(f.root, "phases.jsonl"), preload = join(f.root, "phases.ts"), transcript = join(f.root, "transcript.jsonl");
  const worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  const stallCode = stall ? "const until=performance.now()+3000;while(performance.now()<until){};" : "";
  writeFileSync(phases, "");
  writeFileSync(preload, `import {appendFileSync,readFileSync} from 'node:fs';
const phases=${JSON.stringify(phases)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
globalThis.__phase201=(phase,known)=>appendFileSync(phases,JSON.stringify({phase,pid:process.pid,known})+'\\n');
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===worker?spawn([argv[0],argv[1],'--preload',preload,...argv.slice(2)],options):spawn(argv,options);
Bun.plugin({name:'transcript-order',setup(builder){
builder.onLoad({filter:/[/]hook-native\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='    try { observer?.finished(selected); }';
 if(source.split(anchor).length!==2)throw Error('native receipt order anchor changed');
 return {loader:'ts',contents:source.replace(anchor,"    (globalThis as any).__phase201('native',selected.known);"+anchor)};
});
builder.onLoad({filter:/[/]hook-transcript\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),anchor='  const value = object(input);';
 if(source.split(anchor).length!==2)throw Error('transcript order anchor changed');
 return {loader:'ts',contents:source.replace(anchor,"  (globalThis as any).__phase201('scan');"+${JSON.stringify(stallCode)}+anchor)};
});}});
`);
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "worker summary", timestamp: new Date().toISOString() }) + "\n");
  try {
    await f.seed();
    const result = f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const events = readFileSync(phases, "utf8").trim().split("\n").map(line => JSON.parse(line) as { phase: string; pid: number; known?: boolean });
    const scan = events.findIndex(event => event.phase === "scan"), native = events.filter(event => event.phase === "native");
    expect(scan).toBeGreaterThan(0); expect(native.length).toBeGreaterThan(0);
    expect(events.slice(scan).some(event => event.phase === "native")).toBe(false);
    expect(native.every(event => event.known && event.pid === events[scan]!.pid)).toBe(true);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(rssSourcesKnown(metric.rssSources!)).toBe(true);
    if (stall) expect(metric.transcriptStopReason).toBe("deadline");
    else {
      expect(metric.transcriptOffset).toBeGreaterThan(0);
      expect(f.rows().some(row => row.event === "Title" && row.excerpt === "worker summary")).toBe(true);
    }
  } finally { f.close(); }
});
