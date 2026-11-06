/** Pure same-epoch writer metadata codecs. Valid data and seals are neither person authority nor fresh install proof. */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { syncPlacementWriterId, type MeasuredSyncPlacementWriterRoot } from "./sync-placement-writers.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import type { SyncPlacementWriterAttestation } from "./sync-placement-plan.ts";

export const WRITER_REVISION_MAX_BYTES=512*1024;
export const WRITER_COMMIT_MAX_BYTES=64*1024;
export const WRITER_RENEWAL_INTENT_MAX_BYTES=1024*1024;
export const WRITER_REVISION_LIMIT=64;
export const WRITER_COMMIT_LOG="writer-revisions.jsonl";
export const WRITER_RENEWAL_INTENT_FILE="sync-placement-writer-renewal.json";
export const WRITER_REVISION_SCHEMA="agent-mem.sync-placement-writer-revision/v1";
export const WRITER_COMMIT_SCHEMA="agent-mem.sync-placement-writer-commit/v1";
export const WRITER_RENEWAL_INTENT_SCHEMA="agent-mem.sync-placement-writer-renewal/v1";

export type SharedWriterRevisionErrorCode="invalid"|"bound"|"changed"|"pending"|"cap";
const messages:Record<SharedWriterRevisionErrorCode,string>={
  invalid:"Writer renewal metadata is invalid or unsupported; have the person inspect the retained same-epoch inventory and rerun amem migrate --sync-placement --dry-run.",
  bound:"Writer renewal metadata exceeds its supported bound; retain the existing inventory and request a separately reviewed archival/checkpoint before retrying.",
  changed:"Writer renewal bindings changed; retain the existing inventory, inspect the same-epoch evidence and review a fresh dry-run before applying.",
  pending:"Writer renewal is pending; preserve its exact intent and have the person run amem migrate --sync-placement --resume.",
  cap:"Writer revision capacity is exhausted (remaining 0); retain this epoch and request a separately reviewed archival/checkpoint before another renewal.",
};
// ponytail: at most64 immutable writer revisions; only a separately reviewed archival/checkpoint can extend this history.
export class SharedWriterRevisionError extends Error {
  readonly remaining?:number;
  constructor(readonly code:SharedWriterRevisionErrorCode){
    const safe=typeof code==="string"&&Object.hasOwn(messages,code)?code:"invalid";
    super(messages[safe]);this.name="SharedWriterRevisionError";this.code=safe;if(safe==="cap")this.remaining=0;
  }
}
function fail(code:SharedWriterRevisionErrorCode="invalid"):never {throw new SharedWriterRevisionError(code);}
function safe<T>(run:()=>T):T {try{return run();}catch(error){
  if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SharedWriterRevisionError){
    const code=Object.getOwnPropertyDescriptor(error,"code");if(code&&"value"in code&&typeof code.value==="string"&&Object.hasOwn(messages,code.value))fail(code.value as SharedWriterRevisionErrorCode);
  }return fail();
}}
function object(input:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!input||typeof input!=="object"||types.isProxy(input)||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.getOwnPropertySymbols(input).length)fail();
  if(Object.getOwnPropertyNames(input).length!==keys.length)fail();const out:Record<string,unknown>=Object.create(null);
  for(const key of keys){const field=Object.getOwnPropertyDescriptor(input,key);if(!field||!("value"in field)||!field.enumerable)fail();out[key]=field.value;}return out;
}
function array(input:unknown,maximum:number):unknown[]{
  if(!input||typeof input!=="object"||types.isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||Object.getOwnPropertySymbols(input).length)fail();
  const length=Object.getOwnPropertyDescriptor(input,"length")?.value;
  if(!Number.isSafeInteger(length)||length<1||length>maximum)fail("bound");
  if(Object.getOwnPropertyNames(input).length!==length+1)fail();const out:unknown[]=[];
  for(let i=0;i<length;i++){const field=Object.getOwnPropertyDescriptor(input,String(i));if(!field||!("value"in field)||!field.enumerable)fail();out.push(field.value);}return out;
}
function hex(input:unknown,width=64):string {if(typeof input!=="string"||input.length!==width||!/^[a-f0-9]+$/.test(input))fail();return input;}
function integer(input:unknown,minimum:number,maximum:number):number {if(typeof input!=="number"||!Number.isSafeInteger(input)||input<minimum||input>maximum)fail();return input;}
function sequence(input:unknown):number {if(typeof input==="number"&&Number.isSafeInteger(input)&&input>WRITER_REVISION_LIMIT)fail("cap");return integer(input,1,WRITER_REVISION_LIMIT);}
function path(input:unknown):string {if(typeof input!=="string"||!isAbsolute(input)||resolve(input)!==input||input.includes("\0"))fail();if(Buffer.byteLength(input)>4096)fail("bound");return input;}
function version(input:unknown):string {
  if(typeof input!=="string"||input.length>64)fail();const match=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(input);
  if(!match||match[0]!==input)fail();const parts=match.slice(1).map(Number);
  if(!parts.every(Number.isSafeInteger)||parts[0]===0&&parts[1]!<22)fail();return input;
}
function bounded(value:unknown,maximum:number):void {if(Buffer.byteLength(canonicalJSON(value)+"\n")>maximum)fail("bound");}
function roots(input:unknown):MeasuredSyncPlacementWriterRoot[]{
  const out:MeasuredSyncPlacementWriterRoot[]=[],ids=new Set<string>();let previous="";
  for(const entry of array(input,256)){
    const value=object(entry,["root","writerId","version","pin"]),root=path(value.root),writerId=hex(value.writerId);
    if(root<=previous||ids.has(writerId)||writerId!==syncPlacementWriterId(root))fail();
    out.push({root,writerId,version:version(value.version),pin:hex(value.pin)});ids.add(writerId);previous=root;
  }return out;
}
export function writerRevisionFile(value:number):string {return `writer-revision-${String(sequence(value)).padStart(5,"0")}.json`;}
export function writerHistoryFileLimit(name:string):number|undefined {
  if(name===WRITER_COMMIT_LOG)return WRITER_COMMIT_MAX_BYTES;
  if(typeof name!=="string")return;const match=/^writer-revision-([0-9]{5})\.json$/.exec(name);
  if(!match||match[0]!==name)return;const n=Number(match[1]);return n>=1&&n<=WRITER_REVISION_LIMIT?WRITER_REVISION_MAX_BYTES:undefined;
}
export function writerInventoryGenesis(epochHash:string,activationHash:string):string {
  return hashJSON(["agent-mem.sync-placement-writer-genesis/v1",hex(epochHash),hex(activationHash)]);
}
export interface WriterRevisionBody {
  schema:typeof WRITER_REVISION_SCHEMA;epochHash:string;generation:string;homeHash:string;activationHash:string;initialLocatorHash:string;
  sequence:number;previousHash:string;journal:{sequence:number;headHash:string};roots:MeasuredSyncPlacementWriterRoot[];requestId:string;
}
export interface WriterRevision extends WriterRevisionBody {seal:string}
export interface WriterCommitBody {schema:typeof WRITER_COMMIT_SCHEMA;epochHash:string;sequence:number;previousHash:string;revisionHash:string}
export interface WriterCommit extends WriterCommitBody {seal:string}
export interface WriterRenewalIntentBody {schema:typeof WRITER_RENEWAL_INTENT_SCHEMA;home:string;revision:WriterRevision;commit:WriterCommit;previousLogBytes:number;previousLogHash:string}
export interface WriterRenewalIntent extends WriterRenewalIntentBody {seal:string}
function revision(input:unknown,sealed:boolean):WriterRevision {
  const v=object(input,["schema","epochHash","generation","homeHash","activationHash","initialLocatorHash","sequence","previousHash","journal","roots","requestId",...(sealed?["seal"]:[])]);
  if(v.schema!==WRITER_REVISION_SCHEMA)fail();const journal=object(v.journal,["sequence","headHash"]);
  const body:WriterRevisionBody={schema:WRITER_REVISION_SCHEMA,epochHash:hex(v.epochHash),generation:hex(v.generation,32),homeHash:hex(v.homeHash),activationHash:hex(v.activationHash),
    initialLocatorHash:hex(v.initialLocatorHash),sequence:sequence(v.sequence),previousHash:hex(v.previousHash),journal:{sequence:integer(journal.sequence,0,20000),headHash:hex(journal.headHash)},roots:roots(v.roots),requestId:hex(v.requestId)};
  if(body.sequence===1&&body.previousHash!==writerInventoryGenesis(body.epochHash,body.activationHash))fail();
  const value={...body,seal:hashJSON(body)};if(sealed&&hex(v.seal)!==value.seal)fail();bounded(value,WRITER_REVISION_MAX_BYTES);return value;
}
export function createWriterRevision(body:WriterRevisionBody):WriterRevision {return safe(()=>revision(body,false));}
export function validateWriterRevision(value:unknown):WriterRevision {return safe(()=>revision(value,true));}
export function writerRevisionWriters(input:WriterRevision):SyncPlacementWriterAttestation[]{
  return validateWriterRevision(input).roots.map(({writerId,version,pin})=>({writerId,version,pin,publicationFormat:PLACEMENT_FORMAT,compatible:true as const})).sort((a,b)=>a.writerId.localeCompare(b.writerId));
}
function commit(input:unknown,sealed:boolean):WriterCommit {
  const v=object(input,["schema","epochHash","sequence","previousHash","revisionHash",...(sealed?["seal"]:[])]);if(v.schema!==WRITER_COMMIT_SCHEMA)fail();
  const body:WriterCommitBody={schema:WRITER_COMMIT_SCHEMA,epochHash:hex(v.epochHash),sequence:sequence(v.sequence),previousHash:hex(v.previousHash),revisionHash:hex(v.revisionHash)};
  const value={...body,seal:hashJSON(body)};if(sealed&&hex(v.seal)!==value.seal)fail();bounded(value,WRITER_COMMIT_MAX_BYTES);return value;
}
export function createWriterCommit(input:WriterRevision):WriterCommit {
  const rev=validateWriterRevision(input);return safe(()=>commit({schema:WRITER_COMMIT_SCHEMA,epochHash:rev.epochHash,sequence:rev.sequence,previousHash:rev.previousHash,revisionHash:rev.seal},false));
}
export function validateWriterCommit(value:unknown):WriterCommit {return safe(()=>commit(value,true));}
function intent(input:unknown,sealed:boolean):WriterRenewalIntent {
  const v=object(input,["schema","home","revision","commit","previousLogBytes","previousLogHash",...(sealed?["seal"]:[])]);if(v.schema!==WRITER_RENEWAL_INTENT_SCHEMA)fail();
  const rev=validateWriterRevision(v.revision),ack=validateWriterCommit(v.commit),previousLogBytes=integer(v.previousLogBytes,0,WRITER_COMMIT_MAX_BYTES),previousLogHash=hex(v.previousLogHash);
  if(ack.epochHash!==rev.epochHash||ack.sequence!==rev.sequence||ack.previousHash!==rev.previousHash||ack.revisionHash!==rev.seal)fail();
  if(rev.sequence===1&&(previousLogBytes!==0||previousLogHash!==createHash("sha256").update("").digest("hex")))fail();
  const body:WriterRenewalIntentBody={schema:WRITER_RENEWAL_INTENT_SCHEMA,home:path(v.home),revision:rev,commit:ack,previousLogBytes,previousLogHash};
  const value={...body,seal:hashJSON(body)};if(sealed&&hex(v.seal)!==value.seal)fail();bounded(value,WRITER_RENEWAL_INTENT_MAX_BYTES);return value;
}
export function createWriterRenewalIntent(body:WriterRenewalIntentBody):WriterRenewalIntent {return safe(()=>intent(body,false));}
export function validateWriterRenewalIntent(value:unknown):WriterRenewalIntent {return safe(()=>intent(value,true));}
