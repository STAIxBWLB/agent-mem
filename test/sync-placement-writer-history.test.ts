import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { realPath } from "../src/memory/platform.ts";
import { acquireMutation, type MutationHandle } from "../src/memory/mutation.ts";
import { syncPlacementWriterId } from "../src/memory/sync-placement-writers.ts";
import {
  WRITER_REVISION_SCHEMA, WRITER_RENEWAL_INTENT_SCHEMA, WRITER_COMMIT_LOG, WRITER_RENEWAL_INTENT_FILE,
  WRITER_REVISION_MAX_BYTES, createWriterRevision, createWriterCommit, createWriterRenewalIntent,
  writerRevisionFile, writerInventoryGenesis, SharedWriterRevisionError, type WriterRenewalIntent,
} from "../src/memory/sync-placement-writer-revision-format.ts";
import {
  readWriterHistory, writeWriterRenewalIntent, writeWriterRevision, appendWriterCommit, clearWriterRenewalIntent,
  abandonWriterRenewal, writerRenewalIntentTempName, type WriterHistoryOptions, type WriterHistoryBinding,
} from "../src/memory/sync-placement-writer-history.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const encode=(value:unknown)=>Buffer.from(canonicalJSON(value)+"\n");
const sha=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");
function fixture(){
  const home=realPath(fs.mkdtempSync(join(tmpdir(),"amem-writer-history-")));fs.chmodSync(home,0o700);
  cleanup.push(()=>fs.rmSync(home,{recursive:true,force:true}));
  const stat=fs.statSync(home,{bigint:true}),binding:WriterHistoryBinding={epochHash:"a".repeat(64),activationHash:"b".repeat(64),homeHash:hashJSON([home,String(stat.dev),String(stat.ino),String(stat.uid)]),generation:"c".repeat(32),initialLocatorHash:"d".repeat(64)};
  let epoch=home;for(const part of ["sync-placement","epochs",binding.epochHash]){epoch=join(epoch,part);fs.mkdirSync(epoch,{mode:0o700});}
  const mutation=acquireMutation(home);if(!mutation)throw Error("isolated home lock unavailable");cleanup.push(mutation);
  const opts:WriterHistoryOptions={mutation,assertCurrent(){}};
  const intent=(sequence=1):WriterRenewalIntent=>{
    const old=readWriterHistory(home,binding),root="/fixture/writer";
    const revision=createWriterRevision({schema:WRITER_REVISION_SCHEMA,epochHash:binding.epochHash,activationHash:binding.activationHash,homeHash:binding.homeHash,generation:binding.generation,initialLocatorHash:binding.initialLocatorHash!,sequence,previousHash:old.headHash,journal:{sequence:sequence-1,headHash:sequence===1?binding.epochHash:hashJSON(["journal",sequence-1])},roots:[{root,writerId:syncPlacementWriterId(root),version:"0.22.0",pin:hashJSON(["pin",sequence])}],requestId:hashJSON(["request",sequence])});
    return createWriterRenewalIntent({schema:WRITER_RENEWAL_INTENT_SCHEMA,home,revision,commit:createWriterCommit(revision),previousLogBytes:old.logBytes,previousLogHash:old.logHash});
  };
  const commit=(value:WriterRenewalIntent)=>{writeWriterRenewalIntent(home,value,opts);writeWriterRevision(home,value,opts);appendWriterCommit(home,value,opts);clearWriterRenewalIntent(home,value,opts);};
  return{home,epoch,binding,mutation,opts,intent,commit,log:join(epoch,WRITER_COMMIT_LOG),pending:join(home,WRITER_RENEWAL_INTENT_FILE)};
}
function tree(root:string):Record<string,unknown>{
  const out:Record<string,unknown>={};const visit=(file:string)=>{const s=fs.lstatSync(file,{bigint:true});out[file.slice(root.length)]={dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),nlink:String(s.nlink),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),data:s.isFile()?fs.readFileSync(file).toString("base64"):s.isSymbolicLink()?fs.readlinkSync(file):null};if(s.isDirectory())for(const n of fs.readdirSync(file).sort())visit(join(file,n));};visit(root);return out;
}

test("empty history is passive genesis; committed history retains only the current root inventory",()=>{
  const f=fixture(),before=tree(f.home),initial=readWriterHistory(f.home,f.binding);
  expect(initial).toMatchObject({sequence:0,headHash:writerInventoryGenesis(f.binding.epochHash,f.binding.activationHash),logBytes:0,logHash:sha(Buffer.alloc(0)),appendStarted:false});
  initial.assertCurrent();expect(tree(f.home)).toEqual(before);
  const first=f.intent();f.commit(first);const second=f.intent(2);f.commit(second);
  const result=readWriterHistory(f.home,f.binding),stable=tree(f.home);expect(result.sequence).toBe(2);expect(result.current).toEqual(second.revision);expect(result.commits).toEqual([first.commit,second.commit]);expect(result.anchors).toEqual([first.revision.journal,second.revision.journal]);
  expect(Object.keys(result)).not.toContain("revisions");result.assertCurrent();expect(tree(f.home)).toEqual(stable);
});

test("pending remains strict even after a complete commit line until exact cleanup",()=>{
  const f=fixture(),intent=f.intent();writeWriterRenewalIntent(f.home,intent,f.opts);writeWriterRevision(f.home,intent,f.opts);appendWriterCommit(f.home,intent,f.opts);
  expect(()=>readWriterHistory(f.home,f.binding)).toThrow(SharedWriterRevisionError);
  const result=readWriterHistory(f.home,f.binding,{allowPending:true});expect(result).toMatchObject({sequence:1,pending:intent,appendStarted:true});
  clearWriterRenewalIntent(f.home,intent,f.opts);expect(readWriterHistory(f.home,f.binding).current).toEqual(intent.revision);
});

test("exact candidate and SECOND commit prefixes resume without truncate, duplicate or reseal",()=>{
  const f=fixture(),first=f.intent();f.commit(first);const second=f.intent(2);writeWriterRenewalIntent(f.home,second,f.opts);
  const candidate=join(f.epoch,writerRevisionFile(2));fs.writeFileSync(candidate,encode(second.revision).subarray(0,31),{mode:0o600});writeWriterRevision(f.home,second,f.opts);
  const prefix=fs.readFileSync(f.log);fs.appendFileSync(f.log,encode(second.commit).subarray(0,23));
  expect(readWriterHistory(f.home,f.binding,{allowPending:true})).toMatchObject({sequence:1,headHash:first.commit.seal,appendStarted:true});
  const before=tree(f.home);expect(()=>abandonWriterRenewal(f.home,second,f.opts)).toThrow(SharedWriterRevisionError);expect(tree(f.home)).toEqual(before);
  appendWriterCommit(f.home,second,f.opts);clearWriterRenewalIntent(f.home,second,f.opts);
  expect(fs.readFileSync(f.log)).toEqual(Buffer.concat([prefix,encode(second.commit)]));expect(readWriterHistory(f.home,f.binding).sequence).toBe(2);
});

test("an exact partial intent temp is never a readable fallback, but the same supplied intent can finish it",()=>{
  const f=fixture(),intent=f.intent(),temp=join(f.home,writerRenewalIntentTempName(intent));fs.writeFileSync(temp,encode(intent).subarray(0,27),{mode:0o600});
  expect(()=>readWriterHistory(f.home,f.binding)).toThrow(SharedWriterRevisionError);expect(()=>readWriterHistory(f.home,f.binding,{allowPending:true})).toThrow(SharedWriterRevisionError);
  writeWriterRenewalIntent(f.home,intent,f.opts);expect(fs.readFileSync(f.pending)).toEqual(encode(intent));expect(fs.existsSync(temp)).toBe(false);
  abandonWriterRenewal(f.home,intent,f.opts);expect(readWriterHistory(f.home,f.binding).sequence).toBe(0);
});

test("atomic intent exposes only full bytes and resumes its recognized full two-link pair",()=>{
  const f=fixture(),intent=f.intent();writeWriterRenewalIntent(f.home,intent,f.opts);
  const temp=join(f.home,writerRenewalIntentTempName(intent));fs.linkSync(f.pending,temp);
  expect(readWriterHistory(f.home,f.binding,{allowPending:true}).pending).toEqual(intent);
  writeWriterRenewalIntent(f.home,intent,f.opts);expect(fs.statSync(f.pending).nlink).toBe(1);expect(fs.existsSync(temp)).toBe(false);
});

test("pre-append abandon preserves all previously committed evidence",()=>{
  const f=fixture(),first=f.intent();f.commit(first);const previous=fs.readFileSync(f.log),firstFile=fs.readFileSync(join(f.epoch,writerRevisionFile(1))),second=f.intent(2);
  writeWriterRenewalIntent(f.home,second,f.opts);writeWriterRevision(f.home,second,f.opts);abandonWriterRenewal(f.home,second,f.opts);
  expect(fs.readFileSync(f.log)).toEqual(previous);expect(fs.readFileSync(join(f.epoch,writerRevisionFile(1)))).toEqual(firstFile);
  expect(fs.existsSync(join(f.epoch,writerRevisionFile(2)))).toBe(false);expect(fs.existsSync(f.pending)).toBe(false);
});

for(const kind of ["symlink","hardlink","mode","oversize","orphan","wrong-tail"]as const)test("unsafe history refuses without effects: "+kind,()=>{
  const f=fixture(),intent=f.intent();writeWriterRenewalIntent(f.home,intent,f.opts);const candidate=join(f.epoch,writerRevisionFile(1));
  if(kind==="symlink")fs.symlinkSync(f.pending,candidate);
  if(kind==="hardlink")fs.linkSync(f.pending,candidate);
  if(kind==="mode")fs.writeFileSync(candidate,encode(intent.revision),{mode:0o644});
  if(kind==="oversize"){const fd=fs.openSync(candidate,"wx",0o600);fs.ftruncateSync(fd,WRITER_REVISION_MAX_BYTES+1);fs.closeSync(fd);}
  if(kind==="orphan")fs.writeFileSync(join(f.epoch,writerRevisionFile(2)),"",{mode:0o600});
  if(kind==="wrong-tail"){writeWriterRevision(f.home,intent,f.opts);fs.writeFileSync(f.log,"not the exact commit",{mode:0o600});}
  const before=tree(f.home);expect(()=>readWriterHistory(f.home,f.binding,{allowPending:true})).toThrow(SharedWriterRevisionError);expect(()=>writeWriterRevision(f.home,intent,f.opts)).toThrow(SharedWriterRevisionError);expect(tree(f.home)).toEqual(before);
});

test("passive snapshots reject a replaced revision and bound initial locator mismatch",()=>{
  const f=fixture(),intent=f.intent();f.commit(intent);const read=readWriterHistory(f.home,f.binding),file=join(f.epoch,writerRevisionFile(1)),bytes=fs.readFileSync(file);
  fs.unlinkSync(file);fs.writeFileSync(file,bytes,{mode:0o600});expect(()=>read.assertCurrent()).toThrow(SharedWriterRevisionError);
  expect(()=>readWriterHistory(f.home,{...f.binding,initialLocatorHash:"e".repeat(64)})).toThrow(SharedWriterRevisionError);
});

test("unknown writer filenames and metadata cardinality fail before any writer effect",()=>{
  const f=fixture(),intent=f.intent();fs.writeFileSync(join(f.epoch,"writer-revision-00065.json"),"",{mode:0o600});
  let before=tree(f.home);expect(()=>writeWriterRenewalIntent(f.home,intent,f.opts)).toThrow(SharedWriterRevisionError);expect(tree(f.home)).toEqual(before);
  fs.unlinkSync(join(f.epoch,"writer-revision-00065.json"));for(let i=0;i<256;i++)fs.writeFileSync(join(f.epoch,"unrelated-"+i),"",{mode:0o600});before=tree(f.home);
  expect(()=>writeWriterRenewalIntent(f.home,intent,f.opts)).toThrow(SharedWriterRevisionError);expect(tree(f.home)).toEqual(before);
});

test("forged or released home mutation handles cannot write metadata",()=>{
  const f=fixture(),intent=f.intent(),before=tree(f.home);expect(()=>writeWriterRenewalIntent(f.home,intent,{...f.opts,mutation:(()=>{})as MutationHandle})).toThrow(SharedWriterRevisionError);expect(tree(f.home)).toEqual(before);
  f.mutation();const released=tree(f.home);expect(()=>writeWriterRenewalIntent(f.home,intent,f.opts)).toThrow(SharedWriterRevisionError);expect(tree(f.home)).toEqual(released);
});

for(const phase of ["intent-written","intent-fsync","revision-written","revision-fsync","commit-written","commit-fsync"]as const)test("new owner reasserts exact durability after "+phase,()=>{
  const f=fixture(),intent=f.intent();let failed=false;
  const opts:WriterHistoryOptions={...f.opts,phase(current){if(!failed&&current===phase){failed=true;throw Error("isolated phase interruption");}}};
  const run=()=>{writeWriterRenewalIntent(f.home,intent,opts);writeWriterRevision(f.home,intent,opts);appendWriterCommit(f.home,intent,opts);};
  expect(run).toThrow(SharedWriterRevisionError);expect(failed).toBe(true);
  // A fresh LIVE handle must fsync complete-looking bytes, not merely compare their content.
  f.mutation();const next=acquireMutation(f.home);if(!next)throw Error("isolated replacement owner unavailable");cleanup.push(next);
  const original=fs.fsyncSync;let syncs=0;const spy=spyOn(fs,"fsyncSync").mockImplementation(fd=>{syncs++;return original(fd);});
  try{const recovery={mutation:next,assertCurrent(){}};writeWriterRenewalIntent(f.home,intent,recovery);writeWriterRevision(f.home,intent,recovery);appendWriterCommit(f.home,intent,recovery);clearWriterRenewalIntent(f.home,intent,recovery);expect(syncs).toBeGreaterThan(0);}finally{spy.mockRestore();}
  expect(readWriterHistory(f.home,f.binding).sequence).toBe(1);expect(fs.readFileSync(f.log)).toEqual(encode(intent.commit));
});

test("abandon retry fsyncs parents after a prior unlink and keeps exact intent until the end",()=>{
  const f=fixture(),intent=f.intent();writeWriterRenewalIntent(f.home,intent,f.opts);writeWriterRevision(f.home,intent,f.opts);
  const original=fs.fsyncSync,epoch=fs.statSync(f.epoch,{bigint:true});let interrupted=false,retried=false;
  const spy=spyOn(fs,"fsyncSync").mockImplementation(fd=>{const s=fs.fstatSync(fd,{bigint:true});if(s.dev===epoch.dev&&s.ino===epoch.ino&&!fs.existsSync(join(f.epoch,writerRevisionFile(1)))){if(!interrupted){interrupted=true;throw Error("isolated lost directory fsync");}retried=true;}return original(fd);});
  try{expect(()=>abandonWriterRenewal(f.home,intent,f.opts)).toThrow(SharedWriterRevisionError);expect(fs.existsSync(f.pending)).toBe(true);abandonWriterRenewal(f.home,intent,f.opts);expect(retried).toBe(true);}finally{spy.mockRestore();}
  expect(fs.existsSync(f.pending)).toBe(false);expect(readWriterHistory(f.home,f.binding).sequence).toBe(0);
});

test("exact 64 committed revisions remain readable and a 65th cannot create metadata",()=>{
  const f=fixture();let previous=writerInventoryGenesis(f.binding.epochHash,f.binding.activationHash);const log:Buffer[]=[];
  for(let sequence=1;sequence<=64;sequence++){
    const revision=createWriterRevision({schema:WRITER_REVISION_SCHEMA,epochHash:f.binding.epochHash,activationHash:f.binding.activationHash,homeHash:f.binding.homeHash,generation:f.binding.generation,initialLocatorHash:f.binding.initialLocatorHash!,sequence,previousHash:previous,journal:{sequence:0,headHash:f.binding.epochHash},roots:[{root:"/fixture/writer",writerId:syncPlacementWriterId("/fixture/writer"),version:"0.22.0",pin:hashJSON(["pin",sequence])}],requestId:hashJSON(["request",sequence])});
    const commit=createWriterCommit(revision);fs.writeFileSync(join(f.epoch,writerRevisionFile(sequence)),encode(revision),{mode:0o600});log.push(encode(commit));previous=commit.seal;
  }
  fs.writeFileSync(f.log,Buffer.concat(log),{mode:0o600});const before=tree(f.home),history=readWriterHistory(f.home,f.binding);expect(history.sequence).toBe(64);expect(history.headHash).toBe(previous);
  try{f.intent(65);throw Error("expected revision capacity refusal");}catch(error){expect(error).toBeInstanceOf(SharedWriterRevisionError);expect((error as SharedWriterRevisionError).remaining).toBe(0);}
  expect(tree(f.home)).toEqual(before);
});

test("abandon is idempotent after intent unlink acknowledgement loss",()=>{
  const f=fixture(),intent=f.intent();writeWriterRenewalIntent(f.home,intent,f.opts);writeWriterRevision(f.home,intent,f.opts);
  let stopped=false;expect(()=>abandonWriterRenewal(f.home,intent,{...f.opts,phase(phase){if(phase==="intent-cleared"){stopped=true;throw Error("isolated unlink acknowledgement loss");}}})).toThrow(SharedWriterRevisionError);
  expect(stopped).toBe(true);expect(fs.existsSync(f.pending)).toBe(false);
  abandonWriterRenewal(f.home,intent,f.opts);expect(readWriterHistory(f.home,f.binding).sequence).toBe(0);
});
