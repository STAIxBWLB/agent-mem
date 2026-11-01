import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { measuredHookRss } from "../scripts/hook-rss-check.ts";

test("a worker telemetry write failure keeps capture fail-open but cannot certify RSS", async () => {
  const f = hookFixture(), worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  const preload = join(f.root, "rss-fault.ts"), marker = join(f.root, "rss-fault-entered");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
globalThis.__rssFault=()=>writeFileSync(${JSON.stringify(marker)},'entered');
Bun.plugin({name:'rss-write-fault',setup(b){b.onLoad({filter:/session-brief-worker\\.ts$/},({path})=>{
 const contents=readFileSync(path,'utf8'),needle='try { writeSync(1, JSON.stringify({ rss })';
 if(contents.split(needle).length!==2)throw Error('RSS fault anchor changed');
 return {loader:'ts',contents:contents.replace(needle,'try { if(rss[0]===1||rss[0]===2){globalThis.__rssFault();throw Error("fixture write failure");} writeSync(1, JSON.stringify({ rss })')};
});}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);
`);
  try {
    await f.seed();
    const result = f.runFunctional("PostToolUse", { prompt: "public provenance fixture" }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.length).toBe(0);
    expect(existsSync(marker)).toBe(true); expect(readFileSync(marker, "utf8")).toBe("entered");
    expect(f.rows().some(row => row.excerpt === "public provenance fixture")).toBe(true);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.rssSources!.unavailable).toBeGreaterThan(0);
    expect(() => measuredHookRss(metric, result.resourceUsage.maxRSS / 1048576)).toThrow("provenance unknown");
  } finally { f.close(); }
});

test("malformed transcript progress cannot certify otherwise known RSS", async () => {
  const f = hookFixture(), worker = resolve(import.meta.dir, "../src/session-brief-worker.ts");
  const preload = join(f.root, "progress-fault.ts"), marker = join(f.root, "progress-fault-entered"), transcript = join(f.root, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "public progress fixture" }) + "\n");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
globalThis.__progressFault=()=>writeFileSync(${JSON.stringify(marker)},'entered');
Bun.plugin({name:'progress-write-fault',setup(b){b.onLoad({filter:/session-brief-worker\\.ts$/},({path})=>{
 const contents=readFileSync(path,'utf8'),needle='JSON.stringify({ transcript })';
 if(contents.split(needle).length!==2)throw Error('progress fault anchor changed');
 return {loader:'ts',contents:contents.replace(needle,'(globalThis.__progressFault(),JSON.stringify({transcript:{stopReason:"invalid"}}))')};
});}});
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>Array.isArray(argv)&&argv[2]===${JSON.stringify(worker)}?spawn([argv[0],argv[1],'--preload',${JSON.stringify(preload)},...argv.slice(2)],options):spawn(argv,options);
`);
  try {
    await f.seed();
    const result = f.runFunctional("Stop", { transcript_path: transcript }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.length).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.rssSources!.unavailable).toBeGreaterThan(0);
    expect(() => measuredHookRss(metric, result.resourceUsage.maxRSS / 1048576)).toThrow("provenance unknown");
  } finally { f.close(); }
});
