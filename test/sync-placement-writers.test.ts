import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, closeSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { measureSyncPlacementWriters, SyncPlacementWriterError, extractSyncPlacementWriterFailure, type SyncPlacementWriterErrorCode } from "../src/memory/sync-placement-writers.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";
import { PLACEMENT_FORMAT } from "../src/memory/sync-placement-format.ts";
import { realPath } from "../src/memory/platform.ts";

const temporary:string[]=[];
afterEach(()=>{for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});});
function temp(){const root=realPath(mkdtempSync(join(tmpdir(),"amem-writer-pins-")));temporary.push(root);return root;}
function install(parent=temp(),name="install",version="0.21.0"){
  const root=join(parent,name);mkdirSync(root,{mode:0o755});
  for(const directory of ["src","bin","hooks",".claude-plugin"])mkdirSync(join(root,directory),{mode:0o755});
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@staix/agent-mem",version})+"\n",{mode:0o644});
  // Deliberately invalid foreign code: measurement must read bytes, never execute/import the install.
  writeFileSync(join(root,"src","index.ts"),"throw Error('foreign install must never run');\n",{mode:0o644});
  writeFileSync(join(root,"bin","amem.js"),"throw Error('foreign executable must never run');\n",{mode:0o755});
  writeFileSync(join(root,"hooks","hooks.json"),"{}\n",{mode:0o644});
  writeFileSync(join(root,".claude-plugin","plugin.json"),"{}\n",{mode:0o644});
  return root;
}
function refused(work:()=>unknown,code?:SyncPlacementWriterErrorCode){
  let failure:unknown;try{work();}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(SyncPlacementWriterError);
  const error=failure as SyncPlacementWriterError;
  if(code)expect(error.code).toBe(code);
  expect(error.message).toContain("writer-root");expect(error.message).toContain("upgrade or repair the amem install");
  expect(error.message).toContain("host exact pin");return error;
}

test("byte pins are deterministic and location independent, while writer identity binds the canonical root",()=>{
  const parent=temp(),a=install(parent,"a"),b=install(parent,"b"),before=inspectionFilesystemSnapshot(parent);
  const measured=measureSyncPlacementWriters([b,a]),again=measureSyncPlacementWriters([a,b]);
  expect(again).toEqual(measured);expect(inspectionFilesystemSnapshot(parent)).toEqual(before);
  expect(measured.roots.map(value=>value.root)).toEqual([a,b]);
  expect(measured.roots[0]!.pin).toBe(measured.roots[1]!.pin);expect(measured.roots[0]!.writerId).not.toBe(measured.roots[1]!.writerId);
  for(const writer of measured.writers)expect(writer).toMatchObject({version:"0.21.0",publicationFormat:PLACEMENT_FORMAT,compatible:true});
  for(const value of measured.roots)for(const hash of [value.pin,value.writerId])expect(hash).toMatch(/^[a-f0-9]{64}$/);
});

test("fixed runtime namespaces and package bytes change the pin; outside files do not",()=>{
  const root=install(),initial=measureSyncPlacementWriters([root]).roots[0]!;
  writeFileSync(join(root,"README.md"),"outside runtime inventory\n");
  expect(measureSyncPlacementWriters([root]).roots[0]).toEqual(initial);
  for(const directory of ["src","bin","hooks",".claude-plugin"]){
    const file=join(root,directory,"extra-runtime");writeFileSync(file,"new runtime bytes\n",{mode:0o644});
    expect(measureSyncPlacementWriters([root]).roots[0]!.pin).not.toBe(initial.pin);
    unlinkSync(file);expect(measureSyncPlacementWriters([root]).roots[0]!.pin).toBe(initial.pin);
  }
  writeFileSync(join(root,"src","index.ts"),"changed runtime bytes\n");
  const changed=measureSyncPlacementWriters([root]).roots[0]!;expect(changed.pin).not.toBe(initial.pin);expect(changed.writerId).toBe(initial.writerId);
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.22.0"}));
  const upgraded=measureSyncPlacementWriters([root]).roots[0]!;expect(upgraded.version).toBe("0.22.0");expect(upgraded.pin).not.toBe(changed.pin);expect(upgraded.writerId).toBe(initial.writerId);
});

test("root symlinks resolve canonically, duplicate aliases refuse and retargeting changes writer identity",()=>{
  const parent=temp(),a=install(parent,"a"),b=install(parent,"b"),alias=join(parent,"current");symlinkSync(a,alias);
  expect(measureSyncPlacementWriters([alias])).toEqual(measureSyncPlacementWriters([a]));
  refused(()=>measureSyncPlacementWriters([alias,a]),"invalid");
  const before=measureSyncPlacementWriters([alias]).roots[0]!;unlinkSync(alias);symlinkSync(b,alias);
  const after=measureSyncPlacementWriters([alias]).roots[0]!;expect(after.writerId).not.toBe(before.writerId);expect(after.pin).toBe(before.pin);
});

test("public install modes and legitimate hardlinked runtime files are accepted",()=>{
  const parent=temp(),root=install(parent),shared=join(parent,"cache-file");
  writeFileSync(shared,readFileSync(join(root,"src","index.ts")),{mode:0o644});
  unlinkSync(join(root,"src","index.ts"));linkSync(shared,join(root,"src","index.ts"));
  expect(measureSyncPlacementWriters([root]).writers).toHaveLength(1);
  chmodSync(join(root,"src","index.ts"),0o666);refused(()=>measureSyncPlacementWriters([root]),"unavailable");
});

test("runtime symlink files and directories refuse even when their targets are readable",()=>{
  const parent=temp(),root=install(parent),other=install(parent,"other");
  unlinkSync(join(root,"bin","amem.js"));symlinkSync(join(other,"bin","amem.js"),join(root,"bin","amem.js"));
  refused(()=>measureSyncPlacementWriters([root]),"unavailable");
  unlinkSync(join(root,"bin","amem.js"));writeFileSync(join(root,"bin","amem.js"),"ordinary bytes\n");
  symlinkSync(join(other,"src"),join(root,"src","redirect"));refused(()=>measureSyncPlacementWriters([root]),"unavailable");
});

for(const value of [{name:"other-package",version:"0.21.0"},{name:"@staix/agent-mem",version:"0.20.99"},
  {name:"@staix/agent-mem",version:"0.21.0-rc.1"},{name:"@staix/agent-mem",version:"0.21.0\n"}])test("malformed or unsupported package identity refuses: "+JSON.stringify(value),()=>{
  const root=install();writeFileSync(join(root,"package.json"),JSON.stringify(value));refused(()=>measureSyncPlacementWriters([root]),"unsupported");
});

test("malformed JSON, required entry removal and unreadable roots fail closed with safe errors",()=>{
  const root=install();writeFileSync(join(root,"package.json"),"{invalid package\n");
  const error=refused(()=>measureSyncPlacementWriters([root]),"unsupported");expect(error.message).not.toContain(root);expect(error.message).not.toContain("invalid package");
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}));
  unlinkSync(join(root,"src","index.ts"));refused(()=>measureSyncPlacementWriters([root]),"unsupported");
  refused(()=>measureSyncPlacementWriters([join(root,"missing")]),"unavailable");
});

test("root cardinality, bounded package reads and sparse oversized runtime files refuse before large allocation",()=>{
  const root=install();refused(()=>measureSyncPlacementWriters(Array(257).fill(root)),"bound");
  writeFileSync(join(root,"package.json")," ".repeat(65537));refused(()=>measureSyncPlacementWriters([root]),"bound");
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}));
  const fd=openSync(join(root,"src","huge.ts"),"w",0o644);try{ftruncateSync(fd,64*1024*1024+1);}finally{closeSync(fd);}
  refused(()=>measureSyncPlacementWriters([root]),"bound");
});

test("runtime file count is bounded across the whole inventory",()=>{
  const root=install();for(let i=0;i<4096;i++)writeFileSync(join(root,"src",`file-${i}`),"",{mode:0o644});
  refused(()=>measureSyncPlacementWriters([root]),"bound");
});

test("the runtime byte ceiling is shared across roots rather than reset per install",()=>{
  const parent=temp(),roots=[install(parent,"a"),install(parent,"b")];
  for(const root of roots){const fd=openSync(join(root,"src","large.ts"),"w",0o644);try{ftruncateSync(fd,33*1024*1024);}finally{closeSync(fd);}}
  refused(()=>measureSyncPlacementWriters(roots),"bound");
});

test("accessor inventories and external error messages are never invoked",()=>{
  const root=install();let invoked=0;
  const roots:string[]=[];Object.defineProperty(roots,"0",{enumerable:true,get(){invoked++;return root;}});
  refused(()=>measureSyncPlacementWriters(roots),"invalid");expect(invoked).toBe(0);
  const fault=spyOn(fs,"readSync").mockImplementation(()=>{throw Object.defineProperty({},"message",{get(){invoked++;return "PRIVATE_ERROR_CANARY";}});});
  try{expect(refused(()=>measureSyncPlacementWriters([root])).message).not.toContain("PRIVATE_ERROR_CANARY");}finally{fault.mockRestore();}
  expect(invoked).toBe(0);
});

test("closed writer diagnostics distinguish minimum release, package identity, writable code and unreadable input",()=>{
  const root=install();
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.20.99"}));
  expect(extractSyncPlacementWriterFailure(refused(()=>measureSyncPlacementWriters([root]),"unsupported"))).toEqual({code:"unsupported",detail:"below-minimum",rootIndex:0});
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"other-package",version:"0.21.0"}));
  expect(extractSyncPlacementWriterFailure(refused(()=>measureSyncPlacementWriters([root]),"unsupported"))?.detail).toBe("wrong-package");
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}));chmodSync(join(root,"src/index.ts"),0o666);
  expect(extractSyncPlacementWriterFailure(refused(()=>measureSyncPlacementWriters([root]),"unavailable"))?.detail).toBe("writable-runtime");
  chmodSync(join(root,"src/index.ts"),0o644);unlinkSync(join(root,"package.json"));
  expect(extractSyncPlacementWriterFailure(refused(()=>measureSyncPlacementWriters([root]),"unavailable"))?.detail).toBe("unreadable");
});

test("diagnostic extraction refuses forged accessors and proxies without reading external messages",()=>{
  let called=0;const error=new SyncPlacementWriterError("unsupported",0,"below-minimum");
  Object.defineProperty(error,"message",{get(){called++;return "PRIVATE_MESSAGE";}});
  expect(extractSyncPlacementWriterFailure(error)).toEqual({code:"unsupported",rootIndex:0,detail:"below-minimum"});
  Object.defineProperty(error,"detail",{get(){called++;return "wrong-package";}});
  expect(extractSyncPlacementWriterFailure(error)).toBeUndefined();
  expect(extractSyncPlacementWriterFailure(new Proxy(error,{getPrototypeOf(){called++;throw Error("not invoked");}}))).toBeUndefined();
  expect(called).toBe(0);
});

test("an added runtime file after directory inventory is a changed snapshot, not a silently omitted byte",()=>{
  const root=install(),real=fs.readSync;let reads=0;
  const fault=spyOn(fs,"readSync").mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{
    const count=Reflect.apply(real,fs,args) as number;
    if(++reads===2)writeFileSync(join(root,"src","new.ts"),"new runtime bytes\n",{mode:0o644});
    return count;
  }) as typeof fs.readSync);
  try{refused(()=>measureSyncPlacementWriters([root]),"changed");}finally{fault.mockRestore();}
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("root retarget and file replacement during a descriptor read are detected by final revalidation",()=>{
  const parent=temp(),a=install(parent,"a"),b=install(parent,"b"),alias=join(parent,"current");symlinkSync(a,alias);
  const real=fs.readSync;let changed=false;
  const probe=spyOn(fs,"readSync").mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{
    const count=Reflect.apply(real,fs,args) as number;
    if(!changed){changed=true;unlinkSync(alias);symlinkSync(b,alias);}
    return count;
  }) as typeof fs.readSync);
  try{refused(()=>measureSyncPlacementWriters([alias]),"changed");}finally{probe.mockRestore();}
  expect(changed).toBe(true);changed=false;
  const replacement=spyOn(fs,"readSync").mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{
    const count=Reflect.apply(real,fs,args) as number;
    if(!changed){changed=true;renameSync(join(a,"package.json"),join(a,"old-package"));writeFileSync(join(a,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}));}
    return count;
  }) as typeof fs.readSync);
  try{refused(()=>measureSyncPlacementWriters([a]),"changed");}finally{replacement.mockRestore();}
  expect(changed).toBe(true);
});
