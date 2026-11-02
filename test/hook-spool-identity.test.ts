import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";

test("a reboot-like device change keeps a pending record's stable scope and physical root drainable (#217)", () => {
  const f = hookFixture(), probe = join(f.root, "device-change.ts"), source = resolve(import.meta.dir, "../src/hook-spool.ts");
  // Override only the directory identity's stat call. Ownership/claim verification continues
  // comparing real lstat/fstat dev values, just as it would after an actual reboot.
  writeFileSync(probe, `import {lstatSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
let deviceOffset=0;
(globalThis as any).__directoryDeviceStat=(file:string)=>{const stat=lstatSync(file);return new Proxy(stat,{get(target,key){if(key==='dev')return target.dev+deviceOffset;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
Bun.plugin({name:'reboot-device-change',setup(builder){builder.onLoad({filter:/[/]hook-spool\\.ts$/},({path})=>{
let contents=readFileSync(path,'utf8');
if(process.argv[2]==='legacy-control'){
 const anchor='const parts: string[] = [], identity = (file: string) => {';
 if(contents.split(anchor).length!==2)throw Error('legacy device control anchor changed');
 contents=contents.replace(anchor,'legacyDevice=true; '+anchor);
 contents=contents.replace('return hash(', 'return hash(String(stat.dev)+":"+');
}
for(const anchor of ['const stat = lstatSync(cwd);','const stat = lstatSync(file);']){
 if(contents.split(anchor).length!==2)throw Error('directory device probe anchor changed');
 const argument=anchor.includes('(cwd)')?'cwd':'file';
 contents=contents.replace(anchor,'const stat = (globalThis as any).__directoryDeviceStat('+argument+');');
}
return {loader:'ts',contents};});}});
const {hookCaptureScope,stageHookCapture,drainHookCaptures}=await import(${JSON.stringify(source)});
const cwd=${JSON.stringify(f.cwd)},base=${JSON.stringify(f.base)},project=${JSON.stringify(f.project)};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const stat=lstatSync(cwd),legacyBefore=hash(stat.dev+':'+stat.ino+':'+stat.birthtimeMs);
const scopeBefore=hookCaptureScope(cwd,base);
const pending=await stageHookCapture('PostToolUse',{prompt:'survives device-only change'},{cwd,base});
if(!pending)throw Error('fixture did not publish');
const record=JSON.parse(readFileSync(base+'/hook-spool/'+pending.name,'utf8'));
deviceOffset=1;
const scopeAfter=hookCaptureScope(cwd,base),legacyAfter=hash((stat.dev+deviceOffset)+':'+stat.ino+':'+stat.birthtimeMs);
const appended=[];
const drained=await drainHookCaptures({cwd,base,project,expectedScope:scopeBefore},(input)=>{appended.push(input.excerpt);return {id:1};});
console.log(JSON.stringify({scopeKnown:!!scopeBefore,scopeEqual:scopeBefore===scopeAfter,legacyRootChanged:legacyBefore!==legacyAfter,
rootStable:record.root===hash(stat.ino+':'+stat.birthtimeMs),captured:drained.captured,expected:pending.name,appended}));
`);
  try {
    const result = Bun.spawnSync([process.execPath, "--smol", probe], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report).toMatchObject({ scopeKnown: true, scopeEqual: true, legacyRootChanged: true, rootStable: true,
      appended: ["survives device-only change"] });
    expect(report.captured).toEqual([report.expected]);

    // Negative control: restoring device-inclusive identity reproduces the old orphaning.
    const control = Bun.spawnSync([process.execPath, "--smol", probe, "legacy-control"], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(control.exitCode, control.stderr.toString()).toBe(0);
    expect(JSON.parse(control.stdout.toString())).toMatchObject({ scopeKnown: true, scopeEqual: false, legacyRootChanged: true,
      rootStable: false, captured: [], appended: [] });
  } finally { f.close(); }
});

test("a published compatibility writer's same-boot scope replays once, while its maintenance leaves stable-scope records pending (#217)", () => {
  const oldRoot = process.env.AMEM_COMPAT_ROOT ?? resolve(import.meta.dir, "../node_modules/@staix/agent-mem-v018");
  if (!isAbsolute(oldRoot)) throw new Error("AMEM_COMPAT_ROOT must be an absolute published package root");
  const oldSource = join(oldRoot, "src/hook-spool.ts"), oldVersion = (JSON.parse(readFileSync(join(oldRoot, "package.json"), "utf8")) as { version: string }).version;
  if (typeof oldVersion !== "string" || !oldVersion) throw new Error("compatibility package version unavailable");
  const f = hookFixture(), probe = join(f.root, "old-writer.ts"), source = resolve(import.meta.dir, "../src/hook-spool.ts");
  writeFileSync(probe, `import {existsSync,readFileSync} from 'node:fs';
const current=await import(${JSON.stringify(source)}),old=await import(${JSON.stringify(oldSource)});
const cwd=${JSON.stringify(f.cwd)},base=${JSON.stringify(f.base)},project=${JSON.stringify(f.project)},options={cwd,base};
const staged=await old.stageHookCapture('PostToolUse',{prompt:'published old same-boot record'},options);
if(!staged)throw Error('published writer did not stage');
const oldScope=JSON.parse(readFileSync(base+'/hook-spool/'+staged.name,'utf8')).scope;
const stableScope=current.hookCaptureScope(cwd,base),appended=[];
const first=await current.drainHookCaptures({...options,project,expectedScope:stableScope},(input)=>{appended.push(input.excerpt);return {id:1};});
const second=await current.drainHookCaptures({...options,project,expectedScope:stableScope},(input)=>{appended.push(input.excerpt);return {id:2};});
const stable=await current.stageHookCapture('PostToolUse',{prompt:'stable publication survives old maintenance'},options);
if(!stable)throw Error('stable writer did not stage');
const stableFile=base+'/hook-spool/'+stable.name,bytes=readFileSync(stableFile,'utf8');
await old.stageHookCapture('PostToolUse',{prompt:'old maintenance barrier'},options);
const oldDrain=await old.drainHookCaptures({...options,project},()=>({id:3}));
const preserved=existsSync(stableFile)&&readFileSync(stableFile,'utf8')===bytes;
const stableDrain=await current.drainHookCaptures({...options,project,expectedScope:stableScope},(input)=>{appended.push(input.excerpt);return {id:4};});
console.log(JSON.stringify({version:${JSON.stringify(oldVersion)},oldScopeDiffers:oldScope!==stableScope,first:first.captured,expected:staged.name,second:second.captured,
oldCaptured:oldDrain.captured.length,preserved,stableCaptured:stableDrain.captured,stableExpected:stable.name,appended}));
`);
  try {
    const result = Bun.spawnSync([process.execPath, "--smol", probe], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(result.exitCode, `published ${oldVersion}: ${result.stderr.toString()}`).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report).toMatchObject({ version: oldVersion, oldScopeDiffers: true, second: [], oldCaptured: 1, preserved: true,
      appended: ["published old same-boot record", "stable publication survives old maintenance"] });
    expect(report.first).toEqual([report.expected]);
    expect(report.stableCaptured).toEqual([report.stableExpected]);
  } finally { f.close(); }
});
