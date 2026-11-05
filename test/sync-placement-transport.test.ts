import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, readPlacementProjection, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { syncMemory, type SyncOptions } from "../src/memory/sync.ts";
import { syncPlacementMemory, type PlacementSyncPhase } from "../src/memory/sync-placement-transport.ts";

const PROJECT = "example.test/placement/transport", USER_REF = "refs/heads/amem/u", PROJECT_REF = `refs/heads/amem/p/${shardKeyHash(PROJECT)}`;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-placement-transport-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function git(dir: string, ...args: string[]): string {
  const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw Error(`synthetic Git command failed: ${args[0]}`); return result.stdout.trim();
}
function bare() { const dir = temp(); git(dir, "init", "--bare", "-q"); return dir; }
const note = (text: string, project = PROJECT, scope: "project" | "shared" = "project"): NoteInput => ({ op: "note", project, scope, tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
function refs(dir: string): string[] { return git(dir, "for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter(Boolean); }
/** Remote audit covers every reachable original, not merely the selected tip or current materialized view. */
function reachableBytes(dir: string): string {
  const commits = git(dir, "rev-list", "--all").split("\n").filter(Boolean), values: string[] = [];
  for (const commit of commits) {
    values.push(git(dir, "cat-file", "commit", commit));
    for (const file of git(dir, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean)) values.push(git(dir, "show", `${commit}:${file}`));
  }
  return values.join("\n");
}
/** Candidate objects have never crossed the wire; even unreachable never-permitted payloads are forbidden there. */
function candidateBytes(home: string): string {
  const cache = join(home, "shard-sync-placement", "objects.git"); if (!existsSync(cache)) return "";
  const objects = git(cache, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)").split("\n").filter(Boolean);
  return objects.flatMap(line => { const [oid, type] = line.split(" "); return type === "blob" || type === "commit" ? [git(cache, "cat-file", type, oid!)] : []; }).join("\n");
}
function authoredBytes(home: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && item.name.endsWith(".jsonl")) rows[file.slice(home.length)] = readFileSync(file).toString("base64");
    }
  };
  visit(join(home, "user")); visit(join(home, "projects")); return rows;
}
interface FixtureOptions { project?: string; seed?: (store: MemoryStore) => Record<string, string>; patterns?: string[] }
let generations = 100;
async function fixture(options: FixtureOptions = {}) {
  const root = temp(), home = join(root, "memory"), project = options.project ?? PROJECT;
  const original = new MemoryStore({ memoryDir: home, deferPromotions: true });
  // Every selected project exists before the manually installed v3 pair; opening a new realm is not activation authority.
  const ids = options.seed?.(original) ?? { receiverSeed: original.note(note("independent receiver realm seed", project)) }; original.close();
  const generation = (++generations).toString(16).padStart(32, "0");
  expect(await migrateShards({ memoryDir: home, generation, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  const policy = (patterns: string[]) => writeFileSync(join(home, "amem.config.json"), json({ piiPatterns: patterns }), { mode: 0o600 });
  policy(options.patterns ?? ["NEVER_PUBLIC_"]);
  let policyEpoch = "initial";
  const port: PlacementJournalPort = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }),
    policyVersion: () => policyEpoch, authorize: () => true };
  const preview = planPlacementJournal(home, port), { epochHash } = preparePlacementJournal(home, preview, port);
  const oldShards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")), profile = preview.plan.targetProfile;
  // A fixture of the separately authorized future marker writer. No production activation API is implied.
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), json({ ...oldShards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
  const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home); if (!mutation) throw Error("synthetic home mutation unavailable");
  try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
  const store = openShardStore({ memoryDir: home, project, deferPromotions: true }); cleanup.push(() => store.close());
  const opts = (remote: string): SyncOptions => ({ remote, visibility: async () => "private", placementAttestation: port.attest, policyVersion: port.policyVersion });
  const projection = () => readPlacementProjection(home, epochHash), capture = () => captureSyncPlacementContext(home, port);
  const plans = () => readdirSync(join(home, "sync-placement", "epochs", epochHash)).filter(name => /^publication-[a-f0-9]{64}-root\.json$/.test(name)).sort();
  return { home, store, ids, epochHash, port, opts, policy, projection, capture, plans, changePolicyEpoch() { policyEpoch = "changed"; } };
}
const json = (value: unknown) => canonicalJSON(value) + "\n";
function held(f: Awaited<ReturnType<typeof fixture>>, id: string) { return f.projection().states.find(state => state.key.id === id); }
function assertNeverPublished(home: string, remote: string, canaries: readonly string[]) {
  const remoteBytes = reachableBytes(remote), cacheBytes = candidateBytes(home);
  for (const canary of canaries) { expect(remoteBytes).not.toContain(canary); expect(cacheBytes).not.toContain(canary); }
}

test("two independently activated homes exchange allowed project/user originals while forgotten and task-field canaries remain local", async () => {
  const remote = bare(), source = await fixture({ seed(store) {
    const allowed = store.note(note("synthetic allowed project original")), user = store.note(note("synthetic allowed user original", PROJECT, "shared"));
    const declined = store.note(note("NEVER_PUBLIC_NOTE")), forgotten = store.note(note("NEVER_PUBLIC_FORGOTTEN_ORIGINAL")); store.forget(forgotten, "person", PROJECT);
    const task = store.note({ ...note("otherwise ordinary task-bearing note"), task: `${PROJECT}#NEVER_PUBLIC_TASK@1000` });
    return { allowed, user, declined, forgotten, task };
  } });
  const ownIds = [...source.capture().rows.values()].map(row => row.row.id).sort();
  const sent = await syncMemory(source.store, source.opts(remote));
  expect(sent).toMatchObject({ ok: true, pushed: true, placementPublication: { outcome: "committed", policyCeiling: "last-positive-check-before-in-flight-push" } });
  expect(refs(remote).sort()).toEqual([PROJECT_REF, USER_REF].sort());
  assertNeverPublished(source.home, remote, ["NEVER_PUBLIC_NOTE", "NEVER_PUBLIC_FORGOTTEN_ORIGINAL", "NEVER_PUBLIC_TASK"]);
  expect(held(source, source.ids.declined!)?.held).toBe(true); expect(held(source, source.ids.forgotten!)?.held).toBe(true);
  expect([...source.capture().rows.values()].map(row => row.row.id).sort()).toEqual(ownIds);
  const receiver = await fixture(), received = await syncMemory(receiver.store, receiver.opts(remote));
  expect(received.ok).toBe(true);
  expect(receiver.store.get(source.ids.allowed!, PROJECT)?.text).toBe("synthetic allowed project original");
  expect(receiver.store.get(source.ids.user!, PROJECT)?.text).toBe("synthetic allowed user original");
  expect(receiver.store.get(source.ids.declined!, PROJECT)).toBeUndefined(); expect(receiver.store.get(source.ids.task!, PROJECT)).toBeUndefined();
  assertNeverPublished(receiver.home, remote, ["NEVER_PUBLIC_NOTE", "NEVER_PUBLIC_FORGOTTEN_ORIGINAL", "NEVER_PUBLIC_TASK"]);
});

test("a declined project descriptor/key creates no empty ref while an independent user realm publishes", async () => {
  const project = "example.test/NEVER_PUBLIC_REALM/alpha", remote = bare();
  const f = await fixture({ project, seed: store => ({ denied: store.note(note("otherwise allowed project text", project)), user: store.note(note("independent allowed user", PROJECT, "shared")) }) });
  const result = await syncMemory(f.store, f.opts(remote)); expect(result.ok).toBe(true);
  expect(refs(remote)).toEqual([USER_REF]);
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_REALM"]);
  expect(held(f, f.ids.denied!)?.held).toBe(true);
});

test("strong goal dependencies stay withheld, and weak promotion ancestry never hydrates an intrinsic-local original", async () => {
  const remote = bare(), f = await fixture({ seed(store) {
    const local = store.note({ ...note("NEVER_PUBLIC_LOCAL_ANCESTOR"), tier: "short" });
    const weak = store.note({ ...note("allowed weak ancestry copy"), promotedFrom: local });
    const privateGoal = store.goal({ project: PROJECT, scope: "project", title: "NEVER_PUBLIC_GOAL", milestones: [], dependsOn: [], actor: "person" });
    const dependent = store.goal({ project: PROJECT, scope: "project", title: "dependent goal without private text", milestones: [], dependsOn: [privateGoal], actor: "person" });
    store.goalState(dependent, "active", "person"); store.goalLink(dependent, `${PROJECT}#41@1000`, "person");
    return { local, weak, privateGoal, dependent };
  } });
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_LOCAL_ANCESTOR", "NEVER_PUBLIC_GOAL"]);
  const bytes = reachableBytes(remote); expect(bytes).toContain(f.ids.weak!); expect(bytes).not.toContain(f.ids.dependent!);
  expect(held(f, f.ids.privateGoal!)?.held).toBe(true); expect(held(f, f.ids.dependent!)?.held).toBe(true);
});

test("tightening policy preserves already-public exposure and sticky holds without claiming retraction", async () => {
  const remote = bare(), f = await fixture({ patterns: [], seed: store => ({ prior: store.note(note("ALREADY_PUBLIC_CANARY")) }) });
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(reachableBytes(remote)).toContain("ALREADY_PUBLIC_CANARY");
  f.policy(["ALREADY_PUBLIC_CANARY"]);
  const result = await syncMemory(f.store, f.opts(remote)); expect(result.ok).toBe(true);
  expect(held(f, f.ids.prior!)).toMatchObject({ held: true, exposure: "published" });
  expect(reachableBytes(remote)).toContain("ALREADY_PUBLIC_CANARY");
  expect(JSON.stringify(result)).not.toContain("ALREADY_PUBLIC_CANARY");
});

const phases: PlacementSyncPhase[] = ["before-plan-fsync", "plan-fsynced", "artifact-built", "before-cas", "cas-returned", "before-ack", "acknowledged", "imported", "before-receipt", "receipt-written"];
for (const phase of phases) test("retained transport phase fault resumes without duplicate source rows or resealing: " + phase, async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ allowed: store.note(note("phase fault allowed original")), declined: store.note(note("NEVER_PUBLIC_PHASE")) }) });
  const before = [...f.capture().rows.values()].map(row => canonicalJSON(row.row)).sort(), physicalBefore = authoredBytes(f.home); let fired = false;
  await syncPlacementMemory(f.store, f.opts(remote), at => { if (!fired && at === phase) { fired = true; throw Error("synthetic retained phase fault"); } });
  expect(fired).toBe(true); const retained = f.plans();
  const resumed = await syncMemory(f.store, f.opts(remote)); expect(resumed.ok).toBe(true);
  if (retained.length) expect(f.plans()).toEqual(retained);
  expect([...f.capture().rows.values()].map(row => canonicalJSON(row.row)).sort()).toEqual(before);
  expect(authoredBytes(f.home)).toEqual(physicalBefore);
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_PHASE"]);
  const published = reachableBytes(remote); expect(published).toContain(f.ids.allowed!);
  expect(held(f, f.ids.allowed!)?.exposure).toBe("published");
});

for (const drift of ["policy", "host-epoch", "source"] as const) test("fresh pre-CAS " + drift + " drift refuses without publishing or resealing", async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ allowed: store.note(note("PRE_CAS_POLICY_CANARY")) }) }); let changed = false;
  const result = await syncPlacementMemory(f.store, f.opts(remote), phase => {
    if (changed || phase !== "before-cas") return; changed = true;
    if (drift === "policy") f.policy(["PRE_CAS_POLICY_CANARY"]);
    else if (drift === "host-epoch") f.changePolicyEpoch();
    else {
      const file = readdirSync(join(f.store.dir, "legacy", "log")).find(name => name.endsWith(".jsonl"));
      if (!file) throw Error("synthetic authored prefix unavailable");
      const source = join(f.store.dir, "legacy", "log", file), line = readFileSync(source, "utf8").split("\n").find(Boolean);
      if (!line) throw Error("synthetic authored row unavailable"); appendFileSync(source, line + "\n");
    }
  });
  expect(changed).toBe(true); expect(result.ok).toBe(false); expect(refs(remote)).toEqual([]); expect(f.plans()).toHaveLength(1);
});
