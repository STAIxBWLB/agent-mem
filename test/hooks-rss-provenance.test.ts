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
 return {loader:'ts',contents:contents.replace(needle,'try { if(rss[0]===0){globalThis.__rssFault();throw Error("fixture write failure");} writeSync(1, JSON.stringify({ rss })')};
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

test("a final hook cannot certify RSS when a directly owned native usage collector throws", async () => {
  const f = hookFixture(), preload = join(f.root, "native-usage-fault.ts"), marker = join(f.root, "native-usage-fault-entered");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
globalThis.__nativeUsageFault=()=>writeFileSync(${JSON.stringify(marker)},'entered');
Bun.plugin({name:'native-usage-fault',setup(b){b.onLoad({filter:/hook-native\\.ts$/},({path})=>{
 const source=readFileSync(path,'utf8'),needle='    const raw = (child.resourceUsage()?.maxRSS ?? 0) / 1024;';
 if(source.split(needle).length!==2)throw Error('native usage fault anchor changed');
 return {loader:'ts',contents:source.replace(needle,'    globalThis.__nativeUsageFault();throw Error("fixture usage failure");'+needle)};
});}});`);
  try {
    await f.seed();
    const result = f.runFunctional("Stop", { prompt: "public native usage fixture" }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.length).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1)!;
    expect(metric.rssSources!.unavailable).toBeGreaterThan(0);
    expect(() => measuredHookRss(metric, result.resourceUsage.maxRSS / 1048576)).toThrow("provenance unknown");
  } finally { f.close(); }
});
