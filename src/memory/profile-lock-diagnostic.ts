/** Read-only error hints, never admission, recovery or proof that an owner is dead. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { realPath } from "./platform.ts";

const messages={
  shards:"An interrupted or still-running person shard migration retains profile.lock; have the person finish it or run amem migrate --shards --resume.",
  prune:"An interrupted or still-running person public-prune view migration retains profile.lock; have the person finish it or run amem migrate --public-prune-view --resume.",
  activation:"An interrupted or still-running person sync-placement activation retains profile.lock; have the person run amem migrate --sync-placement --resume, or amem migrate --sync-placement --abandon only while both markers retain their original v2 bytes.",
  renewal:"An interrupted or still-running person writer-inventory renewal retains profile.lock; have the person run amem migrate --sync-placement --resume, or amem migrate --sync-placement --abandon only before the first commit-log byte.",
  staging:"An interrupted or still-running person writer-inventory renewal retains profile.lock and unpublished intent staging; have the person run amem migrate --sync-placement --abandon, then amem migrate --sync-placement --dry-run before another apply.",
} as const;
type Family=keyof typeof messages;
const recognised=new WeakMap<object,string>();
/** A privacy-safe exception carries only one of our fixed messages, never a caught message or path. */
export function rememberProfileLockError(error:object,text:string):void {
  if((Object.values(messages) as readonly string[]).includes(text))recognised.set(error,text);
}
export function safeProfileLockMessage(error:unknown):string|undefined {
  return error!==null&&(typeof error==="object"||typeof error==="function")?recognised.get(error):undefined;
}
const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.mode===b.mode&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function owned(s:BigIntStats,limit:number,privateFile=true):void {
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid?.()??-1)||s.nlink!==1n||(s.mode&(privateFile?0o077n:0o022n))!==0n||s.size>BigInt(limit))throw Error();
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const hex=(v:unknown,width:number)=>typeof v==="string"&&v.length===width&&!/[^a-f0-9]/.test(v);
/** Only called after an existing refusal. Absent lock means no extra marker/intent read at all.
 * ponytail: fixed metadata limits plus20000 home names/256 staging files; a reviewed bounded descriptor inventory is needed to grow this hint. */
export function profileLockRefusal(home:string):string|undefined {
  try{
    const checks:(()=>void)[]=[];
    const read=(name:string,limit:number,privateFile=true):Record<string,unknown>|undefined=>{
      const file=join(home,name),before=lstatSync(file,{bigint:true,throwIfNoEntry:false});
      if(!before){checks.push(()=>{if(lstatSync(file,{throwIfNoEntry:false}))throw Error();});return;}
      owned(before,limit,privateFile);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const s=fstatSync(fd,{bigint:true});if(!same(before,s))throw Error();
        const bytes=Buffer.alloc(Number(s.size)+1);let count=0;
        while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
        if(count!==Number(s.size)||!same(s,fstatSync(fd,{bigint:true}))||!same(s,lstatSync(file,{bigint:true})))throw Error();
        const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,count)));if(!object(value))throw Error();
        checks.push(()=>{if(!same(s,lstatSync(file,{bigint:true})))throw Error();});return value;
      }finally{closeSync(fd);}
    };
    const owner=read("profile.lock",4096);if(!owner)return;
    if(Object.keys(owner).sort().join()!=="pid,signature,token"||!Number.isSafeInteger(owner.pid)||Number(owner.pid)<=0||!hex(owner.signature,64)||!hex(owner.token,32))return;
    const canonical=realPath(home),profile=read("profile.json",262144,false),shards=read("shards.json",262144,false);
    const prune=read("public-prune-view.intent.json",1048576),activation=read("sync-placement-activation.json",1048576),renewal=read("sync-placement-writer-renewal.json",1048576);
    const families=new Set<Family>();
    if(prune){if(prune.schema!=="agent-mem.public-prune-activation/v1"&&prune.schema!=="agent-mem.public-prune-advance/v1"||prune.home!==canonical||!hex(prune.generation,32))return;families.add("prune");}
    if(activation){if(activation.schema!=="agent-mem.sync-placement-activation/v1"||activation.home!==canonical||!object(activation.epoch)||!hex(activation.epoch.generation,32))return;families.add("activation");}
    if(renewal){if(renewal.schema!=="agent-mem.sync-placement-writer-renewal/v1"||renewal.home!==canonical||!object(renewal.revision)||renewal.revision.schema!=="agent-mem.sync-placement-writer-revision/v1"||!hex(renewal.revision.generation,32)||!hex(renewal.revision.epochHash,64))return;families.add("renewal");}
    if(shards?.schema==="agent-mem.shards/v1"&&shards.phase==="captured"&&hex(shards.generation,32))families.add("shards");
    if(!families.size&&profile?.schema==="agent-mem.profile/v3"&&shards?.schema==="agent-mem.shards/v3"&&shards.phase==="active"&&hex(profile.generation,32)&&shards.generation===profile.generation&&hex(profile.placementHead,64)&&profile.placementHead===shards.placementHead){
      const reader=opendirSync(home);let names=0,staging=0,nameBytes=0;
      try{for(;;){const entry=reader.readSync();if(!entry)break;if(++names>20000||(nameBytes+=Buffer.byteLength(entry.name))>8*1024*1024)throw Error();
        const prefix="sync-placement-writer-renewal.json.pending-";if(!entry.name.startsWith(prefix)||!hex(entry.name.slice(prefix.length),64))continue;
        if(++staging>256)throw Error();const file=join(home,entry.name),s=lstatSync(file,{bigint:true});owned(s,1048576);checks.push(()=>{if(!same(s,lstatSync(file,{bigint:true})))throw Error();});
      }}finally{reader.closeSync();}
      if(staging)families.add("staging");
    }
    for(const check of checks)check();if(families.size!==1)return;
    return messages[[...families][0]!];
  }catch{return undefined;}
}
export function profileLockRecoveryError(home:string):Error|undefined {
  const text=profileLockRefusal(home);if(!text)return;const error=new Error(text);error.name="ProfileLockMigrationError";rememberProfileLockError(error,text);return error;
}
