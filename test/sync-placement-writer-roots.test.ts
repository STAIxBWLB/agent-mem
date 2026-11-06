import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as immutableActivation from "../src/memory/public-prune-activation.ts";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { realPath } from "../src/memory/platform.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { planPlacementJournal, preparePlacementJournal, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { measureSyncPlacementWriters, SyncPlacementWriterError } from "../src/memory/sync-placement-writers.ts";
import { readSyncPlacementWriterRoots, writeSyncPlacementWriterRoots, planSyncPlacementWriterRoots, SYNC_PLACEMENT_WRITER_ROOTS_FILE } from "../src/memory/sync-placement-writer-roots.ts";
import { inspectionFilesystemSnapshot, inspectionNote } from "./fakes/sync-placement-inspection.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const json=(value:unknown)=>canonicalJSON(value)+"\n";
async function fixture(){
  const root=realPath(mkdtempSync(join(tmpdir(),"amem-writer-roots-")));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,"memory"),install=join(root,"install");mkdirSync(install,{mode:0o755});
  for(const name of ["src","bin"])mkdirSync(join(install,name),{mode:0o755});
  writeFileSync(join(install,"package.json"),json({name:"@staix/agent-mem",version:"0.21.0"}),{mode:0o644});
  writeFileSync(join(install,"src/index.ts"),"foreign bytes only\n",{mode:0o644});writeFileSync(join(install,"bin/amem.js"),"foreign bytes only\n",{mode:0o755});
  const store=new MemoryStore({memoryDir:home,deferPromotions:true});try{store.note(inspectionNote("isolated locator source"));}finally{store.close();}
  await migrateShards({memoryDir:home,generation:"9".repeat(32),mode:"apply",authorizedPerson:true,tty:true});
  await activatePublicPruneView({memoryDir:home,mode:"apply",authorizedPerson:true,tty:true});
  const measured=measureSyncPlacementWriters([install]);
  const port:PlacementJournalPort={attest:()=>({writers:measureSyncPlacementWriters([install]).writers,legacySyncQuiesced:true}),authorize:()=>true};
  const preview=planPlacementJournal(home,port),prepared=preparePlacementJournal(home,preview,port);
  const input={epochHash:prepared.epochHash,homeHash:preview.epoch.homeHash,activationHash:preview.plan.seal,roots:measured.roots};
  const write=(change:Partial<typeof input>={},writers=measured.writers)=>{
    const proof=captureSyncPlacementContext(home,port),mutation=acquireMutation(home);if(!mutation)throw Error("isolated writer-root mutation unavailable");
    try{writeSyncPlacementWriterRoots(home,{...input,...change},writers,{mutation,assertCurrent:proof.assertCurrent});}finally{mutation();}
  };
  const activate=()=>{
    const shards=JSON.parse(readFileSync(join(home,"shards.json"),"utf8")),profile=preview.plan.targetProfile;
    writeFileSync(join(home,"profile.json"),json(profile),{mode:0o600});
    writeFileSync(join(home,"shards.json"),json({...shards,schema:PLACEMENT_SHARDS_SCHEMA,selectorRevision:hashJSON(profile),publicationFormat:PLACEMENT_FORMAT,placementHead:input.epochHash}),{mode:0o600});
    const proof=captureSyncPlacementContext(home,port),mutation=acquireMutation(home);if(!mutation)throw Error("isolated fence unavailable");
    try{ensurePlacementFence(home,input.epochHash,{mutation,assertCurrent:proof.assertCurrent});}finally{mutation();}
  };
  return{root,home,install,input,measured,write,activate,file:join(home,SYNC_PLACEMENT_WRITER_ROOTS_FILE),snapshot:()=>inspectionFilesystemSnapshot(root)};
}

test("initial locator is immutable, binds a genuine prepared epoch and is read-only only after actual activation",async()=>{
  const f=await fixture();f.write();const text=readFileSync(f.file,"utf8"),saved=JSON.parse(text);
  expect(saved).toEqual({schema:"agent-mem.sync-placement-writer-roots/v1",homeHash:f.input.homeHash,epochHash:f.input.epochHash,activationHash:f.input.activationHash,
    roots:f.measured.roots.map(({root,writerId})=>({root,writerId})),seal:saved.seal});
  expect(text).not.toContain('"pin"');expect(text).not.toContain('"version"');expect(text).not.toContain("isolated locator source");
  expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);
  f.write();expect(readFileSync(f.file,"utf8")).toBe(text);f.activate();
  const before=f.snapshot();expect(readSyncPlacementWriterRoots(f.home)).toEqual([f.install]);expect(f.snapshot()).toEqual(before);
  expect(()=>f.write({activationHash:"1".repeat(64)})).toThrow(SyncPlacementWriterError);expect(readFileSync(f.file,"utf8")).toBe(text);
},20_000);

test("locator paths are expected data, never fresh install-byte evidence",async()=>{
  const f=await fixture();f.write();f.activate();const text=readFileSync(f.file,"utf8");
  writeFileSync(join(f.install,"src/index.ts"),"changed actual install bytes\n");
  expect(readSyncPlacementWriterRoots(f.home)).toEqual([f.install]);
  expect(measureSyncPlacementWriters(readSyncPlacementWriterRoots(f.home)).writers).not.toEqual(f.measured.writers);
  expect(readFileSync(f.file,"utf8")).toBe(text);
},20_000);

test("mismatched epoch, home, activation or expected writer IDs refuse without publishing a locator",async()=>{
  const f=await fixture();
  for(const change of [{epochHash:"1".repeat(64)},{homeHash:"2".repeat(64)},{activationHash:"3".repeat(64)}]){
    expect(()=>f.write(change)).toThrow(SyncPlacementWriterError);expect(fs.existsSync(f.file)).toBe(false);
  }
  expect(()=>f.write({},[{...f.measured.writers[0]!,writerId:"4".repeat(64)}])).toThrow(SyncPlacementWriterError);
  expect(fs.existsSync(f.file)).toBe(false);
},20_000);

test("closed canonical codec rejects future fields, bindings, duplicates and bounds without read effects",async()=>{
  const f=await fixture();f.write();f.activate();const original=readFileSync(f.file,"utf8"),body=JSON.parse(original);
  const seal=(value:Record<string,unknown>)=>{const {seal:_old,...rest}=value;return {...rest,seal:hashJSON(rest)};};
  const variants=[{...body,schema:"agent-mem.sync-placement-writer-roots/v2"},{...body,pin:"f".repeat(64)},
    {...body,homeHash:"1".repeat(64)},{...body,epochHash:"2".repeat(64)},{...body,activationHash:"3".repeat(64)},
    {...body,roots:[body.roots[0],body.roots[0]]},{...body,roots:[{root:f.install,writerId:"4".repeat(64)}]},
    {...body,roots:Array(257).fill(body.roots[0])},{...body,roots:[{...body.roots[0],root:"/"+"x".repeat(4097)}]}];
  for(const variant of variants){writeFileSync(f.file,json(seal(variant)));const before=f.snapshot();expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);expect(f.snapshot()).toEqual(before);}
  writeFileSync(f.file," "+original);expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);
  writeFileSync(f.file," ".repeat(256*1024+1));expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);
},20_000);

test("private modes, no-follow reads and only an exact recognized two-link companion are accepted",async()=>{
  const f=await fixture();f.write();f.activate();const text=readFileSync(f.file,"utf8");
  chmodSync(f.file,0o644);expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);chmodSync(f.file,0o600);
  const unrelated=join(f.root,"unregistered-hardlink");linkSync(f.file,unrelated);expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);unlinkSync(unrelated);
  const companion=f.file+".pending-"+createHash("sha256").update(text).digest("hex");linkSync(f.file,companion);
  const before=f.snapshot();expect(readSyncPlacementWriterRoots(f.home)).toEqual([f.install]);expect(f.snapshot()).toEqual(before);
  unlinkSync(companion);const elsewhere=join(f.root,"elsewhere.json");writeFileSync(elsewhere,text,{mode:0o600});unlinkSync(f.file);symlinkSync(elsewhere,f.file);
  expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);
},20_000);

test("locator replacement during its read is detected and external messages are never inspected",async()=>{
  const f=await fixture();f.write();f.activate();const original=fs.readSync,locatorReadBytes=readFileSync(f.file).length+1;let changed=false;
  const fault=spyOn(fs,"readSync").mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{
    const count=Reflect.apply(original,fs,args) as number;
    // The locator owns this exact-sized read buffer; earlier activation reads have different byte lengths.
    if(!changed&&args[1] instanceof Uint8Array&&args[1].byteLength===locatorReadBytes){changed=true;chmodSync(f.file,0o644);}
    return count;
  }) as typeof fs.readSync);
  try{expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);}finally{fault.mockRestore();}
  expect(changed).toBe(true);chmodSync(f.file,0o600);
  let messageRead=0;const unavailable=spyOn(fs,"readSync").mockImplementation(()=>{throw Object.defineProperty({},"message",{get(){messageRead++;return "PRIVATE_ERROR_CANARY";}});});
  try{expect(()=>readSyncPlacementWriterRoots(f.home)).toThrow(SyncPlacementWriterError);}finally{unavailable.mockRestore();}
  expect(messageRead).toBe(0);
},20_000);

test("oversized and unsafe deterministic orphans refuse before the shared writer can read them",async()=>{
  const f=await fixture();f.write();const text=readFileSync(f.file,"utf8"),pending=f.file+".pending-"+createHash("sha256").update(text).digest("hex");unlinkSync(f.file);
  const fd=fs.openSync(pending,"w",0o600);try{fs.ftruncateSync(fd,256*1024+1);}finally{fs.closeSync(fd);}
  let invoked=0;const fault=spyOn(immutableActivation,"writeImmutableActivationMetadata").mockImplementation(()=>{invoked++;throw Error("unexpected orphan read");});
  try{
    expect(()=>f.write()).toThrow(SyncPlacementWriterError);expect(invoked).toBe(0);expect(fs.statSync(pending).size).toBe(256*1024+1);
    unlinkSync(pending);writeFileSync(pending,"",{mode:0o600});chmodSync(pending,0o644);
    expect(()=>f.write()).toThrow(SyncPlacementWriterError);expect(invoked).toBe(0);expect(fs.statSync(pending).mode&0o777).toBe(0o644);
    unlinkSync(pending);const elsewhere=join(f.root,"orphan-target");writeFileSync(elsewhere,text,{mode:0o600});symlinkSync(elsewhere,pending);
    expect(()=>f.write()).toThrow(SyncPlacementWriterError);expect(invoked).toBe(0);expect(readFileSync(elsewhere,"utf8")).toBe(text);
    unlinkSync(pending);linkSync(elsewhere,pending);
    expect(()=>f.write()).toThrow(SyncPlacementWriterError);expect(invoked).toBe(0);expect(fs.statSync(elsewhere).nlink).toBe(2);
  }finally{fault.mockRestore();}
  expect(fs.existsSync(f.file)).toBe(false);
},20_000);

test("empty and partial private one-link staging prefixes resume only the immutable expected locator",async()=>{
  const f=await fixture();f.write();const text=readFileSync(f.file,"utf8"),pending=f.file+".pending-"+createHash("sha256").update(text).digest("hex");
  for(const prefix of ["",text.slice(0,23)]){
    unlinkSync(f.file);writeFileSync(pending,prefix,{mode:0o600});
    f.write();expect(readFileSync(f.file,"utf8")).toBe(text);expect(fs.existsSync(pending)).toBe(false);expect(fs.statSync(f.file).nlink).toBe(1);
  }
  f.activate();expect(readSyncPlacementWriterRoots(f.home)).toEqual([f.install]);
},20_000);


test("pure locator planning validates full canonical binding and writer tuples without measuring or reading installs",async()=>{
  const f=await fixture(),binding={epochHash:f.input.epochHash,homeHash:f.input.homeHash,activationHash:f.input.activationHash,writers:f.measured.writers};
  const before=f.snapshot();
  const noRead=spyOn(fs,"openSync").mockImplementation((()=>{throw Error("pure locator plan must not read filesystem");}) as typeof fs.openSync);
  try{
    const plan=planSyncPlacementWriterRoots(f.input,binding);
    expect(plan).toMatchObject({epochHash:f.input.epochHash,homeHash:f.input.homeHash,activationHash:f.input.activationHash,roots:f.measured.roots.map(({root,writerId})=>({root,writerId}))});
    expect(Buffer.byteLength(json(plan))).toBeLessThanOrEqual(256*1024);expect(noRead).not.toHaveBeenCalled();
    expect(()=>planSyncPlacementWriterRoots(f.input,{...binding,epochHash:"f".repeat(64)})).toThrow(SyncPlacementWriterError);
    expect(()=>planSyncPlacementWriterRoots({...f.input,roots:f.measured.roots.map(root=>({...root,pin:"f".repeat(64)}))},binding)).toThrow(SyncPlacementWriterError);
  }finally{noRead.mockRestore();}
  expect(f.snapshot()).toEqual(before);
},20_000);
