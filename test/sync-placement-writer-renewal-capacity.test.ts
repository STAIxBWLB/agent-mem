import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { acquireMutation, assertMutationHandle } from "../src/memory/mutation.ts";
import { readPlacementJournal, writerRenewalCapacity } from "../src/memory/sync-placement-journal-storage.ts";
import { readInitialSyncPlacementWriterLocator, SYNC_PLACEMENT_WRITER_ROOTS_FILE } from "../src/memory/sync-placement-writer-roots.ts";
import { measureSyncPlacementWriters } from "../src/memory/sync-placement-writers.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { readWriterHistory, writeWriterRenewalIntent, writeWriterRevision, appendWriterCommit, clearWriterRenewalIntent } from "../src/memory/sync-placement-writer-history.ts";
import { createWriterRevision, createWriterCommit, createWriterRenewalIntent, WRITER_REVISION_SCHEMA, WRITER_RENEWAL_INTENT_SCHEMA,
  WRITER_COMMIT_LOG, WRITER_RENEWAL_INTENT_FILE, writerRevisionFile, SharedWriterRevisionError } from "../src/memory/sync-placement-writer-revision-format.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function install(root:string){
  const dir=join(root,"capacity-extra");for(const name of [dir,join(dir,"src"),join(dir,"bin")])mkdirSync(name,{mode:0o755});
  writeFileSync(join(dir,"package.json"),JSON.stringify({name:"@staix/agent-mem",version:"0.22.0"}),{mode:0o644});
  writeFileSync(join(dir,"src/index.ts"),"// initial capacity writer\n",{mode:0o644});writeFileSync(join(dir,"bin/amem.js"),"// never executed\n",{mode:0o755});return dir;
}

test("unpublished intent staging shares the 256-object allowance before any new revision write",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);await activateSyncPlacement(f.options("apply"));
  const epoch=JSON.parse(readFileSync(join(f.base,"profile.json"),"utf8")).placementHead as string;
  // Reserved private staging is non-authorizing provisional data; no fake publication receipt is fabricated.
  for(let n=1;n<=253;n++)writeFileSync(join(f.base,WRITER_RENEWAL_INTENT_FILE+".pending-"+n.toString(16).padStart(64,"0")),"{",{mode:0o600});
  expect(readPlacementJournal(f.base,epoch).objects).toBe(256);
  const before=inspectionFilesystemSnapshot(f.base);let error:unknown;try{writerRenewalCapacity(f.base,epoch,1);}catch(caught){error=caught;}
  expect((error as {code?:unknown})?.code).toBe("bound");expect(inspectionFilesystemSnapshot(f.base)).toEqual(before);
  expect(existsSync(join(f.base,"sync-placement","epochs",epoch,writerRevisionFile(1)))).toBe(false);
},30_000);
function retainedInitial(home:string,epochHash:string):Record<string,string>{
  const paths=["profile.json","shards.json",SYNC_PLACEMENT_WRITER_ROOTS_FILE,"sync-placement/active.json",
    `sync-placement/epochs/${epochHash}/epoch.json`,`sync-placement/epochs/${epochHash}/activation.json`];
  const collect=(dir:string,relative:string)=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})){const name=join(relative,entry.name),file=join(dir,entry.name);
      if(entry.isDirectory())collect(file,name);else if(entry.isFile()&&entry.name.endsWith(".jsonl"))paths.push(name);
    }
  };
  for(const name of ["projects","user"])if(existsSync(join(home,name)))collect(join(home,name),name);
  return Object.fromEntries(paths.sort().map(name=>[name,readFileSync(join(home,name)).toString("base64")]));
}

test("the genuine same-epoch coordinator reports one remaining renewal, commits revision64 and refuses65 without changing initial history",async()=>{
  const f=await placementActivationFixture();cleanup.push(f.close);const extra=install(f.root),initial=f.options("apply");
  initial.writerRoots=[activationOwnRoot,extra];expect(await activateSyncPlacement(initial)).toMatchObject({active:true});
  // Fixture-only person action; production renewal must not create or edit formats.json.
  writeFileSync(join(f.base,"formats.json"),JSON.stringify([{surface:"home",minReader:"0.22.0",since:"2026-11-06"}])+"\n",{mode:0o600});
  const locator=readInitialSyncPlacementWriterLocator(f.base),epochHash=locator.epochHash,journal=readPlacementJournal(f.base,epochHash);
  expect(journal.sequence).toBe(0);expect(journal.records).toEqual([]);
  const binding={epochHash,activationHash:journal.activation.seal,homeHash:journal.epoch.homeHash,generation:journal.epoch.generation,initialLocatorHash:locator.seal};
  const before=retainedInitial(f.base,epochHash),own=measureSyncPlacementWriters([activationOwnRoot]).roots[0]!,epochDir=join(f.base,"sync-placement","epochs",epochHash);
  const mutation=acquireMutation(f.base);if(!mutation)throw Error("isolated capacity mutation unavailable");
  try{
    // Test-only raw storage seeding, not person-authority proof. Each retained revision is closed, sealed,
    // same-epoch, uses the actual initial locator and records an actually measured dummy install pin.
    for(let sequence=1;sequence<=63;sequence++){
      writeFileSync(join(extra,"src/index.ts"),`// measured capacity revision ${sequence}\n`);
      const prior=readWriterHistory(f.base,binding),roots=[own,measureSyncPlacementWriters([extra]).roots[0]!].sort((a,b)=>a.root<b.root?-1:a.root>b.root?1:0);
      const revision=createWriterRevision({schema:WRITER_REVISION_SCHEMA,...binding,sequence,previousHash:prior.headHash,journal:{sequence:0,headHash:epochHash},roots,requestId:sequence.toString(16).padStart(64,"0")});
      const intent=createWriterRenewalIntent({schema:WRITER_RENEWAL_INTENT_SCHEMA,home:f.base,revision,commit:createWriterCommit(revision),previousLogBytes:prior.logBytes,previousLogHash:prior.logHash});
      const options={mutation,assertCurrent(){assertMutationHandle(mutation,f.base);writerRenewalCapacity(f.base,epochHash,sequence);}};
      writeWriterRenewalIntent(f.base,intent,options);writeWriterRevision(f.base,intent,options);appendWriterCommit(f.base,intent,options);clearWriterRenewalIntent(f.base,intent,options);
    }
  }finally{mutation();}
  const history63=readWriterHistory(f.base,binding);expect(history63.sequence).toBe(63);
  expect(retainedInitial(f.base,epochHash)).toEqual(before);
  const prefix=readFileSync(join(epochDir,WRITER_COMMIT_LOG)),oldRevisions=Array.from({length:63},(_,i)=>readFileSync(join(epochDir,writerRevisionFile(i+1))));
  const preview=await activateSyncPlacement({...f.options("dry-run"),writerRoots:[activationOwnRoot,extra]});
  expect(preview).toMatchObject({active:true,sequence:63,remainingRevisions:1});
  expect((preview as {capacityNotice?:string}).capacityNotice).toContain("1 renewals remain");
  expect((preview as {capacityNotice?:string}).capacityNotice).toContain("shared object budget may refuse earlier");
  writeFileSync(join(extra,"src/index.ts"),"// actual person-coordinated revision64\n");
  const result=await activateSyncPlacement({...f.options("apply"),writerRoots:[activationOwnRoot,extra]});
  expect(result).toMatchObject({active:true,renewed:true,epochHash,sequence:64,remainingRevisions:0});
  expect(readEffectiveSyncPlacementWriters(f.base).revisionSequence).toBe(64);
  const history64=readWriterHistory(f.base,binding),committed=readFileSync(join(epochDir,WRITER_COMMIT_LOG));
  expect(history64.sequence).toBe(64);expect(committed.subarray(0,prefix.length)).toEqual(prefix);
  for(let i=0;i<oldRevisions.length;i++)expect(readFileSync(join(epochDir,writerRevisionFile(i+1)))).toEqual(oldRevisions[i]!);
  expect(retainedInitial(f.base,epochHash)).toEqual(before);expect(readPlacementJournal(f.base,epochHash).records).toEqual(journal.records);
  writeFileSync(join(extra,"src/index.ts"),"// revision65 must not start\n");
  let refused:unknown;try{await activateSyncPlacement({...f.options("apply"),writerRoots:[activationOwnRoot,extra]});}catch(error){refused=error;}
  expect(refused).toBeInstanceOf(SharedWriterRevisionError);const error=refused as SharedWriterRevisionError;
  expect(error.code).toBe("cap");expect(error.remaining).toBe(0);expect(error.message).toContain("separately reviewed archival/checkpoint");
  expect(readWriterHistory(f.base,binding).sequence).toBe(64);expect(readFileSync(join(epochDir,WRITER_COMMIT_LOG))).toEqual(committed);
  expect(existsSync(join(epochDir,"writer-revision-00065.json"))).toBe(false);
  expect(existsSync(join(f.base,WRITER_RENEWAL_INTENT_FILE))).toBe(false);
  expect(readdirSync(f.base).filter(name=>name.startsWith(WRITER_RENEWAL_INTENT_FILE))).toEqual([]);
  expect(readdirSync(join(f.base,"sync-placement","epochs"))).toEqual([epochHash]);
  expect(retainedInitial(f.base,epochHash)).toEqual(before);
  expect(canonicalJSON(readPlacementJournal(f.base,epochHash).records)).toBe(canonicalJSON(journal.records));
},120_000);
