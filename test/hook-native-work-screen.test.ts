import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";

test("native buffered work remains policy screened before it reaches context", async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const { sessionStartBrief } = await import("../src/session-brief.ts");
    const { processSignature } = await import("../src/memory/platform.ts");
    const options = { cwd: f.cwd, base: f.base, project: f.project, timeRemaining: () => 2000,
      nativeSession: { signature: processSignature(process.pid)! } };
    expect((await sessionStartBrief(options)).context).toContain(workMarker);
    const hidden = await sessionStartBrief({ ...options, policy: { piiPatterns: [workMarker] } });
    expect(hidden.context).not.toContain(workMarker);
    expect(hidden.context).toStartWith("Untrusted project memory data");
  } finally { f.close(); }
});

test("a binding change during native fixed screening discards every buffered work row", async () => {
  const f = hookFixture(), marker = join(f.root, "binding-changed"), preload = join(f.root, "native-screen-drift.ts");
  try {
    await f.seed();
    writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
Bun.plugin({name:'native-screen-binding-drift',setup(builder){builder.onLoad({filter:/[/]session-brief\\.ts$/},({path})=>{
const source=readFileSync(path,'utf8'),needle='(value: unknown) => policy.screen(value)';
if(source.split(needle).length!==2)throw new Error('native screening anchor changed');
return {loader:'ts',contents:source.replace(needle,'(value: unknown) => { globalThis.__nativeScreenDrift(); return policy.screen(value); }')};});}});
let changed=false;globalThis.__nativeScreenDrift=()=>{if(changed)return;changed=true;writeFileSync(${JSON.stringify(join(f.base, "profile.json"))},JSON.stringify({schema:'agent-mem.profile/v1',kind:'shared-v1'}));writeFileSync(${JSON.stringify(marker)},'reached');};`);
    const result = f.runFunctional("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(marker), result.stderr.toString()).toBe(true);
    const context = JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext;
    expect(context).not.toContain(workMarker);
    expect(context).toStartWith("Untrusted project memory data");
    expect(context).toContain("work=unavailable");
  } finally { f.close(); }
});
