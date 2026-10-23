import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";

test("SessionStart starts independent signature metadata before awaiting project identity", async () => {
  const f = hookFixture(), preload = join(f.root, "metadata-barrier.ts"), marker = join(f.root, "signature-started");
  try {
    await f.seed();
    writeFileSync(preload, `import{writeFileSync}from'node:fs';
Bun.plugin({name:'host-metadata-barrier',setup(b){
b.onLoad({filter:/[/]hook-project\\.ts$/},()=>({loader:'ts',contents:'export async function resolveHookProjectAsync(){await Promise.resolve();if(!globalThis.signatureStarted)throw new Error("signature not started");return '+JSON.stringify(${JSON.stringify(f.project)})+';}'}));
b.onLoad({filter:/[/]hook-native\\.ts$/},()=>({loader:'ts',contents:'import{writeFileSync}from"node:fs";export async function hookProcessSignature(){globalThis.signatureStarted=true;writeFileSync('+JSON.stringify(${JSON.stringify(marker)})+',"ready");return '+JSON.stringify('1'.repeat(64))+';}'}));
}});`);
    const script = `import{runHook}from${JSON.stringify(resolve(import.meta.dir, "../src/hooks.ts"))};console.log(JSON.stringify(await runHook('SessionStart',{prompt:'metadata barrier'},{cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)}},{deadlineMs:2000})));`;
    const answer = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, "-e", script], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(answer.exitCode, answer.stderr.toString()).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(answer.stdout.toString()).output.hookSpecificOutput.additionalContext).toContain("p3-work-marker");
  } finally { f.close(); }
});
