import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, readdirSync } from "node:fs";
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
import { resolveSetupPaths } from "../src/setup-paths.ts";
import { cadenceDiagnosticPrelude, collectCadenceCallDiagnostic, withCadenceFailureDiagnostics, type CadenceCallDiagnostic } from "./fakes/cadence-diagnostic.ts";

const cleanup:(()=>void)[]=[];
const diagnosticRoots=new Set<string>(), cadenceCalls:CadenceCallDiagnostic[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();diagnosticRoots.clear();cadenceCalls.length=0;});
const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
// #345: 60 s exceeds twice the observed 28.554 s hosted-macOS full sync.
// This functional e2e keeps 30 s child cleanup headroom; the product default stays 30 s.
const CADENCE_E2E_DEADLINE_MS=60_000, CADENCE_E2E_TIMEOUT_MS=240_000;
function run(f:ReturnType<typeof hookFixture>,args:string[],agent=false,syncDeadlineMs?:number,cwd=f.cwd){
  const env={...f.env};delete env.CLAUDECODE;if(agent)env.AGENTHUB_PEER_ID="codex";
  const diagnostic=diagnosticRoots.has(f.root), started=performance.now();
  const load=diagnostic?`${cadenceDiagnosticPrelude(f.env.HOME!)}const {runCli}=await import(${JSON.stringify(cli)});`:`import {runCli} from ${JSON.stringify(cli)};`;
  const report=diagnostic?`finally{const p=globalThis.__cadenceProbe;p.mark("cli-finished",{stops:p.signals.map(s=>({deadlineMs:s.deadlineMs,cause:s.cause()??null,aborted:s.signal.aborted}))});}`:"";
  const source=`${load}try{const out=await runCli(${JSON.stringify(args)},{cwd:${JSON.stringify(cwd)},env:process.env${syncDeadlineMs===undefined?"":`,syncDeadlineMs:${syncDeadlineMs}`}});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}${report}`;
  const result=Bun.spawnSync([process.execPath,"-e",source],{cwd,env,stdout:"pipe",stderr:"pipe",timeout:syncDeadlineMs===undefined?60_000:syncDeadlineMs+30_000});
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
/** #520: an applied receipt for a `<bun> --smol <entry> mcp` runtime, at the native path doctor resolves for this home. */
function setupReceipt(f:ReturnType<typeof hookFixture>,target:"qwen",entry:string){
  const dir=join(f.base,"setup");mkdirSync(dir,{mode:0o700});
  const image=(value:unknown)=>({mode:0o600,bytes:Buffer.from(JSON.stringify(value)).toString("base64")});
  const after={mcpServers:{amem:{command:process.execPath,args:["--smol",entry,"mcp"]}}};
  writeFileSync(join(dir,`${target}.json`),JSON.stringify({version:2,target,intent:"b".repeat(64),phase:"applied",
    changes:[{key:`${target}:0`,path:resolveSetupPaths(f.env).paths[target][0]!,before:image({}),after:image(after)}]}),{mode:0o600});
}
function success(result:ReturnType<typeof run>){expect(result.exitCode,result.stderr.toString()).toBe(0);return JSON.parse(result.stdout.toString()) as Record<string,unknown>;}
/**
 * #520: the later refusal — the receipt's install root disappears between building the active writer proof and the
 * attestation's own re-read — cannot be produced by mutating the home mid-run without a race, so the child removes the
 * root on the receipt's fourth read: reads 1-3 build the context, read 4 is the attestation re-read, and the refusal it
 * meets is the real ENOENT from production code, not a hand-built error.
 */
function runLaterAttestation(f:ReturnType<typeof hookFixture>,args:string[],install:string){
  const env={...f.env};delete env.CLAUDECODE;env.AGENTHUB_PEER_ID="codex";
  const setupPath=fileURLToPath(new URL("../src/setup.ts",import.meta.url));
  const source=`const {mock}=await import("bun:test");const fs=await import("node:fs");
const setup=await import(${JSON.stringify(setupPath)}),read=setup.readSetupWriterRoots;let reads=0;
mock.module(${JSON.stringify(setupPath)},()=>({...setup,readSetupWriterRoots:home=>{if(++reads===4)fs.rmSync(${JSON.stringify(install)},{recursive:true,force:true});return read(home);}}));
const {runCli}=await import(${JSON.stringify(cli)});
try{const out=await runCli(${JSON.stringify(args)},{cwd:${JSON.stringify(f.cwd)},env:process.env});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}`;
  return Bun.spawnSync([process.execPath,"-e",source],{cwd:f.cwd,env,stdout:"pipe",stderr:"pipe",timeout:60_000});
}
/**
 * #551: a `running CLI`/`missing` refusal needs an executing install the inventory does not hold, which activation itself
 * refuses to build; and the masked arm needs a failure that is not a writer refusal at all. Both substitute only this
 * adapter's entry point in the child, so every other production read, refusal and text stays the one under test. The
 * original is bound before the mock is registered, because `mock.module` rewrites the namespace in place and a body that
 * read `context.activePlacementWriterContext` afterwards would call itself.
 */
function runWriterContext(f:ReturnType<typeof hookFixture>,args:string[],agent:boolean,body:string){
  const env={...f.env};delete env.CLAUDECODE;if(agent)env.AGENTHUB_PEER_ID="codex";
  const context=fileURLToPath(new URL("../src/sync-placement-writer-context.ts",import.meta.url));
  const source=`const {mock}=await import("bun:test");
const context=await import(${JSON.stringify(context)}),real=context.activePlacementWriterContext;
mock.module(${JSON.stringify(context)},()=>({...context,activePlacementWriterContext:${body}}));
const {runCli}=await import(${JSON.stringify(cli)});
try{const out=await runCli(${JSON.stringify(args)},{cwd:${JSON.stringify(f.cwd)},env:process.env});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}`;
  return Bun.spawnSync([process.execPath,"-e",source],{cwd:f.cwd,env,stdout:"pipe",stderr:"pipe",timeout:60_000});
}

test("shared parser/help/completions expose only migrate writer roots and forward-only activation",()=>{
  expect(parseCommand(["migrate","--sync-placement","--dry-run","--writer-root","/fixture/root"]).options["--sync-placement"]).toBe(true);
  expect(commandHelp(["migrate"])).toContain("--sync-placement");expect(COMMANDS.migrate?.options?.["--writer-root"]?.value).toBe("path");
  expect(COMMANDS.sync?.options?.["--writer-root"]).toBeUndefined();
  for(const shell of ["zsh","bash","fish"])expect(completionScript(shell)).toContain("--sync-placement");
});

// #448: realm admission keeps its own flags, refuses the activation families, and touches no home it cannot read.
test("#448 realm admission parses only under --sync-placement and refuses before home access",()=>{
  expect(parseCommand(["migrate","--sync-placement","--admit","example.test/realm","--apply"]).options["--admit"]).toBe("example.test/realm");
  expect(commandHelp(["migrate"])).toContain("--admit");expect(COMMANDS.migrate?.options?.["--confirm"]).toBeDefined();
  expect(parseCommand(["migrate"]).options["--admit"]).toBeUndefined();
  const f=hookFixture();cleanup.push(f.close);expect(existsSync(f.base)).toBe(false);
  const conflicts: [string[], string][] = [[["migrate","--admit","example.test/realm"],"--sync-placement"],[["migrate","--sync-placement","--admit","example.test/realm","--writer-root","/fixture/root"],"writer roots"],[["migrate","--sync-placement","--confirm"],"--confirm"]];
  for(const [args,message] of conflicts){const result=run(f,args);expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain(message);}
  expect(existsSync(f.base)).toBe(false);
});

// #431 AC3: an agent-marked session reaches the same activation steps a person does; a missing home still fails before anything is created.
for(const mode of ["--dry-run","--apply","--resume","--abandon"])test("agent activation runs the person path and creates no home: "+mode,()=>{
  const f=hookFixture();cleanup.push(f.close);expect(existsSync(f.base)).toBe(false);
  const agent=run(f,["migrate","--sync-placement",mode,"--json"],true),person=run(f,["migrate","--sync-placement",mode,"--json"]);
  expect(agent.stderr.toString()).not.toContain("requires a person");expect(agent.exitCode).toBe(person.exitCode);expect(existsSync(f.base)).toBe(false);
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
  const {remote,url}=localCliRemote(f),progressed=run(f,["sync","--remote",url,"--json","--progress","json"]),sent=success(progressed);
  expect(sent.ok,JSON.stringify(sent)).toBe(true);expect(sent.placementPublication).toMatchObject({exported:1,withheld:1});expect(reachableInspectionRowIds(remote)).toEqual([f.allowed]);
  // #418: versioned stderr events, one final stdout document, and a read-only status from another invocation.
  const events=progressed.stderr.toString().split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line) as {schema:string;state:string;phase:string;operationId:string;diagnostic?:string}).filter(event=>event.diagnostic===undefined); // the cadence probe writes its own diagnostic lines
  expect(events.length).toBeGreaterThan(5);expect(events.every(event=>event.schema==="agent-mem.sync-progress/v1"&&event.operationId===events[0]!.operationId)).toBe(true);
  expect(events.map(event=>event.phase)).toContain("policy-evaluation");expect(events.at(-1)).toMatchObject({state:"succeeded",phase:"receipt"});
  expect(progressed.stderr.toString()).not.toContain("NEVER_PUBLIC");expect(progressed.stderr.toString()).not.toContain(url);
  const statusBefore=inspectionFilesystemSnapshot(f.base),status=success(run(f,["sync","--status","--json"])) as {operations:{state:string;operationId:string}[];malformed:number};
  expect(status.operations[0]).toMatchObject({state:"succeeded",operationId:events[0]!.operationId});expect(status.malformed).toBe(0);expect(inspectionFilesystemSnapshot(f.base)).toEqual(statusBefore);
  expect(run(f,["sync","--status","--remote",url]).exitCode).not.toBe(0);
  const cadence=success(run(f,["sync","--if-due","--force","--json"],false,CADENCE_E2E_DEADLINE_MS));expect(cadence.ok).toBe(true);expect(cadence.skipped).toBeUndefined();
  const epoch=JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead;
  writeFileSync(join(extra,"src","index.ts"),"// changed unregistered writer\n",{mode:0o644});
  // #551: the drift is a writer-context refusal, so --json returns the failed result and its fixed category, cause class and
  // remedy instead of one masked line; the attempt is still stamped and backs off.
  const blocked=run(f,["sync","--json"]);const refusal=JSON.parse(blocked.stdout.toString()) as {ok:boolean;failure:{cause:string};error:string};
  expect(blocked.exitCode).toBe(0);expect(refusal).toMatchObject({ok:false,failure:{cause:"refusal"}});
  expect(refusal.error).toContain("(declared writer category;");expect(refusal.error).toContain("amem migrate --sync-placement --dry-run");
  expect(blocked.stderr.toString()).not.toContain("Memory operation unavailable or refused");
  expect(refusal.error).not.toContain(extra);
  const failed=readSyncState(f.base);expect(failed.failures).toBe(1);
  expect(nextSyncAt(failed)!-Date.parse(failed.lastAttemptAt!)).toBe(SYNC_BACKOFF_BASE_MS);
  const deferred=success(run(f,["sync","--if-due","--json"]));expect(deferred).toMatchObject({skipped:"not due",failures:1});expect(readSyncState(f.base)).toEqual(failed);
  const forced=run(f,["sync","--if-due","--force","--json"]);expect(JSON.parse(forced.stdout.toString())).toMatchObject({ok:false,failure:{cause:"refusal"}});
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

test("#431: an agent-marked session abandons a changed pre-marker attempt like a person, and reopens the ordinary home",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);
  const options=f.options("apply");options.checkpoint=stage=>{if(stage==="after-root-map")throw Error("interrupted initial apply");};
  await expect(activateSyncPlacement(options)).rejects.toThrow();
  writeFileSync(join(f.base,"amem.config.json"),JSON.stringify({piiPatterns:["NEVER_PUBLIC_","new restriction"]}),{mode:0o600});
  const resumed=run(f,["migrate","--sync-placement","--resume","--json"]);expect(resumed.exitCode).not.toBe(0);expect(resumed.stderr.toString()).toContain("frozen policy input");
  expect(success(run(f,["migrate","--sync-placement","--abandon","--json"],true))).toMatchObject({active:false,abandoned:true});
  expect(run(f,["list","--json"]).exitCode).toBe(0);
  expect(success(run(f,["migrate","--sync-placement","--dry-run","--writer-root",activationOwnRoot,"--json"],true)).active).toBe(false);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"],true)).active).toBe(true);
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


// #520: an applied setup receipt whose recorded amem install is gone refuses every placement sync; a marked session gets
// the target and both remedies as fixed cause text instead of the generic masked refusal, and the same receipt shows up in
// its doctor report without the recorded path.
test("#520: a marked session names the setup target whose recorded install is gone, in sync and doctor", async () => {
  const f=await placementActivationFixture(); cleanup.push(f.close);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"])).active).toBe(true);
  const install=unregisteredWriter(f); setupReceipt(f,"qwen",join(install,"bin","amem.js"));
  rmSync(install,{recursive:true});
  // #551: an early writer-context refusal is the run's own failed result, the same shape a later attestation refusal takes,
  // so `--json` reports it in the body instead of exiting 1 with the text on stderr.
  const marked=run(f,["sync","--json"],true), receipt=JSON.parse(marked.stdout.toString()) as {ok:boolean;failure:{cause:string};error:string}, text=receipt.error;
  expect(marked.exitCode).toBe(0); expect(receipt).toMatchObject({ok:false,failure:{cause:"refusal"}});
  // #551 AC1: the fixed category and cause class ride in front of #520's own marker and remedy, in the one text both surfaces print.
  expect(text).toContain("(setup receipt category; runtime files are unreadable or missing)");
  expect(text).toContain("proof is unavailable");
  expect(text).toContain("[cause: setup_receipt_missing_install]");
  expect(text).toContain("the qwen setup receipt names an amem install that no longer exists");
  expect(text).toContain("amem setup qwen --apply"); expect(text).toContain("amem setup qwen --undo"); expect(text).toContain("then rerun the sync");
  expect(text).not.toContain(install); expect(text).not.toContain(f.base);
  expect(marked.stderr.toString()).not.toContain("Memory operation unavailable or refused");
  // Fail-closed: the refusal is recorded as the run's failure, and a person is still refused by the same receipt.
  expect(readSyncState(f.base).failures).toBe(1);
  const person=run(f,["sync","--json"]), forPerson=JSON.parse(person.stdout.toString()) as {ok:boolean;error:string};
  expect(person.exitCode).toBe(0); expect(forPerson.ok).toBe(false); expect(forPerson.error).toContain("setup receipt"); expect(forPerson.error).not.toContain(install);
  expect(readSyncState(f.base).failures).toBe(2);
  // A readable run still refuses with exit 1 and the same fixed text.
  const human=run(f,["sync"],true); expect(human.exitCode).not.toBe(0);
  expect(human.stderr.toString()).toContain("[cause: setup_receipt_missing_install]"); expect(human.stderr.toString()).not.toContain(install);
  expect(readSyncState(f.base).failures).toBe(3);
  const doctor=run(f,["doctor","--json"],true), report=JSON.parse(doctor.stdout.toString()) as {sections:{setup:{status:string;entries:{target?:string;phase?:string;entry?:string;reason?:string}[]}}};
  expect(doctor.exitCode).toBe(0); expect(report.sections.setup.status).toBe("attention");
  const row=report.sections.setup.entries.find(entry=>entry.entry==="amem install")!;
  expect(row).toMatchObject({target:"qwen",phase:"applied"});
  expect(row.reason).toContain("amem setup qwen --apply"); expect(row.reason).toContain("amem setup qwen --undo");
  expect(doctor.stdout.toString()).not.toContain(install);
},120_000);

test("#520: a marked session keeps the target and remedy for a later attestation refusal too", async () => {
  const f=await placementActivationFixture(); cleanup.push(f.close);
  const install=unregisteredWriter(f); setupReceipt(f,"qwen",join(install,"bin","amem.js"));
  // The receipt's root is part of the activation inventory, so the context builds and only its attestation re-read refuses.
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--writer-root",install,"--json"])).active).toBe(true);
  expect(existsSync(install)).toBe(true);
  const later=runLaterAttestation(f,["sync","--json"],install), text=later.stderr.toString();
  expect(existsSync(install)).toBe(false);   // the refusal came after the context was built, not from it
  // A later refusal is the sync's own failed result, so the marked session reads it from the receipt: fixed category, target and remedies, no path.
  const receipt=JSON.parse(later.stdout.toString()) as {ok:boolean;error:string;failure:{cause:string}};
  expect(later.exitCode).toBe(0); expect(receipt.ok).toBe(false); expect(receipt.failure.cause).toBe("refusal");
  expect(receipt.error).toContain("(setup receipt category");
  expect(receipt.error).toContain("the qwen setup receipt names an amem install that no longer exists");
  expect(receipt.error).toContain("amem setup qwen --apply"); expect(receipt.error).toContain("amem setup qwen --undo");
  expect(receipt.error).not.toContain(install); expect(later.stdout.toString()).not.toContain(install);
  expect(text).not.toContain("Memory operation unavailable or refused"); expect(text).not.toContain(install);
  expect(readSyncState(f.base).failures).toBe(1);
},120_000);

test("#449/#450: an unlisted cwd selects no realm; placement sync covers the activated inventory and leaves the cwd shard unopened", async () => {
  const f=await placementActivationFixture(); cleanup.push(f.close);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"])).active).toBe(true);
  const {url}=localCliRemote(f), cwd=join(f.root,"outside"); mkdirSync(cwd);
  const {memoryProjectKey}=await import("../src/memory/project.ts"), {shardDir, assertCuratedShardPaths}=await import("../src/memory/shard.ts");
  const {CaptureStore}=await import("../src/memory/capture.ts"), {createHash}=await import("node:crypto");
  const project=memoryProjectKey(cwd), capture=new CaptureStore({memoryDir:f.base,project}); capture.close();
  const hash=createHash("sha256").update(project).digest("hex");
  for (const origin of ["cwd binding", "remote"] as const) {
    expect(() => assertCuratedShardPaths(f.base,{project},origin)).toThrow(`scope=project keyHash=${hash}; origin=${origin}`);
  }
  const result=run(f,["sync","--remote",url,"--json"],false,undefined,cwd), receipt=success(result);
  expect(receipt.ok).toBe(true); expect(receipt.skippedCwdProject).toBeUndefined();
  // The activated inventory (user plus the fixture's project) is published regardless of the cwd.
  const realms=(receipt.placementRealms as {realm:string;outcome:string}[]).map(item=>item.realm);
  expect(realms[0]).toBe("user"); expect(realms).toContain(createHash("sha256").update(f.project).digest("hex"));
  expect(realms).not.toContain(hash);
  expect(existsSync(shardDir(f.base,project))).toBe(true);
  expect(existsSync(join(shardDir(f.base,project),"generation.json"))).toBe(false);
  const listed=success(run(f,["sync","--json"])); expect(listed.ok).toBe(true);
},120_000);

// #551 AC1: a writer-context refusal is the run's own failed result with its fixed category, cause class and remedy, on all
// four surfaces - marked and unmarked sync as JSON and as text, and doctor. A receipt naming an existing install the
// activated inventory does not hold produces the `setup receipt`/`missing` arm through production code.
test("#551 AC1: sync and doctor report the setup-receipt writer refusal as fixed data on both sides", async () => {
  const f=await placementActivationFixture(); cleanup.push(f.close);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"])).active).toBe(true);
  const install=unregisteredWriter(f); setupReceipt(f,"qwen",join(install,"bin","amem.js"));
  expect(existsSync(install)).toBe(true);   // the install is present, so this is a missing inventory entry, not a removed root
  const shared=(text:string)=>{expect(text).toContain("(setup receipt category)");expect(text).toContain("proof is missing");expect(text).toContain("amem migrate --sync-placement --dry-run");
    expect(text).not.toContain(install);expect(text).not.toContain(f.base);expect(text).not.toContain("Memory operation unavailable or refused");};
  const marked=success(run(f,["sync","--json"],true)) as {ok:boolean;pushed:boolean;entries:number;failure:{cause:string};error:string};
  expect(marked).toMatchObject({ok:false,pushed:false,entries:0,failure:{cause:"refusal"}}); shared(marked.error);
  expect(readSyncState(f.base).failures).toBe(1);
  const person=success(run(f,["sync","--json"])) as {ok:boolean;failure:{cause:string};error:string};
  expect(person).toMatchObject({ok:false,failure:{cause:"refusal"}}); expect(person.error).toBe(marked.error); shared(person.error);
  expect(readSyncState(f.base).failures).toBe(2);
  // Human runs keep the refusal's own text and exit 1, marked and unmarked alike.
  for(const agent of [true,false]){
    const human=run(f,["sync"],agent); expect(human.exitCode).not.toBe(0); expect(human.stdout.toString()).toBe("");
    shared(human.stderr.toString()); expect(human.stderr.toString()).toContain("Sync placement writer proof is missing");
  }
  const doctor=run(f,["doctor","--json"],true), report=JSON.parse(doctor.stdout.toString()) as {sections:{writers?:{status:string;category?:string;cause?:string;phase?:string;reason?:string;writers?:number}}};
  expect(doctor.exitCode).toBe(0); expect(report.sections.writers).toMatchObject({status:"attention",category:"setup receipt",cause:"missing",phase:"active"});
  shared(report.sections.writers!.reason!);
  // With the receipt gone the same home verifies clean: the section is `ok` and counts the inventory, not a refusal.
  unlinkSync(join(f.base,"setup","qwen.json"));
  const clean=JSON.parse(run(f,["doctor","--json"],true).stdout.toString()) as {sections:{writers?:{status:string;writers?:number;reason?:string}}};
  expect(clean.sections.writers).toMatchObject({status:"ok",writers:1}); expect(clean.sections.writers!.reason).toBeUndefined();
},180_000);

// #551 AC1: the `running CLI` arm - the install running the command is not in the inventory - plus the masked arm, where a
// failure that is not a writer refusal keeps the generic masked line on the same code path.
test("#551 AC1: a running-CLI refusal reaches both surfaces, and any other failure stays masked", async () => {
  const f=await placementActivationFixture(); cleanup.push(f.close);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"])).active).toBe(true);
  const other=unregisteredWriter(f), own=`(home)=>real(home,${JSON.stringify(other)})`;
  const marked=success(runWriterContext(f,["sync","--json"],true,own)) as {ok:boolean;failure:{cause:string};error:string};
  expect(marked).toMatchObject({ok:false,failure:{cause:"refusal"}});
  expect(marked.error).toContain("(running CLI category)"); expect(marked.error).toContain("proof is missing");
  expect(marked.error).toContain("amem migrate --sync-placement --dry-run");
  expect(marked.error).not.toContain(other); expect(marked.error).not.toContain(f.base);
  const person=runWriterContext(f,["sync","--json"],false,own);
  expect(person.exitCode).toBe(0); expect(JSON.parse(person.stdout.toString()).error).toBe(marked.error);
  const human=runWriterContext(f,["sync"],true,own);
  expect(human.exitCode).not.toBe(0); expect(human.stderr.toString()).toContain("(running CLI category)"); expect(human.stderr.toString()).not.toContain(other);
  // A different failure on the same path is not a writer refusal: marked output is the masked line, with no path or message.
  const masked=runWriterContext(f,["sync","--json"],true,`()=>{throw new Error("transport refused at ${join(f.base,"private")}")}`);
  expect(masked.exitCode).not.toBe(0);
  expect(masked.stderr.toString()).toContain("Memory operation unavailable or refused; no partial result is shown.");
  expect(masked.stderr.toString()).not.toContain(f.base); expect(masked.stdout.toString()).toBe("");
  // #551 AC1: the same masking holds for a refusal carried as `placementRefusal` behind a throwing proxy - the run ends in
  // the anonymous line with no trap text, no category and no target. This arm pins that outcome; the adapter's own order is
  // pinned by the unit test, because a trap that fires there is still masked by this catch and would show the same line.
  const trap=`{getPrototypeOf(){throw new Error("proxy trap")},getOwnPropertyDescriptor(){throw new Error("proxy trap")},get(){throw new Error("proxy trap")},has(){throw new Error("proxy trap")}}`;
  const hostile=`()=>{const carrier=new Error("carrier");Object.defineProperty(carrier,"placementRefusal",{value:new Proxy(new context.PlacementWriterContextError("setup receipt","unavailable","active",undefined,undefined,"qwen"),${trap})});throw carrier}`;
  const trapped=runWriterContext(f,["sync","--json"],true,hostile);
  expect(trapped.exitCode).not.toBe(0); expect(trapped.stdout.toString()).toBe("");
  expect(trapped.stderr.toString()).toContain("Memory operation unavailable or refused; no partial result is shown.");
  expect(trapped.stderr.toString()).not.toContain("proxy trap");
  expect(trapped.stderr.toString()).not.toContain("setup receipt"); expect(trapped.stderr.toString()).not.toContain("qwen");
},180_000);

// #551: an inventory that cannot be read far enough proves no category, so it is reported as unverified - never as a root
// reported missing, and never with an invented category.
test("#551: an unprovable writer inventory is unverified in sync and doctor, never a missing root", async () => {
  const f=await placementActivationFixture(); cleanup.push(f.close);
  expect(success(run(f,["migrate","--sync-placement","--apply","--writer-root",activationOwnRoot,"--json"])).active).toBe(true);
  const unverified="Placement writer verification could not establish a category: the retained writer inventory or its history could not be read far enough to name one; have the person inspect the home with a compatible release, then run amem migrate --sync-placement --dry-run.";
  // The whole fixed sentence, so a later edit to it is visible here: no category claim, one next step, no bare "missing".
  // #551 AC2: a marker that does not parse proves neither state, so doctor reports the state as unverified instead of
  // treating the home as one that never activated placement sync - and the same home verifies clean once it parses again,
  // so the row is the marker's and the inventory is never claimed missing.
  const profile=readFileSync(join(f.base,"profile.json"));
  const clean=JSON.parse(run(f,["doctor","--json"]).stdout.toString()) as {sections:{writers?:{status:string;writers?:number}}};
  expect(clean.sections.writers).toMatchObject({status:"ok",writers:1});
  writeFileSync(join(f.base,"profile.json"),"not a profile\n",{mode:0o600});
  const malformedRun=run(f,["doctor","--json"]); expect(malformedRun.exitCode).toBe(0);
  const malformed=JSON.parse(malformedRun.stdout.toString()) as {sections:{writers?:{status:string;category?:string;cause?:string;reason?:string}}};
  expect(malformed.sections.writers).toMatchObject({status:"unavailable"});
  expect(malformed.sections.writers!.reason).toBe(unverified);
  expect(malformed.sections.writers!.category).toBeUndefined(); expect(malformed.sections.writers!.cause).toBeUndefined();
  writeFileSync(join(f.base,"profile.json"),profile,{mode:0o600});
  const epochs=join(f.base,"sync-placement","epochs"), epoch=join(epochs,readdirSync(epochs)[0]!);
  writeFileSync(join(epoch,"writer-revision-00001.json"),"not a writer revision\n",{mode:0o600});   // a real log read failure, not a hand-built error
  const marked=success(run(f,["sync","--json"],true)) as {ok:boolean;failure:{cause:string};error:string};
  expect(marked).toMatchObject({ok:false,failure:{cause:"refusal"}});
  expect(marked.error).toBe(unverified); expect(marked.error).not.toContain("missing");
  const person=run(f,["sync","--json"]); expect(person.exitCode).toBe(0); expect(JSON.parse(person.stdout.toString()).error).toBe(unverified);
  const doctor=run(f,["doctor","--json"],true), report=JSON.parse(doctor.stdout.toString()) as {sections:{writers?:{status:string;category?:string;cause?:string;reason?:string}}};
  expect(doctor.exitCode).toBe(0); expect(report.sections.writers).toMatchObject({status:"unavailable"});
  expect(report.sections.writers!.reason).toBe(unverified);
  expect(report.sections.writers!.category).toBeUndefined(); expect(report.sections.writers!.cause).toBeUndefined();
  expect(doctor.stdout.toString()).not.toContain("writer-revision-00001.json");
},180_000);
