import { afterEach, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileLockRefusal, profileLockRecoveryError, rememberProfileLockError, safeProfileLockMessage } from "../src/memory/profile-lock-diagnostic.ts";
import { readSelector } from "../src/memory/generation.ts";
import { placementSelectorRefusal, SyncPlacementRuntimeError } from "../src/memory/sync-placement-guard.ts";
import { readShardedSelection } from "../src/memory/shard.ts";
import { realPath } from "../src/memory/platform.ts";

const clean:string[]=[];afterEach(()=>{for(const dir of clean.splice(0))rmSync(dir,{recursive:true,force:true});});
const generation="a".repeat(32),hash="b".repeat(64);
function fixture(){const home=realPath(mkdtempSync(join(tmpdir(),"amem-profile-hint-")));clean.push(home);
  const write=(name:string,value:unknown)=>writeFileSync(join(home,name),JSON.stringify(value)+"\n",{mode:0o600});
  const lock=()=>write("profile.lock",{pid:process.pid,signature:hash,token:generation});
  return{home,write,lock};}
const pending={schema:"agent-mem.shards/v1",phase:"captured",generation,selectorRevision:"absent"};
function v3(f:ReturnType<typeof fixture>){f.write("profile.json",{schema:"agent-mem.profile/v3",generation,placementHead:hash});f.write("shards.json",{schema:"agent-mem.shards/v3",phase:"active",generation,placementHead:hash});}

test("a captured shard marker names resume without reclaiming its retained lock",()=>{
  const f=fixture();f.lock();f.write("shards.json",pending);const before=readFileSync(join(f.home,"profile.lock")),s=lstatSync(join(f.home,"profile.lock"));
  expect(profileLockRefusal(f.home)).toContain("amem migrate --shards --resume");expect(profileLockRefusal(f.home)).toContain("person shard migration");
  expect(readFileSync(join(f.home,"profile.lock"))).toEqual(before);expect(lstatSync(join(f.home,"profile.lock")).ino).toBe(s.ino);
});
for(const schema of ["agent-mem.public-prune-activation/v1","agent-mem.public-prune-advance/v1"])test("public-prune resume is named for "+schema,()=>{
  const f=fixture();f.lock();f.write("public-prune-view.intent.json",{schema,home:f.home,generation});
  expect(profileLockRefusal(f.home)).toContain("amem migrate --public-prune-view --resume");expect(profileLockRefusal(f.home)).not.toContain("--abandon");
});
test("activation and registered renewal retain their conditional person abandon semantics",()=>{
  const f=fixture();f.lock();f.write("sync-placement-activation.json",{schema:"agent-mem.sync-placement-activation/v1",home:f.home,epoch:{generation}});
  expect(profileLockRefusal(f.home)).toContain("sync-placement activation");expect(profileLockRefusal(f.home)).toContain("original v2 bytes");
  rmSync(join(f.home,"sync-placement-activation.json"));f.write("sync-placement-writer-renewal.json",{schema:"agent-mem.sync-placement-writer-renewal/v1",home:f.home,revision:{schema:"agent-mem.sync-placement-writer-revision/v1",generation,epochHash:hash}});
  expect(profileLockRefusal(f.home)).toContain("writer-inventory renewal");expect(profileLockRefusal(f.home)).toContain("amem migrate --sync-placement --resume");expect(profileLockRefusal(f.home)).toContain("before the first commit-log byte");
});
test("private partial renewal staging names abandon then a fresh dry-run without reading its body",()=>{
  const f=fixture();f.lock();v3(f);writeFileSync(join(f.home,"sync-placement-writer-renewal.json.pending-"+hash),"{",{mode:0o600});
  expect(profileLockRefusal(f.home)).toContain("unpublished intent staging");expect(profileLockRefusal(f.home)).toContain("amem migrate --sync-placement --abandon");expect(profileLockRefusal(f.home)).toContain("amem migrate --sync-placement --dry-run");expect(profileLockRefusal(f.home)).not.toContain("--resume");
});
test("no lock means the legacy selector and captured split refusals are unchanged",()=>{
  const f=fixture();f.write("profile.json",{schema:"unknown",text:"PRIVATE_METADATA"});
  expect(profileLockRefusal(f.home)).toBeUndefined();expect(placementSelectorRefusal(f.home)).toBeUndefined();expect(()=>readSelector(f.home)).toThrow("memory profile metadata unavailable or invalid");
  rmSync(join(f.home,"profile.json"));f.write("shards.json",pending);expect(()=>readShardedSelection(f.home)).toThrow("no active curated shard migration");
});
test("ambiguous retained intents and ordinary active markers do not invent a killed family",()=>{
  const f=fixture();f.lock();v3(f);expect(profileLockRefusal(f.home)).toBeUndefined();
  f.write("public-prune-view.intent.json",{schema:"agent-mem.public-prune-activation/v1",home:f.home,generation});
  f.write("sync-placement-activation.json",{schema:"agent-mem.sync-placement-activation/v1",home:f.home,epoch:{generation}});expect(profileLockRefusal(f.home)).toBeUndefined();
});
for(const kind of ["bad-owner","bad-json","wrong-home","oversize-marker","oversize-intent","linked-lock","linked-intent","symlink-lock","symlink-intent","wide-mode"] as const)test("unsafe or unidentifiable metadata stays generic: "+kind,()=>{
  const f=fixture();f.lock();f.write("shards.json",pending);
  const name="sync-placement-activation.json";
  if(kind==="bad-owner")f.write("profile.lock",{pid:process.pid,signature:hash.slice(1)+"\n",token:generation});
  if(kind==="bad-json")writeFileSync(join(f.home,name),"{",{mode:0o600});
  if(kind==="wrong-home")f.write(name,{schema:"agent-mem.sync-placement-activation/v1",home:"/different-home",epoch:{generation}});
  if(kind==="oversize-marker")writeFileSync(join(f.home,"profile.json")," ".repeat(262145),{mode:0o600});
  if(kind==="oversize-intent")writeFileSync(join(f.home,name)," ".repeat(1048577),{mode:0o600});
  if(kind==="linked-lock")linkSync(join(f.home,"profile.lock"),join(f.home,"other-lock"));
  if(kind==="linked-intent"){f.write(name,{});linkSync(join(f.home,name),join(f.home,"other-intent"));}
  if(kind==="symlink-lock"){rmSync(join(f.home,"profile.lock"));f.write("private-canary",{});symlinkSync(join(f.home,"private-canary"),join(f.home,"profile.lock"));}
  if(kind==="symlink-intent"){f.write("private-canary",{});symlinkSync(join(f.home,"private-canary"),join(f.home,name));}
  if(kind==="wide-mode")writeFileSync(join(f.home,name),"{}",{mode:0o644});
  expect(profileLockRefusal(f.home)).toBeUndefined();
});
test("noncanonical staging names and staging outside v3 do not identify renewal",()=>{
  const f=fixture();f.lock();v3(f);writeFileSync(join(f.home,"sync-placement-writer-renewal.json.pending-"+hash+"\n"),"{",{mode:0o600});
  expect(profileLockRefusal(f.home)).toBeUndefined();rmSync(join(f.home,"sync-placement-writer-renewal.json.pending-"+hash+"\n"));
  f.write("profile.json",{schema:"agent-mem.profile/v2"});writeFileSync(join(f.home,"sync-placement-writer-renewal.json.pending-"+hash),"{",{mode:0o600});expect(profileLockRefusal(f.home)).toBeUndefined();
});
test("expired selector waits enrich the refusal without starting a fresh wait",()=>{
  const f=fixture();f.lock();f.write("shards.json",pending);
  expect(()=>readSelector(f.home,Date.now()-1)).toThrow("amem migrate --shards --resume");
});
test("marked CLI exception recognises only fixed internal hints, never arbitrary caught error text",()=>{
  const f=fixture();f.lock();f.write("shards.json",pending);const error=profileLockRecoveryError(f.home)!;const expected=safeProfileLockMessage(error)!;
  let reads=0;Object.defineProperty(error,"message",{get(){reads++;throw Error("PRIVATE_CAUGHT_TEXT");}});
  expect(safeProfileLockMessage(error)).toBe(expected);expect(reads).toBe(0);expect(safeProfileLockMessage(new Error(expected))).toBeUndefined();
  const unsafe=new Error("PRIVATE_CAUGHT_TEXT");rememberProfileLockError(unsafe,"PRIVATE_CAUGHT_TEXT");expect(safeProfileLockMessage(unsafe)).toBeUndefined();
  const recognised=new SyncPlacementRuntimeError(expected);expect(safeProfileLockMessage(recognised)).toBe(expected);
  const proxy=new Proxy(error,{get(){throw Error("PRIVATE_PROXY");},getPrototypeOf(){throw Error("PRIVATE_PROXY");}});expect(safeProfileLockMessage(proxy)).toBeUndefined();
});
