/** Immutable initial install locator only. Returned paths are never fresh compatibility or quiescence evidence. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { realPath } from "./platform.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementJournal } from "./sync-placement-journal-storage.ts";
import { writeImmutableActivationMetadata } from "./public-prune-activation.ts";
import { measureSyncPlacementWriters, SyncPlacementWriterError, type MeasuredSyncPlacementWriterRoot } from "./sync-placement-writers.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import type { SyncPlacementWriterAttestation } from "./sync-placement-plan.ts";

export const SYNC_PLACEMENT_WRITER_ROOTS_FILE="sync-placement-writer-roots.json";
export const SYNC_PLACEMENT_WRITER_ROOTS_SCHEMA="agent-mem.sync-placement-writer-roots/v1";
interface LocatorBody {
  schema:typeof SYNC_PLACEMENT_WRITER_ROOTS_SCHEMA;homeHash:string;epochHash:string;activationHash:string;
  roots:{root:string;writerId:string}[];
}
interface Locator extends LocatorBody {seal:string}
const MAX_BYTES=256*1024,MAX_ROOTS=256,MAX_PATH=4096;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const hex=(value:unknown):value is string=>typeof value==="string"&&value.length===64&&/^[a-f0-9]+$/.test(value);
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
function fail():never {throw new SyncPlacementWriterError("unavailable");}
function protectedCall<T>(work:()=>T):T {try{return work();}catch(error){
  if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SyncPlacementWriterError){const code=Object.getOwnPropertyDescriptor(error,"code");if(code&&"value"in code&&code.value==="bound")throw new SyncPlacementWriterError("bound");}
  return fail();
}}
function directory(home:string):BigIntStats {
  const s=lstatSync(home,{bigint:true});
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o777n)!==0o700n)fail();return s;
}
function fileState(file:string):BigIntStats {
  const s=lstatSync(file,{bigint:true});
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o777n)!==0o600n
    ||s.nlink!==1n&&s.nlink!==2n||s.size<1n||s.size>BigInt(MAX_BYTES))fail();return s;
}
function object(input:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!input||typeof input!=="object"||types.isProxy(input)||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.getOwnPropertySymbols(input).length)fail();
  const fields=Object.getOwnPropertyDescriptors(input);if(Object.keys(fields).sort().join()!==[...keys].sort().join())fail();
  const out:Record<string,unknown>=Object.create(null);
  for(const key of keys){const field=fields[key];if(!field||!("value"in field)||!field.enumerable)fail();out[key]=field.value;}return out;
}
function array(input:unknown):unknown[] {
  if(!input||typeof input!=="object"||types.isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||Object.getOwnPropertySymbols(input).length)fail();
  const fields=Object.getOwnPropertyDescriptors(input),length=Object.getOwnPropertyDescriptor(input,"length")?.value;
  if(!Number.isSafeInteger(length)||length<1||length>MAX_ROOTS||Object.keys(fields).length!==length+1)fail();
  const out:unknown[]=[];for(let i=0;i<length;i++){const field=fields[String(i)];if(!field||!("value"in field)||!field.enumerable)fail();out.push(field.value);}return out;
}
function validate(input:unknown):Locator {
  const value=object(input,["schema","homeHash","epochHash","activationHash","roots","seal"]);
  if(value.schema!==SYNC_PLACEMENT_WRITER_ROOTS_SCHEMA||!hex(value.homeHash)||!hex(value.epochHash)||!hex(value.activationHash)||!hex(value.seal)
    )fail();
  const roots:{root:string;writerId:string}[]=[],ids=new Set<string>();let prior="";
  for(const entry of array(value.roots)){
    const item=object(entry,["root","writerId"]);
    if(typeof item.root!=="string"||!isAbsolute(item.root)||resolve(item.root)!==item.root||Buffer.byteLength(item.root)>MAX_PATH||item.root.includes("\0")
      ||item.root<=prior||!hex(item.writerId)||ids.has(item.writerId))fail();
    roots.push({root:item.root,writerId:item.writerId});prior=item.root;ids.add(item.writerId);
  }
  const body:LocatorBody={schema:SYNC_PLACEMENT_WRITER_ROOTS_SCHEMA,homeHash:value.homeHash,epochHash:value.epochHash,activationHash:value.activationHash,roots};
  if(hashJSON(body)!==value.seal)fail();
  if(Buffer.byteLength(canonicalJSON(value)+"\n")>MAX_BYTES)throw new SyncPlacementWriterError("bound");
  return{...body,seal:value.seal};
}
function idSet(writers:readonly SyncPlacementWriterAttestation[]):string[] {
  const copy=memoryPolicySnapshot(writers);if(!Array.isArray(copy)||copy.length<1||copy.length>MAX_ROOTS)fail();
  const ids=copy.map(writer=>{if(!writer||typeof writer!=="object"||!hex(writer.writerId))fail();return writer.writerId;}).sort();
  if(new Set(ids).size!==ids.length)fail();return ids;
}
function bind(value:Locator,expected:{homeHash:string;epochHash:string;activationHash:string},writers:readonly SyncPlacementWriterAttestation[]):void {
  if(value.homeHash!==expected.homeHash||value.epochHash!==expected.epochHash||value.activationHash!==expected.activationHash
    ||canonicalJSON(value.roots.map(root=>root.writerId).sort())!==canonicalJSON(idSet(writers)))fail();
}
function readOwned(file:string):{text:string;check():void} {
  const before=fileState(file),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))fail();
    const data=Buffer.alloc(Number(before.size)+1);let at=0;
    while(at<data.length){const count=readSync(fd,data,at,data.length-at,at);if(!count)break;at+=count;}
    if(at!==Number(before.size)||stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(fileState(file))!==stamp(before))fail();
    const text=new TextDecoder("utf-8",{fatal:true}).decode(data.subarray(0,at)),companion=`${file}.pending-${hash(text)}`;
    const paired=lstatSync(companion,{bigint:true,throwIfNoEntry:false});
    if(before.nlink===2n){const peer=fileState(companion);if(peer.dev!==before.dev||peer.ino!==before.ino||stamp(peer)!==stamp(before))fail();}
    else if(paired)fail();
    return{text,check(){if(stamp(fileState(file))!==stamp(before))fail();
      const now=lstatSync(companion,{bigint:true,throwIfNoEntry:false});
      if(paired? !now||stamp(fileState(companion))!==stamp(paired):!!now)fail();}};
  }finally{closeSync(fd);}
}
export interface SyncPlacementWriterRootsInput {epochHash:string;homeHash:string;activationHash:string;roots:readonly MeasuredSyncPlacementWriterRoot[]}
export interface SyncPlacementWriterRootsBinding {homeHash:string;epochHash:string;activationHash:string;writers:readonly SyncPlacementWriterAttestation[]}
function copiedInput(input:SyncPlacementWriterRootsInput) {
  const copied=object(input,["epochHash","homeHash","activationHash","roots"]);
  if(!hex(copied.epochHash)||!hex(copied.homeHash)||!hex(copied.activationHash))fail();
  const roots=array(copied.roots).map(value=>{
    const root=object(value,["root","writerId","version","pin"]);
    if(typeof root.root!=="string"||typeof root.version!=="string"||!hex(root.writerId)||!hex(root.pin))fail();
    return{root:root.root,writerId:root.writerId,version:root.version,pin:root.pin};
  }).sort((a,b)=>a.root<b.root?-1:a.root>b.root?1:0);
  return{homeHash:copied.homeHash,epochHash:copied.epochHash,activationHash:copied.activationHash,roots};
}
/** Pure initial-locator data plan. It proves framing/binding/bounds only, never fresh install bytes or permission. */
export function planSyncPlacementWriterRoots(input:SyncPlacementWriterRootsInput,binding:SyncPlacementWriterRootsBinding):Locator {
  return protectedCall(()=>{
    const copied=copiedInput(input),expected=object(binding,["homeHash","epochHash","activationHash","writers"]);
    if(!hex(expected.homeHash)||!hex(expected.epochHash)||!hex(expected.activationHash))fail();
    const writers=memoryPolicySnapshot(expected.writers) as readonly SyncPlacementWriterAttestation[]|undefined;if(!writers)fail();idSet(writers);
    const proposed=copied.roots.map(({writerId,version,pin})=>({writerId,version,pin,publicationFormat:PLACEMENT_FORMAT,compatible:true})).sort((a,b)=>a.writerId.localeCompare(b.writerId));
    if(canonicalJSON(proposed)!==canonicalJSON([...writers].sort((a,b)=>a.writerId.localeCompare(b.writerId))))fail();
    const body:LocatorBody={schema:SYNC_PLACEMENT_WRITER_ROOTS_SCHEMA,homeHash:copied.homeHash,epochHash:copied.epochHash,activationHash:copied.activationHash,
      roots:copied.roots.map(({root,writerId})=>({root,writerId}))};
    const value=validate({...body,seal:hashJSON(body)});
    bind(value,{homeHash:expected.homeHash,epochHash:expected.epochHash,activationHash:expected.activationHash},writers);return value;
  });
}
export interface SyncPlacementWriterRootsWriteOptions {mutation:MutationHandle;assertCurrent():void}
/** Called only under activation's live fences. Initial bytes are immutable; renewal belongs to its own reviewed protocol. */
export function writeSyncPlacementWriterRoots(homeInput:string,input:SyncPlacementWriterRootsInput,expectedWriters:readonly SyncPlacementWriterAttestation[],options:SyncPlacementWriterRootsWriteOptions):void {
  protectedCall(()=>{
    const home=realPath(homeInput),before=directory(home);assertMutationHandle(options.mutation,home);options.assertCurrent();
    const copied=copiedInput(input),roots=copied.roots;
    const measured=measureSyncPlacementWriters(roots.map(root=>root.root));
    if(canonicalJSON(measured.roots)!==canonicalJSON(roots.sort((a,b)=>a.root<b.root?-1:a.root>b.root?1:0)))fail();
    const journal=readPlacementJournal(home,copied.epochHash),expected=memoryPolicySnapshot(expectedWriters);
    if(!expected||!Array.isArray(expected))fail();idSet(expected);
    const sorted=(writers:readonly SyncPlacementWriterAttestation[])=>[...writers].sort((a,b)=>a.writerId.localeCompare(b.writerId));
    if(canonicalJSON(sorted(measured.writers))!==canonicalJSON(sorted(expected))||canonicalJSON(sorted(measured.writers))!==canonicalJSON(sorted(journal.activation.writers)))fail();
    const value=planSyncPlacementWriterRoots({...copied,roots:measured.roots},{homeHash:journal.epoch.homeHash,epochHash:hashJSON(journal.epoch),activationHash:journal.activation.seal,writers:journal.activation.writers});
    if(canonicalJSON(idSet(expected))!==canonicalJSON(idSet(journal.activation.writers)))fail();
    assertMutationHandle(options.mutation,home);options.assertCurrent();
    const file=join(home,SYNC_PLACEMENT_WRITER_ROOTS_FILE),text=canonicalJSON(value)+"\n";
    const existing=lstatSync(file,{throwIfNoEntry:false});if(existing){const read=readOwned(file);if(read.text!==text)fail();read.check();}
    // The shared writer reads a crash-left orphan before its own content check. Bound that read here,
    // after the final caller proof; only its exact deterministic staging name can be resumed.
    const staging=lstatSync(`${file}.pending-${hash(text)}`,{bigint:true,throwIfNoEntry:false});
    if(staging){
      if(!staging.isFile()||staging.isSymbolicLink()||staging.uid!==BigInt(process.getuid?.()??-1)||(staging.mode&0o777n)!==0o600n||staging.size>BigInt(MAX_BYTES))fail();
      if(existing){const final=fileState(file);if(final.nlink!==2n||staging.nlink!==2n||stamp(staging)!==stamp(final))fail();}
      else if(staging.nlink!==1n)fail();
    }
    writeImmutableActivationMetadata(file,text);
    assertMutationHandle(options.mutation,home);options.assertCurrent();
    const after=directory(home);if(after.dev!==before.dev||after.ino!==before.ino)fail();
    const read=readOwned(file);if(read.text!==text)fail();read.check();
  });
}
/** Returns only initial locator paths; the caller must independently remeasure their actual bytes at each attestation. */
export function readSyncPlacementWriterRoots(homeInput:string):string[] {
  return protectedCall(()=>{
    const home=realPath(homeInput),before=directory(home);
    const active=()=>{const markers=readPlacementRuntimeMarkers(home),value=readActivePlacementBinding(home,markers.profile,markers.shards);if(!value)fail();return value;};
    const initial=active(),read=readOwned(join(home,SYNC_PLACEMENT_WRITER_ROOTS_FILE)),value=validate(JSON.parse(read.text));
    if(canonicalJSON(value)+"\n"!==read.text)fail();
    bind(value,{homeHash:initial.epoch.homeHash,epochHash:initial.profile.placementHead,activationHash:initial.activation.seal},initial.activation.writers);
    const final=active();if(canonicalJSON(final)!==canonicalJSON(initial))fail();
    const after=directory(home);if(after.dev!==before.dev||after.ino!==before.ino)fail();read.check();
    return value.roots.map(root=>root.root);
  });
}
