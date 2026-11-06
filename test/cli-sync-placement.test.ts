import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { placementActivationFixture, activationOwnRoot } from "./fakes/sync-placement-activation.ts";
import { hookFixture } from "./fakes/hooks-fixture.ts";
import { inspectionFilesystemSnapshot, createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { COMMANDS, commandHelp, parseCommand } from "../src/commands-table.ts";
import { completionScript } from "../src/completion.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
function run(f:ReturnType<typeof hookFixture>,args:string[],agent=false){
  const env={...f.env};delete env.CLAUDECODE;if(agent)env.AGENTHUB_PEER_ID="codex";
  const source=`import {runCli} from ${JSON.stringify(cli)};try{const out=await runCli(${JSON.stringify(args)},{cwd:${JSON.stringify(f.cwd)},env:process.env,visibility:async()=>"private"});if(out)console.log(out);}catch(error){console.error(error.message);process.exitCode=1;}`;
  return Bun.spawnSync([process.execPath,"-e",source],{cwd:f.cwd,env,stdout:"pipe",stderr:"pipe",timeout:60_000});
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
  const extra=join(f.root,"unregistered writer");for(const dir of [extra,join(extra,"src"),join(extra,"bin")])mkdirSync(dir,{mode:0o755});
  writeFileSync(join(extra,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.21.0"}),{mode:0o644});
  writeFileSync(join(extra,"src","index.ts"),"// unregistered measured fixture, never executed\n",{mode:0o644});writeFileSync(join(extra,"bin","amem.js"),"// fixture\n",{mode:0o755});
  const args=["migrate","--sync-placement","--writer-root",activationOwnRoot,"--writer-root",extra,"--json"];
  const before=inspectionFilesystemSnapshot(f.base),preview=success(run(f,[...args,"--dry-run"]));
  expect(preview).toMatchObject({active:false,forwardOnly:true,source:{declined:1}});expect(JSON.stringify(preview)).not.toContain("NEVER_PUBLIC_ACTIVATION_BODY");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect(success(run(f,[...args,"--apply"])).active).toBe(true);
  const rootmap=JSON.parse(readFileSync(join(f.base,"sync-placement-writer-roots.json"),"utf8"));expect(rootmap.roots).toHaveLength(2);
  const remote=createInspectionRemote(f.root),sent=success(run(f,["sync","--remote",remote,"--json"]));
  expect(sent.ok).toBe(true);expect(sent.placementPublication).toMatchObject({exported:1,withheld:1});expect(reachableInspectionRowIds(remote)).toEqual([f.allowed]);
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
