import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activePlacementWriterContext, PlacementWriterContextError } from "../src/sync-placement-writer-context.ts";
import { readPlacementJournal, releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { resolvePlacementWindow, PLACEMENT_CHECKPOINT_PENDING_MESSAGE } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { abandonPlacementCheckpointPerson, confirmPlacementCheckpoint, previewPlacementCheckpoint, resumePlacementCheckpointPerson, checkpointHeadroomFor, PlacementCheckpointError } from "../src/memory/sync-placement-checkpoint-person.ts";
import { placementSyncBoundMessage } from "../src/memory/sync-placement-bound.ts";
import { createInspectionRemote } from "./fakes/sync-placement-inspection.ts";
import { runCli } from "../src/cli.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { shardKeyHash } from "../src/memory/shard.ts";
import { applyRealmAdmission } from "../src/memory/sync-placement-realm-admission.ts";
import { remoteRealmAdmission } from "../src/memory/sync-placement-remote-admission.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FLOOR = "0.30.0";
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (at: string, prefix: string) => { for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (entry.isDirectory()) visit(join(at, entry.name), prefix + entry.name + "/"); else out[prefix + entry.name] = sha(readFileSync(join(at, entry.name)));
  } };
  if (existsSync(dir)) visit(dir, ""); return out;
}
async function cause(work: () => Promise<unknown> | unknown): Promise<string> {
  try { await work(); } catch (error) { return error instanceof PlacementCheckpointError ? error.causeClass : (error as { code?: string }).code ?? (error as Error).message; }
  throw Error("expected a refusal");
}
async function fixture() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  const floor = (minReader: string) => writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader, since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  floor(FLOOR);
  const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
  const sync = async () => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { return await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest }); } finally { store.close(); }
  };
  const opts = { writerRoots: [activationOwnRoot], ownRoot: activationOwnRoot };
  const epochHash = readEffectiveSyncPlacementWriters(f.base).epochHash;
  return { ...f, floor, sync, opts, epochHash, checkpoints: join(f.base, "sync-placement-checkpoints"), epochDir: join(f.base, "sync-placement", "epochs", epochHash) };
}
const withHome = async <T>(home: string, work: () => Promise<T>): Promise<T> => {
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
  try { return await work(); } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
};

test("#288: headroom compares both inputs, reports unknown cache, and rejects a plan too large for one checkpoint", () => {
  const completed = { slots: 12, reservedJournalChunks: 2 };
  expect(checkpointHeadroomFor(0, completed, { state: "none" }).largestPlan).toEqual(completed);
  const unknown = checkpointHeadroomFor(0, completed, { state: "unavailable", reason: "cache-or-remote-evidence-unavailable" });
  expect(unknown.prospectivePlan.state).toBe("unavailable"); expect(unknown.largestPlan).toEqual(completed);
  const pending = checkpointHeadroomFor(0, completed, { state: "cache-only", slots: 20, reservedJournalChunks: 4 });
  expect(pending.largestPlan).toEqual({ slots: 20, reservedJournalChunks: 4 });
  // Four staged files plus active.json and one later renewal: a 250-object plan fits exactly.
  const exact = checkpointHeadroomFor(0, completed, { state: "cache-only", slots: 250, reservedJournalChunks: 0 });
  expect(exact).toMatchObject({ liveAfter: 5, required: 256, remaining: 0 });
  expect(() => checkpointHeadroomFor(0, completed, { state: "cache-only", slots: 251, reservedJournalChunks: 0 })).toThrow("1 over the limit");
  expect(() => checkpointHeadroomFor(0, completed, { state: "cache-only", slots: 250, reservedJournalChunks: 10 })).toThrow("10 over the limit");
  expect(() => checkpointHeadroomFor(0, completed, { state: "cache-only", slots: 250, reservedJournalChunks: 10 })).toThrow("multi-plan split");
});

test("#288: offline prospective plan uses cache and pending source without modifying home bytes", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try { store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "new checkpoint prospective row", about: [] }); }
  finally { store.close(); }
  const before = tree(f.base), preview = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(tree(f.base)).toEqual(before);
  expect(preview.headroom.prospectivePlan.state).toBe("cache-only");
  if (preview.headroom.prospectivePlan.state === "cache-only") {
    expect(preview.headroom.prospectivePlan.slots).toBeGreaterThan(0);
    const actual = await f.sync(); expect(actual.ok).toBe(true);
    expect(actual.placementPublication?.journalObjects?.newPlan?.slots).toBe(preview.headroom.prospectivePlan.slots);
  }
}, 240_000);

test("#288: unavailable remote evidence remains explicit through confirm", async () => {
  const f = await fixture(), before = tree(f.base);
  const preview = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(preview.headroom.prospectivePlan.state).toBe("unavailable");
  expect(tree(f.base)).toEqual(before);
  expect(await confirmPlacementCheckpoint(f.base, preview, { ...f.opts })).toMatchObject({ window: 1, renewed: true });
}, 240_000);

test("#288: confirm refuses when reviewed cache evidence disappears", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try { store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "synthetic pending checkpoint row", about: [] }); }
  finally { store.close(); }
  const preview = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(preview.headroom.prospectivePlan.state).toBe("cache-only");
  const cache = join(f.base, "shard-sync-placement", "objects.git");
  const deleted = memoryGitSync(["--git-dir", cache, "update-ref", "-d", `refs/heads/amem/p/${shardKeyHash(f.project)}`], { encoding: "utf8" });
  expect(deleted.status).toBe(0);
  const before = tree(f.base);
  const current = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(current.headroom.prospectivePlan.state).toBe("unavailable");
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview, { ...f.opts }))).toBe("changed");
  expect(tree(f.base)).toEqual(before);
}, 240_000);

test("#288 step 3: preview is readonly and reports composition, headroom and the exact confirm step", async () => {
  const f = await fixture();
  const noCache = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(noCache.headroom.prospectivePlan.state).toBe("unavailable");
  expect((await f.sync()).ok).toBe(true);
  const before = tree(f.base);
  const preview = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(preview.headroom.prospectivePlan.state).toBe("none");
  expect(tree(f.base)).toEqual(before);
  expect(existsSync(f.checkpoints)).toBe(false);
  expect(preview).toMatchObject({ mode: "checkpoint-preview", window: 0, nextWindow: 1, floorReady: true, writers: 1 });
  const parts = preview.journalObjects;
  expect(parts.epochFixed + parts.writerHistory + parts.journalChunks + parts.completedPublications.objects).toBe(preview.currentObjects);
  expect(preview.headroom.required).toBe(preview.headroom.liveAfter + 1 + preview.headroom.largestPlan.slots + preview.headroom.largestPlan.reservedJournalChunks);
  expect(preview.headroom.largestPlan.slots).toBeGreaterThan(0);
  expect(preview.nextStep).toContain("amem migrate --sync-placement --checkpoint --confirm --plan");
  // A below-minimum home floor is reported without writing.
  f.floor("0.22.0");
  expect((await previewPlacementCheckpoint(f.base, f.opts)).floorReady).toBe(false);
  // Without a writer inventory there is nothing to renew into (W, 1).
  expect(await cause(() => previewPlacementCheckpoint(f.base, { ...f.opts, writerRoots: [] }))).toBe("candidate");
}, 180_000);

test("#288 step 3: confirm refuses below the person floor, never writes it, then commits the sealed plan with one renewal", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  f.floor("0.22.0");
  const preview = await previewPlacementCheckpoint(f.base, { ...f.opts }), frozen = tree(f.epochDir), formats = readFileSync(join(f.base, "formats.json"));
  // The CLI's real floor is 0.30.0: a 0.22.0 home floor refuses with the formats raise next step, and nothing is written.
  const refused = await confirmPlacementCheckpoint(f.base, preview, f.opts).catch(error => error as PlacementCheckpointError);
  expect(refused).toBeInstanceOf(PlacementCheckpointError); expect((refused as PlacementCheckpointError).causeClass).toBe("floor");
  expect((refused as Error).message).toContain("amem formats raise home 0.30.0");
  expect(existsSync(f.checkpoints)).toBe(false); expect(readFileSync(join(f.base, "formats.json"))).toEqual(formats);
  // The reviewed plan can be confirmed after the person raises the home floor.
  f.floor(FLOOR);
  // This release meets the checkpoint floor (PLACEMENT_CHECKPOINT_MIN_READER); later releases stay above it.
  expect(Bun.semver.order(JSON.parse(readFileSync(join(activationOwnRoot, "package.json"), "utf8")).version, FLOOR)).toBeGreaterThanOrEqual(0);
  // Confirm must retain the reviewed headroom envelope, not accept a bare or edited plan.
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview.plan, { ...f.opts }))).toBe("changed");
  expect(await cause(() => confirmPlacementCheckpoint(f.base, { ...preview, headroom: { ...preview.headroom, remaining: preview.headroom.remaining + 1 } }, { ...f.opts }))).toBe("changed");
  const before = readEffectiveSyncPlacementWriters(f.base);
  expect(await confirmPlacementCheckpoint(f.base, preview, { ...f.opts })).toMatchObject({ window: 1, renewed: true, planHash: preview.planHash, nextStep: "amem sync" });
  releasePlacementStorageCaches();
  const window = resolvePlacementWindow(f.base, f.epochHash);
  expect(window).toMatchObject({ window: 1, pending: false });
  expect(preview.headroom.liveAfter).toBe(readdirSync(window.dir).length + 1);
  expect(tree(f.epochDir)).toEqual(frozen);
  const after = readEffectiveSyncPlacementWriters(f.base);
  expect(after.revisionSequence).toBe(1); expect(after.revisionHash).not.toBe(before.revisionHash);
  // The same sealed plan never commits twice.
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview, { ...f.opts }))).toBe("changed");
  expect((await f.sync()).ok).toBe(true);
}, 240_000);

test("#288: a sync-only floor cannot authorize a checkpoint", async () => {
  const f = await fixture();
  const file = join(f.base, "formats.json");
  writeFileSync(file, JSON.stringify([{ surface: "home", minReader: "0.21.0", since: "2026-11-19" }, { surface: "sync", minReader: FLOOR, since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const before = readFileSync(file);
  const preview = await previewPlacementCheckpoint(f.base, { ...f.opts });
  expect(preview.floorReady).toBe(false);
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview, { ...f.opts }))).toBe("floor");
  expect(readFileSync(file)).toEqual(before);
  expect(existsSync(f.checkpoints)).toBe(false);
}, 180_000);

test("#288: a release at or above 0.30.0 confirms a checkpoint using its real home floor", async () => {
  const f = await fixture();
  expect(Bun.semver.order(JSON.parse(readFileSync(join(activationOwnRoot, "package.json"), "utf8")).version, FLOOR)).toBeGreaterThanOrEqual(0);
  const formats = readFileSync(join(f.base, "formats.json"));
  const preview = await previewPlacementCheckpoint(f.base, f.opts);
  expect(preview.floorReady).toBe(true);
  expect(await confirmPlacementCheckpoint(f.base, preview, f.opts)).toMatchObject({ window: 1, renewed: true });
  expect(readFileSync(join(f.base, "formats.json"))).toEqual(formats);
}, 180_000);

test("#288: suffixed home and sync floors use the existing numeric floor comparison", async () => {
  const f = await fixture();
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([
    { surface: "home", minReader: "0.30.0+build.1", since: "2026-11-19" },
    { surface: "home", minReader: "0.30.0", since: "2026-11-19" },
    { surface: "sync", minReader: "0.30.0-rc.1", since: "2026-11-19" },
  ]) + "\n", { mode: 0o600 });
  const opts = { ...f.opts };
  const preview = await previewPlacementCheckpoint(f.base, opts);
  expect(preview.floorReady).toBe(true);
  expect(await confirmPlacementCheckpoint(f.base, preview, opts)).toMatchObject({ window: 1, renewed: true });
}, 180_000);

test("#288: every candidate writer must meet the actual home floor, including a suffixed floor", async () => {
  const f = await fixture();
  const old = join(f.root, "older candidate writer");
  mkdirSync(old, { mode: 0o755 }); mkdirSync(join(old, "src"), { mode: 0o755 }); mkdirSync(join(old, "bin"), { mode: 0o755 });
  writeFileSync(join(old, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.29.0" }), { mode: 0o644 });
  writeFileSync(join(old, "src", "index.ts"), "// isolated writer\n", { mode: 0o644 });
  writeFileSync(join(old, "bin", "amem.js"), "// isolated writer\n", { mode: 0o755 });
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([
    { surface: "home", minReader: "0.30.0+build.1", since: "2026-11-19" },
    { surface: "home", minReader: "0.30.0", since: "2026-11-19" },
  ]) + "\n", { mode: 0o600 });
  const opts = { ...f.opts, writerRoots: [activationOwnRoot, old] };
  const preview = await previewPlacementCheckpoint(f.base, opts);
  expect(preview.floorReady).toBe(true);
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview, opts))).toBe("writer-below-floor");
  expect(existsSync(f.checkpoints)).toBe(false);
}, 180_000);

test("#288 step 3: a pending checkpoint pauses sync with its own cause; abandon before the commit byte, resume after it", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const records = readPlacementJournal(f.base, f.epochHash).records, frozen = tree(f.epochDir);
  const preview = await previewPlacementCheckpoint(f.base, { ...f.opts });
  await expect(confirmPlacementCheckpoint(f.base, preview, { ...f.opts, phase: phase => { if (phase === "staged-fsync") throw Error("isolated interruption after staging"); } })).rejects.toThrow();
  releasePlacementStorageCaches();
  // Journal effects and the host writer adapter name the checkpoint, rather than an unrelated renewal transaction.
  expect(() => readPlacementJournal(f.base, f.epochHash)).toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(() => readEffectiveSyncPlacementWriters(f.base)).toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(() => activePlacementWriterContext(f.base, activationOwnRoot)).toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  const pendingBytes = tree(f.base), other = "example.test/checkpoint/unadmitted";
  await expect(applyRealmAdmission(f.base, other, { mode: "apply" })).rejects.toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  await expect(remoteRealmAdmission(f.base, other, { mode: "apply" })).rejects.toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  await expect(remoteRealmAdmission(f.base, other, { mode: "abandon", confirm: true })).rejects.toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(tree(f.base)).toEqual(pendingBytes);
  // A malformed checkpoint intent also fails closed: admission must not mutate evidence merely because the resolver
  // cannot classify the pending state. Restore the fixture's exact intent before exercising ordinary recovery.
  const intentFile = join(f.checkpoints, f.epochHash, "intent.json"), intentBytes = readFileSync(intentFile);
  writeFileSync(intentFile, "{}\n", { mode: 0o600 });
  const malformedBytes = tree(f.base);
  await expect(applyRealmAdmission(f.base, other, { mode: "apply" })).rejects.toThrow();
  await expect(remoteRealmAdmission(f.base, other, { mode: "abandon", confirm: true })).rejects.toThrow();
  expect(tree(f.base)).toEqual(malformedBytes);
  writeFileSync(intentFile, intentBytes, { mode: 0o600 });
  await withHome(f.base, async () => {
    for (const env of [{}, { CODEX_THREAD_ID: "t" }])
      await expect(runCli(["migrate", "--sync-placement", "--dry-run", "--writer-root", activationOwnRoot], { cwd: f.root, env, stdinTTY: false })).rejects.toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  });
  const paused = await f.sync();
  expect(paused.ok).toBe(false); expect(paused.failure?.cause).toBe("checkpoint-pending"); expect(paused.error).toBe(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(await cause(() => previewPlacementCheckpoint(f.base, { ...f.opts }))).toBe("pending");
  expect((await abandonPlacementCheckpointPerson(f.base)).abandoned).toBe(true);
  releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 0, pending: false });
  expect(tree(f.epochDir)).toEqual(frozen); expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(records);
  expect(await abandonPlacementCheckpointPerson(f.base)).toMatchObject({ abandoned: false, removed: 0 });
  // After the first commit byte: abandon refuses and names resume; resume finishes the frozen bytes once.
  const again = await previewPlacementCheckpoint(f.base, { ...f.opts });
  await expect(confirmPlacementCheckpoint(f.base, again, { ...f.opts, phase: phase => { if (phase === "commit-started") throw Error("isolated interruption inside the commit line"); } })).rejects.toThrow();
  releasePlacementStorageCaches();
  const refused = await abandonPlacementCheckpointPerson(f.base).then(() => { throw Error("expected a refusal"); }, error => error as PlacementCheckpointError);
  expect(refused.causeClass).toBe("commit-started"); expect(refused.message).toContain("amem migrate --sync-placement --checkpoint --resume");
  expect(await resumePlacementCheckpointPerson(f.base)).toMatchObject({ window: 1, resumed: true });
  expect(await resumePlacementCheckpointPerson(f.base)).toMatchObject({ window: 1, resumed: false });
  releasePlacementStorageCaches();
  expect((await f.sync()).ok).toBe(true);
}, 300_000);

test("#288 step 3: the CLI runs every mode for a marked session, refuses mixed modes, and the bound names the checkpoint", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  f.floor("0.22.0");
  const env = { CODEX_THREAD_ID: "t" }, roots = ["--writer-root", activationOwnRoot];
  await withHome(f.base, async () => {
    const text = await runCli(["migrate", "--sync-placement", "--checkpoint", ...roots], { cwd: f.root, env, stdinTTY: false });
    expect(text).toContain("Objects by holder"); expect(text).toContain("headroom after checkpoint");
    expect(text).toContain("home floor 0.30.0: missing; preview amem formats raise home 0.30.0");
    expect(text).toContain("completed plan:"); expect(text).toContain("prospective plan:");
    const saved = JSON.parse(await runCli(["migrate", "--sync-placement", "--checkpoint", "--json", ...roots], { cwd: f.root, env, stdinTTY: false }));
    const plan = join(f.root, "checkpoint-plan.json"); writeFileSync(plan, JSON.stringify(saved), { mode: 0o600 });
    // The below-minimum fixture floor makes confirm refuse with the floor step without writing.
    await expect(runCli(["migrate", "--sync-placement", "--checkpoint", "--confirm", "--plan", plan, ...roots], { cwd: f.root, env, stdinTTY: false })).rejects.toThrow("amem formats raise home 0.30.0");
    expect(existsSync(f.checkpoints)).toBe(false);
    expect(await runCli(["migrate", "--sync-placement", "--checkpoint", "--resume"], { cwd: f.root, env, stdinTTY: false })).toContain("nothing pending");
    expect(await runCli(["migrate", "--sync-placement", "--checkpoint", "--abandon"], { cwd: f.root, env, stdinTTY: false })).toContain("nothing pending");
    for (const argv of [["--confirm", ...roots], ["--resume", "--abandon"], ["--plan", plan, ...roots], ["--resume", ...roots], ["--apply", ...roots], ["--list-remote"], ["--from-remote"]])
      await expect(runCli(["migrate", "--sync-placement", "--checkpoint", ...argv], { cwd: f.root, env, stdinTTY: false })).rejects.toThrow();
    await expect(runCli(["migrate", "--checkpoint"], { cwd: f.root, env, stdinTTY: false })).rejects.toThrow("apply only to --sync-placement");
  });
  expect(placementSyncBoundMessage({ phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 280 })).toContain("amem migrate --sync-placement --checkpoint --writer-root");
  expect(placementSyncBoundMessage({ phase: "publication-plan", kind: "journal-records", limit: 20000, observed: 20001 })).not.toContain("--checkpoint");
}, 240_000);

// #624: the remedy the writer-proof refusal prints runs as printed: its saving preview yields the plan file confirm reads.
test("#624: the printed saving checkpoint preview produces a plan that --confirm --plan accepts", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const message = new PlacementWriterContextError("running CLI", "missing").message;
  const saving = /\(umask 077; set -C; amem (migrate .+?) > (checkpoint-plan\.json)\)/.exec(message)!;
  const confirm = /run amem (migrate --sync-placement --checkpoint --confirm --plan checkpoint-plan\.json) with the same --writer-root list/.exec(message)!;
  expect(saving).not.toBeNull(); expect(confirm).not.toBeNull();
  const fill = (argv: string) => argv.split(" ").map(arg => arg === "<install" ? activationOwnRoot : arg).filter(arg => arg !== "root>");
  const previewArgv = fill(saving[1]!), file = join(f.root, saving[2]!);
  expect(previewArgv).toEqual(["migrate", "--sync-placement", "--checkpoint", "--writer-root", activationOwnRoot, "--json"]);
  await withHome(f.base, async () => {
    // The redirect target is what the parentheses write: the preview's --json stdout, in a new 0600 file.
    writeFileSync(file, await runCli(previewArgv, { cwd: f.root, env: {}, stdinTTY: false }), { mode: 0o600, flag: "wx" });
    const done = JSON.parse(await runCli([...confirm[1]!.split(" ").map(arg => arg === "checkpoint-plan.json" ? file : arg), "--writer-root", activationOwnRoot, "--json"], { cwd: f.root, env: {}, stdinTTY: false }));
    expect(done).toMatchObject({ renewed: true, window: 1 });
  });
}, 240_000);
