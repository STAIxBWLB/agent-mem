/** Private append-only writer inventory history. It never measures installs or grants activation authority. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, opendirSync, readSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import {
  WRITER_REVISION_MAX_BYTES, WRITER_COMMIT_MAX_BYTES, WRITER_RENEWAL_INTENT_MAX_BYTES, WRITER_REVISION_LIMIT,
  WRITER_COMMIT_LOG, WRITER_RENEWAL_INTENT_FILE, writerRevisionFile, writerInventoryGenesis,
  validateWriterRevision, validateWriterCommit, validateWriterRenewalIntent, createWriterCommit,
  SharedWriterRevisionError, type WriterRevision, type WriterCommit, type WriterRenewalIntent,
} from "./sync-placement-writer-revision-format.ts";

export interface WriterHistoryBinding { epochHash: string; activationHash: string; homeHash: string; generation: string; initialLocatorHash?: string }
export type WriterHistoryPhase = "intent-started" | "intent-written" | "intent-fsync" | "intent-published" | "revision-written" | "revision-fsync" | "commit-started" | "commit-written" | "commit-fsync" | "intent-cleared";
export interface WriterHistoryOptions { mutation: MutationHandle; assertCurrent(): void; phase?(phase: WriterHistoryPhase): void }
export interface WriterHistoryRead {
  current?: WriterRevision; commits: WriterCommit[]; anchors: { sequence: number; headHash: string }[];
  sequence: number; headHash: string; logBytes: number; logHash: string; pending?: WriterRenewalIntent; appendStarted: boolean; assertCurrent(): void;
}
const encode = (value: unknown) => Buffer.from(canonicalJSON(value) + "\n");
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const stamp = (s: BigIntStats) => [s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
const identity = (s: BigIntStats) => [s.dev,s.ino,s.uid,s.mode].map(String).join(":");
function fail(code: "invalid" | "bound" | "changed" | "pending" | "staging" = "invalid"): never { throw new SharedWriterRevisionError(code); }
function safe<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error && typeof error === "object" && !types.isProxy(error) && error instanceof SharedWriterRevisionError) {
      const code=Object.getOwnPropertyDescriptor(error,"code");
      if(code&&"value"in code&&["invalid","bound","changed","pending","staging","cap"].includes(code.value))throw new SharedWriterRevisionError(code.value);
    }
    return fail();
  }
}
function owned(s: BigIntStats, dir = false, links: readonly bigint[] = [1n]): void {
  if (s.isSymbolicLink() || s.uid !== BigInt(process.getuid?.() ?? -1)
    || (dir ? !s.isDirectory() || (s.mode & 0o077n) !== 0n : !s.isFile() || !links.includes(s.nlink) || (s.mode & 0o777n) !== 0o600n)) fail();
}
function checkedDir(file: string): BigIntStats { const s = lstatSync(file,{bigint:true}); owned(s,true); return s; }
interface FileRead { bytes: Buffer; stat: BigIntStats }
function read(file: string, max: number, checks: (() => void)[] = [], links: readonly bigint[] = [1n]): FileRead | undefined {
  const before = lstatSync(file,{bigint:true,throwIfNoEntry:false});
  if (!before) { checks.push(() => { if (lstatSync(file,{throwIfNoEntry:false})) fail("changed"); }); return undefined; }
  owned(before,false,links); if (before.size > BigInt(max)) fail("bound");
  const fd = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd,{bigint:true}); owned(opened,false,links); if (stamp(opened)!==stamp(before)) fail("changed");
    const buffer = Buffer.alloc(Number(opened.size)+1); let at=0;
    while (at<buffer.length) { const n=readSync(fd,buffer,at,buffer.length-at,at); if (!n) break; at+=n; }
    if (at!==Number(opened.size) || stamp(fstatSync(fd,{bigint:true}))!==stamp(opened) || stamp(lstatSync(file,{bigint:true}))!==stamp(opened)) fail("changed");
    checks.push(() => { const now=lstatSync(file,{bigint:true}); owned(now,false,links); if(stamp(now)!==stamp(opened))fail("changed"); });
    return {bytes:buffer.subarray(0,at),stat:opened};
  } finally { closeSync(fd); }
}
function decode<T>(bytes: Buffer, validate: (value: unknown) => T): T {
  const text = new TextDecoder("utf-8",{fatal:true}).decode(bytes), result=validate(JSON.parse(text));
  if (!bytes.equals(encode(result))) fail(); return result;
}
function binding(value: WriterHistoryBinding): WriterHistoryBinding {
  if (!value || typeof value!=="object" || types.isProxy(value) || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors=Object.getOwnPropertyDescriptors(value), keys=["epochHash","activationHash","homeHash","generation"];
  if(Object.keys(descriptors).some(key=>![...keys,"initialLocatorHash"].includes(key)))fail();
  const result: Record<string,string>={};
  for(const key of keys){const d=descriptors[key];if(!d||!("value"in d)||!d.enumerable||typeof d.value!=="string"||d.value.length!==(key==="generation"?32:64)||!/^[a-f0-9]+$/.test(d.value))fail();result[key]=d.value;}
  const locator=descriptors.initialLocatorHash;if(locator){if(!("value"in locator)||!locator.enumerable||typeof locator.value!=="string"||locator.value.length!==64||!/^[a-f0-9]+$/.test(locator.value))fail();result.initialLocatorHash=locator.value;}
  return result as unknown as WriterHistoryBinding;
}
interface Paths { home: string; epoch: string; intent: string; log: string; dirs: [string,BigIntStats][] }
function paths(homeInput: string, input: WriterHistoryBinding): Paths {
  const home=realPath(homeInput), original=checkedDir(homeInput), root=checkedDir(home);
  if(identity(original)!==identity(root)||hashJSON([home,String(root.dev),String(root.ino),String(root.uid)])!==input.homeHash)fail("changed");
  const dirs:[string,BigIntStats][]=[[home,root]];
  let current=home;for(const part of ["sync-placement","epochs",input.epochHash]){current=join(current,part);dirs.push([current,checkedDir(current)]);}
  return {home,epoch:current,intent:join(home,WRITER_RENEWAL_INTENT_FILE),log:join(current,WRITER_COMMIT_LOG),dirs};
}
function manifest(p: Paths): string[] {
  const iterator=opendirSync(p.epoch), names:string[]=[]; let count=0;
  try {for(;;){const entry=iterator.readSync();if(!entry)break;if(++count>255)fail("bound");
    if(entry.name.startsWith("writer-")){if(entry.name!==WRITER_COMMIT_LOG&&!/^writer-revision-\d{5}\.json$/.test(entry.name))fail();names.push(entry.name);}
  }} finally {iterator.closeSync();} return names.sort();
}
function boundRevision(revision: WriterRevision,b:WriterHistoryBinding):void {
  if(revision.epochHash!==b.epochHash||revision.activationHash!==b.activationHash||revision.homeHash!==b.homeHash||revision.generation!==b.generation||b.initialLocatorHash!==undefined&&revision.initialLocatorHash!==b.initialLocatorHash)fail();
}
function intentBinding(intent:WriterRenewalIntent):WriterHistoryBinding {const r=intent.revision;return {epochHash:r.epochHash,activationHash:r.activationHash,homeHash:r.homeHash,generation:r.generation};}
/** Exact basename reserved alongside the final outside intent during atomic publication. */
export function writerRenewalIntentTempName(value:WriterRenewalIntent):string {return WRITER_RENEWAL_INTENT_FILE+".pending-"+sha(encode(validateWriterRenewalIntent(value)));}
export function isWriterRenewalIntentTempName(name:string):boolean {const match=new RegExp("^"+WRITER_RENEWAL_INTENT_FILE.replaceAll(".","\\.")+"\\.pending-[a-f0-9]{64}$").exec(name);return !!match&&match[0]===name;}
function intentTemps(p:Paths):string[]{
  const iterator=opendirSync(p.home),out:string[]=[];let count=0,bytes=0;
  try{for(;;){const item=iterator.readSync();if(!item)break;if(++count>20000||(bytes+=Buffer.byteLength(item.name))>8*1024*1024)fail("bound");
    if(item.name.startsWith(WRITER_RENEWAL_INTENT_FILE+".pending-")){if(!isWriterRenewalIntentTempName(item.name))fail();if(out.length>=256)fail("bound");out.push(item.name);}
  }}finally{iterator.closeSync();}return out.sort();
}
function readIntent(p:Paths,checks:(()=>void)[],expected?:WriterRenewalIntent,ignoreUnpublishedStaging=false):{file?:FileRead;intent?:WriterRenewalIntent;temp?:string}{
  const names=intentTemps(p);if(!ignoreUnpublishedStaging)checks.push(()=>{if(canonicalJSON(intentTemps(p))!==canonicalJSON(names))fail("changed");});
  const final=read(p.intent,WRITER_RENEWAL_INTENT_MAX_BYTES,checks,[1n,2n]);
  if(!final&&names.length){if(ignoreUnpublishedStaging)return{};fail("staging");}
  if(names.length>1)fail();const temp=names[0]?join(p.home,names[0]):undefined;
  const staging=temp?read(temp,WRITER_RENEWAL_INTENT_MAX_BYTES,checks,[1n,2n]):undefined;
  if(!final&&!staging)return{};
  const file=final??staging!;
  let intent:WriterRenewalIntent;
  if(expected){const full=encode(expected);if(file.bytes.length>full.length||!file.bytes.equals(full.subarray(0,file.bytes.length)))fail();intent=expected;}
  else {try{intent=decode(file.bytes,validateWriterRenewalIntent);}catch{fail("pending");}}
  const full=encode(intent),known=join(p.home,writerRenewalIntentTempName(intent));if(temp&&temp!==known)fail();
  if(final){if(!final.bytes.equals(full))fail();if(staging){if(final.stat.nlink!==2n||staging.stat.nlink!==2n||stamp(final.stat)!==stamp(staging.stat)||!staging.bytes.equals(full))fail();}else if(final.stat.nlink!==1n)fail();}
  else if(staging!.stat.nlink!==1n)fail();
  return{file,intent,temp};
}
function publishIntent(p:Paths,intent:WriterRenewalIntent,opts:WriterHistoryOptions):void{
  const before=readIntent(p,[],intent),full=encode(intent),temp=join(p.home,writerRenewalIntentTempName(intent));
  if(!before.file||!lstatSync(p.intent,{throwIfNoEntry:false})){
    complete(p,temp,full,WRITER_RENEWAL_INTENT_MAX_BYTES,opts,"intent-written","intent-fsync",{at:0,phase:"intent-started"});proof(p,opts);
    const staged=readFileExpected(temp,full,WRITER_RENEWAL_INTENT_MAX_BYTES);proof(p,opts);
    if(stamp(lstatSync(temp,{bigint:true}))!==stamp(staged.stat))fail("changed");linkSync(temp,p.intent);syncDir(p,p.home,opts);
  }
  const current=readIntent(p,[],intent);if(!current.file||!current.file.bytes.equals(full))fail();
  if(current.temp){proof(p,opts);const pair=readIntent(p,[],intent);if(pair.temp!==temp||!pair.file||stamp(pair.file.stat)!==stamp(current.file.stat))fail("changed");unlinkSync(temp);syncDir(p,p.home,opts);}
  const final=readFileExpected(p.intent,full,WRITER_RENEWAL_INTENT_MAX_BYTES),fd=openSync(p.intent,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{if(stamp(fstatSync(fd,{bigint:true}))!==stamp(final.stat))fail("changed");proof(p,opts);fsyncSync(fd);if(stamp(lstatSync(p.intent,{bigint:true}))!==stamp(final.stat))fail("changed");}finally{closeSync(fd);}syncDir(p,p.home,opts);
  if(stamp(lstatSync(p.intent,{bigint:true}))!==stamp(final.stat))fail("changed");
}
interface Snapshot { result:WriterHistoryRead; paths:Paths; log:Buffer; intentBytes?:Buffer }
function snapshot(home:string,b:WriterHistoryBinding,allowPending:boolean,expected?:WriterRenewalIntent,ignoreUnpublishedStaging=false):Snapshot {
  const p=paths(home,b), checks:(()=>void)[]=[], names=manifest(p);
  for(const [dir,stat]of p.dirs)checks.push(()=>{if(identity(checkedDir(dir))!==identity(stat))fail("changed");});
  checks.push(()=>{if(canonicalJSON(manifest(p))!==canonicalJSON(names))fail("changed");});
  const intentRead=readIntent(p,checks,expected,ignoreUnpublishedStaging),intentFile=intentRead.file;let pending=intentRead.intent;
  if(pending){if(!allowPending)fail("pending");if(pending.home!==p.home)fail();boundRevision(pending.revision,b);}
  else if(expected)fail("pending");
  const logFile=read(p.log,WRITER_COMMIT_MAX_BYTES,checks), log=logFile?.bytes??Buffer.alloc(0);
  const commits:WriterCommit[]=[],anchors:{sequence:number;headHash:string}[]=[];let current:WriterRevision|undefined;
  let head=writerInventoryGenesis(b.epochHash,b.activationHash),previous=0,completeBytes=log.length;
  const lastLF=log.lastIndexOf(10);if(lastLF!==log.length-1){if(!pending)fail("pending");completeBytes=lastLF+1;}
  let at=0;
  while(at<completeBytes){const end=log.indexOf(10,at);if(end<at)fail();const commit=decode(log.subarray(at,end+1),validateWriterCommit);at=end+1;
    if(commits.length>=WRITER_REVISION_LIMIT)fail("bound");if(commit.epochHash!==b.epochHash||commit.sequence!==commits.length+1||commit.previousHash!==head)fail();
    const file=join(p.epoch,writerRevisionFile(commit.sequence)),raw=read(file,WRITER_REVISION_MAX_BYTES,checks);if(!raw)fail();
    const revision=decode(raw.bytes,validateWriterRevision);boundRevision(revision,b);
    if(revision.sequence!==commit.sequence||revision.previousHash!==head||canonicalJSON(createWriterCommit(revision))!==canonicalJSON(commit))fail();
    if(current&&revision.initialLocatorHash!==current.initialLocatorHash)fail();
    if(revision.journal.sequence<previous||revision.journal.sequence===previous&&anchors.length&&revision.journal.headHash!==anchors.at(-1)!.headHash)fail();
    anchors.push({...revision.journal});previous=revision.journal.sequence;commits.push(commit);current=revision;head=commit.seal;
  }
  const expectedNames=new Set(commits.map(commit=>writerRevisionFile(commit.sequence)));if(logFile)expectedNames.add(WRITER_COMMIT_LOG);
  if(pending){
    const start=pending.previousLogBytes, next=pending.revision.sequence;
    if(start>log.length||sha(log.subarray(0,start))!==pending.previousLogHash||start>0&&log[start-1]!==10)fail();
    const beforeCount=commits.filter(commit=>commit.sequence<next).length;
    if(beforeCount!==next-1||commits.length<next-1||commits.length>next)fail();
    const beforeHead=next===1?writerInventoryGenesis(b.epochHash,b.activationHash):commits[next-2]!.seal;
    if(pending.revision.previousHash!==beforeHead||start!==committedPrefixLength(log,next-1))fail();
    const tail=log.subarray(start),line=encode(pending.commit);if(tail.length>line.length||!tail.equals(line.subarray(0,tail.length)))fail();
    const candidateFile=join(p.epoch,writerRevisionFile(next)),candidate=read(candidateFile,WRITER_REVISION_MAX_BYTES,checks),full=encode(pending.revision);
    if(candidate){if(candidate.bytes.length>full.length||!candidate.bytes.equals(full.subarray(0,candidate.bytes.length)))fail();expectedNames.add(writerRevisionFile(next));}
    if(tail.length&&(!candidate||!candidate.bytes.equals(full)))fail();
    if(current&&current.initialLocatorHash!==pending.revision.initialLocatorHash)fail();
    if(next>1){const anchor=anchors[next-2]!;if(pending.revision.journal.sequence<anchor.sequence||pending.revision.journal.sequence===anchor.sequence&&pending.revision.journal.headHash!==anchor.headHash)fail();}
  }else if(completeBytes!==log.length||logFile&&commits.length===0)fail("pending");
  if(canonicalJSON([...expectedNames].sort())!==canonicalJSON(names))fail();
  const assertCurrent=()=>safe(()=>{for(const check of checks)check();});assertCurrent();
  return{paths:p,log,intentBytes:intentFile?.bytes,result:{current,commits,anchors,sequence:commits.length,headHash:head,logBytes:log.length,logHash:sha(log),pending,appendStarted:!!pending&&log.length>pending.previousLogBytes,assertCurrent}};
}
function committedPrefixLength(log:Buffer,count:number):number {let at=0;for(let n=0;n<count;n++){const lf=log.indexOf(10,at);if(lf<0)fail();at=lf+1;}return at;}
export function readWriterHistory(home:string,input:WriterHistoryBinding,options:{allowPending?:boolean}={}):WriterHistoryRead {
  return safe(()=>snapshot(home,binding(input),options.allowPending===true).result);
}
function proof(p:Paths,opts:WriterHistoryOptions):void {
  assertMutationHandle(opts.mutation,p.home);opts.assertCurrent();assertMutationHandle(opts.mutation,p.home);
  for(const [dir,stat]of p.dirs)if(identity(checkedDir(dir))!==identity(stat))fail("changed");
}
function syncDir(p:Paths,dir:string,opts:WriterHistoryOptions):void {
  proof(p,opts);const stat=checkedDir(dir),fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{if(identity(fstatSync(fd,{bigint:true}))!==identity(stat))fail("changed");proof(p,opts);fsyncSync(fd);}finally{closeSync(fd);}proof(p,opts);
}
function complete(p:Paths,file:string,full:Buffer,max:number,opts:WriterHistoryOptions,written:WriterHistoryPhase,synced:WriterHistoryPhase,start?:{at:number;phase:WriterHistoryPhase}):void {
  if(full.length>max)fail("bound");proof(p,opts);const prior=read(file,max);if(prior&&(prior.bytes.length>full.length||!prior.bytes.equals(full.subarray(0,prior.bytes.length))))fail();
  let installed:BigIntStats;
  const fd=openSync(file,constants.O_WRONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(prior?0:constants.O_CREAT|constants.O_EXCL),0o600);
  try{
    const opened=fstatSync(fd,{bigint:true});owned(opened);if(prior?stamp(opened)!==stamp(prior.stat):opened.size!==0n)fail("changed");
    let observed=opened;proof(p,opts);let at=prior?.bytes.length??0;
    while(at<full.length){proof(p,opts);if(stamp(fstatSync(fd,{bigint:true}))!==stamp(observed)||stamp(lstatSync(file,{bigint:true}))!==stamp(observed))fail("changed");const firstByte=start!==undefined&&at===start.at;const n=writeSync(fd,full,at,firstByte?1:full.length-at,at);if(n<=0)fail();at+=n;observed=fstatSync(fd,{bigint:true});if(firstByte)opts.phase?.(start!.phase);}
    opts.phase?.(written);proof(p,opts);const after=fstatSync(fd,{bigint:true});if(stamp(after)!==stamp(observed)||after.size!==BigInt(full.length)||stamp(lstatSync(file,{bigint:true}))!==stamp(after))fail("changed");fsyncSync(fd);installed=fstatSync(fd,{bigint:true});opts.phase?.(synced);
    if(stamp(lstatSync(file,{bigint:true}))!==stamp(installed))fail("changed");
  }finally{closeSync(fd);}syncDir(p,dirname(file),opts);proof(p,opts);if(stamp(lstatSync(file,{bigint:true}))!==stamp(installed!))fail("changed");
}
function checkedIntent(home:string,value:WriterRenewalIntent,opts:WriterHistoryOptions):{intent:WriterRenewalIntent;snapshot:Snapshot}{
  const intent=validateWriterRenewalIntent(value),b=intentBinding(intent),p=paths(home,b);proof(p,opts);
  const read=snapshot(home,b,true,intent);if(!read.intentBytes)fail("pending");return{intent,snapshot:read};
}
export function writeWriterRenewalIntent(home:string,value:WriterRenewalIntent,opts:WriterHistoryOptions):void {
  safe(()=>{
    const intent=validateWriterRenewalIntent(value),b=intentBinding(intent),p=paths(home,b);if(intent.home!==p.home)fail();
    if(intent.previousLogBytes+encode(intent.commit).length>WRITER_COMMIT_MAX_BYTES)fail("bound");proof(p,opts);
    const prior=readIntent(p,[],intent).file;
    const old=prior?snapshot(home,b,true,intent):snapshot(home,b,false);
    if(!prior&&(intent.revision.sequence!==old.result.sequence+1||intent.revision.previousHash!==old.result.headHash||intent.previousLogBytes!==old.result.logBytes||intent.previousLogHash!==old.result.logHash))fail("changed");
    old.result.assertCurrent();publishIntent(p,intent,opts);snapshot(home,b,true).result.assertCurrent();opts.phase?.("intent-published");
  });
}
export function writeWriterRevision(home:string,value:WriterRenewalIntent,opts:WriterHistoryOptions):void {
  safe(()=>{const {intent,snapshot:read}=checkedIntent(home,value,opts);read.result.assertCurrent();
    publishIntent(read.paths,intent,opts);
    complete(read.paths,join(read.paths.epoch,writerRevisionFile(intent.revision.sequence)),encode(intent.revision),WRITER_REVISION_MAX_BYTES,opts,"revision-written","revision-fsync");
    snapshot(home,intentBinding(intent),true).result.assertCurrent();});
}
export function appendWriterCommit(home:string,value:WriterRenewalIntent,opts:WriterHistoryOptions):void {
  safe(()=>{const {intent,snapshot:read}=checkedIntent(home,value,opts);read.result.assertCurrent();
    publishIntent(read.paths,intent,opts);
    complete(read.paths,join(read.paths.epoch,writerRevisionFile(intent.revision.sequence)),encode(intent.revision),WRITER_REVISION_MAX_BYTES,opts,"revision-written","revision-fsync");
    const prefix=read.log.subarray(0,intent.previousLogBytes),full=Buffer.concat([prefix,encode(intent.commit)]);
    complete(read.paths,read.paths.log,full,WRITER_COMMIT_MAX_BYTES,opts,"commit-written","commit-fsync",{at:intent.previousLogBytes,phase:"commit-started"});snapshot(home,intentBinding(intent),true).result.assertCurrent();});
}
export function clearWriterRenewalIntent(home:string,value:WriterRenewalIntent,opts:WriterHistoryOptions):void {
  safe(()=>{const intent=validateWriterRenewalIntent(value),p=paths(home,intentBinding(intent));proof(p,opts);
    const prior=readIntent(p,[],intent).file;
    if(prior){const read=snapshot(home,intentBinding(intent),true,intent);if(!prior.bytes.equals(encode(intent))||read.result.headHash!==intent.commit.seal||read.log.length!==intent.previousLogBytes+encode(intent.commit).length)fail("pending");
      appendWriterCommit(home,intent,opts);proof(p,opts);const now=readFileExpected(p.intent,encode(intent),WRITER_RENEWAL_INTENT_MAX_BYTES);proof(p,opts);if(stamp(lstatSync(p.intent,{bigint:true}))!==stamp(now.stat))fail("changed");unlinkSync(p.intent);opts.phase?.("intent-cleared");}
    else {const read=snapshot(home,intentBinding(intent),false);if(read.result.headHash!==intent.commit.seal)fail("changed");}
    syncDir(p,p.epoch,opts);syncDir(p,p.home,opts);proof(p,opts);snapshot(home,intentBinding(intent),false).result.assertCurrent();});
}
function readFileExpected(file:string,full:Buffer,max:number):FileRead {const value=read(file,max);if(!value||!value.bytes.equals(full))fail();return value;}
export function abandonWriterRenewal(home:string,value:WriterRenewalIntent,opts:WriterHistoryOptions):void {
  safe(()=>{const intent=validateWriterRenewalIntent(value),p=paths(home,intentBinding(intent));proof(p,opts);
    if(!readIntent(p,[],intent).file){
      const cleared=snapshot(home,intentBinding(intent),false);
      if(cleared.result.sequence!==intent.revision.sequence-1||cleared.result.headHash!==intent.revision.previousHash||cleared.result.logBytes!==intent.previousLogBytes||cleared.result.logHash!==intent.previousLogHash)fail("changed");
      cleared.result.assertCurrent();syncDir(p,p.epoch,opts);syncDir(p,p.home,opts);proof(p,opts);return;
    }
    const before=snapshot(home,intentBinding(intent),true,intent);
    if(before.result.appendStarted)fail("pending");
    const check=()=>{proof(p,opts);const current=snapshot(home,intentBinding(intent),true,intent);if(current.result.appendStarted||current.log.length!==intent.previousLogBytes||sha(current.log)!==intent.previousLogHash)fail("pending");};
    check();const candidate=join(p.epoch,writerRevisionFile(intent.revision.sequence)),prior=read(candidate,WRITER_REVISION_MAX_BYTES);
    if(prior){check();if(stamp(lstatSync(candidate,{bigint:true}))!==stamp(prior.stat))fail("changed");unlinkSync(candidate);syncDir(p,p.epoch,opts);}
    const log=read(p.log,WRITER_COMMIT_MAX_BYTES);if(intent.revision.sequence===1&&log){if(log.bytes.length)fail("pending");check();if(stamp(lstatSync(p.log,{bigint:true}))!==stamp(log.stat))fail("changed");unlinkSync(p.log);syncDir(p,p.epoch,opts);}
    // Reassert parent durability even when the prior owner removed a member before its fsync.
    syncDir(p,p.epoch,opts);check();const intentRead=readIntent(p,[],intent);if(!intentRead.file)fail("changed");
    if(intentRead.temp){check();unlinkSync(intentRead.temp);syncDir(p,p.home,opts);}
    const pending=read(p.intent,WRITER_RENEWAL_INTENT_MAX_BYTES);
    if(pending){proof(p,opts);if(!pending.bytes.equals(encode(intent))||stamp(lstatSync(p.intent,{bigint:true}))!==stamp(pending.stat))fail("changed");unlinkSync(p.intent);opts.phase?.("intent-cleared");}
    syncDir(p,p.home,opts);proof(p,opts);snapshot(home,intentBinding(intent),false).result.assertCurrent();
  });
}


/** Person coordinator only: discard unpublished atomic-intent staging, never a registered or committed renewal.
 * This purpose-specific reader exception is deliberately unavailable to ordinary history/resolver callers. */
export function abandonUnpublishedWriterStaging(home:string,input:WriterHistoryBinding,opts:WriterHistoryOptions&{assertCommittedHistory?(history:WriterHistoryRead):void}):{removed:number}{
  return safe(()=>{
    const b=binding(input),p=paths(home,b);proof(p,opts);
    if(lstatSync(p.intent,{throwIfNoEntry:false}))fail("pending");
    const before=snapshot(home,b,false,undefined,true);before.result.assertCurrent();
    const guarded:WriterHistoryOptions={...opts,assertCurrent(){opts.assertCurrent();opts.assertCommittedHistory?.(before.result);}};
    proof(p,guarded);
    const members=new Map<string,{stat:BigIntStats;hash:string}>();
    for(const name of intentTemps(p)){
      proof(p,guarded);const file=join(p.home,name),value=read(file,WRITER_RENEWAL_INTENT_MAX_BYTES);if(!value)fail("changed");
      members.set(name,{stat:value.stat,hash:sha(value.bytes)});
    }
    const check=()=>{
      proof(p,guarded);before.result.assertCurrent();
      if(lstatSync(p.intent,{throwIfNoEntry:false})||canonicalJSON(intentTemps(p))!==canonicalJSON([...members.keys()].sort()))fail("changed");
    };
    check();let removed=0;
    for(const [name,expected]of members){
      check();const file=join(p.home,name),value=read(file,WRITER_RENEWAL_INTENT_MAX_BYTES);
      if(!value||stamp(value.stat)!==stamp(expected.stat)||sha(value.bytes)!==expected.hash)fail("changed");
      check();if(stamp(lstatSync(file,{bigint:true}))!==stamp(expected.stat))fail("changed");
      unlinkSync(file);members.delete(name);removed++;syncDir(p,p.home,guarded);check();
    }
    // A previous owner may have unlinked the last stage before the directory fsync/acknowledgement.
    syncDir(p,p.epoch,guarded);syncDir(p,p.home,guarded);check();return{removed};
  });
}
