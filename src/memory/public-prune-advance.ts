/** Already-v2 monotone commit. Native rows stay unchanged; readers apply the proved growing mask on rebind. */
import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { canonicalJSON, fsyncDirectory, hashJSON, readSelector, withProfileLock } from "./generation.ts";
import { aliasLogPath, shardDir, userShardDir, resolveShardProfile, SHARDED_V2_FIELDS } from "./shard.ts";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { createPublicPruneReplayCache, type PublicPruneProjection } from "./public-prune-inputs.ts";
import { PUBLIC_PRUNE_INTENT, publicPruneViewHash, readPublicPruneViewForActivation, validatePublicPruneView, type PublicPruneViewV1 } from "./public-prune-view.ts";
import { realPath } from "./platform.ts";

export type PublicPruneAdvanceStage = "after-intent" | "after-shards" | "after-profile" | "after-remove";
export interface PublicPruneAdvanceOptions {
  memoryDir: string; view: PublicPruneViewV1; expectedRevision: string; mutations?: readonly MutationHandle[];
  checkpoint?: (stage: PublicPruneAdvanceStage) => void | Promise<void>;
}
export interface PublicPruneAdvanceResult { revision: string; viewHash: string }
interface Binding { key: string; dir: string; dev: number; ino: number; metadata: string }
interface AdvanceIntent {
  schema: "agent-mem.public-prune-advance/v1"; home: string; generation: string; expectedRevision: string;
  previousProfile: string; previousShards: string; finalProfile: string; finalShards: string; finalProfileHash: string; finalShardsHash: string;
  view: PublicPruneViewV1; bindings: Binding[]; root: { dev: number; ino: number; aliasesHash: string; machineHash: string };
}
const MAX = 1024 * 1024;
const fail = (): never => { throw new Error("public prune advance unavailable; resume the pending view operation"); };
function guard(ok: unknown): asserts ok { if (!ok) fail(); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v,key));
const hex = (v: unknown, size: number): v is string => typeof v === "string" && v.length === size && /^[a-f0-9]+$/.test(v);
function owned(file: string, directory = false, links = 1) {
  const stat = lstatSync(file); guard(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === links)
    && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0); return stat;
}
function raw(file: string, links = 1): string {
  const before = owned(file,false,links); guard(before.size > 0 && before.size <= MAX);
  const fd = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), afterFd = fstatSync(fd), after = owned(file,false,links);
    guard(opened.isFile() && opened.nlink === links && opened.uid === before.uid && (opened.mode & 0o077) === 0
      && afterFd.ino === opened.ino && afterFd.dev === opened.dev && afterFd.size === opened.size && afterFd.mtimeMs === opened.mtimeMs && afterFd.ctimeMs === opened.ctimeMs
      && opened.ino === before.ino && opened.dev === before.dev && after.ino === before.ino && after.dev === before.dev
      && bytes.length === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs);
    return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  } finally { closeSync(fd); }
}
const optional = (file: string) => lstatSync(file,{throwIfNoEntry:false}) ? {exists:true,bytes:raw(file)} : {exists:false};
function metadata(dir: string): string {
  return hashJSON(["project.json","generation.json","generation-seal.json","migration-sources.json","machine.json"].map(name=>[name,optional(join(dir,name))]));
}
function realmDir(home: string, key: string): string { return key === "user" ? userShardDir(home) : key.startsWith("project:") ? shardDir(home,key.slice(8)) : fail(); }
function immutable(file: string, bytes: string): void {
  const base = dirname(file); if (!lstatSync(base,{throwIfNoEntry:false})) {mkdirSync(base,{mode:0o700});fsyncDirectory(dirname(base));} owned(base,true);
  const temp = file+".pending-"+createHash("sha256").update(bytes).digest("hex");
  if (lstatSync(file,{throwIfNoEntry:false})) {
    const stat = lstatSync(file);
    if (stat.nlink === 2) { const pending = owned(temp,false,2); owned(file,false,2); guard(pending.ino === stat.ino && pending.dev === stat.dev && raw(file,2) === bytes); unlinkSync(temp);fsyncDirectory(base); }
    guard(raw(file) === bytes);return;
  }
  if (lstatSync(temp,{throwIfNoEntry:false})) { const staged=owned(temp); guard(staged.size<=MAX); if (!readFileSync(temp).equals(Buffer.from(bytes))) {unlinkSync(temp);fsyncDirectory(base);} }
  if (!lstatSync(temp,{throwIfNoEntry:false})) {const fd=openSync(temp,"wx",0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
  const stagedFd=openSync(temp,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(stagedFd);}finally{closeSync(stagedFd);}
  linkSync(temp,file);fsyncDirectory(base);unlinkSync(temp);fsyncDirectory(base);
}
function replace(file: string, text: string): void {
  const temp=file+".advance.tmp";
  if (lstatSync(temp,{throwIfNoEntry:false})) {owned(temp);unlinkSync(temp);}
  const fd=openSync(temp,"wx",0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
  // Same exact bytes recorded in the durable intent, not a reparsed/re-authored payload.
  renameSync(temp,file);fsyncDirectory(dirname(file));
}
function checked(value: unknown, home: string): AdvanceIntent {
  guard(object(value) && exact(value,["schema","home","generation","expectedRevision","previousProfile","previousShards","finalProfile","finalShards","finalProfileHash","finalShardsHash","view","bindings","root"]));
  guard(value.schema === "agent-mem.public-prune-advance/v1" && value.home === home && hex(value.generation,32) && hex(value.expectedRevision,64));
  for(const key of ["previousProfile","previousShards","finalProfile","finalShards"])guard(typeof value[key] === "string");
  const previous=JSON.parse(value.previousProfile as string), oldShards=JSON.parse(value.previousShards as string), final=JSON.parse(value.finalProfile as string), shards=JSON.parse(value.finalShards as string), view=validatePublicPruneView(value.view);
  guard(object(previous) && exact(previous,["schema","kind","generation","foreignPruneFormat","pruneInputSetHash"]) && previous.kind === "generation" && hex(previous.pruneInputSetHash,64) && previous.schema === "agent-mem.profile/v2" && previous.generation === value.generation && previous.foreignPruneFormat === "agent-mem.public-prune-witness/v1" && hashJSON(previous) === value.expectedRevision);
  guard(object(final) && exact(final,["schema","kind","generation","foreignPruneFormat","pruneInputSetHash"]) && final.schema === previous.schema && final.kind === "generation" && final.generation === value.generation && final.foreignPruneFormat === previous.foreignPruneFormat && final.pruneInputSetHash === publicPruneViewHash(view));
  guard(view.receivingGeneration === value.generation && canonicalJSON(final)+"\n" === value.finalProfile && hashJSON(final) === value.finalProfileHash && hashJSON(shards) === value.finalShardsHash && canonicalJSON(shards)+"\n" === value.finalShards);
  guard(object(oldShards) && object(shards) && Object.keys(oldShards).every(key=>(SHARDED_V2_FIELDS as readonly string[]).includes(key)) && Object.keys(shards).every(key=>(SHARDED_V2_FIELDS as readonly string[]).includes(key)) && oldShards.phase === "active" && oldShards.generation === value.generation && oldShards.schema === "agent-mem.shards/v2" && oldShards.selectorRevision === value.expectedRevision && shards.selectorRevision === value.finalProfileHash);
  const {selectorRevision:_old,...a}=oldShards,{selectorRevision:_new,...b}=shards;guard(canonicalJSON(a)===canonicalJSON(b));
  guard(Array.isArray(value.bindings) && value.bindings.length <= 1024 && object(value.root) && exact(value.root,["dev","ino","aliasesHash","machineHash"]) && hex(value.root.aliasesHash,64) && hex(value.root.machineHash,64));
  let prior="";for(const item of value.bindings){guard(object(item)&&exact(item,["key","dir","dev","ino","metadata"])&&typeof item.key==="string"&&item.key>prior&&item.dir===realmDir(home,item.key)&&hex(item.metadata,64));prior=item.key;}
  guard(Buffer.byteLength(canonicalJSON(value))<=MAX);return {...value,view} as unknown as AdvanceIntent;
}
function proofs(intent: AdvanceIntent): (()=>void)[] {
  const previous=JSON.parse(intent.previousProfile),old=readPublicPruneViewForActivation(intent.home,previous.pruneInputSetHash,intent.generation);
  guard(Object.keys(old.realms).every(key=>Object.hasOwn(intent.view.realms,key)));
  const changed=Object.keys(intent.view.realms).filter(key=>old.realms[key]!==intent.view.realms[key]);
  guard(intent.bindings.length===changed.length&&intent.bindings.every(item=>changed.includes(item.key)));
  const checks:(()=>void)[]=[];
  for(const [key,set] of Object.entries(intent.view.realms)){
    if(old.realms[key]===set)continue;
    const binding=intent.bindings.find(item=>item.key===key);guard(binding);
    const load=createPublicPruneReplayCache({dir:binding.dir,realm:key==="user"?{scope:"user"}:{scope:"project",key:key.slice(8)},receivingGeneration:intent.generation,inputSetHash:set});
    const check=()=>{const proof:PublicPruneProjection=load();guard(old.realms[key]===undefined||proof.commitments.includes(old.realms[key]!));};check();checks.push(check);
  }
  return checks;
}
function run(intent: AdvanceIntent, provided: readonly MutationHandle[]|undefined, checkpoint?: PublicPruneAdvanceOptions["checkpoint"]): Promise<PublicPruneAdvanceResult> {
  const checks=proofs(intent), releases:MutationHandle[]=[];
  const work=()=>{
    const dirs=[intent.home,...intent.bindings.map(item=>item.dir)].sort();
    const handles=provided??dirs.map(dir=>{const lease=acquireMutation(dir);guard(lease);releases.push(lease);return lease;});
    const verify=()=>{
      const root=owned(intent.home,true);guard(root.dev===intent.root.dev&&root.ino===intent.root.ino&&hashJSON(optional(aliasLogPath(intent.home)))===intent.root.aliasesHash&&hashJSON(raw(join(intent.home,"machine.json")))===intent.root.machineHash);
      for(const dir of dirs){let found=false;for(const handle of handles){try{assertMutationHandle(handle,dir);found=true;break;}catch{}}guard(found);}
      for(const item of intent.bindings){const stat=owned(item.dir,true);guard(stat.dev===item.dev&&stat.ino===item.ino&&metadata(item.dir)===item.metadata);}
      for(const check of checks)check();
    };
    const stages=function*():Generator<PublicPruneAdvanceStage,PublicPruneAdvanceResult>{
      verify();let profile=raw(join(intent.home,"profile.json")),shards=raw(join(intent.home,"shards.json"));
      guard((profile===intent.previousProfile||profile===intent.finalProfile)&&(shards===intent.previousShards||shards===intent.finalShards)&&!(profile===intent.finalProfile&&shards!==intent.finalShards));
      const viewHash=publicPruneViewHash(intent.view),file=join(intent.home,PUBLIC_PRUNE_INTENT),text=canonicalJSON(intent)+"\n";
      if(profile===intent.finalProfile&&shards===intent.finalShards&&!lstatSync(file,{throwIfNoEntry:false}))return{revision:intent.finalProfileHash,viewHash};
      immutable(join(intent.home,"public-prune-input-sets",viewHash+".json"),canonicalJSON(intent.view)+"\n");
      // Recovery evidence only: pending native transport plans retain their exact original selector binding.
      immutable(join(intent.home,"public-prune-selector-history",intent.expectedRevision+".json"),canonicalJSON(JSON.parse(intent.previousProfile))+"\n");
      immutable(file,text);yield "after-intent";verify();guard(raw(file)===text&&raw(join(intent.home,"profile.json"))===profile&&raw(join(intent.home,"shards.json"))===shards);
      if(shards!==intent.finalShards)replace(join(intent.home,"shards.json"),intent.finalShards);shards=intent.finalShards;
      yield "after-shards";verify();guard(raw(file)===text&&raw(join(intent.home,"profile.json"))===profile&&raw(join(intent.home,"shards.json"))===shards);
      if(profile!==intent.finalProfile)replace(join(intent.home,"profile.json"),intent.finalProfile);profile=intent.finalProfile;
      yield "after-profile";verify();guard(raw(file)===text&&raw(join(intent.home,"profile.json"))===profile&&raw(join(intent.home,"shards.json"))===shards);
      unlinkSync(file);fsyncDirectory(intent.home);yield "after-remove";verify();
      return{revision:intent.finalProfileHash,viewHash};
    };
    if(checkpoint)return(async()=>{const iterator=stages();for(;;){const next=iterator.next();if(next.done)return next.value;await checkpoint(next.value);}})();
    const iterator=stages();for(;;){const next=iterator.next();if(next.done)return next.value;}
  };
  return withProfileLock(intent.home,work).finally(()=>{for(const release of releases.reverse())release();});
}
export async function advancePublicPruneView(options: PublicPruneAdvanceOptions):Promise<PublicPruneAdvanceResult>{
  const home=realPath(options.memoryDir),root=owned(home,true),selection=readSelector(home),profile=selection.selector;
  guard(profile?.schema==="agent-mem.profile/v2"&&selection.revision===options.expectedRevision);
  const view=validatePublicPruneView(options.view);guard(view.receivingGeneration===profile.generation);
  const previousProfile=raw(join(home,"profile.json")),previousShards=raw(join(home,"shards.json")),old=readPublicPruneViewForActivation(home,profile.pruneInputSetHash,profile.generation);
  const bindings:Binding[]=[];
  for(const key of Object.keys(view.realms).sort())if(old.realms[key]!==view.realms[key]){
    const bound=resolveShardProfile(home,key==="user"?{user:true}:{project:key.slice(8)}),stat=owned(bound.dir,true);
    bindings.push({key,dir:bound.dir,dev:stat.dev,ino:stat.ino,metadata:metadata(bound.dir)});
  }
  const final={...profile,pruneInputSetHash:publicPruneViewHash(view)},shards={...JSON.parse(previousShards),selectorRevision:hashJSON(final)};
  const intent=checked({schema:"agent-mem.public-prune-advance/v1",home,generation:profile.generation,expectedRevision:options.expectedRevision,previousProfile,previousShards,
    finalProfile:canonicalJSON(final)+"\n",finalShards:canonicalJSON(shards)+"\n",finalProfileHash:hashJSON(final),finalShardsHash:hashJSON(shards),view,bindings,
    root:{dev:root.dev,ino:root.ino,aliasesHash:hashJSON(optional(aliasLogPath(home))),machineHash:hashJSON(raw(join(home,"machine.json")))}},home);
  return run(intent,options.mutations,options.checkpoint);
}
/** Explicit forward recovery only; ordinary reads never call this operation. */
export async function resumePublicPruneAdvance(memoryDir:string,checkpoint?:PublicPruneAdvanceOptions["checkpoint"]):Promise<PublicPruneAdvanceResult>{
  const home=realPath(memoryDir),file=join(home,PUBLIC_PRUNE_INTENT),stat=lstatSync(file),text=raw(file,stat.nlink);
  const intent=checked(JSON.parse(text),home);guard(text===canonicalJSON(intent)+"\n");return run(intent,undefined,checkpoint);
}
