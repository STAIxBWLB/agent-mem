/** Person-only home-wide initial activation. No automatic migration, renewal or transport. */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON, writeProfileJSON, fsyncDirectory } from "./generation.ts";
import { invalidateCuratedCaches } from "./curated-cache-state.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { withPlacementActivationFences, PlacementInventoryFenceError } from "./sync-placement-activation-locks.ts";
import { realPath } from "./platform.ts";
import { planSyncPlacementActivation, validateSyncPlacementActivation, SyncPlacementPlanError } from "./sync-placement-plan.ts";
import { PLACEMENT_EPOCH_SCHEMA, placementEpochHash, SyncPlacementJournalError, type PlacementEpoch } from "./sync-placement-journal-format.ts";
import { preparePlacementEpoch, ensurePlacementFence } from "./sync-placement-journal-storage.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import { captureSyncPlacementActivationContext, previewSyncPlacementSources, type PlacementSourcePreview } from "./sync-placement-capture.ts";
import { createPlacementActivationOwner, assertPlacementActivationOwner, createPlacementActivationCaptureProof } from "./sync-placement-activation-proof.ts";
import { sealPlacementActivationIntent, readPlacementActivationIntent, writePlacementActivationIntent, clearPlacementActivationIntent, placementActivationFinalMarkers, PLACEMENT_ACTIVATION_INTENT_SCHEMA, type PlacementActivationIntent } from "./sync-placement-activation-storage.ts";
import { writeSyncPlacementWriterRoots, readSyncPlacementWriterRoots, planSyncPlacementWriterRoots, SYNC_PLACEMENT_WRITER_ROOTS_FILE } from "./sync-placement-writer-roots.ts";
import { SyncPlacementWriterError } from "./sync-placement-writers.ts";
import { requirePlacementActivationPrerequisites, requirePlacementHomeFloor } from "./sync-placement-prerequisites.ts";
import { outboundPolicyEvaluator, type SyncPolicyCategory } from "./sync-screen.ts";
import { initialPlacementWriterContext, PlacementWriterContextError, type PlacementWriterContext } from "../sync-placement-writer-context.ts";
import { abandonPlacementActivation, PlacementActivationAbandonError } from "./sync-placement-abandon.ts";
import { renewSyncPlacementWriters } from "./sync-placement-writer-renewal.ts";
import type { WriterHistoryPhase } from "./sync-placement-writer-history.ts";

export type PlacementActivationStage = "after-intent"|"after-epoch"|"after-root-map"|"after-shards"|"after-profile"|"after-fence"|"after-remove";
export interface PlacementActivationOptions {
  memoryDir: string; mode: "dry-run"|"apply"|"resume"|"abandon"; writerRoots: readonly string[]; ownRoot: string;
  authorize(binding: Readonly<{seal:string;generation:string;homeHash:string}>): boolean;
  checkpoint?(stage: PlacementActivationStage): void|Promise<void>;
  /** Internal renewal fault seam; the CLI never supplies it. */
  renewalCheckpoint?(stage:WriterHistoryPhase):void;
  /** Internal fault-test observer, never supplied by CLI options. */
  testOnlyFailure?(error: unknown): void;
}
export class PlacementActivationError extends Error {
  constructor(readonly causeClass: "readers"|"busy"|"changed"|"metadata"|"authorization"|"pending"|"bound") {
    super(`Sync placement activation failed (${causeClass}); close cooperating writers and run amem migrate --sync-placement --dry-run before retrying apply. If an activation intent is retained, use --resume, or --abandon only while both markers are still the original v2 bytes. Once a v3 marker exists, resume is forward-only; never restore v2 markers.`);
    this.name="PlacementActivationError";
  }
}
export class PlacementActivationInputError extends Error {
  constructor(readonly inputClass:"policy"|"source"|"aliases"|"writer root"|"receipt"|"floor"){
    super(`Sync placement activation frozen ${inputClass} input changed or is unavailable; restore that input and run amem migrate --sync-placement --resume. If both markers still contain their original v2 bytes, the person may run amem migrate --sync-placement --abandon, then review a fresh --dry-run and --apply. Once any v3 marker exists, only forward resume is supported.`);
    this.name="PlacementActivationInputError";
  }
}
function writerInputFailure(error:unknown):never {
  const category=error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof PlacementWriterContextError?Object.getOwnPropertyDescriptor(error,"category")?.value:undefined;
  throw new PlacementActivationInputError(category==="setup receipt"?"receipt":"writer root");
}
function fail(cause: PlacementActivationError["causeClass"]): never { throw new PlacementActivationError(cause); }
function rethrowActivationFailure(error:unknown):never {
    if(error&&typeof error==="object"&&!types.isProxy(error)){
      if(error instanceof PlacementInventoryFenceError)fail(error.causeClass);
      if(error instanceof PlacementWriterContextError||error instanceof PlacementActivationError||error instanceof PlacementActivationInputError||error instanceof PlacementActivationAbandonError)throw error;
      if(error instanceof SyncPlacementJournalError||error instanceof SyncPlacementPlanError||error instanceof SyncPlacementWriterError){
        const code=Object.getOwnPropertyDescriptor(error,"code");
        if(code&&"value" in code){if(code.value==="bound")fail("bound");if(code.value==="busy")fail("busy");if(code.value==="changed")fail("changed");if(code.value==="authorization")fail("authorization");}
      }
    }
    fail("metadata");
}
function counts(source: PlacementSourcePreview) {
  const evaluate = outboundPolicyEvaluator(source.home), categories: Partial<Record<SyncPolicyCategory,number>> = {};
  let eligibleOriginals=0,declined=0,intrinsicLocal=0;
  for (const row of [...source.rows.values(),...source.specialRows.values()]) {
    if (row.intrinsicLocal || row.sourcePlacement!=="synced") { intrinsicLocal++; continue; }
    const verdict=evaluate(row.row as unknown as Record<string,unknown>);
    if (verdict.ok) eligibleOriginals++; else { declined++;categories[verdict.category]=(categories[verdict.category]??0)+1; }
  }
  source.assertSourcesUnchanged();
  return {selected:source.rows.size+source.specialRows.size,policyPermittedOriginals:eligibleOriginals,declined,intrinsicLocal,categories,dependencyDecisions:"deferred-to-sync" as const};
}
function committed(home:string,intent:Pick<PlacementActivationIntent,"epoch"|"plan">) {
  const markers=readPlacementRuntimeMarkers(home);
  if ((markers.profile as {schema?:string})?.schema!=="agent-mem.profile/v3"||(markers.shards as {schema?:string})?.schema!=="agent-mem.shards/v3") return false;
  const binding=readActivePlacementBinding(home,markers.profile,markers.shards);
  return binding?.profile.placementHead===placementEpochHash(intent.epoch)&&binding.activation.seal===intent.plan.seal;
}
function syncFile(file:string) {
  const before=lstatSync(file,{bigint:true});
  if (!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.uid!==BigInt(process.getuid?.()??-1)||(before.mode&0o077n)!==0n) fail("metadata");
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try { const actual=fstatSync(fd,{bigint:true}); if(actual.dev!==before.dev||actual.ino!==before.ino||actual.size!==before.size)fail("changed");fsyncSync(fd); }
  finally{closeSync(fd);}fsyncDirectory(join(file,".."));
}
function authorize(options:PlacementActivationOptions,intent:Pick<PlacementActivationIntent,"epoch"|"plan">) {
  let okay=false;try{okay=options.authorize(Object.freeze({seal:intent.plan.seal,generation:intent.epoch.generation,homeHash:intent.epoch.homeHash}))===true;}catch{fail("authorization");}
  if(!okay)fail("authorization");
}
async function finishCommittedActivation(home:string,binding:Pick<PlacementActivationIntent,"epoch"|"plan">,options:PlacementActivationOptions,
  mutation:MutationHandle,owner:ReturnType<typeof createPlacementActivationOwner>,intent?:PlacementActivationIntent,report?:ReturnType<typeof counts>) {
  const epochHash=placementEpochHash(binding.epoch);
  const check=()=>{assertPlacementActivationOwner(owner);requirePlacementHomeFloor(home);if(!committed(home,binding))fail("changed");readSyncPlacementWriterRoots(home);assertMutationHandle(mutation,home);};
  authorize(options,binding);check();
  for(const name of ["profile.json","shards.json",SYNC_PLACEMENT_WRITER_ROOTS_FILE,join("sync-placement","epochs",epochHash,"epoch.json"),join("sync-placement","epochs",epochHash,"activation.json")]){check();syncFile(join(home,name));}
  ensurePlacementFence(home,epochHash,{mutation,assertCurrent:check});check();
  if(intent)clearPlacementActivationIntent(home,intent,{mutation,assertCurrent:check});else fsyncDirectory(home);
  await options.checkpoint?.("after-remove");check();
  return{mode:options.mode,active:true,forwardOnly:true,epochHash,generation:binding.epoch.generation,writers:binding.plan.writers.length,source:report,resumed:options.mode==="resume",alreadyCommitted:!intent,writerProof:"not-claimed-during-committed-cleanup" as const};
}
export async function activateSyncPlacement(options:PlacementActivationOptions) {
  if(!["dry-run","apply","resume","abandon"].includes(options.mode)||typeof options.authorize!=="function")fail("authorization");
  let home:string;
  try{home=realPath(options.memoryDir);}catch{throw Error("Sync placement memory home is unavailable; select an existing private home and run amem migrate --sync-placement --dry-run.");}
  const pending=readPlacementActivationIntent(home);
  if(!pending&&requirePlacementActivationPrerequisites(home).active){
    const renewed=await renewSyncPlacementWriters(options);if(renewed)return renewed;
  }
  if(options.mode==="abandon"){
    if(!pending)throw Error("No initial sync placement intent is retained; use amem migrate --sync-placement --dry-run to inspect the home. Active v3 placement cannot be abandoned or downgraded.");
    const dirs=pending.plan.realms.map(realm=>realm.scope==="user"?join(home,"user"):join(home,"projects",realm.keyHash.slice(0,16)));
    return withPlacementActivationFences(home,dirs,async(mutation,owner)=>{
      authorize(options,pending);
      abandonPlacementActivation(home,pending,{mutation,assertCurrent:()=>assertPlacementActivationOwner(owner)});
      return{mode:options.mode,active:false,abandoned:true,forwardOnly:true,nextStep:"amem migrate --sync-placement --dry-run"};
    }).catch(error=>rethrowActivationFailure(error));
  }
  const initialBase=pending?undefined:requirePlacementActivationPrerequisites(home);
  let initialFloorHash:string;
  try{initialFloorHash=pending?requirePlacementHomeFloor(home):initialBase!.floorHash;}catch(error){if(pending)throw new PlacementActivationInputError("floor");throw error;}
  if(options.mode==="resume"&&!pending){
    if(!initialBase?.active)throw Error("No retained sync placement activation exists; run amem migrate --sync-placement --dry-run to review an initial activation.");
    const active=initialBase.active,dirs=active.activation.realms.map(realm=>realm.scope==="user"?join(home,"user"):join(home,"projects",realm.keyHash.slice(0,16)));
    return withPlacementActivationFences(home,dirs,(mutation,owner)=>finishCommittedActivation(home,{epoch:active.epoch,plan:active.activation},options,mutation,owner)).catch(error=>rethrowActivationFailure(error));
  }
  if(pending&&options.mode!=="resume")throw Error("Sync placement activation is retained; run amem migrate --sync-placement --resume, or person --abandon while both markers retain the original v2 bytes, before reviewing a new --dry-run.");
  const source=pending?undefined:previewSyncPlacementSources(home);
  const writer=pending?undefined:initialPlacementWriterContext(home,options.writerRoots,options.ownRoot);
  const report=source?counts(source):undefined;
  if(options.mode==="dry-run")return{mode:options.mode,active:false,forwardOnly:true,quiescence:"deferred-to-apply",realms:source!.base.realms.length,writers:writer!.measurement.roots,source:report};
  if(!pending&&!options.writerRoots.length)throw Error("Initial sync placement apply requires an explicit complete --writer-root inventory; run amem migrate --sync-placement --dry-run, then apply the reviewed roots.");
  const directories=pending?pending.plan.realms.map(realm=>realm.scope==="user"?join(home,"user"):join(home,"projects",realm.keyHash.slice(0,16))):source!.directories;
  let previousProjects: string[] | undefined;
  try{
    const result=await withPlacementActivationFences(home,directories,async(mutation,owner)=>{
    let intent=pending;
    const initialCheck=()=>{assertPlacementActivationOwner(owner);source!.assertSourcesUnchanged();writer!.attest();if(requirePlacementHomeFloor(home)!==initialFloorHash)fail("changed");};
    if(!intent){
      initialCheck();const facts=writer!.attest(),context={...source!.base,writers:facts.writers,legacySyncQuiesced:true as const};
      const normalized=planSyncPlacementActivation(context,"0".repeat(64));context.writers=normalized.writers;context.realms=normalized.realms;
      const epoch:PlacementEpoch={schema:PLACEMENT_EPOCH_SCHEMA,publicationFormat:PLACEMENT_FORMAT,generation:(context.profile as {generation:string}).generation,homeHash:context.homeHash,contextHash:hashJSON(context),nonce:randomBytes(16).toString("hex")};
      const plan=planSyncPlacementActivation(context,placementEpochHash(epoch));
      intent=sealPlacementActivationIntent({schema:PLACEMENT_ACTIVATION_INTENT_SCHEMA,home,epoch,plan,roots:writer!.measurement.roots.map(row=>row.root).sort(),previousProfile:source!.markers.profileText,previousShards:source!.markers.shardsText,profileStamp:source!.markers.profileStamp,shardsStamp:source!.markers.shardsStamp,floorHash:initialFloorHash,inputHashes:{sourceHash:context.sourceHash,aliasesHash:context.aliasesHash,policyHash:context.policyHash}});
      // All future initial-locator framing/binding limits must fit before retaining an exclusive activation intent.
      const epochHash=placementEpochHash(epoch);
      planSyncPlacementWriterRoots({epochHash,homeHash:epoch.homeHash,activationHash:plan.seal,roots:writer!.measurement.roots},
        {epochHash,homeHash:epoch.homeHash,activationHash:plan.seal,writers:plan.writers});
      validateSyncPlacementActivation(plan,{current:()=>{initialCheck();return context;},authorize:()=>{authorize(options,intent!);return true;}});
      writePlacementActivationIntent(home,intent,{mutation,assertCurrent:initialCheck});
    }
    const fixed=intent,epochHash=placementEpochHash(fixed.epoch);
    const metadataCheck=()=>{assertPlacementActivationOwner(owner);requirePlacementHomeFloor(home);if(!committed(home,fixed))fail("changed");readSyncPlacementWriterRoots(home);assertMutationHandle(mutation,home);};
    if(committed(home,fixed)){
      previousProjects=invalidateCuratedCaches(home);
      return finishCommittedActivation(home,fixed,options,mutation,owner,fixed,report);
    }
    let current:PlacementWriterContext;
    try{current=writer??initialPlacementWriterContext(home,fixed.roots,options.ownRoot);}catch(error){writerInputFailure(error);}
    if(canonicalJSON(current.measurement.writers)!==canonicalJSON(fixed.plan.writers))throw new PlacementActivationInputError("writer root");
    const proof=createPlacementActivationCaptureProof(owner,fixed);
    const check=()=>{
      assertPlacementActivationOwner(owner);
      try{if(requirePlacementHomeFloor(home)!==fixed.floorHash)throw Error();}catch{throw new PlacementActivationInputError("floor");}
      try{current.attest();}catch(error){writerInputFailure(error);}
      let captured:ReturnType<typeof captureSyncPlacementActivationContext>;
      try{captured=captureSyncPlacementActivationContext(home,{attest:current.attest},proof);}catch(error){if(current.lastRefusal)writerInputFailure(current.lastRefusal);throw new PlacementActivationInputError("source");}
      if(captured.context.policyHash!==fixed.inputHashes.policyHash)throw new PlacementActivationInputError("policy");
      if(captured.context.aliasesHash!==fixed.inputHashes.aliasesHash)throw new PlacementActivationInputError("aliases");
      if(captured.context.sourceHash!==fixed.inputHashes.sourceHash||hashJSON(captured.context)!==fixed.plan.contextHash)throw new PlacementActivationInputError("source");
      try{captured.assertUnchanged();}catch(error){if(current.lastRefusal)writerInputFailure(current.lastRefusal);throw new PlacementActivationInputError("source");}
      assertPlacementActivationOwner(owner);
    };
    authorize(options,fixed);check();writePlacementActivationIntent(home,fixed,{mutation,assertCurrent:check});await options.checkpoint?.("after-intent");check();
    preparePlacementEpoch(home,fixed.epoch,fixed.plan,{mutation,assertCurrent:check});await options.checkpoint?.("after-epoch");check();
    writeSyncPlacementWriterRoots(home,{epochHash,homeHash:fixed.epoch.homeHash,activationHash:fixed.plan.seal,roots:current.measurement.roots},fixed.plan.writers,{mutation,assertCurrent:check});await options.checkpoint?.("after-root-map");check();
    const final=placementActivationFinalMarkers(fixed),markers=readPlacementRuntimeMarkers(home);
    previousProjects=invalidateCuratedCaches(home);
    if(canonicalJSON(markers.shards)+"\n"!==final.shards)writeProfileJSON(join(home,"shards.json"),JSON.parse(final.shards));else syncFile(join(home,"shards.json"));
    await options.checkpoint?.("after-shards");check();
    if(canonicalJSON(readPlacementRuntimeMarkers(home).profile)+"\n"!==final.profile)writeProfileJSON(join(home,"profile.json"),JSON.parse(final.profile));else syncFile(join(home,"profile.json"));
    await options.checkpoint?.("after-profile");check();
    ensurePlacementFence(home,epochHash,{mutation,assertCurrent:check});await options.checkpoint?.("after-fence");metadataCheck();return finishCommittedActivation(home,fixed,options,mutation,owner,fixed,report);
  });
    if(previousProjects){
      try{await(await import("./curated-cache-maintenance.ts")).rebuildCuratedCachesAfterProfileChange(home,previousProjects);}catch{/* Derived cache work never changes a committed activation result. */}
    }
    return result;
  }catch(error){
    try{options.testOnlyFailure?.(error);}catch{/* observers never affect production outcomes */}
    return rethrowActivationFailure(error);
  }
}
