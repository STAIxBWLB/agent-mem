/** Read-only install measurement. Pins are exact-byte facts, not person authority or host quiescence. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { types } from "node:util";
import { hashJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import type { SyncPlacementWriterAttestation } from "./sync-placement-plan.ts";

export interface MeasuredSyncPlacementWriterRoot { root: string; writerId: string; version: string; pin: string }
export interface SyncPlacementWriterMeasurement { roots: MeasuredSyncPlacementWriterRoot[]; writers: SyncPlacementWriterAttestation[] }
export type SyncPlacementWriterErrorCode = "invalid" | "unavailable" | "unsupported" | "bound" | "changed";
const causes: Record<SyncPlacementWriterErrorCode,string> = {
  invalid:"invalid or duplicate writer-root inventory",unavailable:"unreadable or unsafe writer-root runtime files",
  unsupported:"unsupported writer-root package identity or release",bound:"writer-root inventory exceeds its supported bound",changed:"writer-root changed during measurement",
};
export type SyncPlacementWriterFailureDetail = "below-minimum" | "wrong-package" | "writable-runtime" | "unreadable" | "invalid-version" | "invalid-inventory" | "unsafe-runtime" | "missing-runtime" | "bound" | "changed";
const details:Record<SyncPlacementWriterFailureDetail,string>={
  "below-minimum":"release is below 0.21.0", "wrong-package":"package is not @staix/agent-mem", "writable-runtime":"runtime code is group- or world-writable",
  unreadable:"runtime files are unreadable or missing", "invalid-version":"package version is not a supported plain release", "invalid-inventory":"root inventory is invalid or duplicated",
  "unsafe-runtime":"runtime files have unsafe types or symlinks", "missing-runtime":"required bin/amem.js or src/index.ts is missing",bound:"inventory exceeds a supported bound",changed:"install changed during measurement",
};
export class SyncPlacementWriterError extends Error {
  constructor(readonly code: SyncPlacementWriterErrorCode, readonly rootIndex?: number, readonly detail:SyncPlacementWriterFailureDetail=code==="unsupported"?"invalid-version":code==="invalid"?"invalid-inventory":code==="bound"?"bound":code==="changed"?"changed":"unreadable") {
    super(`Sync placement ${causes[code]} (${details[detail]}); upgrade or repair the amem install and its host exact pin, then rerun amem migrate --sync-placement --dry-run. For a managed writer, rerun amem setup <target> --apply after upgrading.`);
    this.name="SyncPlacementWriterError";
  }
}
/** Closed own data only: external error messages, accessors and proxies are never diagnostic authority. */
export function extractSyncPlacementWriterFailure(error:unknown):{code:SyncPlacementWriterErrorCode;detail:SyncPlacementWriterFailureDetail;rootIndex?:number}|undefined {
  try{
    if(!error||typeof error!=="object"||types.isProxy(error)||!(error instanceof SyncPlacementWriterError))return;
    const fields=Object.getOwnPropertyDescriptors(error),code=fields.code?.value,detail=fields.detail?.value,index=fields.rootIndex;
    if(typeof code!=="string"||!Object.hasOwn(causes,code)||typeof detail!=="string"||!Object.hasOwn(details,detail)
      ||index&&!("value"in index))return;
    const rootIndex=index?.value;if(rootIndex!==undefined&&(!Number.isSafeInteger(rootIndex)||rootIndex<0||rootIndex>=256))return;
    return{code:code as SyncPlacementWriterErrorCode,detail:detail as SyncPlacementWriterFailureDetail,...(rootIndex===undefined?{}:{rootIndex})};
  }catch{return;}
}
const MAX_ROOTS=256,MAX_FILES=4096,MAX_BYTES=64*1024*1024,MAX_PACKAGE=64*1024,MAX_PATH=4096,MAX_NODES=8192;
// ponytail: namespace traversal also caps 8192 entries and depth64; larger installs need a reviewed chunked inventory.
const RUNTIME=["src","bin","hooks",".claude-plugin"] as const;
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

/** Internal frozen-locator identity; callers validate canonical paths before treating it as a writer key. */
export function syncPlacementWriterId(root:string):string {return hashJSON(["agent-mem.sync-placement-writer/v1",root]);}

export function measureSyncPlacementWriters(input:readonly string[]):SyncPlacementWriterMeasurement {
  let index:number|undefined;
  function fail(code:SyncPlacementWriterErrorCode,detail?:SyncPlacementWriterFailureDetail):never {throw new SyncPlacementWriterError(code,index,detail);}
  if(!input||typeof input!=="object"||types.isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype
    ||input.length<1||Object.getOwnPropertySymbols(input).length)fail("invalid");
  if(input.length>MAX_ROOTS)fail("bound");
  const fields=Object.getOwnPropertyDescriptors(input);
  if(Object.keys(fields).length!==input.length+1)fail("invalid");
  const requested:string[]=[],seen=new Set<string>(),checks:(()=>void)[]=[],namespaces:(()=>void)[]=[],measured:MeasuredSyncPlacementWriterRoot[]=[];
  let files=0,bytes=0,nodes=0;
  const rememberCheck=(check:()=>void)=>{const rootIndex=index;checks.push(()=>{index=rootIndex;check();});};
  try {
    const node=(file:string,directory:boolean):BigIntStats=>{
      const s=lstatSync(file,{bigint:true});
      // Public installs may be readable by everyone and share Bun's hardlinked cache. Writeable code is unsafe.
      if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()))fail("unavailable","unsafe-runtime");
      if((s.mode&0o022n)!==0n)fail("unavailable","writable-runtime");
      return s;
    };
    for(index=0;index<input.length;index++){
      const field=fields[String(index)];if(!field||!("value"in field)||!field.enumerable)fail("invalid");
      const value:unknown=field.value;
      if(typeof value!=="string"||!isAbsolute(value)||Buffer.byteLength(value)>MAX_PATH||value.includes("\0"))fail("invalid");
      requested.push(value);
    }
    for(index=0;index<requested.length;index++){
      const requestedRoot=requested[index]!,root=realPath(requestedRoot);
      if(Buffer.byteLength(root)>MAX_PATH||seen.has(root))fail("invalid");seen.add(root);
      const rootStat=node(root,true),inventory:[string,string][]=[];
      rememberCheck(()=>{if(realPath(requestedRoot)!==root||stamp(node(root,true))!==stamp(rootStat))fail("changed");});
      const remember=(file:string,before:BigIntStats,directory:boolean)=>rememberCheck(()=>{if(stamp(node(file,directory))!==stamp(before))fail("changed");});
      const path=(relative:string)=>{if(Buffer.byteLength(relative)>MAX_PATH||Buffer.byteLength(join(root,relative))>MAX_PATH)fail("bound");return join(root,relative);};
      const read=(relative:string,maximum:number):Buffer=>{
        const file=path(relative),before=node(file,false);
        if(++files>MAX_FILES||before.size>BigInt(maximum)||before.size>BigInt(MAX_BYTES-bytes))fail("bound");
        const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
          if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))fail("changed");
          const data=Buffer.alloc(Number(before.size));let at=0;
          while(at<data.length){const count=readSync(fd,data,at,data.length-at,at);if(count<=0)fail("changed");at+=count;}
          if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(node(file,false))!==stamp(before))fail("changed");
          bytes+=data.length;inventory.push([relative,digest(data)]);remember(file,before,false);return data;
        }finally{closeSync(fd);}
      };
      const visit=(relative:string,depth=0)=>{
        if(depth>64)fail("bound");
        const file=path(relative),before=node(file,true),names:string[]=[];remember(file,before,true);
        const dir=opendirSync(file);
        try{for(;;){const entry=dir.readSync();if(!entry)break;if(++nodes>MAX_NODES)fail("bound");names.push(entry.name);}}finally{dir.closeSync();}
        if(stamp(node(file,true))!==stamp(before))fail("changed");
        const rootIndex=index;
        namespaces.push(()=>{
          index=rootIndex;const current:string[]=[],reader=opendirSync(file);
          try{for(;;){const entry=reader.readSync();if(!entry)break;if(current.length>=names.length)fail("changed");current.push(entry.name);}}finally{reader.closeSync();}
          if(JSON.stringify(current.sort())!==JSON.stringify(names))fail("changed");
        });
        for(const name of names.sort()){
          const child=`${relative}/${name}`,s=lstatSync(path(child),{bigint:true});
          if(s.isSymbolicLink())fail("unavailable","unsafe-runtime");
          if(s.isDirectory())visit(child,depth+1);else read(child,MAX_BYTES);
        }
      };
      const packageBytes=read("package.json",MAX_PACKAGE);let pkg:unknown;
      try{pkg=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(packageBytes));}catch(error){if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SyncPlacementWriterError)throw error;fail("unsupported");}
      const version=pkg&&typeof pkg==="object"&&!Array.isArray(pkg)?Object.getOwnPropertyDescriptor(pkg,"version")?.value:undefined;
      const name=pkg&&typeof pkg==="object"?Object.getOwnPropertyDescriptor(pkg,"name")?.value:undefined;
      const match=typeof version==="string"&&version.length<=64?/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version):null;
      if(name!=="@staix/agent-mem")fail("unsupported","wrong-package");
      if(!match||match[0]!==version)fail("unsupported","invalid-version");
      const parts=match.slice(1).map(Number);if(!parts.every(Number.isSafeInteger))fail("unsupported","invalid-version");
      if(parts[0]===0&&parts[1]!<21)fail("unsupported","below-minimum");
      for(const relative of RUNTIME){
        const file=path(relative),s=lstatSync(file,{bigint:true,throwIfNoEntry:false});
        if(s)visit(relative);else rememberCheck(()=>{if(lstatSync(file,{throwIfNoEntry:false}))fail("changed");});
      }
      if(!inventory.some(([file])=>file==="bin/amem.js")||!inventory.some(([file])=>file==="src/index.ts"))fail("unsupported","missing-runtime");
      inventory.sort(([a],[b])=>a<b?-1:a>b?1:0);
      measured.push({root,writerId:syncPlacementWriterId(root),version:version as string,pin:hashJSON(inventory)});
    }
    for(const check of checks)check();
    for(const check of namespaces)check();
    measured.sort((a,b)=>a.root<b.root?-1:a.root>b.root?1:0);
    const writers=measured.map<SyncPlacementWriterAttestation>(({writerId,version,pin})=>({writerId,version,pin,publicationFormat:PLACEMENT_FORMAT,compatible:true})).sort((a,b)=>a.writerId.localeCompare(b.writerId));
    return{roots:measured,writers};
  }catch(error){if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SyncPlacementWriterError)throw error;return fail("unavailable");}
}
