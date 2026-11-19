import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { readPlacementJournal, releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { resolvePlacementWindow, PLACEMENT_CHECKPOINT_PENDING_MESSAGE } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { abandonPlacementCheckpointPerson, confirmPlacementCheckpoint, previewPlacementCheckpoint, resumePlacementCheckpointPerson, PlacementCheckpointError } from "../src/memory/sync-placement-checkpoint-person.ts";
import { placementSyncBoundMessage } from "../src/memory/sync-placement-bound.ts";
import { createInspectionRemote } from "./fakes/sync-placement-inspection.ts";
import { runCli } from "../src/cli.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// ponytail: this package is still 0.29.0, below the 0.30.0 checkpoint floor; tests confirm under a 0.22.0 floor through the seam task 312 removes.
const FLOOR = "0.22.0";
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

test("#288 step 3: preview is readonly and reports composition, headroom and the exact confirm step", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const before = tree(f.base);
  const preview = previewPlacementCheckpoint(f.base, { ...f.opts, minReader: FLOOR });
  expect(tree(f.base)).toEqual(before);
  expect(existsSync(f.checkpoints)).toBe(false);
  expect(preview).toMatchObject({ mode: "checkpoint-preview", window: 0, nextWindow: 1, floorReady: true, writers: 1 });
  const parts = preview.journalObjects;
  expect(parts.epochFixed + parts.writerHistory + parts.journalChunks + parts.completedPublications.objects).toBe(preview.currentObjects);
  expect(preview.headroom.required).toBe(preview.headroom.liveAfter + 1 + preview.headroom.largestPlan.slots + preview.headroom.largestPlan.reservedJournalChunks);
  expect(preview.headroom.largestPlan.slots).toBeGreaterThan(0);
  expect(preview.nextStep).toContain("amem migrate --sync-placement --checkpoint --confirm --plan");
  // The real 0.30.0 floor is missing here: preview says so and does not refuse.
  expect(previewPlacementCheckpoint(f.base, f.opts).floorReady).toBe(false);
  // Without a writer inventory there is nothing to renew into (W, 1).
  expect(await cause(() => previewPlacementCheckpoint(f.base, { ...f.opts, writerRoots: [] }))).toBe("candidate");
}, 180_000);

test("#288 step 3: confirm refuses below the person floor, never writes it, then commits the sealed plan with one renewal", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const preview = previewPlacementCheckpoint(f.base, { ...f.opts, minReader: FLOOR }), frozen = tree(f.epochDir), formats = readFileSync(join(f.base, "formats.json"));
  // The CLI's real floor is 0.30.0: a 0.22.0 home floor refuses with the formats raise next step, and nothing is written.
  const refused = await confirmPlacementCheckpoint(f.base, preview, f.opts).catch(error => error as PlacementCheckpointError);
  expect(refused).toBeInstanceOf(PlacementCheckpointError); expect((refused as PlacementCheckpointError).causeClass).toBe("floor");
  expect((refused as Error).message).toContain("amem formats raise home 0.30.0");
  expect(existsSync(f.checkpoints)).toBe(false); expect(readFileSync(join(f.base, "formats.json"))).toEqual(formats);
  // A writer below the floor refuses too (this install is 0.29.0 and the floor names 0.30.0 for every known writer).
  f.floor("0.30.0");
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview, { ...f.opts, minReader: "0.30.0" }))).toBe("writer-below-floor");
  expect(existsSync(f.checkpoints)).toBe(false);
  f.floor(FLOOR);
  const before = readEffectiveSyncPlacementWriters(f.base);
  expect(await confirmPlacementCheckpoint(f.base, preview, { ...f.opts, minReader: FLOOR })).toMatchObject({ window: 1, renewed: true, planHash: preview.planHash, nextStep: "amem sync" });
  releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 1, pending: false });
  expect(tree(f.epochDir)).toEqual(frozen);
  const after = readEffectiveSyncPlacementWriters(f.base);
  expect(after.revisionSequence).toBe(1); expect(after.revisionHash).not.toBe(before.revisionHash);
  // The same sealed plan never commits twice.
  expect(await cause(() => confirmPlacementCheckpoint(f.base, preview, { ...f.opts, minReader: FLOOR }))).toBe("changed");
  expect((await f.sync()).ok).toBe(true);
}, 240_000);

test("#288 step 3: a pending checkpoint pauses sync with its own cause; abandon before the commit byte, resume after it", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const records = readPlacementJournal(f.base, f.epochHash).records, frozen = tree(f.epochDir);
  const preview = previewPlacementCheckpoint(f.base, { ...f.opts, minReader: FLOOR });
  await expect(confirmPlacementCheckpoint(f.base, preview, { ...f.opts, minReader: FLOOR, phase: phase => { if (phase === "staged-fsync") throw Error("isolated interruption after staging"); } })).rejects.toThrow();
  releasePlacementStorageCaches();
  // Journal effects and the host writer adapter name the checkpoint, rather than an unrelated renewal transaction.
  expect(() => readPlacementJournal(f.base, f.epochHash)).toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(() => readEffectiveSyncPlacementWriters(f.base)).toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(() => activePlacementWriterContext(f.base, activationOwnRoot)).toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  await withHome(f.base, async () => {
    for (const env of [{}, { CODEX_THREAD_ID: "t" }])
      await expect(runCli(["migrate", "--sync-placement", "--dry-run", "--writer-root", activationOwnRoot], { cwd: f.root, env, stdinTTY: false })).rejects.toThrow(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  });
  const paused = await f.sync();
  expect(paused.ok).toBe(false); expect(paused.failure?.cause).toBe("checkpoint-pending"); expect(paused.error).toBe(PLACEMENT_CHECKPOINT_PENDING_MESSAGE);
  expect(await cause(() => previewPlacementCheckpoint(f.base, { ...f.opts, minReader: FLOOR }))).toBe("pending");
  expect((await abandonPlacementCheckpointPerson(f.base)).abandoned).toBe(true);
  releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 0, pending: false });
  expect(tree(f.epochDir)).toEqual(frozen); expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(records);
  expect(await abandonPlacementCheckpointPerson(f.base)).toMatchObject({ abandoned: false, removed: 0 });
  // After the first commit byte: abandon refuses and names resume; resume finishes the frozen bytes once.
  const again = previewPlacementCheckpoint(f.base, { ...f.opts, minReader: FLOOR });
  await expect(confirmPlacementCheckpoint(f.base, again, { ...f.opts, minReader: FLOOR, phase: phase => { if (phase === "commit-started") throw Error("isolated interruption inside the commit line"); } })).rejects.toThrow();
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
  const env = { CODEX_THREAD_ID: "t" }, roots = ["--writer-root", activationOwnRoot];
  await withHome(f.base, async () => {
    const text = await runCli(["migrate", "--sync-placement", "--checkpoint", ...roots], { cwd: f.root, env, stdinTTY: false });
    expect(text).toContain("Objects by holder"); expect(text).toContain("headroom after checkpoint");
    expect(text).toContain("home floor 0.30.0: missing; preview amem formats raise home 0.30.0");
    const saved = JSON.parse(await runCli(["migrate", "--sync-placement", "--checkpoint", "--json", ...roots], { cwd: f.root, env, stdinTTY: false }));
    const plan = join(f.root, "checkpoint-plan.json"); writeFileSync(plan, JSON.stringify(saved), { mode: 0o600 });
    // The real floor (0.30.0) is not met by this 0.29.0 install: confirm refuses with the floor step, and writes nothing.
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
