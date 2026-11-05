import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPrune, inspectSyncPlacement, planPrune, syncMemory, type SyncPlacementInspection } from "../src/index.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { inspectionDecisions, inspectionGit, inspectionNote, createPlacementInspectionFixture,
  type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const homes: PlacementInspectionFixture[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); });
type Complete = Extract<SyncPlacementInspection, { complete: true }>;
async function inspect(f: PlacementInspectionFixture): Promise<Complete> {
  const result = await inspectSyncPlacement(f.store, f.opts());
  expect(result.complete, JSON.stringify(result)).toBe(true);
  if (!result.complete) throw Error("isolated stage-5 inspection incomplete; inspect the safe refusal above");
  const keys = (rows: { realm: unknown; id: string; rowHash: string }[]) => rows.map(row => canonicalJSON([row.realm, row.id, row.rowHash])).sort();
  expect(keys([...result.rows, ...result.intrinsicLocal])).toEqual(keys([...f.capture().rows.values(), ...f.capture().specialRows.values()].map(row => row.key)));
  return result;
}
function matchPlan(result: Complete, publication: ReturnType<PlacementInspectionFixture["publications"]>[number]) {
  const key = (row: { realm: unknown; id: string; rowHash: string }) => canonicalJSON([row.realm, row.id, row.rowHash]);
  const expected = inspectionDecisions(publication.bundle).map(row => ({ key: key(row.key), eligible: row.eligible, reason: row.reason })).sort((a,b) => a.key.localeCompare(b.key));
  const actual = result.rows.map(row => ({ key: key(row), eligible: row.disposition === "eligible", reason: row.reason })).sort((a,b) => a.key.localeCompare(b.key));
  expect(actual).toEqual(expected);
}
async function publish(f: PlacementInspectionFixture) {
  const before = await inspect(f), prior = new Set(f.publications().map(row => row.bundle.root.seal));
  const result = await syncMemory(f.store, f.opts()); expect(result.ok, JSON.stringify(result)).toBe(true);
  const added = f.publications().filter(row => !prior.has(row.bundle.root.seal)); expect(added).toHaveLength(1);
  matchPlan(before, added[0]!);
  return before;
}

// Several real local-Git publication/import/rebuild cycles run serially; keep this allowance test-local.
test("stage 5: prepared v2 to fixture v3, filtered publication, inspection, second-machine import and later forget/prune", async () => {
  let preparedHomes = 0;
  const prepared = (home: string, result: { activated: false; epochHash: string }) => {
    expect(result.activated).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "profile.json"), "utf8")).schema).toBe("agent-mem.profile/v2");
    expect(JSON.parse(readFileSync(join(home, "shards.json"), "utf8")).schema).toBe("agent-mem.shards/v2");
    expect(existsSync(join(home, "sync-placement", "active.json"))).toBe(false);
    expect(existsSync(join(home, "sync-placement", "epochs", result.epochHash))).toBe(true);
    expect(existsSync(join(home, "formats.json"))).toBe(false);
    preparedHomes++;
  };
  const source = await createPlacementInspectionFixture({ prepared, seed(store, project) {
    const target = store.note(inspectionNote("stage-5 allowed prune target", project));
    const forgotten = store.note(inspectionNote("stage-5 allowed later forgotten target", project));
    const user = store.note(inspectionNote("stage-5 allowed user overlay", project, "shared"));
    const declined = store.note(inspectionNote("NEVER_PUBLIC_STAGE5_BODY", project));
    const goal = store.goal({ project, scope: "project", title: "NEVER_PUBLIC_STAGE5_GOAL", milestones: [], dependsOn: [], actor: "person" });
    const dependent = store.goal({ project, scope: "project", title: "stage-5 permitted dependent", milestones: [], dependsOn: [goal], actor: "person" });
    return { target, forgotten, user, declined, goal, dependent };
  } }); homes.push(source);
  const first = await publish(source);
  expect(first.rows.find(row => row.id === source.ids.declined)?.disposition).toBe("policy-local");
  expect(first.rows.find(row => row.id === source.ids.dependent)).toMatchObject({ disposition: "held", reason: "related-local" });
  const eligible = first.rows.filter(row => row.disposition === "eligible").map(row => row.id).sort();
  expect(source.reachableIds()).toEqual(eligible);

  const receiver = await createPlacementInspectionFixture({ prepared, generation: source.generation,
    seed: (store, project) => ({ seed: store.note(inspectionNote("stage-5 second-machine original", project)) }) }); homes.push(receiver);
  expect(preparedHomes).toBe(2);
  const receiverResult = await syncMemory(receiver.store, receiver.opts(source.remote)); expect(receiverResult.ok, JSON.stringify(receiverResult)).toBe(true);
  matchPlan(await inspect(receiver), receiver.publications()[0]!);
  for (const id of eligible) expect(receiver.store.get(id, source.project)).toBeDefined();
  for (const id of [source.ids.declined!, source.ids.goal!, source.ids.dependent!]) expect(receiver.store.get(id, source.project)).toBeUndefined();
  for (const publication of receiver.publications()) matchPlan(await inspect(receiver), publication);

  // Import the second machine's independent original before comparing the next own-source plan.
  const firstSeals = new Set(source.publications().map(row => row.bundle.root.seal));
  expect((await syncMemory(source.store, source.opts())).ok).toBe(true);
  const reconciled = source.publications().filter(row => !firstSeals.has(row.bundle.root.seal));
  expect(reconciled).toHaveLength(1); matchPlan(await inspect(source), reconciled[0]!);
  expect(source.store.forget(source.ids.forgotten!, "person", source.project)).toBeDefined();
  await publish(source);
  expect(source.store.demote(source.ids.target!, "person", source.project)).toBeDefined();
  await publish(source);
  source.clock.now += 2000;
  const auth = { project: source.project, actor: "person" as const, authorize: () => true,
    policy: { revision: () => "stage-5-public-prune", classify: () => "public" as const, attest: () => true } };
  const plan = planPrune(source.store.prunePort(), { cutoff: new Date(source.clock.now).toISOString(), targets: [source.ids.target!] }, auth);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("synced");
  const prune = plan.rows[0]!.payload;
  expect(applyPrune(source.store.prunePort(), plan, auth).completed).toContain(prune.id);
  const pruning = await publish(source);
  expect(pruning.rows.find(row => row.id === prune.id)?.disposition).toBe("eligible");
  expect((await syncMemory(receiver.store, receiver.opts(source.remote))).ok).toBe(true);
  expect(receiver.store.get(source.ids.forgotten!, source.project)).toBeUndefined();
  expect(receiver.store.get(source.ids.target!, source.project)).toBeUndefined();
  expect(receiver.store.prunePort().snapshot().pruned).toContain(source.ids.target!);
  const beforeRebuild = canonicalJSON(receiver.store.prunePort().snapshot()); receiver.store.rebuild();
  expect(canonicalJSON(receiver.store.prunePort().snapshot())).toBe(beforeRebuild);
  const physicalIds = [...receiver.capture().rows.values(), ...receiver.capture().specialRows.values()].map(row => row.key.id);
  for (const id of [source.ids.declined!, source.ids.goal!, source.ids.dependent!]) expect(physicalIds).not.toContain(id);
  // Search every reachable blob, including immutable old packs and witness payloads, not only the current tree.
  for (const line of inspectionGit(source.remote, "rev-list", "--objects", "--all").split("\n")) {
    const oid = line.split(" ")[0]!;
    if (inspectionGit(source.remote, "cat-file", "-t", oid) !== "blob") continue;
    expect(inspectionGit(source.remote, "cat-file", "blob", oid)).not.toContain("NEVER_PUBLIC_STAGE5_");
  }
}, 60_000);
