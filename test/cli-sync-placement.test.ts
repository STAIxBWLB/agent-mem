import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { placementActivationFixture, activationOwnRoot } from "./fakes/sync-placement-activation.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { inspectionFilesystemSnapshot, createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { COMMANDS, commandHelp, parseCommand } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";
import { readSyncState, nextSyncAt, SYNC_BACKOFF_BASE_MS } from "../src/memory/sync-cadence.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { cadenceDiagnosticPrelude, collectCadenceCallDiagnostic, withCadenceFailureDiagnostics, type CadenceCallDiagnostic } from "./fakes/cadence-diagnostic.ts";

const cleanup:(()=>void)[]=[];
const diagnosticRoots=new Set<string>(), cadenceCalls:CadenceCallDiagnostic[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();diagnosticRoots.clear();cadenceCalls.length=0;});
const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
// #345: 60 s exceeds twice the observed 28.554 s hosted-macOS full sync.
// This functional e2e keeps 30 s child cleanup headroom; the product default stays 30 s.
const CADENCE_E2E_DEADLINE_MS=60_000, CADENCE_E2E_TIMEOUT_MS=240_000;
function run(f:ReturnType<typeof hookFixture>,args:string[],agent=false,syncDeadlineMs?:number){
  const env={...f.env};delete env.CLAUDECODE;if(agent)env.AGENTHUB_PEER_ID="codex";
  const diagnostic=diagnosticRoots.has(f.root), started=performance.now();
  const load=diagnostic?`${cadenceDiagnosticPrelude(f.env.HOME!)}const {runCli}=await import(${JSON.stringify(cli)});`:`import {runCli} from ${JSON.stringify(cli)};`;
  const report=diagnostic?`finally{const p=globalThis.__cadenceProbe;p.mark("cli-finished",{stops:p.signals.map(s=>({deadlineMs:s.deadlineMs,cause:s.cause()??null,aborted:s.signal.aborted}))});}`:"";
  const source=`${load}try{const out=await runCli(${JSON.stringify(args)},{cwd:${JSON.stringify(f.cwd)},env:process.env${syncDeadlineMs===undefined?"":`,syncDeadlineMs:${syncDeadlineMs}`}});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}${report}`;
  const result=Bun.spawnSync([process.execPath,"-e",source],{cwd:f.cwd,env,stdout:"pipe",stderr:"pipe",timeout:syncDeadlineMs===undefined?60_000:syncDeadlineMs+30_000});
  if(diagnostic)cadenceCalls.push(collectCadenceCallDiagnostic({call:cadenceCalls.length+1,command:args[0]??"unknown",ifDue:args.includes("--if-due"),force:args.includes("--force"),elapsedMs:performance.now()-started,exitCode:result.exitCode,signalCode:result.signalCode,stdout:result.stdout.toString(),stderr:result.stderr.toString()}));
  return result;
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
  writeFileSync(join(extra,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.22.0"}),{mode:0o644});
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

for(const mode of ["--dry-run","--apply","--resume","--abandon"])test("agent activation refuses before home access: "+mode,()=>{
  const f=hookFixture();cleanup.push(f.close);expect(existsSync(f.base)).toBe(false);
  const result=run(f,["migrate","--sync-placement",mode,"--json"],true);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("requires a person");expect(existsSync(f.base)).toBe(false);
});

for(const conflict of ["--shards","--public-prune-view","--deactivate","--generation"])test("migration families refuse before home access: "+conflict,()=>{
  const f=hookFixture();cleanup.push(f.close);
  const result=run(f,["migrate","--sync-placement",conflict,...(conflict==="--generation"?["a".repeat(32)]:[]),"--json"]);
  expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("forward-only");expect(existsSync(f.base)).toBe(false);
});

test("person activation supports plain and cadence sync with an unreceipted writer; drift fails closed",()=>withCadenceFailureDiagnostics(cadenceCalls,async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);
  diagnosticRoots.add(f.root);
  const extra=unregisteredWriter(f);
  const args=["migrate","--sync-placement","--writer-root",activationOwnRoot,"--writer-root",extra,"--json"];
  const before=inspectionFilesystemSnapshot(f.base),preview=success(run(f,[...args,"--dry-run"]));
  expect(preview).toMatchObject({active:false,forwardOnly:true,source:{declined:1}});expect(JSON.stringify(preview)).not.toContain("NEVER_PUBLIC_ACTIVATION_BODY");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect(success(run(f,[...args,"--apply"])).active).toBe(true);
  const rootmap=JSON.parse(readFileSync(join(f.base,"sync-placement-writer-roots.json"),"utf8"));expect(rootmap.roots).toHaveLength(2);
  const {remote,url}=localCliRemote(f),sent=success(run(f,["sync","--remote",url,"--json"]));
  expect(sent.ok,JSON.stringify(sent)).toBe(true);expect(sent.placementPublication).toMatchObject({exported:1,withheld:1});expect(reachableInspectionRowIds(remote)).toEqual([f.allowed]);
  const cadence=success(run(f,["sync","--if-due","--force","--json"],false,CADENCE_E2E_DEADLINE_MS));expect(cadence.ok).toBe(true);expect(cadence.skipped).toBeUndefined();
  const epoch=JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead;
  writeFileSync(join(extra,"src","index.ts"),"// changed unregistered writer\n",{mode:0o644});
  const blocked=run(f,["sync","--json"]);expect(blocked.exitCode).not.toBe(0);expect(blocked.stderr.toString()).toContain("amem migrate --sync-placement --dry-run");
  const failed=readSyncState(f.base);expect(failed.failures).toBe(1);
  expect(nextSyncAt(failed)!-Date.parse(failed.lastAttemptAt!)).toBe(SYNC_BACKOFF_BASE_MS);
  const deferred=success(run(f,["sync","--if-due","--json"]));expect(deferred).toMatchObject({skipped:"not due",failures:1});expect(readSyncState(f.base)).toEqual(failed);
  const forced=run(f,["sync","--if-due","--force","--json"]);expect(forced.exitCode).not.toBe(0);
  const repeated=readSyncState(f.base);expect(repeated.failures).toBe(2);expect(nextSyncAt(repeated)!-Date.parse(repeated.lastAttemptAt!)).toBe(2*SYNC_BACKOFF_BASE_MS);
  const drift=success(run(f,["migrate","--sync-placement","--dry-run","--json"]));expect(drift.active).toBe(true);expect((drift.writers as {matches:boolean}).matches).toBe(false);
  const preserved=inspectionFilesystemSnapshot(f.base),renew=run(f,["migrate","--sync-placement","--apply","--json"]);
  expect(renew.exitCode).not.toBe(0);expect(renew.stderr.toString()).toContain("home floor of 0.22.0");expect(inspectionFilesystemSnapshot(f.base)).toEqual(preserved);
  expect(JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead).toBe(epoch);
  const initialMap=readFileSync(join(f.base,"sync-placement-writer-roots.json")),fence=readFileSync(join(f.base,"sync-placement","active.json"));
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.22.0",since:"2026-11-06"}]),{mode:0o600});
  expect(success(run(f,[...args,"--apply"]))).toMatchObject({active:true,renewed:true,sequence:1});
  expect(success(run(f,["sync","--json"])).ok).toBe(true);
  const writer=openShardStore({memoryDir:f.base,project:f.project,deferPromotions:true});let fresh:string;
  try{fresh=writer.note({op:"note",project:f.project,scope:"project",tier:"long",kind:"finding",peer:"person",source:"person",text:"cadence publication after renewal",about:[]});}finally{writer.close();}
  expect(success(run(f,["sync","--if-due","--force","--json"],false,CADENCE_E2E_DEADLINE_MS)).ok).toBe(true);expect(reachableInspectionRowIds(remote)).toEqual([f.allowed,fresh!].sort());
  expect(cadenceCalls.filter(call=>call.ifDue&&call.outcome.ok===true&&call.outcome.skipped===null).map(call=>call.observedDeadlinesMs)).toEqual([[CADENCE_E2E_DEADLINE_MS],[CADENCE_E2E_DEADLINE_MS]]);
  expect(JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead).toBe(epoch);expect(readFileSync(join(f.base,"sync-placement-writer-roots.json"))).toEqual(initialMap);expect(readFileSync(join(f.base,"sync-placement","active.json"))).toEqual(fence);
}),CADENCE_E2E_TIMEOUT_MS); // Two 60 s cadence budgets, 90 s child envelopes, plus activation/plain sync and cleanup; functional, not R2 timing proof.

test("missing prerequisites/floor and missing explicit CLI root refuse with next steps",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);
  unlinkSync(join(f.base,"formats.json"));let result=run(f,["migrate","--sync-placement","--dry-run","--json"]);
  expect(result.stderr.toString()).toContain("formats.json");expect(result.stderr.toString()).toContain("0.21.0");
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.21.0",since:"2026-11-06"}]),{mode:0o600});
  result=run(f,["migrate","--sync-placement","--apply","--json"]);expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain("explicit complete --writer-root");
});

test("only a person can abandon a changed pre-marker attempt and reopen the ordinary home",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);
  const options=f.options("apply");options.checkpoint=stage=>{if(stage==="after-root-map")throw Error("interrupted initial apply");};
  await expect(activateSyncPlacement(options)).rejects.toThrow();
  writeFileSync(join(f.base,"amem.config.json"),JSON.stringify({piiPatterns:["NEVER_PUBLIC_","new restriction"]}),{mode:0o600});
  const resumed=run(f,["migrate","--sync-placement","--resume","--json"]);expect(resumed.exitCode).not.toBe(0);expect(resumed.stderr.toString()).toContain("frozen policy input");
  const before=inspectionFilesystemSnapshot(f.base),agent=run(f,["migrate","--sync-placement","--abandon","--json"],true);
  expect(agent.exitCode).not.toBe(0);expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect(success(run(f,["migrate","--sync-placement","--abandon","--json"]))).toMatchObject({active:false,abandoned:true});
  expect(run(f,["list","--json"]).exitCode).toBe(0);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"])).active).toBe(true);
  const active=inspectionFilesystemSnapshot(f.base),refused=run(f,["migrate","--sync-placement","--abandon","--json"]);
  expect(refused.exitCode).not.toBe(0);expect(inspectionFilesystemSnapshot(f.base)).toEqual(active);
},60_000);


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
