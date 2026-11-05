import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { inspectSyncPlacement, syncMemory, holdPlacementRow, planPrune, applyPrune,
  type SyncPlacementInspection, type SyncPlacementInspectionRow } from "../src/index.ts";
import * as publicationStorage from "../src/memory/sync-placement-publication-storage.ts";
import * as syncGit from "../src/memory/sync.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { shardSyncRef } from "../src/memory/shard-sync-format.ts";
import { createPlacementInspectionFixture, inspectionGit, inspectionNote, inspectionDecisions, INSPECTION_PROJECT,
  type InspectionFixtureOptions, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const fixtures: PlacementInspectionFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0).reverse()) f.close(); });
async function fixture(options: InspectionFixtureOptions = {}) { const f = await createPlacementInspectionFixture(options); fixtures.push(f); return f; }
type Complete = Extract<SyncPlacementInspection, { complete: true }>;
function complete(value: SyncPlacementInspection): Complete {
  expect(value.complete).toBe(true); if (!value.complete) throw Error("expected complete isolated placement inspection"); return value;
}
const keyId = (row: Pick<SyncPlacementInspectionRow, "realm" | "id" | "rowHash">) => canonicalJSON([row.realm,row.id,row.rowHash]);
function row(result: Complete, id: string): SyncPlacementInspectionRow {
  const selected = result.rows.find(value => value.id === id); expect(selected).toBeDefined(); if (!selected) throw Error("fixture row not inspected"); return selected;
}
function matchesPlan(result: Complete, f: PlacementInspectionFixture, attempt = f.publications().at(-1)!) {
  expect(attempt).toBeDefined();
  const actual = inspectionDecisions(attempt.bundle).map(decision => ({ key: keyId(decision.key), eligible: decision.eligible, reason: decision.reason })).sort((a,b)=>a.key.localeCompare(b.key));
  const inspected = result.rows.map(value => ({ key: keyId(value), eligible: value.disposition === "eligible", reason: value.reason })).sort((a,b)=>a.key.localeCompare(b.key));
  expect(inspected).toEqual(actual);
}
async function unchangedInspection(f: PlacementInspectionFixture, options = f.opts()) {
  const before = f.snapshot(), inspected = await inspectSyncPlacement(f.store, options);
  expect(f.snapshot()).toEqual(before); return complete(inspected);
}

test("public inspection matches the first actual sealed decisions and verified exposure without mutating sources or cache", async () => {
  const f = await fixture({ seed(store, project) {
    const allowed = store.note(inspectionNote("allowed conformance original", project)), user = store.note(inspectionNote("allowed conformance overlay", project, "shared"));
    const declined = store.note(inspectionNote("NEVER_PUBLIC_CONFORMANCE", project));
    const goal = store.goal({ project, scope:"project",title:"NEVER_PUBLIC_REQUIRED_GOAL",milestones:[],dependsOn:[],actor:"person" });
    const dependent = store.goal({ project,scope:"project",title:"permitted text requiring held goal",milestones:[],dependsOn:[goal],actor:"person" });
    return { allowed,user,declined,goal,dependent };
  } });
  const before = await unchangedInspection(f), repeated = await unchangedInspection(f);
  expect(repeated.fingerprint).toBe(before.fingerprint); expect(before.fingerprint).toBe(hashJSON(before.rows));
  expect(row(before,f.ids.allowed!).disposition).toBe("eligible"); expect(row(before,f.ids.declined!).disposition).toBe("policy-local");
  expect(row(before,f.ids.dependent!)).toMatchObject({ disposition:"held",reason:"related-local" });
  for (const value of before.rows) expect(value.exposure.certainty).toBe("not-observed");
  expect((await syncMemory(f.store,f.opts())).ok).toBe(true); matchesPlan(before,f);
  expect(f.reachableIds()).toEqual(before.rows.filter(value=>value.disposition==="eligible").map(value=>value.id).sort());
  const after = await unchangedInspection(f);
  const publication = f.publications()[0]!, remoteHash = createHash("sha256").update(f.remote).digest("hex");
  for (const id of [f.ids.allowed!,f.ids.user!]) {
    const inspected = row(after,id), target = publication.bundle.root.targets.find(value=>canonicalJSON(value.realm)===canonicalJSON(inspected.realm))!;
    expect(inspected.exposure).toEqual({certainty:"verified-published",evidence:[{remoteHash,refHash:target.refHash,commit:target.commit!}]});
    expect(inspectionGit(f.remote,"rev-parse",shardSyncRef(inspected.realm.scope==="user"?{scope:"user"}:{scope:"project",key:f.project}))).toBe(target.commit!);
  }
  const output = JSON.stringify(after);
  for (const content of [f.home,f.remote,f.project,"allowed conformance original","NEVER_PUBLIC_CONFORMANCE","NEVER_PUBLIC_REQUIRED_GOAL"]) expect(output).not.toContain(content);
},20_000);

test("person-local hold agrees with actual publication through root APIs", async () => {
  const f = await fixture(), capture = f.capture(), source = [...capture.rows.values()].find(value=>value.key.id===f.ids.project)!;
  holdPlacementRow(f.home,{epochHash:f.epochHash,expectedHead:f.projection().headHash,requestId:"a".repeat(64),key:source.key},f.port,"person");
  const inspected = await unchangedInspection(f);
  expect(row(inspected,f.ids.project!)).toMatchObject({disposition:"person-local",reason:"journal-hold",holdReasons:["person-local"]});
  expect((await syncMemory(f.store,f.opts())).ok).toBe(true); matchesPlan(inspected,f);
  expect(f.reachableIds()).not.toContain(f.ids.project!); expect(f.reachableIds()).toContain(f.ids.user!);
  expect(row(await unchangedInspection(f),f.ids.project!).disposition).toBe("person-local");
},20_000);

test("loosening policy cannot release a sticky hold and a fresh allowed row forces a comparable new sealed plan", async () => {
  const f = await fixture(); expect((await syncMemory(f.store,f.opts())).ok).toBe(true);
  f.policy([]); f.changePolicyEpoch("looser-policy");
  const fresh = f.store.note(inspectionNote("fresh independently allowed source after policy change",f.project));
  const before = await unchangedInspection(f), plans = new Set(f.publications().map(value=>value.bundle.root.seal));
  expect(row(before,f.ids.declined!)).toMatchObject({disposition:"policy-local",reason:"journal-hold",holdReasons:["personal-data"]});
  expect(row(before,fresh).disposition).toBe("eligible");
  expect((await syncMemory(f.store,f.opts())).ok).toBe(true); expect(f.publications()).toHaveLength(plans.size+1);
  const added = f.publications().find(value=>!plans.has(value.bundle.root.seal))!;
  matchesPlan(before,f,added); expect(f.reachableIds()).not.toContain(f.ids.declined!); expect(f.reachableIds()).toContain(fresh);
},20_000);

test("a declined project descriptor with an independent user realm agrees with publication and leaks no empty project ref", async () => {
  const project = "example.test/NEVER_PUBLIC_DESCRIPTOR/inspection", f = await fixture({project,seed(store,key){return {
    denied:store.note(inspectionNote("otherwise ordinary project row",key)),user:store.note(inspectionNote("independent user original",INSPECTION_PROJECT,"shared")),
  };}});
  const before = await unchangedInspection(f);
  expect(row(before,f.ids.denied!).disposition).toBe("policy-local"); expect(row(before,f.ids.user!).disposition).toBe("eligible");
  expect((await syncMemory(f.store,f.opts())).ok).toBe(true); matchesPlan(before,f);
  expect(inspectionGit(f.remote,"for-each-ref","--format=%(refname)","refs/heads/")).toBe("refs/heads/amem/u");
  expect(JSON.stringify(before)).not.toContain("NEVER_PUBLIC_DESCRIPTOR");
},20_000);

test("generated prune-witness host decline agrees with transport without changing or splitting the original", async () => {
  const f = await fixture({patterns:[],seed:(store,project)=>({target:store.note(inspectionNote("public target for witness-only host decline",project))})});
  expect((await syncMemory(f.store,f.opts())).ok).toBe(true);
  expect(f.store.demote(f.ids.target!,"person",f.project)).toBeDefined(); expect((await syncMemory(f.store,f.opts())).ok).toBe(true);
  f.clock.now += 2000;
  const auth = {project:f.project,actor:"person" as const,authorize:()=>true,policy:{revision:()=>"conformance-prune",classify:()=>"public" as const,attest:()=>true}};
  const plan = planPrune(f.store.prunePort(),{cutoff:new Date(f.clock.now).toISOString(),targets:[f.ids.target!]},auth);
  expect(plan.rows).toHaveLength(1); const prune = plan.rows[0]!.payload;
  expect(applyPrune(f.store.prunePort(),plan,auth).completed).toContain(prune.id);
  const opts = {...f.opts(),screen:(value:Record<string,unknown>)=>!Object.hasOwn(value,"prune")};
  const before = await unchangedInspection(f,opts);
  expect(row(before,prune.id)).toMatchObject({disposition:"policy-local",reason:"host",categories:["host"]});
  const plans = new Set(f.publications().map(value=>value.bundle.root.seal));
  expect((await syncMemory(f.store,opts)).ok).toBe(true);
  const fresh = f.publications().find(value=>!plans.has(value.bundle.root.seal))!; matchesPlan(before,f,fresh);
  expect(f.reachableIds()).not.toContain(prune.id);
  expect([...f.capture().specialRows.values()].find(value=>value.key.id===prune.id)?.row).toEqual(prune);
},20_000);

test("candidate-only installed objects and a durable intent before CAS never count as positive exposure", async () => {
  const f = await fixture(), real = publicationStorage.recordPlacementPublicationPhase; let interrupted = false;
  const fault = spyOn(publicationStorage,"recordPlacementPublicationPhase").mockImplementation((home,epoch,attempt,phase,input,opts)=>{
    real(home,epoch,attempt,phase,input,opts);
    if(phase==="publication-intent"&&!interrupted){interrupted=true;throw Error("synthetic interruption before native CAS");}
  });
  try { expect((await syncMemory(f.store,f.opts())).ok).toBe(false); } finally { fault.mockRestore(); }
  expect(interrupted).toBe(true); expect(f.reachableIds()).toEqual([]);
  const retained = f.publications()[0]!; expect(retained.phase).toBe("publication-intent");
  for(const target of retained.bundle.root.targets)if(target.commit)expect(inspectionGit(join(f.home,"shard-sync-placement","objects.git"),"cat-file","-t",target.commit)).toBe("commit");
  const inspected = await unchangedInspection(f);
  for(const id of [f.ids.project!,f.ids.user!])expect(row(inspected,id).exposure).toEqual({certainty:"unknown"});
  expect(inspected.counts.verifiedPublished).toBe(0);
},20_000);

test("lost native CAS acknowledgement stays unknown until ordinary sync finishes the retained proof", async () => {
  const f = await fixture(), real = syncGit.generationSyncGit; let lost = false;
  const fault = spyOn(syncGit,"generationSyncGit").mockImplementation(async (...args)=>{
    const result = await real(...args);
    if(args[1].includes("push")&&result.code===0&&!lost){lost=true;return {...result,code:1,err:"synthetic accepted CAS with missing acknowledgement"};}
    return result;
  });
  try { expect((await syncMemory(f.store,f.opts())).ok).toBe(false); } finally { fault.mockRestore(); }
  expect(lost).toBe(true); expect(f.reachableIds()).toContain(f.ids.project!); expect(f.reachableIds()).not.toContain(f.ids.declined!);
  const uncertain = await unchangedInspection(f);
  expect(row(uncertain,f.ids.project!).exposure).toEqual({certainty:"unknown"}); expect(uncertain.counts.verifiedPublished).toBe(0);
  expect((await syncMemory(f.store,f.opts())).ok).toBe(true);
  expect(row(await unchangedInspection(f),f.ids.project!).exposure.certainty).toBe("verified-published");
},20_000);
