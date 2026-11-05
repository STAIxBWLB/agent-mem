import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stageHookCapture } from "../src/hook-spool.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";

const fixtures: ReturnType<typeof hookFixture>[] = [], originalHome = process.env.HOME;
const modulePath = resolve(import.meta.dir, "../src/hook-spool.ts"), at = "2026-11-04T00:00:00.000Z";
const input = { agent: "claude", event: "Title", at, excerpt: "private writing recovery" };
const suffix = "a".repeat(24), old = new Date(Date.now() - 2 * 3600_000);
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = hookFixture(); fixtures.push(f); process.env.HOME = f.env.HOME;
  const writing = join(f.base, "hook-spool", ".writing"); mkdirSync(writing, { recursive: true, mode: 0o700 });
  return { ...f, writing, options: { cwd: f.cwd, base: f.base } };
}
const privateName = (index: number, unique = false) => `hook-v3-${"1".repeat(64)}-${"2".repeat(64)}-${index.toString(16).padStart(32, "0")}.json${unique ? `.writing-${suffix}` : ""}`;
function stale(f: ReturnType<typeof fixture>, index: number, body = "", unique = false) {
  const file = join(f.writing, privateName(index, unique)); writeFileSync(file, body, { mode: 0o600 }); utimesSync(file, old, old); return file;
}
function runner(f: ReturnType<typeof fixture>, body = 'const result=await stageTranscriptCapture(input,options,"same-line");console.log(JSON.stringify(result));') {
  const file = join(f.root, `writer-${readdirSync(f.root).length}.ts`);
  writeFileSync(file, `import {stageHookCapture,stageTranscriptCapture,drainHookCaptures} from ${JSON.stringify(modulePath)};
const options=${JSON.stringify(f.options)},input=${JSON.stringify(input)};${body}`);
  return file;
}
function run(f: ReturnType<typeof fixture>, body?: string, preload?: string) {
  return Bun.spawnSync([process.execPath, ...(preload ? ["--preload", preload] : []), runner(f, body)], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
}
/** Loader-only faults do not add a product export or touch the real home. */
function preload(f: ReturnType<typeof fixture>, injected: string, fixedSuffix = false) {
  const file = join(f.root, `fault-${readdirSync(f.root).length}.ts`);
  const temporaryAnchor = 'const temporary = join(writing, `${name}.writing-${randomBytes(12).toString("hex")}`);';
  writeFileSync(file, `import {readFileSync,writeFileSync,renameSync,existsSync,symlinkSync,linkSync} from 'node:fs';
(globalThis as any).__writingFault=(temporary)=>{${injected}};
Bun.plugin({name:'private-writing-fault',setup(b){b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
let s=readFileSync(path,'utf8');const once=(a,b)=>{if(s.split(a).length!==2)throw Error('writing fault anchor changed');s=s.replace(a,b);};
once('    writeFileSync(fd, bytes);','    writeFileSync(fd, bytes); (globalThis as any).__writingFault(temporary);');
${fixedSuffix ? `once(${JSON.stringify(temporaryAnchor)}, ${JSON.stringify(`const temporary = join(writing, name + ".writing-${suffix}");`)});` : ""}
return {loader:'ts',contents:s};});}});`);
  return file;
}

test("a writer killed after its private write does not block deterministic publication on the next call", () => {
  const f = fixture(), marker = join(f.root, "killed-private-name");
  const fault = preload(f, `writeFileSync(${JSON.stringify(marker)},temporary);process.kill(process.pid,'SIGKILL');`);
  const killed = run(f, undefined, fault); expect(killed.exitCode).not.toBe(0);
  const abandoned = readFileSync(marker, "utf8"), bytes = readFileSync(abandoned);
  expect(abandoned).toMatch(/\.json\.writing-[a-f0-9]{24}$/);
  const next = run(f); expect(next.exitCode, next.stderr.toString()).toBe(0);
  const published = JSON.parse(next.stdout.toString()) as { name: string; receipt: string };
  expect(published.name).toMatch(/^hook-v3-[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{32}\.json$/);
  expect(readFileSync(join(f.base, "hook-spool", published.name))).toEqual(bytes);
  expect(readFileSync(abandoned)).toEqual(bytes); // Fresh abandoned evidence is left for the age-bound sweep.
});

for (const collision of [false, true]) test("a concurrent writer keeps its own temporary inode: " + (collision ? "forced suffix collision" : "unique suffixes"), async () => {
  const f = fixture(), marker = join(f.root, "waiting-private-name"), release = join(f.root, "release-writer");
  const waiting = preload(f, `writeFileSync(${JSON.stringify(marker)},temporary);const end=Date.now()+5000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);if(!existsSync(${JSON.stringify(release)}))throw Error('release absent');`, true);
  const child = Bun.spawn([process.execPath, "--preload", waiting, runner(f)], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < until) await Bun.sleep(5);
    expect(existsSync(marker), "the first writer reached its private write").toBe(true);
    const held = readFileSync(marker, "utf8"), bytes = readFileSync(held);
    const other = collision ? preload(f, "", true) : undefined;
    const second = run(f, 'try{const result=await stageTranscriptCapture(input,options,"same-line");console.log(JSON.stringify({ok:true,...result}));}catch(error){console.log(JSON.stringify({ok:false,code:error.code,full:error.name==="HookSpoolFull"}));}', other);
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    const result = JSON.parse(second.stdout.toString()) as { ok: boolean; code?: string; full?: boolean };
    if (collision) expect(result).toEqual({ ok: false, code: "EEXIST", full: false }); else expect(result.ok).toBe(true);
    expect(readFileSync(held)).toEqual(bytes); // EEXIST must not unlink the other writer's file.
    writeFileSync(release, "go");
    expect(await child.exited).toBe(0);
    const resultA = JSON.parse(await new Response(child.stdout).text()) as { name: string };
    expect(readFileSync(join(f.base, "hook-spool", resultA.name))).toEqual(bytes);
  } finally { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } await child.exited; }
}, 15000);

test("writer finally cleanup preserves a pathname replacement", () => {
  const f = fixture(), replaced = join(f.root, "replaced-private-name"), held = join(f.root, "original-private-inode");
  const fault = preload(f, `renameSync(temporary,${JSON.stringify(held)});writeFileSync(temporary,'replacement',{mode:0o600});writeFileSync(${JSON.stringify(replaced)},temporary);`);
  const result = run(f, undefined, fault); expect(result.exitCode).not.toBe(0);
  expect(readFileSync(readFileSync(replaced, "utf8"), "utf8")).toBe("replacement");
  expect(existsSync(held)).toBe(true);
  expect(readdirSync(join(f.base, "hook-spool")).filter(name => name.startsWith("hook-"))).toEqual([]);
});

test("writer finally removes only its own inode after a partial write failure", () => {
  const f = fixture(), fault = join(f.root, "partial-write.ts");
  writeFileSync(fault, `import {readFileSync} from 'node:fs';Bun.plugin({name:'partial-private-write',setup(b){b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
const s=readFileSync(path,'utf8'),a='    writeFileSync(fd, bytes);';if(s.split(a).length!==2)throw Error('partial write anchor changed');return{loader:'ts',contents:s.replace(a,'    writeFileSync(fd, bytes.slice(0,3)); throw new Error("injected partial write");')};});}});`);
  const result = run(f, undefined, fault);
  expect(result.exitCode).not.toBe(0); expect(result.stderr.toString()).toContain("injected partial write");
  expect(readdirSync(f.writing)).toEqual([]);
});

test("stale legacy and unique private files are swept four at a time, including empty and partial writes", async () => {
  const f = fixture(), files = Array.from({ length: 7 }, (_, i) => stale(f, i, i ? "partial" : "", i % 2 === 0));
  await stageHookCapture("PostToolUse", { prompt: "first bounded writing sweep" }, f.options);
  expect(files.filter(file => existsSync(file))).toHaveLength(3);
  await stageHookCapture("PostToolUse", { prompt: "second bounded writing sweep" }, f.options);
  expect(files.filter(file => existsSync(file))).toHaveLength(0);
});

for (const unsafe of ["fresh", "public", "symlink", "hardlink"] as const) test("private sweep preserves " + unsafe + " evidence", async () => {
  const f = fixture(), file = stale(f, 0, "held private body", true), target = join(f.root, "unrelated-target");
  if (unsafe === "fresh") utimesSync(file, new Date(), new Date());
  if (unsafe === "public") chmodSync(file, 0o644);
  if (unsafe === "symlink") { rmSync(file); writeFileSync(target, "unrelated target"); symlinkSync(target, file); }
  if (unsafe === "hardlink") linkSync(file, target);
  await stageHookCapture("PostToolUse", { prompt: "safe writing sweep" }, f.options);
  expect(existsSync(file)).toBe(true);
  if (unsafe === "symlink") expect(readFileSync(target, "utf8")).toBe("unrelated target");
  else expect(readFileSync(file, "utf8")).toBe("held private body");
});

test("private sweep refuses evidence reported as owned by a different uid", () => {
  const f = fixture(), file = stale(f, 0, "foreign uid evidence");
  const fault = join(f.root, "foreign-writing-uid.ts");
  writeFileSync(fault, `import {readFileSync} from 'node:fs';Bun.plugin({name:'foreign-writing-uid',setup(b){b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
const s=readFileSync(path,'utf8'),a='        file = openOwned(join(writing, entry.name));';if(s.split(a).length!==2)throw Error('writing uid anchor changed');return{loader:'ts',contents:s.replace(a,a+' file.initial.uid = process.getuid!()+1;')};});}});`);
  const result = run(f, 'await stageHookCapture("PostToolUse",{prompt:"uid-bound sweep"},options);', fault);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("foreign uid evidence");
});

test("private sweep leaves an over-budget stale file without reading its body", async () => {
  const f = fixture(), file = stale(f, 0, "x".repeat(256 * 1024 + 1));
  await stageHookCapture("PostToolUse", { prompt: "byte-bound sweep" }, f.options);
  expect(readFileSync(file)).toHaveLength(256 * 1024 + 1);
});

test("private sweep leaves SessionStart untouched", async () => {
  const f = fixture(), file = stale(f, 0, "stale but SessionStart must not inspect it");
  await stageHookCapture("SessionStart", { source: "startup" }, f.options);
  expect(readFileSync(file, "utf8")).toBe("stale but SessionStart must not inspect it");
});

test("private sweep charges the same file and byte maintenance budget before retirement", () => {
  const f = fixture(), observed = join(f.root, "maintenance-budget.json");
  for (let i = 0; i < 4; i++) stale(f, i, "x".repeat(i));
  const file = join(f.root, "observe-maintenance.ts");
  writeFileSync(file, `import {readFileSync,writeFileSync} from 'node:fs';Bun.plugin({name:'writing-maintenance-budget',setup(b){b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
let s=readFileSync(path,'utf8');const once=(a,b)=>{if(s.split(a).length!==2)throw Error('maintenance anchor changed');s=s.replace(a,b);};
once('  if (event !== "SessionStart") cleanStaleWriting(writing, budget);','  if (event !== "SessionStart") cleanStaleWriting(writing, budget); (globalThis as any).__writingBudget=budget; writeFileSync(${JSON.stringify(observed)},JSON.stringify(budget));');
once('  const retired = new Set<string>(), cwdHash = admittingCwd === undefined ? undefined : hash(admittingCwd);','  if(budget!==(globalThis as any).__writingBudget)throw Error("maintenance allowance replaced"); const retired = new Set<string>(), cwdHash = admittingCwd === undefined ? undefined : hash(admittingCwd);');return{loader:'ts',contents:s};});}});`);
  const result = run(f, 'await stageHookCapture("PostToolUse",{prompt:"budget bound"},options);', file);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(observed, "utf8"))).toEqual({ files: 28, bytes: 256 * 1024 - 6 });
});

test("private sweep never removes a replacement discovered after opening the stale file", () => {
  const f = fixture(), file = stale(f, 0, "old partial"), moved = join(f.root, "moved-stale-inode"), marker = join(f.root, "replacement-observed");
  const fault = join(f.root, "replace-stale.ts");
  writeFileSync(fault, `import {readFileSync,writeFileSync,renameSync} from 'node:fs';Bun.plugin({name:'stale-replacement',setup(b){b.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
const s=readFileSync(path,'utf8'),a='        budget.bytes -= file.initial.size;';if(s.split(a).length!==2)throw Error('stale ownership anchor changed');return{loader:'ts',contents:s.replace(a,a+' renameSync(file.file,${JSON.stringify(moved)});writeFileSync(file.file,"replacement",{mode:0o600});writeFileSync(${JSON.stringify(marker)},"seen");')};});}});`);
  const result = run(f, 'await stageHookCapture("PostToolUse",{prompt:"replace stale"},options);', fault);
  expect(result.exitCode, result.stderr.toString()).toBe(0); expect(existsSync(marker)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("replacement"); expect(readFileSync(moved, "utf8")).toBe("old partial");
});
