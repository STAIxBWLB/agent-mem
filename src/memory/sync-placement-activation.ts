/** Person-only home-wide initial activation. No automatic migration, renewal or transport. */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON, withProfileLock, writeProfileJSON, fsyncDirectory } from "./generation.ts";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
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
import { writeSyncPlacementWriterRoots, readSyncPlacementWriterRoots, SYNC_PLACEMENT_WRITER_ROOTS_FILE } from "./sync-placement-writer-roots.ts";
import { requirePlacementActivationPrerequisites, requirePlacementHomeFloor } from "./sync-placement-prerequisites.ts";
import { outboundPolicyEvaluator, type SyncPolicyCategory } from "./sync-screen.ts";
import { initialPlacementWriterContext, previewActivePlacementWriters, PlacementWriterContextError, type PlacementWriterContext } from "../sync-placement-writer-context.ts";

export type PlacementActivationStage = "after-intent"|"after-epoch"|"after-root-map"|"after-shards"|"after-profile"|"after-fence"|"after-remove";
export interface PlacementActivationOptions {
  memoryDir: string; mode: "dry-run"|"apply"|"resume"; writerRoots: readonly string[]; ownRoot: string;
  authorize(binding: Readonly<{seal:string;generation:string;homeHash:string}>): boolean;
  checkpoint?(stage: PlacementActivationStage): void|Promise<void>;
}
export class PlacementActivationError extends Error {
  constructor(readonly causeClass: "readers"|"busy"|"changed"|"metadata"|"authorization"|"pending"|"bound") {
    super(`Sync placement activation failed (${causeClass}); close cooperating writers, inspect retained activation evidence and run amem migrate --sync-placement --resume. This transition is forward-only; do not restore v2 markers.`);
    this.name="PlacementActivationError";
  }
}
const fail = (cause: PlacementActivationError["causeClass"]): never => { throw new PlacementActivationError(cause); };
function counts(source: PlacementSourcePreview) {
  const evaluate = outboundPolicyEvaluator(source.home), categories: Partial<Record<SyncPolicyCategory,number>> = {};
  let eligibleOriginals=0,declined=0,intrinsicLocal=0;
  for (const row of [...source.rows.values(),...source.specialRows.values()]) {
    if (row.intrinsicLocal || row.sourcePlacement!=="synced") { intrinsicLocal++; continue; }
    const verdict=evaluate(row.row as unknown as Record<string,unknown>);
    if (verdict.ok) eligibleOriginals++; else { declined++;categories[verdict.category]=(categories[verdict.category]??0)+1; }
  }
  source.assertSourcesUnchanged();
  return {selected:source.rows.size+source.specialRows.size,eligibleOriginals,declined,intrinsicLocal,categories,dependencyDecisions:"deferred-to-sync" as const};
}
function committed(home:string,intent:PlacementActivationIntent) {
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
function authorize(options:PlacementActivationOptions,intent:PlacementActivationIntent) {
  let okay=false;try{okay=options.authorize(Object.freeze({seal:intent.plan.seal,generation:intent.epoch.generation,homeHash:intent.epoch.homeHash}))===true;}catch{fail("authorization");}
  if(!okay)fail("authorization");
}
async function fenced<T>(home:string,directories:readonly string[],work:(mutation:MutationHandle,owner:ReturnType<typeof createPlacementActivationOwner>)=>Promise<T>):Promise<T> {
  return withProfileLock(home,async()=>{
    const releases:(()=>void)[]=[];
    try {
      const transports=["shard-sync","shard-sync-placement"].map(name=>join(home,name)).filter(dir=>lstatSync(dir,{throwIfNoEntry:false})!==undefined);
      const dirs=[...new Set([home,...directories,...transports])].sort();let mutation:MutationHandle|undefined;
      for(const dir of dirs){
        try{assertNoLiveReaders(dir,{includeShards:true});}catch{fail("readers");}
        const handle=acquireMutation(dir);if(!handle)fail("busy");releases.push(handle);if(dir===home)mutation=handle;
      }
      if(!mutation)fail("busy");
      for(const dir of [home,...transports]){const release=generationSyncLock(dir);if(!release)fail("busy");releases.push(release);}
      const owner=createPlacementActivationOwner(home,mutation);return await work(mutation,owner);
    }finally{for(const release of releases.reverse())release();}
  });
}
export async function activateSyncPlacement(options:PlacementActivationOptions) {
  if(!["dry-run","apply","resume"].includes(options.mode)||typeof options.authorize!=="function")fail("authorization");
  let home:string;
  try{home=realPath(options.memoryDir);}catch{throw Error("Sync placement memory home is unavailable; select an existing private home and run amem migrate --sync-placement --dry-run.");}
  const pending=readPlacementActivationIntent(home);
  const initialBase=pending?undefined:requirePlacementActivationPrerequisites(home);
  const initialFloorHash=pending?requirePlacementHomeFloor(home):initialBase!.floorHash;
  if(options.mode==="resume"&&!pending)throw Error("No retained sync placement activation exists; run amem migrate --sync-placement --dry-run to review an initial activation.");
  if(pending&&options.mode!=="resume")throw Error("Sync placement activation is retained; run amem migrate --sync-placement --resume rather than creating a new plan.");
  if(!pending){
    const base=initialBase!;
    if(base.active){
      if(options.mode==="apply")throw Error("Sync placement is already active; restore the inventoried install, or renew the writer inventory with an amem release that supports renewal. Preview differences with amem migrate --sync-placement --dry-run.");
      return{mode:options.mode,active:true,forwardOnly:true,renewalSupported:false,writers:previewActivePlacementWriters(home,options.ownRoot,options.writerRoots),source:counts(previewSyncPlacementSources(home))};
    }
  }
  const source=pending?undefined:previewSyncPlacementSources(home);
  const writer=pending?undefined:initialPlacementWriterContext(home,options.writerRoots,options.ownRoot);
  const report=source?counts(source):undefined;
  if(options.mode==="dry-run")return{mode:options.mode,active:false,forwardOnly:true,quiescence:"deferred-to-apply",realms:source!.base.realms.length,writers:writer!.measurement.roots,source:report};
  if(!pending&&!options.writerRoots.length)throw Error("Initial sync placement apply requires an explicit complete --writer-root inventory; run amem migrate --sync-placement --dry-run, then apply the reviewed roots.");
  const directories=pending?pending.plan.realms.map(realm=>realm.scope==="user"?join(home,"user"):join(home,"projects",realm.keyHash.slice(0,16))):source!.directories;
  try{return await fenced(home,directories,async(mutation,owner)=>{
    let intent=pending;
    const initialCheck=()=>{assertPlacementActivationOwner(owner);source!.assertSourcesUnchanged();writer!.attest();if(requirePlacementHomeFloor(home)!==initialFloorHash)fail("changed");};
    if(!intent){
      initialCheck();const facts=writer!.attest(),context={...source!.base,writers:facts.writers,legacySyncQuiesced:true as const};
      const epoch:PlacementEpoch={schema:PLACEMENT_EPOCH_SCHEMA,publicationFormat:PLACEMENT_FORMAT,generation:(context.profile as {generation:string}).generation,homeHash:context.homeHash,contextHash:hashJSON(context),nonce:randomBytes(16).toString("hex")};
      const plan=planSyncPlacementActivation(context,placementEpochHash(epoch));
      intent=sealPlacementActivationIntent({schema:PLACEMENT_ACTIVATION_INTENT_SCHEMA,home,epoch,plan,roots:writer!.measurement.roots.map(row=>row.root).sort(),previousProfile:source!.markers.profileText,previousShards:source!.markers.shardsText,profileStamp:source!.markers.profileStamp,shardsStamp:source!.markers.shardsStamp,floorHash:initialFloorHash});
      validateSyncPlacementActivation(plan,{current:()=>{initialCheck();return context;},authorize:()=>{authorize(options,intent!);return true;}});
      writePlacementActivationIntent(home,intent,{mutation,assertCurrent:initialCheck});
    }
    const fixed=intent,epochHash=placementEpochHash(fixed.epoch);
    const metadataCheck=()=>{assertPlacementActivationOwner(owner);requirePlacementHomeFloor(home);if(!committed(home,fixed))fail("changed");readSyncPlacementWriterRoots(home);assertMutationHandle(mutation,home);};
    const finish=async()=>{
      authorize(options,fixed);metadataCheck();
      for(const name of ["profile.json","shards.json",SYNC_PLACEMENT_WRITER_ROOTS_FILE,join("sync-placement","epochs",epochHash,"epoch.json"),join("sync-placement","epochs",epochHash,"activation.json")]){metadataCheck();syncFile(join(home,name));}
      ensurePlacementFence(home,epochHash,{mutation,assertCurrent:metadataCheck});metadataCheck();
      clearPlacementActivationIntent(home,fixed,{mutation,assertCurrent:metadataCheck});await options.checkpoint?.("after-remove");metadataCheck();
      return{mode:options.mode,active:true,forwardOnly:true,epochHash,generation:fixed.epoch.generation,writers:fixed.plan.writers.length,source:report,resumed:options.mode==="resume"};
    };
    if(committed(home,fixed))return finish();
    const current:PlacementWriterContext=writer??initialPlacementWriterContext(home,fixed.roots,options.ownRoot);
    if(canonicalJSON(current.measurement.writers)!==canonicalJSON(fixed.plan.writers))fail("changed");
    const proof=createPlacementActivationCaptureProof(owner,fixed);
    const check=()=>{assertPlacementActivationOwner(owner);if(requirePlacementHomeFloor(home)!==fixed.floorHash)fail("changed");current.attest();const captured=captureSyncPlacementActivationContext(home,{attest:current.attest},proof);if(hashJSON(captured.context)!==fixed.plan.contextHash)fail("changed");captured.assertUnchanged();assertPlacementActivationOwner(owner);};
    authorize(options,fixed);check();writePlacementActivationIntent(home,fixed,{mutation,assertCurrent:check});await options.checkpoint?.("after-intent");check();
    preparePlacementEpoch(home,fixed.epoch,fixed.plan,{mutation,assertCurrent:check});await options.checkpoint?.("after-epoch");check();
    writeSyncPlacementWriterRoots(home,{epochHash,homeHash:fixed.epoch.homeHash,activationHash:fixed.plan.seal,roots:current.measurement.roots},fixed.plan.writers,{mutation,assertCurrent:check});await options.checkpoint?.("after-root-map");check();
    const final=placementActivationFinalMarkers(fixed),markers=readPlacementRuntimeMarkers(home);
    if(canonicalJSON(markers.shards)+"\n"!==final.shards)writeProfileJSON(join(home,"shards.json"),JSON.parse(final.shards));else syncFile(join(home,"shards.json"));
    await options.checkpoint?.("after-shards");check();
    if(canonicalJSON(readPlacementRuntimeMarkers(home).profile)+"\n"!==final.profile)writeProfileJSON(join(home,"profile.json"),JSON.parse(final.profile));else syncFile(join(home,"profile.json"));
    await options.checkpoint?.("after-profile");check();
    ensurePlacementFence(home,epochHash,{mutation,assertCurrent:check});await options.checkpoint?.("after-fence");metadataCheck();return finish();
  });}catch(error){
    if(error&&typeof error==="object"&&!types.isProxy(error)){
      if(error instanceof PlacementWriterContextError||error instanceof PlacementActivationError)throw error;
      if(error instanceof SyncPlacementJournalError||error instanceof SyncPlacementPlanError){
        const code=Object.getOwnPropertyDescriptor(error,"code");
        if(code&&"value" in code){if(code.value==="bound")fail("bound");if(code.value==="busy")fail("busy");if(code.value==="changed")fail("changed");if(code.value==="authorization")fail("authorization");}
      }
    }
    fail("metadata");
  }
}
