/** Shared pure event scheduling for sync and read-only prospective planning. */
import { canonicalJSON, hashJSON } from "./generation.ts";
import { placementKeyId, type PlacementEvent, type PlacementHoldReason, type PlacementRealm } from "./sync-placement-journal-format.ts";
import type { PlacementProjection } from "./sync-placement-projection.ts";
import type { PlacementPublicationBundle, PlacementPublicationDecision } from "./sync-placement-publication-plan.ts";
import type { ShardHistory } from "./shard-sync-history.ts";
import { PlacementSyncRefusal } from "./sync-placement-refusal.ts";
const sameRealm = (a: PlacementRealm, b: PlacementRealm) => canonicalJSON(a) === canonicalJSON(b);
function refuse(): never { throw new PlacementSyncRefusal(); }

export function* placementPublicationEventSteps(bundle:PlacementPublicationBundle,projection:PlacementProjection,old:(ShardHistory|undefined)[]):Generator<void,{events:PlacementEvent[];preCount:number;holdCount:number},void>{
    const decisions=bundle.chunks.filter(chunk=>chunk.kind==="decisions").flatMap(chunk=>chunk.items as PlacementPublicationDecision[]).sort((a,b)=>placementKeyId(a.key).localeCompare(placementKeyId(b.key)));
    const holds:PlacementEvent[]=[],known:PlacementEvent[]=[],ambiguous:PlacementEvent[]=[],committed:PlacementEvent[]=[];
    const root=bundle.root;
    const make=(decision:PlacementPublicationDecision,kind:PlacementEvent["kind"],commit?:string):PlacementEvent=>{
      const base={requestId:hashJSON({attempt:root.seal,key:decision.key,kind,commit:commit??null}),key:decision.key,sourcePlacement:decision.sourcePlacement,
        effectHash:hashJSON({attempt:root.seal,context:root.contextHash,key:decision.key,kind,commit:commit??null})};
      if(kind==="hold"){
        const reason=decision.reason;
        const hold:PlacementHoldReason=reason==="secret"||reason==="personal-data"||reason==="deny-path"||reason==="private-or-invalid"||reason==="host"||reason==="person-local"?reason:"related-local";
        return{...base,kind,reason:hold};
      }
      const index=root.targets.findIndex(target=>sameRealm(target.realm,decision.key.realm));if(index<0)refuse();
      const outcome={attemptHash:root.seal,remoteHash:root.remoteHash,refHash:root.targets[index]!.refHash};
      if(kind==="publication-ambiguous")return{...base,kind,outcome};
      if(kind!=="publication-committed"||!commit)refuse();
      return{...base,kind,outcome:{...outcome,commit,proofHash:hashJSON({attempt:root.seal,key:decision.key,commit,remote:root.remoteHash,ref:root.targets[index]!.refHash})}};
    };
    let stepped=0;
    for(const decision of decisions){
      if(++stepped>=64){stepped=0;yield;}
      const state=projection.get(decision.key);
      const index=root.targets.findIndex(target=>sameRealm(target.realm,decision.key.realm)),target=root.targets[index];if(!target)refuse();
      const original=old[index]?.rows.get(decision.key.id),published=original&&hashJSON(original)===decision.key.rowHash;
      if(decision.hold)holds.push(make(decision,"hold"));
      if(published&&state?.exposure!=="published"&&target.expectedRemoteHead)known.push(make(decision,"publication-committed",target.expectedRemoteHead));
      if(decision.eligible&&target.publish&&!published){
        ambiguous.push(make(decision,"publication-ambiguous"));committed.push(make(decision,"publication-committed",target.commit!));
      }
    }
    return{events:[...holds,...known,...ambiguous,...committed],preCount:holds.length+known.length+ambiguous.length,holdCount:holds.length};
  }

