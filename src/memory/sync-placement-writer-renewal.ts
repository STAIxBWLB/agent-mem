/** Person-only same-epoch writer renewal. No source/journal recovery, publication or floor writer. */
import { randomBytes, createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join, basename } from "node:path";
import { types } from "node:util";
import { canonicalJSON, readProfileJSON, hashJSON, legacyProfileMarkerShape } from "./generation.ts";
import { validatePlacementProfile } from "./sync-placement-format.ts";
import { realPath } from "./platform.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding, type ActivePlacementBinding } from "./sync-placement-active.ts";
import { readInitialSyncPlacementWriterLocator } from "./sync-placement-writer-roots.ts";
import { readEffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { readPlacementJournal, readPlacementWriterJournalAnchors, writerRenewalCapacity } from "./sync-placement-journal-storage.ts";
import { readWriterHistory, writeWriterRenewalIntent, writeWriterRevision, appendWriterCommit, clearWriterRenewalIntent, abandonWriterRenewal, abandonUnpublishedWriterStaging, type WriterHistoryPhase, type WriterHistoryRead } from "./sync-placement-writer-history.ts";
import { createWriterRevision, createWriterCommit, createWriterRenewalIntent, writerRevisionWriters, WRITER_REVISION_SCHEMA, WRITER_RENEWAL_INTENT_SCHEMA, WRITER_REVISION_LIMIT, WRITER_COMMIT_LOG, SharedWriterRevisionError, type WriterRenewalIntent } from "./sync-placement-writer-revision-format.ts";
import { requireWriterRenewalHomeFloor } from "./sync-placement-prerequisites.ts";
import { withPlacementActivationFences } from "./sync-placement-activation-locks.ts";
import { assertPlacementActivationOwner, type PlacementActivationOwner } from "./sync-placement-activation-proof.ts";
import { previewSyncPlacementSources, previewOwnedSyncPlacementSources } from "./sync-placement-capture.ts";
import { captureInspectionPendingPrunes } from "./sync-placement-inspection-pending.ts";
import { validatePrunePlan } from "./prune.ts";
import { initialPlacementWriterContext, previewActivePlacementWriters } from "../sync-placement-writer-context.ts";
import type { PlacementActivationOptions } from "./sync-placement-activation.ts";

export class WriterRenewalError extends Error{
  constructor(readonly causeClass:"pending"|"candidate"|"changed"|"capacity"|"authorization",details=""){
    super(causeClass==="pending"
      ? "Writer renewal refuses an outstanding append, publication, reservation or source-recovery intent; restore the inventoried install (for example dot ai rollback amem or the host's previous pin), run amem sync to finish the exact attempt, then preview and apply renewal."
      :causeClass==="candidate"
        ? "Writer renewal requires an explicit complete --writer-root inventory of 0.22.0-or-later installs; upgrade the CLI/host pins, refresh managed setup receipts and run amem migrate --sync-placement --dry-run before applying."
        :causeClass==="capacity"
          ? `Writer renewal metadata capacity is exhausted ${details}; retain this epoch and request a separately reviewed archival/checkpoint protocol before another renewal.`
          :causeClass==="authorization"
            ? "Writer renewal requires explicit person authorization of this exact inventory; have the person preview it with amem migrate --sync-placement --dry-run and then apply."
            : "Writer renewal frozen inventory or binding changed; restore it and run amem migrate --sync-placement --resume, or use --abandon before commit append starts and review a new dry-run.");
    this.name="WriterRenewalError";
  }
}
function active(home:string):ActivePlacementBinding{
  const markers=readPlacementRuntimeMarkers(home),value=readActivePlacementBinding(home,markers.profile,markers.shards);if(!value)throw new WriterRenewalError("changed");return value;
}
const binding=(a:ActivePlacementBinding)=>({epochHash:a.profile.placementHead,activationHash:a.activation.seal,homeHash:a.epoch.homeHash,generation:a.epoch.generation});
function list(dir:string,maximum:number):string[]{
  const out:string[]=[],reader=opendirSync(dir);try{for(;;){const e=reader.readSync();if(!e)break;if(out.length>=maximum)throw new SharedWriterRevisionError("bound");out.push(e.name);}}finally{reader.closeSync();}return out.sort();
}
function directories(home:string,a:ActivePlacementBinding):string[]{
  const out=[home];for(const r of a.activation.realms)out.push(r.scope==="user"?join(home,"user"):join(home,"projects",r.keyHash.slice(0,16)));
  const checked=(dir:string)=>{const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o022)!==0)throw new WriterRenewalError("changed");};
  const projects=join(home,"projects");if(lstatSync(projects,{throwIfNoEntry:false})){
    checked(projects);for(const name of list(projects,256))if(/^[a-f0-9]{16}$/.test(name)){
      const dir=join(projects,name);checked(dir);if(lstatSync(join(dir,"generation.json"),{throwIfNoEntry:false}))out.push(dir);
    }
  }
  for(const dir of out)checked(dir);
  return[...new Set(out)].sort();
}
function pendingSources(home:string,owner?:PlacementActivationOwner):()=>void{
  try{
    const source=owner?previewOwnedSyncPlacementSources(home,owner):previewSyncPlacementSources(home),checks=source.directories.map(captureInspectionPendingPrunes);
    for(const dir of source.directories){
      const history=join(dir,"prune-plans","selector-history");if(!lstatSync(history,{throwIfNoEntry:false}))continue;
      const seen=new Set<string>();
      for(const name of list(history,128)){
        const m=/^([a-f0-9]{64})\.json(\.pending)?$/.exec(name);if(!m||m[2])throw new WriterRenewalError("pending");seen.add(m[1]!);
        if(seen.size>64)throw new SharedWriterRevisionError("bound");
        const stat=lstatSync(join(history,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>262144)throw new WriterRenewalError("pending");
        const plan=validatePrunePlan(readProfileJSON(join(dir,"prune-plans",m[1]+".json")));
        if(plan.seal!==m[1]||plan.rows.length!==1)throw new WriterRenewalError("pending");
        const prior=readProfileJSON(join(history,name));if(!prior||typeof prior!=="object"||hashJSON(prior)!==plan.selectorRevision)throw new WriterRenewalError("pending");
        if((prior as {schema?:unknown}).schema==="agent-mem.profile/v3")validatePlacementProfile(prior);else if(!legacyProfileMarkerShape(prior))throw new WriterRenewalError("pending");
        const row=plan.rows[0]!.payload;
        if(![...source.specialRows.values()].some(item=>item.row.id===row.id&&hashJSON(item.row)===hashJSON(row)
          &&(dir===home||basename(dir)==="user"&&item.key.realm.scope==="user"||item.key.realm.scope==="project"&&item.key.realm.keyHash.slice(0,16)===basename(dir))))throw new WriterRenewalError("pending");
      }
    }
    return()=>{source.assertSourcesUnchanged();for(const check of checks)check();};
  }catch(error){if(error instanceof SharedWriterRevisionError&&error.code==="bound")throw error;throw new WriterRenewalError("pending");}
}
function journalClear(home:string,epochHash:string):void{
  try{const j=readPlacementJournal(home,epochHash);if(j.pending||j.publicationReservation)throw Error();}catch{throw new WriterRenewalError("pending");}
}
function supported(version:string):boolean{const p=version.split(".").map(Number);return p[0]!>0||p[0]===0&&p[1]!>=22;}
function person(options:PlacementActivationOptions,intent:WriterRenewalIntent):void{
  let okay=false;try{okay=options.authorize(Object.freeze({seal:intent.revision.seal,generation:intent.revision.generation,homeHash:intent.revision.homeHash}))===true;}catch{}
  if(!okay)throw new WriterRenewalError("authorization");
}
export async function renewSyncPlacementWriters(options:PlacementActivationOptions):Promise<Record<string,unknown>|undefined>{
  const home=realPath(options.memoryDir),initial=active(home),b=binding(initial);
  let history:WriterHistoryRead;
  try{history=readWriterHistory(home,b,{allowPending:true});}catch(error){
    if(options.mode!=="abandon"||!error||typeof error!=="object"||types.isProxy(error)||!(error instanceof SharedWriterRevisionError)||Object.getOwnPropertyDescriptor(error,"code")?.value!=="staging")throw error;
    requireWriterRenewalHomeFloor(home);
    return withPlacementActivationFences(home,directories(home,initial),async(mutation,owner)=>{
      const locator=readInitialSyncPlacementWriterLocator(home),seal=hashJSON({action:"abandon-unpublished-writer-staging",...b,initialLocatorHash:locator.seal});
      let authorized=false;try{authorized=options.authorize(Object.freeze({seal,generation:b.generation,homeHash:b.homeHash}))===true;}catch{}
      if(!authorized)throw new WriterRenewalError("authorization");
      const assertCurrent=()=>{assertPlacementActivationOwner(owner);requireWriterRenewalHomeFloor(home);if(canonicalJSON(binding(active(home)))!==canonicalJSON(b)||readInitialSyncPlacementWriterLocator(home).seal!==locator.seal)throw new WriterRenewalError("changed");};
      const assertCommittedHistory=(history:WriterHistoryRead)=>{
        assertCurrent();const journal=readPlacementWriterJournalAnchors(home,b.epochHash);
        for(const anchor of history.anchors)if(anchor.sequence>journal.sequence||(anchor.sequence===0?b.epochHash:journal.records[anchor.sequence-1]?.seal)!==anchor.headHash)throw new WriterRenewalError("changed");
      };
      const cleared=abandonUnpublishedWriterStaging(home,{...b,initialLocatorHash:locator.seal},{mutation,assertCurrent,assertCommittedHistory});
      return{mode:options.mode,active:true,abandoned:true,unpublishedStagingRemoved:cleared.removed,nextStep:"amem migrate --sync-placement --dry-run"};
    });
  }
  if(!history.pending&&(options.mode==="resume"||options.mode==="abandon")&&history.sequence===0)return undefined;
  if(options.mode==="dry-run"){
    if(history.pending)return{mode:options.mode,active:true,renewalSupported:true,pending:true,commitStarted:history.appendStarted,abandonable:!history.appendStarted,sequence:history.sequence,remainingRevisions:WRITER_REVISION_LIMIT-history.sequence};
    const expected=readEffectiveSyncPlacementWriters(home);let floorReady=true;try{requireWriterRenewalHomeFloor(home);}catch{floorReady=false;}
    let recoveryReady=true,objectSlotsRemaining:number|undefined;
    try{journalClear(home,b.epochHash);pendingSources(home);objectSlotsRemaining=256-readPlacementJournal(home,b.epochHash).objects;}catch{recoveryReady=false;}
    const writers=previewActivePlacementWriters(home,options.ownRoot,options.writerRoots),remaining=WRITER_REVISION_LIMIT-history.sequence;
    return{mode:options.mode,active:true,renewalSupported:true,forwardOnly:true,sequence:history.sequence,revisionHash:history.headHash,remainingRevisions:WRITER_REVISION_LIMIT-history.sequence,
      quiescence:"deferred-to-apply",floorReady,requiredHomeFloor:"0.22.0",recoveryReady,...(recoveryReady?{}:{nextStep:new WriterRenewalError("pending").message}),
      ...(objectSlotsRemaining===undefined?{}:{objectSlotsRemaining}),...(remaining<=4?{capacityNotice:`${remaining} renewals remain before the 64-revision ceiling; the shared object budget may refuse earlier. Archival/checkpointing requires a separate reviewed protocol.`}:{}),
      writers,candidateMinimumVersion:"0.22.0",candidatesSupported:writers.complete&&writers.roots.every(r=>supported(r.version)),expectedWriterCount:expected.writers.length};
  }
  requireWriterRenewalHomeFloor(home);
  if(history.pending&&options.mode==="apply")throw new SharedWriterRevisionError("pending");
  if(!history.pending&&options.mode==="abandon")throw new WriterRenewalError("changed");
  if(!history.pending&&options.mode==="apply"&&!options.writerRoots.length)throw new WriterRenewalError("candidate");
  // No new intent is written before every pre-existing recovery obligation has been rejected.
  let sourceCheck=options.mode==="apply"?(journalClear(home,b.epochHash),pendingSources(home)):undefined;
  return withPlacementActivationFences(home,directories(home,initial),async(mutation,owner)=>{
    if(options.mode==="resume"&&history.pending&&!history.appendStarted){journalClear(home,b.epochHash);sourceCheck=pendingSources(home,owner);}
    let intent=history.pending;
    const cleanupOnly=!intent&&options.mode==="resume"&&!!history.current;
    if(cleanupOnly){
      const prefix=Buffer.from(history.commits.slice(0,-1).map(row=>canonicalJSON(row)+"\n").join(""));
      intent=createWriterRenewalIntent({schema:WRITER_RENEWAL_INTENT_SCHEMA,home,revision:history.current!,commit:history.commits.at(-1)!,previousLogBytes:prefix.length,previousLogHash:createHash("sha256").update(prefix).digest("hex")});
    }
    const locator=readInitialSyncPlacementWriterLocator(home);
    const metadata=()=>{
      assertPlacementActivationOwner(owner);requireWriterRenewalHomeFloor(home);
      const now=active(home);if(canonicalJSON(binding(now))!==canonicalJSON(b)||readInitialSyncPlacementWriterLocator(home).seal!==locator.seal)throw new WriterRenewalError("changed");
      if(intent){const journal=readPlacementWriterJournalAnchors(home,b.epochHash),anchor=intent.revision.journal;
        if(anchor.sequence>journal.sequence||(anchor.sequence===0?b.epochHash:journal.records[anchor.sequence-1]?.seal)!==anchor.headHash)throw new WriterRenewalError("changed");}
    };
    metadata();
    if(cleanupOnly){
      person(options,intent!);clearWriterRenewalIntent(home,intent!,{mutation,assertCurrent:metadata});
      return{mode:options.mode,active:true,renewed:false,alreadyCommitted:true,sequence:history.sequence,remainingRevisions:WRITER_REVISION_LIMIT-history.sequence};
    }
    if(!intent){
      journalClear(home,b.epochHash);sourceCheck?.();
      const current=readWriterHistory(home,{...b,initialLocatorHash:locator.seal});
      if(current.sequence>=WRITER_REVISION_LIMIT)throw new SharedWriterRevisionError("cap");
      const candidate=initialPlacementWriterContext(home,options.writerRoots,options.ownRoot);if(candidate.measurement.roots.some(r=>!supported(r.version)))throw new WriterRenewalError("candidate");
      candidate.attest();const previous=current.current?writerRevisionWriters(current.current):initial.activation.writers;
      if(canonicalJSON(previous)===canonicalJSON(candidate.measurement.writers))return{mode:options.mode,active:true,renewed:false,sequence:current.sequence,remainingRevisions:WRITER_REVISION_LIMIT-current.sequence};
      const journal=readPlacementJournal(home,b.epochHash),revision=createWriterRevision({schema:WRITER_REVISION_SCHEMA,...b,initialLocatorHash:locator.seal,sequence:current.sequence+1,previousHash:current.headHash,
        journal:{sequence:journal.sequence,headHash:journal.headHash},roots:candidate.measurement.roots,requestId:randomBytes(32).toString("hex")});
      intent=createWriterRenewalIntent({schema:WRITER_RENEWAL_INTENT_SCHEMA,home,revision,commit:createWriterCommit(revision),previousLogBytes:current.logBytes,previousLogHash:current.logHash});
    }
    const fixed=intent;person(options,fixed);
    const log=join(home,"sync-placement","epochs",b.epochHash,WRITER_COMMIT_LOG);
    const started=()=>{const s=lstatSync(log,{throwIfNoEntry:false});return!!s&&s.isFile()&&!s.isSymbolicLink()&&s.size>fixed.previousLogBytes;};
    const check=()=>{
      metadata();
      try{writerRenewalCapacity(home,b.epochHash,fixed.revision.sequence);}catch{throw new WriterRenewalError("capacity",`(remaining ${WRITER_REVISION_LIMIT-history.sequence} revision slots before the independent 64-revision ceiling)`);}
      if(!started()&&options.mode!=="abandon"){
        journalClear(home,b.epochHash);sourceCheck?.();
        const candidate=initialPlacementWriterContext(home,fixed.revision.roots.map(r=>r.root),options.ownRoot);candidate.attest();
        if(canonicalJSON(candidate.measurement.roots)!==canonicalJSON(fixed.revision.roots))throw new WriterRenewalError("changed");
        const j=readPlacementJournal(home,b.epochHash);if(j.sequence!==fixed.revision.journal.sequence||j.headHash!==fixed.revision.journal.headHash)throw new WriterRenewalError("changed");
      }
    };
    const storage={mutation,assertCurrent:check,phase:(phase:WriterHistoryPhase)=>options.renewalCheckpoint?.(phase)};
    if(options.mode==="abandon"){
      abandonWriterRenewal(home,fixed,{...storage,assertCurrent:metadata});
      return{mode:options.mode,active:true,abandoned:true,sequence:history.sequence,remainingRevisions:WRITER_REVISION_LIMIT-history.sequence};
    }
    check();writeWriterRenewalIntent(home,fixed,storage);writeWriterRevision(home,fixed,storage);appendWriterCommit(home,fixed,storage);
    clearWriterRenewalIntent(home,fixed,{...storage,assertCurrent:metadata});
    return{mode:options.mode,active:true,renewed:true,epochHash:b.epochHash,sequence:fixed.revision.sequence,revisionHash:fixed.commit.seal,remainingRevisions:WRITER_REVISION_LIMIT-fixed.revision.sequence};
  });
}
