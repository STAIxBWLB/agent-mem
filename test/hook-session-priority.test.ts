import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture, workMarker } from "./fakes/hooks-fixture.ts";
import { sessionStartBrief } from "../src/session-brief.ts";

test("native SessionStart preserves known work when the optional capture module cannot load", async () => {
  const f = hookFixture(), preload = join(f.root, "optional-capture-fault.ts"), worker = resolve(import.meta.dir, "../src/session-brief-worker.ts"), marker = join(f.root, "optional-attempted");
  try {
    await f.seed();
    writeFileSync(preload, `import {writeFileSync} from "node:fs";const marker=${JSON.stringify(marker)},worker=${JSON.stringify(worker)},preload=${JSON.stringify(preload)};
const spawn=Bun.spawn.bind(Bun);Bun.spawn=(argv,options)=>spawn(Array.isArray(argv)&&argv[2]===worker?[argv[0],argv[1],'--preload',preload,...argv.slice(2)]:argv,options);
Bun.plugin({name:'optional-capture-fault',setup(b){b.onLoad({filter:/memory\\/capture\\.ts$/},()=>{writeFileSync(marker,'attempted');throw new Error('synthetic unavailable optional capture module');});}});
`);
    // Positive control: the same preload must reject the actual optional module in the parent.
    const capture = resolve(import.meta.dir, "../src/memory/capture.ts");
    const control = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, "--eval",
      `try { await import(${JSON.stringify(capture)}); process.exit(2); } catch { process.exit(0); }`],
      { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(control.exitCode).toBe(0); expect(existsSync(marker)).toBe(true); rmSync(marker);
    const result = f.run("SessionStart", { prompt: "priority capture retained" }, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString(), `optional module attempted=${existsSync(marker)}; stderr=${result.stderr.toString()}`).not.toBe("");
    const context = JSON.parse(result.stdout.toString()).hookSpecificOutput?.additionalContext;
    expect(context).toContain(workMarker); expect(context).toContain("Untrusted project memory");
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1200); expect(context).toContain("capture=unavailable");
    for (let i = 0; i < 4 && !f.rows().some(row => row.excerpt === "priority capture retained"); i++) f.run("PostToolUse", { prompt: `priority replay ${i}` });
    expect(f.rows().filter(row => row.excerpt === "priority capture retained")).toHaveLength(1);
  } finally { f.close(); }
});

test("a native-sized brief budget keeps work and defers cold optional stores", async () => {
  const f = hookFixture();
  try {
    await f.seed();
    const brief = await sessionStartBrief({ cwd: f.cwd, base: f.base, project: f.project, timeRemaining: () => 70 });
    expect(brief.context).toContain(workMarker);
    expect(brief.coverage).toEqual({ work: "complete", curated: "unavailable", capture: "unavailable" });
    expect(brief.tokens).toBeLessThanOrEqual(1200);
  } finally { f.close(); }
});

for (const missingCapture of [false, true]) test(`a repeated full-tier refusal cannot discard the brief already computed by recovery${missingCapture ? " when optional capture cannot load" : ""}`, async () => {
  const f = hookFixture(), preload = join(f.root, "repeat-full.ts"), marker = join(f.root, "full-capture-import");
  try {
    await f.seed();
    writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';
Bun.plugin({name:'repeat-full-admission',setup(b){${missingCapture ? `b.onLoad({filter:/memory\\/capture\\.ts$/},()=>{writeFileSync(${JSON.stringify(marker)},'attempted');throw new Error('optional recovery module unavailable');});` : ''}b.onLoad({filter:/hook-spool\\.ts$/},({path})=>({loader:'ts',contents:readFileSync(path,'utf8').replace('export async function stageHookCapture(event: string, input: unknown, options: Options): Promise<PendingHookCapture | undefined> {','export async function stageHookCapture(event: string, input: unknown, options: Options): Promise<PendingHookCapture | undefined> { throw new HookSpoolFull();')}));}});`);
    const result = f.run("SessionStart", {}, { BUN_OPTIONS: `--preload=${preload}` });
    expect(result.exitCode).toBe(0);
    if (missingCapture) expect(existsSync(marker)).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toContain(workMarker);
    const hooks = resolve(import.meta.dir, "../src/hooks.ts");
    const script = `import {runHook} from ${JSON.stringify(hooks)};console.log(JSON.stringify(await runHook('SessionStart',{cwd:${JSON.stringify(f.cwd)},prompt:'repeat capacity library'},{cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)}})));`;
    const library = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, "-e", script], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(library.exitCode, library.stderr.toString()).toBe(0);
    const receipt = JSON.parse(library.stdout.toString());
    expect(receipt.output.hookSpecificOutput.additionalContext).toContain(workMarker);
    expect(receipt.captured).toBe(false); expect(receipt).not.toHaveProperty("pending");
  } finally { f.close(); }
});

test("with an available recovery slice a full tier progresses before deterministic late brief work", async () => {
  const f = hookFixture(), preload = join(f.root, "late-brief.ts"), marker = join(f.root, "late-brief-observed"), home = process.env.HOME;
  try {
    await f.seed(); process.env.HOME = f.env.HOME;
    const { stageHookCapture } = await import("../src/hook-spool.ts");
    for (let i = 0; i < 256; i++) await stageHookCapture("PostToolUse", { prompt: `late brief backlog ${i}` }, { cwd: f.cwd, base: f.base });
    writeFileSync(preload, `import {readFileSync,writeFileSync} from 'node:fs';let offset=0;
Object.defineProperty(performance,'now',{value:()=>offset,configurable:true});
globalThis.__lateBrief=(remaining)=>{offset+=Math.max(0,remaining-12);writeFileSync(${JSON.stringify(marker)},'observed');};
Bun.plugin({name:'late-brief-budget',setup(b){b.onLoad({filter:/[/]hook-project\\.ts$/},()=>({loader:'ts',contents:'export async function resolveHookProjectAsync(){return '+JSON.stringify(${JSON.stringify(f.project)})+';}'}));b.onLoad({filter:/[/]hook-native\\.ts$/},()=>({loader:'ts',contents:'export async function hookProcessSignature(){return '+JSON.stringify('1'.repeat(64))+';}'}));b.onLoad({filter:/[/]hooks\\.ts$/},({path})=>{const source=readFileSync(path,'utf8'),anchor='    const brief = await sessionStartBrief({ ...options, cwd, base, project, nativeSession: { signature }, timeRemaining: remaining });';if(source.split(anchor).length!==2)throw new Error('late brief anchor changed');return{loader:'ts',contents:source.replace(anchor,anchor+'globalThis.__lateBrief(remaining());')};});}});`);
    // This is an ordering regression with host-only identity/clock ports, not a native R2 timing measurement.
    // Actual native boot/deadline behavior is covered by the full-tier process tests and budget script.
    const hooks = resolve(import.meta.dir, "../src/hooks.ts");
    const script = `import {runHook} from ${JSON.stringify(hooks)};console.log(JSON.stringify(await runHook('SessionStart',{cwd:${JSON.stringify(f.cwd)},prompt:'late brief current event'},{cwd:${JSON.stringify(f.cwd)},base:${JSON.stringify(f.base)}})));`;
    const result = Bun.spawnSync([process.execPath, "--smol", "--preload", preload, "-e", script], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0); expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(result.stdout.toString()).output.hookSpecificOutput.additionalContext).toContain(workMarker);
    expect(f.rows().filter(row => row.excerpt.startsWith("late brief backlog ")).length).toBeGreaterThan(0);
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; f.close(); }
});
