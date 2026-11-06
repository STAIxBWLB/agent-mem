/** Expected inventory metadata only. Callers must still obtain fresh install attestations. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { readActivePlacementBinding, type ActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementWriterJournalAnchors, placementWriterJournalToken } from "./sync-placement-journal-storage.ts";
import { readWriterHistory } from "./sync-placement-writer-history.ts";
import { SharedWriterRevisionError, writerRevisionWriters } from "./sync-placement-writer-revision-format.ts";
import { readInitialSyncPlacementWriterLocator, SYNC_PLACEMENT_WRITER_ROOTS_FILE } from "./sync-placement-writer-roots.ts";
import { requireWriterRenewalHomeFloor } from "./sync-placement-prerequisites.ts";
import type { SyncPlacementWriterAttestation } from "./sync-placement-plan.ts";

export interface EffectiveSyncPlacementWriters {
  epochHash:string;activationHash:string;revisionSequence:number;revisionHash:string;roots?:readonly string[];
  writers:readonly SyncPlacementWriterAttestation[];initialLocatorHash?:string;
  assertCurrent():void;
}
function fail():never{throw new SharedWriterRevisionError("changed");}
function active(home:string):ActivePlacementBinding {
  const markers=readPlacementRuntimeMarkers(home),value=readActivePlacementBinding(home,markers.profile,markers.shards);if(!value)fail();return value;
}
const key=(value:ActivePlacementBinding)=>hashJSON({epoch:value.epoch,activation:value.activation,head:value.profile.placementHead,generation:value.profile.generation});
const fileStamp=(home:string)=>{
  const s=lstatSync(join(home,SYNC_PLACEMENT_WRITER_ROOTS_FILE),{bigint:true,throwIfNoEntry:false});
  return s?[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":"):undefined;
};
export function readEffectiveSyncPlacementWriters(home:string):EffectiveSyncPlacementWriters {
  const binding=active(home),bindingKey=key(binding),epochHash=binding.profile.placementHead;
  const history=readWriterHistory(home,{epochHash,activationHash:binding.activation.seal,homeHash:binding.epoch.homeHash,generation:binding.epoch.generation});
  const initialStamp=fileStamp(home),initial=initialStamp===undefined?undefined:readInitialSyncPlacementWriterLocator(home);
  if(history.sequence){
    requireWriterRenewalHomeFloor(home);
    if(!initial||history.current?.initialLocatorHash!==initial.seal)fail();
  }
  let anchorToken:string|undefined;
  // ponytail: native inode/size/ctime identity permits prefix reuse; hostile same-user rewrites need immutable snapshot blocks.
  const anchors=()=>{
    if(!history.sequence)return;
    const token=placementWriterJournalToken(home,epochHash);if(token===anchorToken)return;
    const journal=readPlacementWriterJournalAnchors(home,epochHash);
    if(journal.epoch.homeHash!==binding.epoch.homeHash||journal.activation.seal!==binding.activation.seal)fail();
    for(const anchor of history.anchors){
      if(anchor.sequence>journal.sequence||(anchor.sequence===0?epochHash:journal.records[anchor.sequence-1]?.seal)!==anchor.headHash)fail();
    }
    if(placementWriterJournalToken(home,epochHash)!==token)fail();anchorToken=token;
  };
  const assertCurrent=()=>{
    history.assertCurrent();if(key(active(home))!==bindingKey||fileStamp(home)!==initialStamp)fail();
    if(initial&&readInitialSyncPlacementWriterLocator(home).seal!==initial.seal)fail();
    if(history.sequence)requireWriterRenewalHomeFloor(home);
    anchors();history.assertCurrent();
  };
  anchors();assertCurrent();
  const roots=history.current?.roots.map(root=>root.root)??initial?.roots.map(root=>root.root);
  return{epochHash,activationHash:binding.activation.seal,revisionSequence:history.sequence,revisionHash:history.headHash,
    writers:history.current?writerRevisionWriters(history.current):binding.activation.writers,
    ...(roots?{roots}:{}),...(initial?{initialLocatorHash:initial.seal}:{}),assertCurrent};
}
/** Locators only; these paths and expected pins never replace a fresh callback. */
export function readEffectiveSyncPlacementWriterRoots(home:string):string[]{
  const value=readEffectiveSyncPlacementWriters(home);if(!value.roots)throw new SharedWriterRevisionError("invalid");value.assertCurrent();return[...value.roots];
}
/** Keep existing no-revision artifacts byte-identical while binding renewed attempts to their committed head. */
export function writerBoundPlacementContextHash(context:unknown,inventory?:Pick<EffectiveSyncPlacementWriters,"revisionSequence"|"revisionHash">):string {
  return inventory?.revisionSequence?hashJSON(["agent-mem.sync-placement-writer-bound-context/v1",context,inventory.revisionHash]):hashJSON(context);
}
