import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { placementActivationFixture, activationOwnRoot } from "./fakes/sync-placement-activation.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";

const clean:(()=>void)[]=[];
afterEach(()=>{for(const close of clean.splice(0).reverse())close();});
type Fixture=ReturnType<typeof hookFixture>;
const note=(project:string)=>({op:"note" as const,project,scope:"project" as const,tier:"long" as const,kind:"finding" as const,peer:"person",source:"person" as const,
  text:"PRIVATE_STALE_LOCK_SOURCE, isolated authoritative original",about:[]});
function base(){const f=hookFixture();clean.push(f.close);const store=new MemoryStore({memoryDir:f.base,deferPromotions:true});try{store.note(note(f.project));}finally{store.close();}return f;}
function cli(f:Fixture,marked:boolean){
  const env={...f.env};for(const name of ["CLAUDECODE","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","PI_SESSION_ID","AGENTHUB_PEER_ID"])delete env[name];
  if(marked)env.AGENTHUB_PEER_ID="codex";
  const entry=resolve(import.meta.dir,"../src/cli.ts"),code=`import {runCli} from ${JSON.stringify(entry)};try{const out=await runCli(['search','PRIVATE_STALE_LOCK_SOURCE'],{cwd:${JSON.stringify(f.cwd)},env:process.env});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}`;
  return Bun.spawnSync([process.execPath,"-e",code],{cwd:f.cwd,env,stdout:"pipe",stderr:"pipe",timeout:20_000});
}
/** Preserve all source/marker/intent bytes, allowing only existing derived index/admission housekeeping. */
function authoritative(home:string):Record<string,string>{
  const result:Record<string,string>={};
  const visit=(relative:string)=>{
    const dir=join(home,relative);
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      const name=relative?`${relative}/${entry.name}`:entry.name,file=join(home,name);
      if(entry.isDirectory()){if(!["readers","shard-readers"].includes(entry.name))visit(name);continue;}
      if(/^(?:index[^/]*\.db|reader-admission\.db|mutation-lock\.db)(?:-(?:wal|shm|journal))?$/.test(entry.name))continue;
      if(!entry.isFile())throw Error("unexpected node in isolated profile fixture");
      result[name]=readFileSync(file).toString("base64");
    }
  };visit("");return result;
}
function lock(home:string){const file=join(home,"profile.lock"),s=lstatSync(file,{bigint:true});return{bytes:readFileSync(file).toString("base64"),dev:String(s.dev),ino:String(s.ino),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),mode:String(s.mode),nlink:String(s.nlink)};}
function extraRoot(f:Fixture){const dir=join(f.root,"new-writer");for(const part of [dir,join(dir,"src"),join(dir,"bin")])mkdirSync(part,{mode:0o755});
  writeFileSync(join(dir,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.22.0"}),{mode:0o644});
  writeFileSync(join(dir,"src/index.ts"),"// measured only\n",{mode:0o644});writeFileSync(join(dir,"bin/amem.js"),"// never executed\n",{mode:0o755});return dir;}
async function prepare(family:string):Promise<{f:Fixture;roots?:string[]}>{
  if(family==="shards")return{f:base()};
  if(family==="public-prune"){
    const f=base();await migrateShards({memoryDir:f.base,generation:"b".repeat(32),mode:"apply",authorizedPerson:true,tty:true});return{f};
  }
  const f=await placementActivationFixture();clean.push(f.close);
  if(family==="placement")return{f};
  await activateSyncPlacement(f.options("apply"));
  // The test acts as the person; migration diagnostics never edit floors.
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.22.0",since:"2026-11-06"}])+"\n",{mode:0o600});
  return{f,roots:[activationOwnRoot,extraRoot(f)]};
}
const cases=[
  {family:"shards",phase:"after-shard",label:"shard migration",command:"amem migrate --shards --resume"},
  {family:"public-prune",phase:"after-intent",label:"public-prune view",command:"amem migrate --public-prune-view --resume"},
  {family:"placement",phase:"after-intent",label:"sync-placement activation",command:"amem migrate --sync-placement --resume",abandon:true},
  {family:"renewal",phase:"intent-published",label:"writer-inventory renewal",command:"amem migrate --sync-placement --resume",abandon:true},
  {family:"renewal",phase:"revision-fsync",label:"writer-inventory renewal",command:"amem migrate --sync-placement --resume",abandon:true},
  {family:"renewal",phase:"intent-started",label:"writer-inventory renewal",command:"amem migrate --sync-placement --abandon",staging:true},
] as const;

for(const scenario of cases)test(`native killed ${scenario.label} (${scenario.phase}) gives the same person recovery diagnostic to marked and unmarked reads`,async()=>{
  const {f,roots}=await prepare(scenario.family);
  const child=Bun.spawnSync([process.execPath,join(import.meta.dir,"fakes/profile-migration-crash.ts"),f.base,activationOwnRoot,scenario.family,scenario.phase,...(roots?[JSON.stringify(roots)]:[])],
    {cwd:f.cwd,env:f.env,stdout:"pipe",stderr:"pipe",timeout:40_000});
  expect(child.signalCode,child.stderr.toString()).toBe("SIGKILL");expect(child.exitCode).not.toBe(0);
  expect(child.stdout.toString()).toContain(JSON.stringify({family:scenario.family,phase:scenario.phase}));
  expect(existsSync(join(f.base,"profile.lock"))).toBe(true);
  if(scenario.family==="shards")expect(JSON.parse(readFileSync(join(f.base,"shards.json"),"utf8")).phase).toBe("captured");
  const preserved=authoritative(f.base),held=lock(f.base),messages:string[]=[];
  for(const marked of [false,true]){
    const result=cli(f,marked);expect(result.exitCode).not.toBe(0);expect(result.stdout.length).toBe(0);
    const message=result.stderr.toString().trim();messages.push(message);
    expect(message).toContain("profile.lock");expect(message).toContain("person");expect(message).toContain(scenario.label);expect(message).toContain(scenario.command);
    if("abandon"in scenario)expect(message).toContain("--abandon");
    if("staging"in scenario){expect(message).toContain("amem migrate --sync-placement --dry-run");expect(message).not.toContain("--resume");}
    expect(message).not.toContain("PRIVATE_STALE_LOCK_SOURCE");expect(lock(f.base)).toEqual(held);expect(authoritative(f.base)).toEqual(preserved);
  }
  expect(messages[1]).toBe(messages[0]);

},120_000);

for(const split of [false,true])test(`CLI reads without a profile lock retain existing ${split?"shard":"shared-v1"} behavior`,async()=>{
  const f=base();
  if(split)await migrateShards({memoryDir:f.base,generation:"d".repeat(32),mode:"apply",authorizedPerson:true,tty:true});
  expect(existsSync(join(f.base,"profile.lock"))).toBe(false);
  const store=split?openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true}):new MemoryStore({memoryDir:f.base,deferPromotions:true});
  try{expect(store.list({project:f.project}).some(row=>row.text.includes("PRIVATE_STALE_LOCK_SOURCE"))).toBe(true);}finally{store.close();}
  for(const marked of [false,true]){const result=cli(f,marked);expect(result.exitCode,result.stderr.toString()).toBe(0);expect(result.stderr.toString()).not.toContain("profile.lock");}
  expect(existsSync(join(f.base,"profile.lock"))).toBe(false);
},30_000);
