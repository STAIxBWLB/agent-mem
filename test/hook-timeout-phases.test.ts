import { expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { hookProcessObserver } from "./fakes/hooks-process-observer.ts";
import { readMetrics } from "../src/memory/metrics.ts";

test("native SessionStart records an expired pre-helper deadline without loading the curated brief", () => {
  const f = hookFixture(), observer = hookProcessObserver(f.root, true, undefined, true, true);
  const imported = join(f.root, "brief-imported");
  try {
    // A cold loader stall consumes the real executable deadline, never extends it.
    const preload = readFileSync(observer.preload, "utf8");
    const anchor = " const source=readFileSync(path,'utf8'),guard=";
    expect(preload.split(anchor)).toHaveLength(2);
    writeFileSync(observer.preload, preload.replace(anchor, " Bun.sleepSync(200);" + anchor));
    appendFileSync(observer.preload, `
Bun.plugin({name:'observe-expired-brief-import',setup(builder){
 builder.onLoad({filter:/[/]session-brief[.]ts$/},()=>{writeFileSync(${JSON.stringify(imported)},'imported');});
}});
`);
    const result = f.run("SessionStart", { prompt: "expired before metadata" }, { BUN_OPTIONS: `--preload=${observer.preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const metric = readMetrics(f.base).filter(row => row.kind === "hook").at(-1);
    expect(metric?.wallMs).toBeGreaterThanOrEqual(200);
    expect(observer.read()).toEqual([]);
    const skips = observer.evidence().filter(row => row.pid === result.pid && row.phase === "session-native-deadline-skip");
    expect(skips).toHaveLength(1);
    expect(skips[0]!.remainingUs).toBeLessThanOrEqual(0);
    expect(existsSync(imported)).toBe(false);
  } finally { f.close(); }
});

test("SessionStart launches all three timeout helpers before importing the curated brief", () => {
  const f = hookFixture(), observer = hookProcessObserver(f.root, true, undefined, true, true);
  const imported = join(f.root, "brief-imported");
  try {
    appendFileSync(observer.preload, `
Bun.plugin({name:'observe-brief-import',setup(builder){builder.onLoad({filter:/[/]session-brief[.]ts$/},()=>{
 const rows=readFileSync(${JSON.stringify(join(f.root, "hook-worker-processes.jsonl"))},'utf8').trim().split('\\n').map(JSON.parse);
 writeFileSync(${JSON.stringify(imported)},JSON.stringify(rows.map(row=>({kind:row.kind,detached:row.detached}))));
 throw Error('intentional brief import refusal after native launches');
});}});
`);
    // The host port isolates ordering from the native wall budget; the actual native
    // probe still requires exactly three children under its unchanged real deadline.
    const result = f.runFunctional("SessionStart", { prompt: "metadata before curated import" }, { BUN_OPTIONS: `--preload=${observer.preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(imported, "utf8"))).toEqual(Array.from({ length: 3 }, () => ({ kind: "native", detached: true })));
    expect(observer.read()).toHaveLength(3);
    expect(observer.evidence().filter(row => row.phase === "session-native-deadline-skip")).toEqual([]);
    expect(observer.lifecycle(result.pid).filter(row => row.phase === "reap-end" && row.reaped === 1)).toHaveLength(3);
  } finally { f.close(); }
});
