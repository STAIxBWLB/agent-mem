import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { placementActivationFixture, activationOwnRoot } from "./fakes/sync-placement-activation.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { inspectionFilesystemSnapshot, createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { COMMANDS, commandHelp, parseCommand } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
function run(f:ReturnType<typeof hookFixture>,args:string[],agent=false){
  const env={...f.env};delete env.CLAUDECODE;if(agent)env.AGENTHUB_PEER_ID="codex";
  const source=`import {runCli} from ${JSON.stringify(cli)};try{const out=await runCli(${JSON.stringify(args)},{cwd:${JSON.stringify(f.cwd)},env:process.env});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}`;
  return Bun.spawnSync([process.execPath,"-e",source],{cwd:f.cwd,env,stdout:"pipe",stderr:"pipe",timeout:60_000});
}
/** Native visibility still runs. Only this fake-home command environment maps GitHub transport to local Git. */
function localCliRemote(f:ReturnType<typeof hookFixture>){
  const remote=createInspectionRemote(f.root),url="https://github.com/amem-fixture/sync-placement.git",bin=join(f.root,"fixture-bin");mkdirSync(bin,{mode:0o700});
  const git=Bun.which("git");if(!git)throw Error("fixture needs its native git binary");
  writeFileSync(join(bin,"gh"),'#!/usr/bin/env bun\nif(process.argv[2]!=="repo"||process.argv[3]!=="view")process.exit(2);console.log("PRIVATE");\n',{mode:0o700});
  const script=`#!/usr/bin/env bun\nconst args=process.argv.slice(2);const transport=args.some(x=>["fetch","push","ls-remote"].includes(x));const mapped=transport?args.map(x=>x==="origin"||x===${JSON.stringify(url)}?${JSON.stringify(remote)}:x):args;const p=Bun.spawnSync([${JSON.stringify(git)},...mapped],{stdout:"inherit",stderr:"inherit",stdin:"ignore",timeout:50000});process.exit(p.exitCode);\n`;
  writeFileSync(join(bin,"git"),script,{mode:0o700});f.env.PATH=bin+":"+f.env.PATH;return{remote,url};
}
function unregisteredWriter(f:ReturnType<typeof hookFixture>){
  const extra=join(f.root,"unregistered writer");for(const dir of [extra,join(extra,"src"),join(extra,"bin")])mkdirSync(dir,{mode:0o755});
  writeFileSync(join(extra,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}),{mode:0o644});
  writeFileSync(join(extra,"src","index.ts"),"// unregistered measured fixture, never executed\n",{mode:0o644});writeFileSync(join(extra,"bin","amem.js"),"// fixture\n",{mode:0o755});
  return extra;
}
function success(result:ReturnType<typeof run>){expect(result.exitCode,result.stderr.toString()).toBe(0);return JSON.parse(result.stdout.toString()) as Record<string,unknown>;}

test("shared parser/help/completions expose only migrate writer roots and forward-only activation",()=>{
  expect(parseCommand(["migrate","--sync-placement","--dry-run","--writer-root","/fixture/root"]).options["--sync-placement"]).toBe(true);
  expect(commandHelp(["migrate"])).toContain("--sync-placement");expect(COMMANDS.migrate?.options?.["--writer-root"]?.value).toBe("path");
  expect(COMMANDS.sync?.options?.["--writer-root"]).toBeUndefined();
  for(const shell of ["zsh","bash","fish"])expect(completionScript(shell)).toContain("--sync-placement");
});

for(const mode of ["--dry-run","--apply","--resume"])test("agent activation refuses before home access: "+mode,()=>{
  const f=hookFixture();cleanup.push(f.close);expect(existsSync(f.base)).toBe(false);
  const result=run(f,["migrate","--sync-placement",mode,"--json"],true);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("requires a person");expect(existsSync(f.base)).toBe(false);
});

for(const conflict of ["--shards","--public-prune-view","--deactivate","--generation"])test("migration families refuse before home access: "+conflict,()=>{
  const f=hookFixture();cleanup.push(f.close);
  const result=run(f,["migrate","--sync-placement",conflict,...(conflict==="--generation"?["a".repeat(32)]:[]),"--json"]);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("forward-only");expect(existsSync(f.base)).toBe(false);
});

test("person activation supports plain and cadence sync with an unreceipted writer; drift fails closed",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);
  const extra=unregisteredWriter(f);
  const args=["migrate","--sync-placement","--writer-root",activationOwnRoot,"--writer-root",extra,"--json"];
  const before=inspectionFilesystemSnapshot(f.base),preview=success(run(f,[...args,"--dry-run"]));
  expect(preview).toMatchObject({active:false,forwardOnly:true,source:{declined:1}});expect(JSON.stringify(preview)).not.toContain("NEVER_PUBLIC_ACTIVATION_BODY");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect(success(run(f,[...args,"--apply"])).active).toBe(true);
  const rootmap=JSON.parse(readFileSync(join(f.base,"sync-placement-writer-roots.json"),"utf8"));expect(rootmap.roots).toHaveLength(2);
  const {remote,url}=localCliRemote(f),sent=success(run(f,["sync","--remote",url,"--json"]));
  expect(sent.ok,JSON.stringify(sent)).toBe(true);expect(sent.placementPublication).toMatchObject({exported:1,withheld:1});expect(reachableInspectionRowIds(remote)).toEqual([f.allowed]);
  const cadence=success(run(f,["sync","--if-due","--force","--json"]));expect(cadence.ok).toBe(true);expect(cadence.skipped).toBeUndefined();
  const epoch=JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead;
  writeFileSync(join(extra,"src","index.ts"),"// changed unregistered writer\n",{mode:0o644});
  const blocked=run(f,["sync","--json"]);expect(blocked.exitCode).not.toBe(0);expect(blocked.stderr.toString()).toContain("an amem release that supports renewal");
  const drift=success(run(f,["migrate","--sync-placement","--dry-run","--json"]));expect(drift.active).toBe(true);expect((drift.writers as {matches:boolean}).matches).toBe(false);
  const preserved=inspectionFilesystemSnapshot(f.base),renew=run(f,["migrate","--sync-placement","--apply","--json"]);
  expect(renew.exitCode).not.toBe(0);expect(renew.stderr.toString()).toContain("supports renewal");expect(inspectionFilesystemSnapshot(f.base)).toEqual(preserved);
  expect(JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead).toBe(epoch);
},60_000);

test("missing prerequisites/floor and missing explicit CLI root refuse with next steps",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);
  unlinkSync(join(f.base,"formats.json"));let result=run(f,["migrate","--sync-placement","--dry-run","--json"]);
  expect(result.stderr.toString()).toContain("formats.json");expect(result.stderr.toString()).toContain("0.21.0");
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.21.0",since:"2026-11-06"}]),{mode:0o600});
  result=run(f,["migrate","--sync-placement","--apply","--json"]);expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("explicit complete --writer-root");
});


test("incomplete CLI or receipt writer inventory refuses before durable activation",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);const extra=unregisteredWriter(f);
  let before=inspectionFilesystemSnapshot(f.base),result=run(f,["migrate","--sync-placement","--apply","--writer-root",extra,"--json"]);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("running CLI");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  const setup=join(f.base,"setup");mkdirSync(setup,{mode:0o700});
  const image=(value:unknown)=>({mode:0o600,bytes:Buffer.from(JSON.stringify(value)).toString("base64")});
  const value={version:2,target:"claude",intent:"a".repeat(64),phase:"applied",changes:[0,1].map(index=>({key:`claude:${index}`,path:join(f.root,"home",index===0?".claude.json":"settings.json"),before:{mode:0o600,bytes:null},
    after:image(index===0?{mcpServers:{amem:{command:process.execPath,args:["--smol",join(extra,"bin","amem.js"),"mcp"]}}}:{})}))};
  writeFileSync(join(setup,"claude.json"),JSON.stringify(value),{mode:0o600});before=inspectionFilesystemSnapshot(f.base);
  result=run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"]);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("setup receipt");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
});

test("missing migration prerequisites name their exact next command and never migrate automatically",async()=>{
  const f=hookFixture();cleanup.push(f.close);const store=new MemoryStore({memoryDir:f.base,deferPromotions:true});
  try{store.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text:"migration prerequisite fixture",about:[]});}finally{store.close();}
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.21.0",since:"2026-11-06"}]),{mode:0o600});
  let before=inspectionFilesystemSnapshot(f.base),result=run(f,["migrate","--sync-placement","--dry-run","--json"]);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("amem migrate --shards --dry-run");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect((await migrateShards({memoryDir:f.base,generation:"b".repeat(32),mode:"apply",authorizedPerson:true,tty:true})).active).toBe(true);
  before=inspectionFilesystemSnapshot(f.base);result=run(f,["migrate","--sync-placement","--dry-run","--json"]);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("amem migrate --public-prune-view --dry-run");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
});
