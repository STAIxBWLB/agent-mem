import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateSync, deflateSync } from "node:zlib";
import { MemoryStore, openShardStore, type NoteInput } from "../src/memory/store.ts";
import { memoryGitSync, realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON, writeProfileJSON } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, readPlacementProjection, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import * as journalStorage from "../src/memory/sync-placement-journal-storage.ts";
import * as publicationStorage from "../src/memory/sync-placement-publication-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { applyPrune, planPrune, validatePrunePlan, type PrunePlan, type PruneRow } from "../src/memory/prune.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import type { PublicPruneWitnessV1 } from "../src/memory/public-prune-witness.ts";
import { syncMemory, type SyncOptions } from "../src/memory/sync.ts";
import { syncOutboundContent } from "../src/memory/sync-screen.ts";
import { syncPlacementMemory, type PlacementSyncPhase } from "../src/memory/sync-placement-transport.ts";

// Real local-Git round trips: hosted macOS runs these at up to ~20 s, so each keeps a 60 s test-local allowance (global --timeout unchanged).
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
function verifiedPublicRows(remote: string): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  for (const commit of git(remote, "rev-list", "--all").split("\n").filter(Boolean))
    for (const file of git(remote, "ls-tree", "-r", "--name-only", commit).split("\n").filter(name => /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.test(name)))
      for (const line of git(remote, "show", `${commit}:${file}`).split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as { id: string };
        const prior = rows.get(row.id); if (prior) expect(canonicalJSON(prior)).toBe(canonicalJSON(row)); rows.set(row.id, row);
      }
  return rows;
}
function assertWitnessCopies(before: Record<string, string>, after: Record<string, string>, remote: string) {
  for (const [file, bytes] of Object.entries(before)) expect(after[file]).toBe(bytes);
  const publicRows = verifiedPublicRows(remote), counts = new Map<string, number>();
  for (const [file, bytes] of Object.entries(after)) if (!Object.hasOwn(before, file)) {
    expect(file).toMatch(/\/sync-[a-f0-9]{64}\.jsonl$/);
    const body = Buffer.from(bytes, "base64").toString("utf8"); expect(body).not.toContain("NEVER_PUBLIC_");
    for (const line of body.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { id: string }; expect(publicRows.has(row.id)).toBe(true);
      expect(hashJSON(row)).toBe(hashJSON(publicRows.get(row.id)));
      counts.set(row.id, (counts.get(row.id) ?? 0) + 1); expect(counts.get(row.id)).toBe(1);
    }
  }
}
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
interface FixtureOptions { project?: string; generation?: string; seed?: (store: MemoryStore) => Record<string, string>; patterns?: string[] }
let generations = 100;
async function fixture(options: FixtureOptions = {}) {
  const root = temp(), home = join(root, "memory"), project = options.project ?? PROJECT, clock = { now: Date.parse("2026-10-01T12:00:00.000Z") };
  const original = new MemoryStore({ memoryDir: home, deferPromotions: true, now: () => clock.now, ttlMs: 1000 });
  // Every selected project exists before the manually installed v3 pair; opening a new realm is not activation authority.
  const ids = options.seed?.(original) ?? { receiverSeed: original.note(note("independent receiver realm seed", project)) }; original.close();
  const generation = options.generation ?? (++generations).toString(16).padStart(32, "0");
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
  const store = openShardStore({ memoryDir: home, project, deferPromotions: true, now: () => clock.now, ttlMs: 1000 }); cleanup.push(() => store.close());
  const opts = (remote: string): SyncOptions => ({ remote, visibility: async () => "private", placementAttestation: port.attest, policyVersion: port.policyVersion });
  const projection = () => readPlacementProjection(home, epochHash), capture = () => captureSyncPlacementContext(home, port);
  const plans = () => readdirSync(join(home, "sync-placement", "epochs", epochHash)).filter(name => /^publication-[a-f0-9]{64}-root\.json$/.test(name)).sort();
  return { home, store, ids, epochHash, port, opts, policy, projection, capture, plans, clock, changePolicyEpoch() { policyEpoch = "changed"; } };
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
  const sent = await syncPlacementMemory(source.store, source.opts(remote), undefined, error => console.error("isolated transport diagnostic", error));
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
  const afterSuccess = authoredBytes(f.home); assertWitnessCopies(physicalBefore, afterSuccess, remote);
  const completedPlans = f.plans(); expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(authoredBytes(f.home)).toEqual(afterSuccess); expect(f.plans()).toEqual(completedPlans);
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_PHASE"]);
  const published = reachableBytes(remote); expect(published).toContain(f.ids.allowed!);
  expect(held(f, f.ids.allowed!)?.exposure).toBe("published");
});

test("a real deadline after durable publication intent retains an unknown attempt without publishing and resumes that exact plan", async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ allowed: store.note(note("deadline-retained allowed original")), declined: store.note(note("NEVER_PUBLIC_DEADLINE")) }) });
  const controller = new AbortController(), options = { ...f.opts(remote), signal: controller.signal };
  const observed: PlacementSyncPhase[] = [], originalRows = [...f.capture().rows.values()].map(row => canonicalJSON(row.row)).sort();
  let saved: ReturnType<typeof retainedPublication> | undefined, planNames: string[] = [], planBytes = "", intentBytes: Buffer | undefined;
  const result = await syncPlacementMemory(f.store, options, async phase => {
    observed.push(phase);
    if (phase !== "before-cas") return;
    expect(saved).toBeUndefined(); saved = retainedPublication(f);
    expect(saved).toMatchObject({ phase: "publication-intent", pending: false });
    expect(saved.facts.map(fact => fact.phase)).toEqual(["artifact-built", "publication-intent"]);
    planNames = f.plans(); planBytes = canonicalJSON(saved.bundle);
    const dir = join(f.home, "sync-placement", "epochs", f.epochHash), attempt = saved.bundle.root.seal;
    intentBytes = readFileSync(join(dir, `publication-${attempt}-intent.json`));
    expect(readFileSync(join(dir, `publication-${attempt}-receipt.json`))).toHaveLength(0); // Reserved slot, not a completed receipt.
    expect(refs(remote)).toEqual([]);
    // The operation has this same signal from its start; only the test's exact phase boundary arms the real timer.
    const deadline = AbortSignal.timeout(1);
    await new Promise<void>(resolve => {
      if (deadline.aborted) resolve(); else deadline.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(deadline.aborted).toBe(true); expect(deadline.reason).toMatchObject({ name: "TimeoutError" });
    controller.abort(deadline.reason);
    expect(controller.signal.reason).toBe(deadline.reason);
  });
  expect(saved).toBeDefined(); expect(controller.signal.aborted).toBe(true);
  const attempt = saved!.bundle.root.seal, dir = join(f.home, "sync-placement", "epochs", f.epochHash);
  expect(result).toMatchObject({ ok: false, pushed: false, placementPublication: { attemptHash: attempt, outcome: "unknown" } });
  expect(result.error).toContain("retained attempt");
  expect(observed).toEqual(["before-plan-fsync", "plan-fsynced", "artifact-built", "before-cas"]);
  const retained = retainedPublication(f);
  expect(retained).toMatchObject({ phase: "publication-intent", pending: false });
  expect(canonicalJSON(retained.bundle)).toBe(planBytes); expect(f.plans()).toEqual(planNames);
  expect(readFileSync(join(dir, `publication-${attempt}-intent.json`)).equals(intentBytes!)).toBe(true);
  expect(readFileSync(join(dir, `publication-${attempt}-receipt.json`))).toHaveLength(0);
  expect(retained.facts.some(fact => fact.phase === "completed")).toBe(false);
  expect(refs(remote)).toEqual([]); expect(verifiedPublicRows(remote).size).toBe(0);
  expect([...f.capture().rows.values()].map(row => canonicalJSON(row.row)).sort()).toEqual(originalRows);
  const resumed = await syncMemory(f.store, f.opts(remote));
  expect(resumed).toMatchObject({ ok: true, pushed: true, placementPublication: { attemptHash: attempt, outcome: "committed" } });
  const completed = retainedPublication(f);
  expect(completed).toMatchObject({ phase: "completed", pending: false });
  expect(canonicalJSON(completed.bundle)).toBe(planBytes); expect(f.plans()).toEqual(planNames);
  expect(readFileSync(join(dir, `publication-${attempt}-intent.json`)).equals(intentBytes!)).toBe(true);
  expect(verifiedPublicRows(remote).has(f.ids.allowed!)).toBe(true);
  expect(held(f, f.ids.declined!)?.held).toBe(true);
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_DEADLINE"]);
}, 60_000);

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

test("native multi-ref CAS race keeps every other selected ref unchanged and never reseals the failed attempt", async () => {
  const remote = bare(), competitorRemote = bare();
  const competitor = await fixture({ seed: store => ({ row: store.note(note("independent competing public original")) }) });
  expect((await syncMemory(competitor.store, competitor.opts(competitorRemote))).ok).toBe(true);
  const competingHead = git(competitorRemote, "rev-parse", PROJECT_REF);
  const f = await fixture({ seed: store => ({ project: store.note(note("racing project original")), user: store.note(note("racing user original", PROJECT, "shared")) }) });
  let raced = false;
  const result = await syncPlacementMemory(f.store, f.opts(remote), phase => {
    if (raced || phase !== "before-cas") return; raced = true;
    git(remote, "fetch", "-q", "--no-tags", competitorRemote, `${PROJECT_REF}:${PROJECT_REF}`);
  });
  expect(raced).toBe(true); expect(result).toMatchObject({ ok: false, pushed: false, placementPublication: { outcome: "unknown" } });
  expect(refs(remote)).toEqual([PROJECT_REF]); expect(git(remote, "rev-parse", PROJECT_REF)).toBe(competingHead);
  expect(held(f, f.ids.project!)?.exposure).toBe("unknown"); expect(held(f, f.ids.user!)?.exposure).toBe("unknown");
  const retained = f.plans(); expect(retained).toHaveLength(1);
  const recovery = await syncMemory(f.store, f.opts(remote)); expect(recovery).toMatchObject({ ok: false, placementPublication: { outcome: "unknown" } });
  expect(f.plans()).toEqual(retained); expect(refs(remote)).toEqual([PROJECT_REF]); expect(git(remote, "rev-parse", PROJECT_REF)).toBe(competingHead);
});

test("policy tightened after accepted CAS retains factual publication and reports the last positive policy ceiling", async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ row: store.note(note("POST_ACCEPTED_POLICY_CANARY")) }) });
  const previousPolicy = f.capture().context.policyHash; let changed = false, changedAt = 0;
  const result = await syncPlacementMemory(f.store, f.opts(remote), phase => {
    if (changed || phase !== "cas-returned") return; changed = true; changedAt = Date.now();
    f.policy(["POST_ACCEPTED_POLICY_CANARY"]); f.changePolicyEpoch();
  });
  expect(changed).toBe(true);
  expect(result).toMatchObject({ ok: true, pushed: true, placementPublication: { outcome: "committed", lastPolicyHash: previousPolicy, policyCeiling: "last-positive-check-before-in-flight-push" } });
  expect(result.placementPublication?.lastPolicyCheckUnixMs).toBeGreaterThan(0);
  expect(result.placementPublication!.lastPolicyCheckUnixMs!).toBeLessThanOrEqual(changedAt);
  expect(f.capture().context.policyHash).not.toBe(previousPolicy);
  expect(held(f, f.ids.row!)?.exposure).toBe("published"); expect(reachableBytes(remote)).toContain("POST_ACCEPTED_POLICY_CANARY");
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(held(f, f.ids.row!)).toMatchObject({ held: true, exposure: "published" });
});

test("same-size owned candidate blob corruption is detected before any native CAS", async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ row: store.note(note("candidate integrity original")) }) }); let corrupted = false, returned = false;
  const result = await syncPlacementMemory(f.store, f.opts(remote), phase => {
    if (phase === "cas-returned") returned = true;
    if (corrupted || phase !== "before-cas") return;
    const plan = JSON.parse(readFileSync(join(f.home, "sync-placement", "epochs", f.epochHash, f.plans()[0]!), "utf8")) as { seal: string; chunks: { kind: string; index: number }[] };
    const descriptor = plan.chunks.find(chunk => chunk.kind === "objects"); if (!descriptor) throw Error("synthetic object chunk unavailable");
    const chunk = JSON.parse(readFileSync(join(f.home, "sync-placement", "epochs", f.epochHash, `publication-${plan.seal}-chunk-${String(descriptor.index).padStart(5, "0")}.json`), "utf8")) as { items: { oid: string; type: string }[] };
    const object = chunk.items.find(item => item.type === "blob"); if (!object) throw Error("synthetic candidate blob unavailable");
    const file = join(f.home, "shard-sync-placement", "objects.git", "objects", object.oid.slice(0, 2), object.oid.slice(2)), raw = inflateSync(readFileSync(file)), bodyStart = raw.indexOf(0) + 1;
    if (bodyStart < 1 || bodyStart >= raw.length) throw Error("synthetic candidate body unavailable");
    const originalSize = raw.length; raw[bodyStart] = raw[bodyStart]! ^ 1; expect(raw.length).toBe(originalSize);
    chmodSync(file, 0o600); writeFileSync(file, deflateSync(raw)); corrupted = true;
  });
  expect(corrupted).toBe(true); expect(returned).toBe(false); expect(result.ok).toBe(false); expect(refs(remote)).toEqual([]);
});

for (const indirection of ["commondir", "partial-clone"] as const) test("existing placement cache refuses " + indirection + " without touching unrelated Git state", async () => {
  const remote = bare(), unrelated = bare(), f = await fixture({ seed: store => ({ row: store.note(note("cache isolation original")) }) });
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  const head = git(remote, "rev-parse", PROJECT_REF); git(unrelated, "fetch", "-q", "--no-tags", remote, `${PROJECT_REF}:refs/heads/unrelated`);
  const foreignRefs = git(unrelated, "for-each-ref", "--format=%(refname) %(objectname)"), foreignConfig = readFileSync(join(unrelated, "config"));
  const remoteRefs = git(remote, "for-each-ref", "--format=%(refname) %(objectname)"), cache = join(f.home, "shard-sync-placement", "objects.git");
  f.store.note(note("new candidate cannot cross cache indirection"));
  if (indirection === "commondir") writeFileSync(join(cache, "commondir"), unrelated + "\n", { mode: 0o600 });
  else git(cache, "config", "extensions.partialClone", "origin");
  const result = await syncMemory(f.store, f.opts(remote)); expect(result.ok).toBe(false);
  expect(git(remote, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(remoteRefs); expect(git(remote, "rev-parse", PROJECT_REF)).toBe(head);
  expect(git(unrelated, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(foreignRefs); expect(readFileSync(join(unrelated, "config"))).toEqual(foreignConfig);
});

function expiredPrune(f: Awaited<ReturnType<typeof fixture>>, target: string, placement: "local" | "synced"): PruneRow {
  const auth = { project: PROJECT, actor: "person" as const, authorize: () => true,
    ...(placement === "synced" ? { policy: { revision: () => "synthetic-public-prune-v1", classify: () => "public" as const, attest: () => true } } : {}) };
  const plan = planPrune(f.store.prunePort(), { cutoff: new Date(f.clock.now).toISOString(), targets: [target] }, auth);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe(placement);
  expect(applyPrune(f.store.prunePort(), plan, auth).completed).toContain(plan.rows[0]!.payload.id);
  return plan.rows[0]!.payload;
}
async function publishedPruneFixture() {
  const remote = bare(), source = await fixture({ seed: store => ({ target: store.note(note("strict public prune target")) }) });
  expect((await syncMemory(source.store, source.opts(remote))).ok).toBe(true);
  expect(source.store.demote(source.ids.target!, "person", PROJECT)).toBeDefined();
  // Both exact original and expiry-basis occurrences are positively public before the native prune is authored.
  expect((await syncMemory(source.store, source.opts(remote))).ok).toBe(true);
  source.clock.now += 2000;
  const prune = expiredPrune(source, source.ids.target!, "synced");
  return { remote, source, prune };
}

test("same-generation v3 native prune retains exact public witnesses, original row and rebuild parity", async () => {
  const f = await publishedPruneFixture();
  expect((await syncMemory(f.source.store, f.source.opts(f.remote))).ok).toBe(true);
  expect(reachableBytes(f.remote)).toContain(canonicalJSON(f.prune));
  const receiver = await fixture({ generation: f.source.store.profile.generation! });
  expect((await syncMemory(receiver.store, receiver.opts(f.remote))).ok).toBe(true);
  const snapshot = receiver.store.prunePort().snapshot();
  expect(snapshot.pruned).toContain(f.source.ids.target!); expect(snapshot.durablePruneIds).toContain(f.prune.id);
  expect(receiver.store.get(f.source.ids.target!, PROJECT)).toBeUndefined();
  const before = canonicalJSON(snapshot); receiver.store.rebuild(); expect(canonicalJSON(receiver.store.prunePort().snapshot())).toBe(before);
  const bytes = authoredBytes(receiver.home), plans = receiver.plans(); expect((await syncMemory(receiver.store, receiver.opts(f.remote))).ok).toBe(true); expect(authoredBytes(receiver.home)).toEqual(bytes); expect(receiver.plans()).toEqual(plans);
}, 60_000);

test("foreign supported v3 prune activates its complete graph without appending a native translation", async () => {
  const f = await publishedPruneFixture(); expect((await syncMemory(f.source.store, f.source.opts(f.remote))).ok).toBe(true);
  const receiver = await fixture(); expect(receiver.store.profile.generation).not.toBe(f.source.store.profile.generation);
  const result = await syncMemory(receiver.store, receiver.opts(f.remote));
  expect(result).toMatchObject({ ok: true, pruneApplication: { proofComplete: 1, projectionActive: 1, held: 0 } });
  expect(receiver.store.get(f.source.ids.target!, PROJECT)).toBeUndefined();
  const snapshot = receiver.store.prunePort().snapshot(); expect(snapshot.pruned).toContain(f.source.ids.target!); expect(snapshot.durablePruneIds).not.toContain(f.prune.id);
  for (const bytes of Object.values(authoredBytes(receiver.home))) expect(Buffer.from(bytes, "base64").toString("utf8")).not.toContain(canonicalJSON(f.prune));
  const before = canonicalJSON(snapshot); receiver.store.rebuild(); expect(canonicalJSON(receiver.store.prunePort().snapshot())).toBe(before);
  const stored = authoredBytes(receiver.home), plans = receiver.plans(); expect((await syncMemory(receiver.store, receiver.opts(f.remote))).ok).toBe(true);
  expect(authoredBytes(receiver.home)).toEqual(stored); expect(receiver.plans()).toEqual(plans);
}, 60_000);

test("a permitted native prune uses exact already-public held target and basis packs without resending their bodies", async () => {
  const f = await publishedPruneFixture(), target = f.source.ids.target!;
  const before = git(f.remote, "rev-parse", PROJECT_REF), oldFiles = new Set(git(f.remote, "ls-tree", "-r", "--name-only", before).split("\n").filter(Boolean));
  const oldRows = verifiedPublicRows(f.remote);
  expect(Object.keys(syncOutboundContent(oldRows.get(f.prune.targets[0]!.basis.id)))).toEqual([]);
  expect(Object.keys(syncOutboundContent(f.prune)).length).toBeGreaterThan(0);
  f.source.policy(["strict public prune target"]); f.source.changePolicyEpoch();
  // A demotion's validated ID/UTC operands are generated metadata, so its projected content is empty.
  // This fresh host restriction holds that already-public basis as well as the machine-policy-held target.
  const opts: SyncOptions = { ...f.source.opts(f.remote), screen: value => Object.keys(value).length > 0 };
  const result = await syncMemory(f.source.store, opts); expect(result.ok).toBe(true);
  const after = git(f.remote, "rev-parse", PROJECT_REF); expect(after).not.toBe(before);
  const files = git(f.remote, "ls-tree", "-r", "--name-only", after).split("\n").filter(Boolean);
  const newPacks = files.filter(file => file.startsWith("rows/") && !oldFiles.has(file));
  const newRows = newPacks.flatMap(file => git(f.remote, "show", `${after}:${file}`).split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string }));
  expect(newRows).toEqual([f.prune]);
  for (const file of newPacks) expect(git(f.remote, "show", `${after}:${file}`)).not.toContain("strict public prune target");
  const manifests = files.filter(file => file.startsWith("prune-witnesses/") && !oldFiles.has(file)).map(file => JSON.parse(git(f.remote, "show", `${after}:${file}`)) as PublicPruneWitnessV1);
  const manifest = manifests.find(value => value.prune.id === f.prune.id); expect(manifest).toBeDefined();
  expect(Object.keys(syncOutboundContent(manifest!)).length).toBeGreaterThan(0);
  expect(manifest!.prune).toEqual(f.prune); expect(manifest!.realm).toEqual({ scope: "project", key: PROJECT });
  expect(manifest!.prune.generation).toBe(f.source.store.profile.generation!);
  for (const item of f.prune.targets) for (const required of [item, item.basis]) {
    const witness = manifest!.witnesses.find(value => value.id === required.id); expect(witness).toBeDefined();
    expect(witness!.rowHash).toBe(required.rowHash); expect(oldFiles.has(witness!.pack)).toBe(true);
    expect(witness!.blob).toBe(git(f.remote, "rev-parse", `${before}:${witness!.pack}`));
    expect(hashJSON(oldRows.get(required.id))).toBe(required.rowHash);
    expect(held(f.source, required.id)).toMatchObject({ held: true, exposure: "published" });
  }
  expect((oldRows.get(f.prune.targets[0]!.basis.id) as { op: string }).op).toBe("demote");
  expect(held(f.source, target)).toMatchObject({ held: true, exposure: "published" });
  expect(held(f.source, f.prune.id)).toMatchObject({ held: false, exposure: "published" });
  expect(reachableBytes(f.remote)).toContain("strict public prune target"); // Historical disclosure is retained, never retracted.
  const receiver = await fixture(); expect((await syncMemory(receiver.store, receiver.opts(f.remote))).ok).toBe(true);
  expect(receiver.store.get(target, PROJECT)).toBeUndefined(); expect(receiver.store.prunePort().snapshot().pruned).toContain(target);
}, 60_000);

function nativePruneTargets(f: Awaited<ReturnType<typeof fixture>>, targets: string[]): PruneRow {
  const auth = { project: PROJECT, actor: "person" as const, authorize: () => true,
    policy: { revision: () => "synthetic-public-prune-v1", classify: () => "public" as const, attest: () => true } };
  const plan = planPrune(f.store.prunePort(), { cutoff: new Date(f.clock.now).toISOString(), targets }, auth);
  expect(plan.rows).toHaveLength(1); expect(plan.rows[0]!.placement).toBe("synced");
  expect(plan.rows[0]!.payload.targets.map(target => target.id).sort()).toEqual([...targets].sort());
  expect(applyPrune(f.store.prunePort(), plan, auth).completed).toContain(plan.rows[0]!.payload.id);
  return plan.rows[0]!.payload;
}

test("a legitimate native prune of an unpublished held target stays whole and never hydrates its body", async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ bootstrap: store.note(note("native unpublished bootstrap")) }) });
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true); // Installs the actual publisher boundary for later person operations.
  const target = f.store.note(note("NEVER_PUBLIC_NATIVE_PRUNE_TARGET")); expect(f.store.demote(target, "person", PROJECT)).toBeDefined();
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true); expect(held(f, target)).toMatchObject({ held: true, exposure: "unknown" });
  f.clock.now += 2000;
  // The existing person-authorized native API may classify a physical synced row public. Transport must
  // independently require an actual public occurrence, rather than treating that source classification as disclosure.
  const prune = nativePruneTargets(f, [target]), head = git(remote, "rev-parse", PROJECT_REF), physical = authoredBytes(f.home);
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(git(remote, "rev-parse", PROJECT_REF)).toBe(head); expect(authoredBytes(f.home)).toEqual(physical);
  expect(held(f, prune.id)).toMatchObject({ held: true, exposure: "unknown" });
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_NATIVE_PRUNE_TARGET", prune.id]);
  expect(candidateBytes(f.home)).not.toContain('"op":"prune"');
}, 60_000);

test("a mixed native prune with public-held and unpublished-held targets never splits or backfills its original", async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ public: store.note(note("MIXED_ALREADY_PUBLIC_TARGET")) }) });
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(f.store.demote(f.ids.public!, "person", PROJECT)).toBeDefined(); expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  const hidden = f.store.note(note("NEVER_PUBLIC_MIXED_PRUNE_TARGET")); expect(f.store.demote(hidden, "person", PROJECT)).toBeDefined();
  f.policy(["NEVER_PUBLIC_", "MIXED_ALREADY_PUBLIC_TARGET"]);
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(held(f, f.ids.public!)).toMatchObject({ held: true, exposure: "published" }); expect(held(f, hidden)).toMatchObject({ held: true, exposure: "unknown" });
  f.clock.now += 2000;
  const prune = nativePruneTargets(f, [f.ids.public!, hidden]), head = git(remote, "rev-parse", PROJECT_REF), physical = authoredBytes(f.home);
  const beforeRows = [...verifiedPublicRows(remote).keys()].sort();
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  expect(git(remote, "rev-parse", PROJECT_REF)).toBe(head); expect([...verifiedPublicRows(remote).keys()].sort()).toEqual(beforeRows);
  expect(authoredBytes(f.home)).toEqual(physical); expect(held(f, prune.id)).toMatchObject({ held: true, exposure: "unknown" });
  assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_MIXED_PRUNE_TARGET", prune.id]);
  expect(candidateBytes(f.home)).not.toContain('"op":"prune"');
}, 60_000);

test("an unwitnessed locally pruned legacy original never gets first publication or a candidate object", async () => {
  const remote = bare(), f = await fixture({ seed(store) {
    const target = store.note(note("UNWITNESSED_PRUNED_CANARY")); expect(store.demote(target, "person", PROJECT)).toBeDefined();
    return { target, allowed: store.note(note("independent eligible original beside local prune")) };
  } });
  f.clock.now += 2000; const prune = expiredPrune(f, f.ids.target!, "local"); expect(prune.placement).toBe("local");
  expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
  assertNeverPublished(f.home, remote, ["UNWITNESSED_PRUNED_CANARY"]);
  expect(reachableBytes(remote)).toContain(f.ids.allowed!); expect(reachableBytes(remote)).not.toContain(prune.id);
  expect(f.store.get(f.ids.target!, PROJECT)).toBeUndefined();
}, 60_000);

test("receiver policy-held incoming public goal cannot authorize a fresh dependent, and first-attempt exposure/holds are durable", async () => {
  const remote = bare(), source = await fixture({ patterns: [], seed: store => ({ goal: store.goal({ project: PROJECT, scope: "project", title: "ALREADY_PUBLIC_PRIVATE_GOAL", milestones: [], dependsOn: [], actor: "person" }) }) });
  expect((await syncMemory(source.store, source.opts(remote))).ok).toBe(true); expect(reachableBytes(remote)).toContain("ALREADY_PUBLIC_PRIVATE_GOAL");
  const receiver = await fixture({ patterns: ["ALREADY_PUBLIC_PRIVATE_GOAL"], seed: store => ({ dependent: store.goal({ project: PROJECT, scope: "project", title: "safe receiver dependent", milestones: [], dependsOn: [source.ids.goal!], actor: "person" }) }) });
  const result = await syncMemory(receiver.store, receiver.opts(remote)); expect(result.ok).toBe(true);
  expect(held(receiver, source.ids.goal!)).toMatchObject({ held: true, exposure: "published" });
  expect(held(receiver, receiver.ids.dependent!)).toMatchObject({ held: true, exposure: "unknown" });
  expect(reachableBytes(remote)).not.toContain(receiver.ids.dependent!); expect(candidateBytes(receiver.home)).not.toContain(receiver.ids.dependent!);
  // The goal was already public; no retraction or never-published claim is made for its body.
  expect(reachableBytes(remote)).toContain("ALREADY_PUBLIC_PRIVATE_GOAL");
  const plans = receiver.plans(), physical = authoredBytes(receiver.home);
  expect((await syncMemory(receiver.store, receiver.opts(remote))).ok).toBe(true);
  expect(receiver.plans()).toEqual(plans); expect(authoredBytes(receiver.home)).toEqual(physical);
  expect(held(receiver, source.ids.goal!)).toMatchObject({ held: true, exposure: "published" });
}, 60_000);

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function pendingNativePruneFixture(mode: "valid" | "invalid-tail" | "missing-fetched") {
  // Source has already published the exact target and expiry basis; its newly authored prune is still private here.
  const f = await publishedPruneFixture(), receiver = await fixture({ generation: f.source.store.profile.generation! });
  expect((await syncMemory(receiver.store, receiver.opts(f.remote))).ok).toBe(true);
  if (mode !== "missing-fetched") expect((await syncMemory(f.source.store, f.source.opts(f.remote))).ok).toBe(true);
  const row = f.prune, realm = { scope: "project" as const, key: PROJECT }, port = receiver.store.prunePort();
  const body: Omit<PrunePlan, "seal"> = { schema: "agent-mem.prune-plan/v1", generation: receiver.store.profile.generation!, selectorRevision: port.selectorRevision(), project: PROJECT,
    policyRevision: hashJSON({ schema: "agent-mem.shard-sync/v1", realm }), rows: [{ placement: "synced", payload: row }],
    counts: { eligible: row.targets.length, selected: row.targets.length, local: 0, synced: row.targets.length }, hasMore: false };
  const plan = validatePrunePlan({ ...body, seal: hashJSON(body) }); port.persistPrunePlan(plan);
  const line = canonicalJSON(row) + "\n", segment = join(receiver.store.dir, "log", `${row.machine}.jsonl`);
  const initial = openSync(segment, "a", 0o600); try { fsyncSync(initial); } finally { closeSync(initial); }
  const prefix = readFileSync(segment), pending = join(receiver.store.dir, "prune-plans", `pending-log-${row.machine}.json`);
  writeProfileJSON(pending, { schema: "agent-mem.prune-append/v1", seal: plan.seal, rowId: row.id, lineHash: digest(line), offset: prefix.length, prefixHash: digest(prefix) });
  const partial = Buffer.from(line).subarray(0, 23);
  if (mode === "invalid-tail") partial[partial.length - 1] = partial[partial.length - 1]! ^ 1;
  appendFileSync(segment, partial); const written = openSync(segment, "a"); try { fsyncSync(written); } finally { closeSync(written); }
  return { ...f, receiver, row, plan, line, prefix, segment, pending };
}

test("ordinary v3 sync resumes an actual owned PARTIAL native prune claim from exact fetched proof, preserving the original once", async () => {
  const f = await pendingNativePruneFixture("valid");
  expect(() => f.receiver.capture()).toThrow(); // A raw partial tail alone is never a general capture admission port.
  const result = await syncMemory(f.receiver.store, f.receiver.opts(f.remote)); expect(result.ok).toBe(true);
  expect(existsSync(f.pending)).toBe(false);
  expect(readFileSync(f.segment)).toEqual(Buffer.concat([f.prefix, Buffer.from(f.line)]));
  const appended = readFileSync(f.segment, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string });
  expect(appended.filter(row => row.id === f.row.id)).toEqual([f.row]);
  expect(f.receiver.store.prunePort().snapshot().durablePruneIds?.filter(id => id === f.row.id)).toHaveLength(1);
  expect(f.receiver.store.get(f.source.ids.target!, PROJECT)).toBeUndefined();
  const snapshot = canonicalJSON(f.receiver.store.prunePort().snapshot()); f.receiver.store.rebuild(); expect(canonicalJSON(f.receiver.store.prunePort().snapshot())).toBe(snapshot);
  const physical = authoredBytes(f.receiver.home), plans = f.receiver.plans();
  expect((await syncMemory(f.receiver.store, f.receiver.opts(f.remote))).ok).toBe(true);
  expect(authoredBytes(f.receiver.home)).toEqual(physical); expect(f.receiver.plans()).toEqual(plans);
}, 60_000);

for (const mode of ["invalid-tail", "missing-fetched"] as const) test("v3 pending prune " + mode + " refuses before publication or source repair", async () => {
  const f = await pendingNativePruneFixture(mode), before = authoredBytes(f.receiver.home), claim = readFileSync(f.pending), plans = f.receiver.plans();
  const heads = git(f.remote, "for-each-ref", "--format=%(refname) %(objectname)");
  const result = await syncMemory(f.receiver.store, f.receiver.opts(f.remote)); expect(result).toMatchObject({ ok: false, pushed: false });
  expect(authoredBytes(f.receiver.home)).toEqual(before); expect(readFileSync(f.pending)).toEqual(claim); expect(f.receiver.plans()).toEqual(plans);
  expect(git(f.remote, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(heads);
}, 60_000);

/** Isolated crash-prefix construction only. Production recovery must complete the prefix itself; tests never heal it. */
function persistCrashPrefix(file: string, bytes: Uint8Array): void {
  writeFileSync(file, bytes, { mode: 0o600 }); const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function retainedPublication(f: Awaited<ReturnType<typeof fixture>>) {
  const names = f.plans(); expect(names).toHaveLength(1);
  const root = JSON.parse(readFileSync(join(f.home, "sync-placement", "epochs", f.epochHash, names[0]!), "utf8")) as { seal: string };
  return publicationStorage.readPlacementPublication(f.home, f.epochHash, root.seal);
}

for (const kind of ["hold", "publication-ambiguous", "publication-committed"] as const)
  test(`ordinary coordinator resumes a torn SECOND ${kind} journal append after an already durable prefix`, async () => {
    const remote = bare(), f = await fixture({ seed(store) {
      return { a: store.note(note("later journal allowed a")), b: store.note(note("later journal allowed b")), c: store.note(note("later journal allowed c")),
        deniedA: store.note(note("NEVER_PUBLIC_LATER_A")), deniedB: store.note(note("NEVER_PUBLIC_LATER_B")), deniedC: store.note(note("NEVER_PUBLIC_LATER_C")) };
    } });
    const physicalBefore = authoredBytes(f.home), realAppend = journalStorage.appendPlacementEvent;
    let matching = 0, fired = false;
    const fault = spyOn(journalStorage, "appendPlacementEvent").mockImplementation((home, epochHash, event, expectedHead, options) => {
      const selected = home === f.home && event.kind === kind && ++matching === 2;
      return realAppend(home, epochHash, event, expectedHead, { ...options, phase(stage) {
        options.phase?.(stage);
        if (!selected || fired || stage !== "intent-fsync") return;
        const dir = join(home, "sync-placement", "epochs", epochHash);
        const intent = JSON.parse(readFileSync(join(dir, "append-intent.json"), "utf8")) as { chunk: string; prefixBytes: number; record: unknown };
        const chunk = join(dir, intent.chunk), before = existsSync(chunk) ? readFileSync(chunk) : Buffer.alloc(0), line = Buffer.from(json(intent.record));
        expect(before.length).toBe(intent.prefixBytes);
        persistCrashPrefix(chunk, Buffer.concat([before, line.subarray(0, 23)])); fired = true;
        throw Error("synthetic second journal append crash");
      } });
    });
    let interrupted: Awaited<ReturnType<typeof syncPlacementMemory>> | undefined;
    try { interrupted = await syncPlacementMemory(f.store, f.opts(remote)); } finally { fault.mockRestore(); }
    expect(fired).toBe(true); expect(interrupted?.ok).toBe(false);
    const pending = journalStorage.readPlacementJournal(f.home, f.epochHash), before = retainedPublication(f);
    expect(pending.pending).toBe(true); expect(pending.pendingRecordSequence).toBeGreaterThan(1);
    expect(pending.pendingRecord?.kind).toBe(kind); expect(pending.sequence).toBe(pending.pendingRecordSequence! - 1);
    expect(pending.publicationReservation?.consumedRecords).toBeGreaterThan(0);
    if (kind !== "publication-committed") expect(refs(remote)).toEqual([]);
    const plans = f.plans(), resumed = await syncMemory(f.store, f.opts(remote));
    expect(resumed.ok).toBe(true); expect(f.plans()).toEqual(plans);
    const done = retainedPublication(f), journal = journalStorage.readPlacementJournal(f.home, f.epochHash);
    expect(done.phase).toBe("completed"); expect(done.pending).toBe(false); expect(journal.pending).toBe(false);
    expect(done.bundle.root.seal).toBe(before.bundle.root.seal); expect(done.consumedRecords).toBe(done.reservedRecords);
    expect(new Set(journal.records.map(record => record.requestId)).size).toBe(journal.records.length);
    for (const id of [f.ids.a!, f.ids.b!, f.ids.c!]) expect(held(f, id)?.exposure).toBe("published");
    for (const id of [f.ids.deniedA!, f.ids.deniedB!, f.ids.deniedC!]) expect(held(f, id)?.held).toBe(true);
    assertWitnessCopies(physicalBefore, authoredBytes(f.home), remote);
    assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_LATER_A", "NEVER_PUBLIC_LATER_B", "NEVER_PUBLIC_LATER_C"]);
    const after = authoredBytes(f.home); expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true);
    expect(authoredBytes(f.home)).toEqual(after); expect(f.plans()).toEqual(plans);
  });

for (const phase of ["artifact-built", "publication-intent", "completed"] as const)
  test(`ordinary coordinator completes a known partial ${phase} fact from its frozen payload without resealing`, async () => {
    const remote = bare(), f = await fixture({ seed: store => ({ allowed: store.note(note("partial publication fact original")), denied: store.note(note("NEVER_PUBLIC_PARTIAL_FACT")) }) });
    const physicalBefore = authoredBytes(f.home), realPhase = publicationStorage.recordPlacementPublicationPhase; let fired = false;
    const fault = spyOn(publicationStorage, "recordPlacementPublicationPhase").mockImplementation((home, epochHash, attemptHash, current, input, options) =>
      realPhase(home, epochHash, attemptHash, current, input, { ...options, phase(stage) {
        options.phase?.(stage);
        if (home !== f.home || current !== phase || fired || stage !== "publication-fact-written") return;
        const suffix = phase === "artifact-built" ? "artifact" : phase === "publication-intent" ? "intent" : "receipt";
        const file = join(home, "sync-placement", "epochs", epochHash, `publication-${attemptHash}-${suffix}.json`), bytes = readFileSync(file);
        persistCrashPrefix(file, bytes.subarray(0, 29)); fired = true; throw Error("synthetic partial publication fact crash");
      } }));
    let interrupted: Awaited<ReturnType<typeof syncPlacementMemory>> | undefined;
    try { interrupted = await syncPlacementMemory(f.store, f.opts(remote)); } finally { fault.mockRestore(); }
    expect(fired).toBe(true); expect(interrupted?.ok).toBe(false);
    const partial = retainedPublication(f); expect(partial.pending).toBe(true); expect(partial.pendingPhase).toBe(phase);
    const plans = f.plans(), root = partial.bundle.root;
    expect(root.policySnapshotUnixMs).toBeGreaterThan(0);
    const resumed = await syncMemory(f.store, f.opts(remote)); expect(resumed.ok).toBe(true);
    const complete = retainedPublication(f); expect(complete.pending).toBe(false); expect(complete.phase).toBe("completed");
    expect(complete.bundle).toEqual(partial.bundle); expect(f.plans()).toEqual(plans);
    const intent = complete.facts.find(fact => fact.phase === "publication-intent");
    expect(intent?.phase === "publication-intent" ? intent.policyCheckUnixMs : undefined).toBe(root.policySnapshotUnixMs);
    expect(held(f, f.ids.allowed!)?.exposure).toBe("published"); expect(held(f, f.ids.denied!)?.held).toBe(true);
    assertWitnessCopies(physicalBefore, authoredBytes(f.home), remote); assertNeverPublished(f.home, remote, ["NEVER_PUBLIC_PARTIAL_FACT"]);
    expect((await syncMemory(f.store, f.opts(remote))).ok).toBe(true); expect(f.plans()).toEqual(plans);
  });

test("source-local already-public row keeps its frozen hold when policy drifts after plan fsync", async () => {
  const remote = bare(), source = await fixture({ patterns: [], seed: store => ({ row: store.note(note("ALREADY_PUBLIC_SOURCE_LOCAL")) }) });
  expect((await syncMemory(source.store, source.opts(remote))).ok).toBe(true);
  const original = [...source.capture().rows.values()].find(value => value.key.id === source.ids.row!)!.row;
  if (original.op !== "note") throw Error("synthetic original is not a note");
  const receiver = await fixture({ patterns: ["ALREADY_PUBLIC_SOURCE_LOCAL"], seed(store) {
    const { schema: _schema, id, at, machine, ...input } = original;
    expect(store.importNote(input as NoteInput, at, { machine, expectedId: id }).id).toBe(id);
    // Before migration, model an existing valid legacy-local long original, preserving its exact ID/payload.
    // The original has positive public occurrence evidence in the independent sender's real Git history.
    renameSync(join(store.dir, "log", `${store.machine.id}.jsonl`), join(store.dir, "local", `${store.machine.id}.jsonl`));
    return { row: id };
  } });
  expect([...receiver.capture().rows.values()].find(value => value.key.id === original.id)?.sourcePlacement).toBe("local");
  const physicalBefore = authoredBytes(receiver.home), remoteHead = git(remote, "rev-parse", PROJECT_REF); let fired = false;
  const interrupted = await syncPlacementMemory(receiver.store, receiver.opts(remote), phase => {
    if (!fired && phase === "plan-fsynced") { fired = true; throw Error("synthetic source-local frozen hold crash"); }
  });
  expect(fired).toBe(true); expect(interrupted?.ok).toBe(false);
  const frozen = retainedPublication(receiver), decision = frozen.bundle.chunks.filter(chunk => chunk.kind === "decisions")
    .flatMap(chunk => chunk.items as { key: { id: string }; sourcePlacement: string; hold: boolean }[]).find(value => value.key.id === original.id);
  expect(decision).toMatchObject({ sourcePlacement: "local", hold: true });
  receiver.policy([]); receiver.changePolicyEpoch();
  const stale = await syncMemory(receiver.store, receiver.opts(remote));
  expect(stale).toMatchObject({ ok: false, placementPublication: { outcome: "unknown", recovered: true } });
  expect(held(receiver, original.id)?.held).toBe(true); expect(retainedPublication(receiver).phase).toBe("completed");
  expect(receiver.plans()).toHaveLength(1); expect(authoredBytes(receiver.home)).toEqual(physicalBefore); expect(git(remote, "rev-parse", PROJECT_REF)).toBe(remoteHead);
  expect((await syncMemory(receiver.store, receiver.opts(remote))).ok).toBe(true);
  expect(held(receiver, original.id)).toMatchObject({ held: true, exposure: "published" });
  expect(git(remote, "rev-parse", PROJECT_REF)).toBe(remoteHead);
});

for (const kind of ["missing", "incompatible", "throwing"] as const) test(`actual v3 sync refuses ${kind} writer attestation before cache, publication or source effects`, async () => {
  const remote = bare(), f = await fixture({ seed: store => ({ row: store.note(note("attestation refusal source original")) }) });
  const physical = authoredBytes(f.home), plans = f.plans(), cache = join(f.home, "shard-sync-placement");
  const opts: SyncOptions = { ...f.opts(remote), placementAttestation: kind === "missing" ? undefined
    : kind === "incompatible" ? () => ({ writers: [], legacySyncQuiesced: true })
    : () => { throw Error("NEVER_PUBLIC_ATTESTATION_FAILURE"); } };
  expect(existsSync(cache)).toBe(false);
  const result = await syncMemory(f.store, opts);
  expect(result).toMatchObject({ ok: false, pushed: false }); expect(JSON.stringify(result)).not.toContain("NEVER_PUBLIC_ATTESTATION_FAILURE");
  expect(existsSync(cache)).toBe(false); expect(refs(remote)).toEqual([]); expect(authoredBytes(f.home)).toEqual(physical); expect(f.plans()).toEqual(plans);
});
