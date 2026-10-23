import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookBin, hookFixture } from "./fakes/hooks-fixture.ts";

test("the published hook never receives a test deadline from environment or arguments", () => {
  const f = hookFixture(), preload = join(f.root, "host-port-probe.ts"), receipt = join(f.root, "host-port.json");
  try {
    writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
Bun.plugin({name:'observe-programmatic-host-only',setup(b){b.onLoad({filter:/[/]hooks\\.ts$/},({path})=>{const source=readFileSync(path,'utf8'),anchor='export async function hookMain(args: readonly string[], startedAt = performance.now(), host?: HookHostPorts): Promise<string> {';if(source.split(anchor).length!==2)throw Error('host port anchor changed');return{loader:'ts',contents:source.replace(anchor,anchor+'globalThis.writeHost(host);'),};});}});
globalThis.writeHost=(host)=>writeFileSync(${JSON.stringify(receipt)},JSON.stringify({deadlineMs:host?.deadlineMs??null}),{mode:0o600});`);
    // Explicit native user input cannot construct the programmatic object.
    const extra = { BUN_OPTIONS: `--preload=${preload}`, AMEM_HOOK_DEADLINE_MS: "9000", AMEM_TEST_DEADLINE_MS: "9000" };
    const native = f.run("PostToolUse", { prompt: "native host boundary" }, extra);
    expect(native.exitCode).toBe(0); expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ deadlineMs: null });
    const flags = Bun.spawnSync([hookBin, "hook", "PostToolUse", "--deadline-ms", "9000"], { cwd: f.cwd, env: { ...f.env, ...extra }, stdin: Buffer.from("{}"), stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(flags.exitCode).toBe(0); expect(flags.stdout.length).toBe(0);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ deadlineMs: null });
    // Positive control: exactly the same observer sees the actual host object in the functional entry.
    const functional = f.runFunctional("PostToolUse", { prompt: "functional host boundary" }, extra);
    expect(functional.exitCode).toBe(0); expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ deadlineMs: 2000 });
  } finally { f.close(); }
});
