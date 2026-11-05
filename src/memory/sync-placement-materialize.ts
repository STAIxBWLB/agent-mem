/** Shared internal row materialization. All source/transport authority and effect boundaries belong to the caller. */
import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { SYNC_SCREEN_MAX_BYTES, SYNC_SCREEN_MAX_ROWS, type OutboundVerdict } from "./sync-screen.ts";
import type { PlacementCapture } from "./sync-placement-capture.ts";
import { compilePlacementDependencies, type DependencySource, type VerifiedDependencyEndpoint } from "./sync-placement-dependencies.ts";
import { compilePlacementGitObjects, type PlannedGitObject } from "./sync-placement-git.ts";
import { PLACEMENT_DESCRIPTOR_SCHEMA, PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import { placementKeyId, SyncPlacementJournalError, type PlacementKey, type PlacementRealm } from "./sync-placement-journal-format.ts";
import type { PlacementProjection } from "./sync-placement-projection.ts";
import type { PlacementPublicationBundle, PlacementPublicationDecision, PlacementPublicationObject, PlacementPublicationTarget } from "./sync-placement-publication-plan.ts";
import type { ShardHistory } from "./shard-sync-history.ts";
import { decodeShardPack, encodeShardPacks, encodeShardManifest, shardSyncRef, type ShardSyncRow, type ShardSyncRealm } from "./shard-sync-format.ts";
import { verifyPublicPruneWitness, type PublicPruneWitnessV1, type PublicPruneLineage } from "./public-prune-witness.ts";
import type { Entry } from "./store.ts";
import type { PruneRow } from "./prune.ts";

export interface PlacementMaterializeTarget {
  realm: ShardSyncRealm; generation: string; remote?: string; local?: string;
  fetched: ReadonlySet<string>; localPrunes: ReadonlyMap<string, PruneRow>; pruned: ReadonlySet<string>;
}
export interface PlacementMaterializeSource { key: PlacementKey; row: unknown; sourcePlacement: "local" | "synced" }
export interface PlacementMaterializeInput {
  capture: Pick<PlacementCapture, "rows">; projection: PlacementProjection; generation: string;
  targets: readonly PlacementMaterializeTarget[]; old: readonly (ShardHistory | undefined)[];
  verifiedPrunes: ReadonlySet<string>; evaluate(row: unknown): OutboundVerdict;
  readTree(index: number, head: string): Promise<string>;
  publisherLineages(index: number, rows: readonly PruneRow[]): ReadonlyMap<string, PublicPruneLineage>;
  createdUnixSeconds: number; frozen?: PlacementPublicationBundle;
  /** Caller-validated special originals; the same compiler still validates exact keys and row syntax. */
  extraSources?: readonly PlacementMaterializeSource[];
}
export interface PlacementMaterializeTargetResult { candidate: ShardHistory; objects: PlannedGitObject[]; commit?: string }
export interface PlacementMaterializeResult {
  decisions: PlacementPublicationDecision[]; targets: PlacementMaterializeTargetResult[];
  plannedTargets: PlacementPublicationTarget[]; objects: PlacementPublicationObject[];
}
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sameRealm = (a: PlacementRealm, b: PlacementRealm) => canonicalJSON(a) === canonicalJSON(b);
const physical = (target: Pick<PlacementMaterializeTarget, "realm">): PlacementRealm => target.realm.scope === "user" ? {scope:"user"} : {scope:"project",keyHash:digest(target.realm.key)};
const keyFor = (target: Pick<PlacementMaterializeTarget, "realm">, row: ShardSyncRow): PlacementKey => ({realm:physical(target),id:row.id,rowHash:hashJSON(row)});
function refuse(): never { throw new Error("placement sync unavailable"); }
export interface PlacementPruneProofTarget {
  realm: ShardSyncRealm; generation: string; rows: ReadonlyMap<string, ShardSyncRow>; fetched: ReadonlySet<string>; lineageIds?: ReadonlySet<string>;
}
/** Pure predicate only: fetched/lineage membership must already be independently verified by the caller. */
export function verifiedPlacementPrunes(targets: readonly PlacementPruneProofTarget[]): Set<string> {
  const verified = new Set<string>();
  for (const target of targets) for (const row of target.rows.values()) {
    if (row.op !== "prune" || row.generation !== target.generation) continue;
    const complete = row.targets.every(item => [item,item.basis].every(ref => target.fetched.has(ref.id) && hashJSON(target.rows.get(ref.id)) === ref.rowHash));
    if (complete && (target.fetched.has(row.id) || target.lineageIds?.has(row.id))) verified.add(placementKeyId(keyFor(target,row)));
  }
  return verified;
}
export async function materializePlacementRows(input: PlacementMaterializeInput): Promise<PlacementMaterializeResult> {
  const {capture,projection,old,frozen,createdUnixSeconds}=input;
  const workTargets = input.targets.map(target => ({...target,objects:[] as PlannedGitObject[],commit:undefined as string|undefined,candidate:undefined as ShardHistory|undefined}));
    const sources: DependencySource[] = [], blocked = new Set<string>(), verified = input.verifiedPrunes;
    let sourceBytes=0;
    const admit=(row:unknown)=>{const bytes=Buffer.byteLength(canonicalJSON(row));if(sources.length>=SYNC_SCREEN_MAX_ROWS||sourceBytes+bytes>SYNC_SCREEN_MAX_BYTES)throw new SyncPlacementJournalError("bound");sourceBytes+=bytes;};
    const prunedByTarget = new Map(workTargets.map(target => [target, target.pruned]));
    function* selectedSources(): IterableIterator<PlacementMaterializeSource> { yield* capture.rows.values(); yield* (input.extraSources ?? []); }
    for (const source of selectedSources()) {
      const target = workTargets.find(target => sameRealm(physical(target), source.key.realm)); if (!target) refuse();
      const pruned = prunedByTarget.get(target)!.has(source.key.id) && !target.fetched.has(source.key.id);
      if (pruned) blocked.add(placementKeyId(source.key));
      admit(source.row); sources.push({ key: source.key, row: source.row, sourcePlacement: source.sourcePlacement, policy: input.evaluate(source.row), held: !!projection.get(source.key)?.held || !!pruned });
    }
    for (const target of workTargets) for (const row of target.localPrunes.values()) {
      const key = keyFor(target,row); if (sources.some(source => placementKeyId(source.key) === placementKeyId(key))) continue;
      admit(row); sources.push({ key, row, sourcePlacement: "synced", policy: input.evaluate(row), held: !!projection.get(key)?.held });
    }
    // Incoming verified occurrences are selected immutable originals too. Classify them before import so a private
    // remote goal cannot temporarily authorize a new dependent, and exposure/holds are durable in this same attempt.
    const seenSources=new Set(sources.map(source=>placementKeyId(source.key)));
    for(const [index,target]of workTargets.entries())for(const row of old[index]?.rows.values()??[])if(row.op!=="prune"||row.generation===target.generation){
      const key=keyFor(target,row),id=placementKeyId(key);if(seenSources.has(id))continue;seenSources.add(id);
      admit(row); sources.push({key,row,sourcePlacement:"synced",policy:input.evaluate(row),held:!!projection.get(key)?.held});
    }
    // Strong endpoints are already in sources and current holds cannot be bypassed by past publication. Only
    // deletion/prune exceptions need a second verified occurrence fact; do not duplicate every historical body.
    const publicNeeded=new Set<string>();
    for(const source of sources){const row=source.row as ShardSyncRow;
      if(row.op==="forget"||row.op==="demote")publicNeeded.add(row.target);
      if(row.op==="prune")for(const target of row.targets)for(const ref of [target,target.basis])publicNeeded.add(ref.id);
    }
    const endpoints: VerifiedDependencyEndpoint[] = workTargets.flatMap((target,index) => [...(old[index]?.rows.values() ?? [])].filter((row): row is Entry => row.op !== "prune"&&publicNeeded.has(row.id)).map(row => ({ key: keyFor(target,row), row })));
    const descriptorVerdicts = workTargets.map(target => input.evaluate({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...target.realm, publicationFormat: PLACEMENT_FORMAT }));
    const publishes = workTargets.map(() => false);
    for (const source of sources) {
      const index = workTargets.findIndex(target => sameRealm(physical(target),source.key.realm));
      if (!descriptorVerdicts[index]!.ok) source.policy = descriptorVerdicts[index]!;
    }
    const sourceMap = new Map(sources.map(source => [placementKeyId(source.key), source]));
    let decisions: PlacementPublicationDecision[] = [];
    for (let pass = 0; pass < 2; pass++) {
      decisions = compilePlacementDependencies({ generation: input.generation, selectedRealms: workTargets.map(physical), rows:sources, publicEndpoints:endpoints,
        verifiedPrunes:sources.filter(source => verified.has(placementKeyId(source.key))).map(source => source.key) }).map(decision => {
          const source = sourceMap.get(placementKeyId(decision.key))!;
          const index=workTargets.findIndex(target=>sameRealm(physical(target),decision.key.realm));
          const original=old[index]?.rows.get(decision.key.id), published=!!original&&hashJSON(original)===decision.key.rowHash;
          const reason=blocked.has(placementKeyId(decision.key)) && !projection.get(decision.key)?.held ? "related-local" : decision.reason ?? null;
          return { ...decision, sourcePlacement:source.sourcePlacement, reason,
            hold:!decision.eligible&&(reason!=="source-local"||published)&&!projection.get(decision.key)?.held };
        });
      let rejected = false;
      for (const [index,target] of workTargets.entries()) {
        const files = new Map(old[index]?.files), eligible = new Set(decisions.filter(decision => decision.eligible && sameRealm(decision.key.realm,physical(target))).map(decision => decision.key.id));
        const publish = descriptorVerdicts[index]!.ok && (!!old[index] || eligible.size > 0); publishes[index] = publish;
        if (publish) files.set("shard.json", Buffer.from(canonicalJSON({schema:PLACEMENT_DESCRIPTOR_SCHEMA,...target.realm,publicationFormat:PLACEMENT_FORMAT})+"\n"));
        const additions = sources.filter(source => sameRealm(source.key.realm,physical(target)) && eligible.has(source.key.id) && !old[index]?.rows.has(source.key.id)).map(source => source.row as ShardSyncRow);
        for (const [path,bytes] of encodeShardPacks(additions)) { const prior = files.get(path); if (prior && !prior.equals(bytes)) refuse(); files.set(path,bytes); }
        const manifests = new Map(old[index]?.manifests), occurrences = new Map<string,{pack:string;blob:string}>();
        for (const [path,bytes] of files) if (path.startsWith("rows/")) for (const row of decodeShardPack(path,bytes,target.realm,target.generation))
          if (!occurrences.has(row.id)) occurrences.set(row.id,{pack:path,blob:createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")});
        const native = additions.filter((row):row is PruneRow => row.op==="prune" && row.generation===target.generation);
        if (native.length) {
          const lineages = input.publisherLineages(index,native);
          for (const row of native) {
            const lineage = lineages.get(row.id), own = occurrences.get(row.id); if (!lineage || !own) refuse();
            const needed = new Map<string,string>(); for (const item of row.targets) for (const ref of [item,item.basis]) needed.set(ref.id,ref.rowHash);
            const witnesses = [...needed].sort(([a],[b])=>a.localeCompare(b)).map(([id,rowHash])=>{ const place=occurrences.get(id); if(!place)refuse(); return{id,rowHash,...place}; });
            const value:PublicPruneWitnessV1={schema:"agent-mem.public-prune-witness/v1",realm:target.realm,prune:row,lineage,pruneOccurrence:own,witnesses};
            const encoded=encodeShardManifest(value), packs=new Map([own,...witnesses].map(ref=>[ref.pack,{pack:ref.pack,blob:ref.blob,bytes:files.get(ref.pack)!}]));
            if(verifyPublicPruneWitness(value,{realm:target.realm,packs:[...packs.values()]}).status!=="verified")refuse();
            const verdict=input.evaluate(value);
            if(!verdict.ok){const source=sources.find(source=>source.key.id===row.id&&sameRealm(source.key.realm,physical(target)))!;source.policy=verdict;rejected=true;continue;}
            files.set(encoded.path,encoded.bytes); manifests.set(encoded.path,{path:encoded.path,bytes:encoded.bytes,value,row,eligible:true,commit:"0".repeat(40),blob:createHash("sha1").update(`blob ${encoded.bytes.length}\0`).update(encoded.bytes).digest("hex")});
          }
        }
        target.objects=[];
        if(publish){
          const previous=old[index]&&target.remote?{tree:await input.readTree(index,frozen?.root.targets[index]?.expectedRemoteHead??target.remote!),commit:frozen?.root.targets[index]?.expectedRemoteHead??target.remote!}:undefined;
          const objects=compilePlacementGitObjects(files,frozen?.root.targets[index]?.expectedRemoteHead??target.remote??null,createdUnixSeconds,previous);target.objects=objects.objects;target.commit=objects.commit;
          for(const [path,manifest]of manifests)if(manifest.commit==="0".repeat(40))manifests.set(path,{...manifest,commit:objects.commit});
        }else target.commit=target.remote;
        const rows=new Map(old[index]?.rows);for(const row of additions)rows.set(row.id,row);
        target.candidate={rows,files,origins:new Map(old[index]?.origins),version:publish?"v3":old[index]?.version??"v3",manifests};
      }
      if(!rejected)break;if(pass===1)refuse();
    }
    const plannedTargets:PlacementPublicationTarget[]=workTargets.map((target,index)=>{
      const publish=publishes[index]!,descriptor=target.candidate?.files.get("shard.json");
      return{realm:physical(target),publish,refHash:digest(shardSyncRef(target.realm)),expectedRemoteHead:frozen?.root.targets[index]?.expectedRemoteHead??target.remote??null,
        expectedCacheHead:frozen?.root.targets[index]?.expectedCacheHead??target.local??null,descriptorHash:digest(descriptor??Buffer.alloc(0)),
        exportSetHash:hashJSON([...target.candidate!.rows.values()].map(row=>({id:row.id,rowHash:hashJSON(row)})).sort((a,b)=>a.id.localeCompare(b.id))),
        tree:publish?target.objects.find(object=>object.type==="tree"&&object.path==="")!.oid:target.remote?frozen?.root.targets[index]?.tree??null:null,commit:target.commit??null};
    });
    for(const [index,target]of workTargets.entries())if(!plannedTargets[index]!.publish&&target.remote)plannedTargets[index]!.tree=await input.readTree(index,target.remote);
    const objects:PlacementPublicationObject[]=workTargets.flatMap((target,targetIndex)=>target.objects.map(object=>({targetIndex,type:object.type,path:object.path === "" ? null : object.path,oid:object.oid,sha256:digest(object.bytes),size:object.bytes.length})));
    return {decisions,targets:workTargets.map(target=>({candidate:target.candidate!,objects:target.objects,commit:target.commit})),plannedTargets,objects};
}
