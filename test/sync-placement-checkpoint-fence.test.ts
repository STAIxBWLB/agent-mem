import { afterEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { readPlacementJournal, releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_CHECKPOINT_PENDING_MESSAGE } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { confirmPlacementCheckpoint, previewPlacementCheckpoint } from "../src/memory/sync-placement-checkpoint-person.ts";
import { PLACEMENT_CHECKPOINT_BUSY_MESSAGE, PlacementInventoryFenceError } from "../src/memory/sync-placement-activation-locks.ts";
import { createInspectionRemote } from "./fakes/sync-placement-inspection.ts";
import { runCli } from "../src/cli.ts";
import { applyRealmAdmission } from "../src/memory/sync-placement-realm-admission.ts";
import { readEffectiveRealmInventory } from "../src/memory/sync-placement-realm-effective.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { registerReaderLease } from "../src/memory/reader-lease.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { createPlacementRecord } from "../src/memory/sync-placement-journal-format.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// #578 Q1+Q3: the checkpoint fences placement writers only; live curated readers no longer block it.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
async function fixture() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
  const sync = async () => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { return await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest }); } finally { store.close(); }
  };
  const opts = { writerRoots: [activationOwnRoot], ownRoot: activationOwnRoot };
  return { ...f, sync, opts, epochHash: readEffectiveSyncPlacementWriters(f.base).epochHash };
}
const inventory = (home: string) => {
  const markers = readPlacementRuntimeMarkers(home);
  return readEffectiveRealmInventory(home, readActivePlacementBinding(home, markers.profile, markers.shards)!);
};

test("#578: a live curated reader lease no longer blocks the checkpoint confirm", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const reader = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try {
    const preview = await previewPlacementCheckpoint(f.base, f.opts);
    expect(await confirmPlacementCheckpoint(f.base, preview, f.opts)).toMatchObject({ window: 1, renewed: true });
    // The reader opened before the commit keeps working on its curated shard.
    expect(reader.list({ project: f.project }).length).toBeGreaterThanOrEqual(0);
  } finally { reader.close(); }
}, 240_000);

test("#578: an extension-log reader fails closed: checkpoint-pending during the interval, changed after the commit", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  await expect(applyRealmAdmission(f.base, "example.test/checkpoint/extension", { mode: "apply" })).resolves.toMatchObject({ state: "admitted" });
  releasePlacementStorageCaches();
  const before = inventory(f.base);
  expect(before.realms.length).toBeGreaterThan(1);
  const preview = await previewPlacementCheckpoint(f.base, f.opts);
  let pending: unknown = "not reached";
  await confirmPlacementCheckpoint(f.base, preview, { ...f.opts, phase: phase => {
    if (phase !== "intent-fsync") return;
    releasePlacementStorageCaches();
    try { inventory(f.base); pending = "opened"; } catch (error) { pending = error; }
  } });
  // During the pending interval a fresh extension-log reader refuses rather than reading a half-written window.
  expect(pending).toBeInstanceOf(Error);
  expect(String((pending as Error).message ?? pending)).not.toBe("opened");
  releasePlacementStorageCaches();
  // The reader opened before the commit holds a token naming window 0 and fails `changed` on its next recheck.
  expect(() => before.assertCurrent()).toThrow();
  // A reader opened after the commit sees the renewed window and the same realms.
  expect(inventory(f.base).realms).toEqual(before.realms);
}, 240_000);

test("#578: a reader that starts while the checkpoint holds the profile lock is refused admission", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const preview = await previewPlacementCheckpoint(f.base, f.opts);
  let admission: unknown = "not reached";
  await confirmPlacementCheckpoint(f.base, preview, { ...f.opts, phase: phase => {
    if (phase !== "intent-fsync") return;
    try { const release = registerReaderLease(f.base, { busyTimeoutMs: 0 }); release(); admission = "admitted"; } catch (error) { admission = error; }
  } });
  expect(admission).toBeInstanceOf(Error);
  expect((admission as Error).message).toMatch(/profile lock|profile\.lock/);
}, 240_000);

test("#578: the checkpoint busy refusal names its own next step, and a marked CLI prints it instead of the masked line", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const preview = await previewPlacementCheckpoint(f.base, f.opts);
  const held = acquireMutation(f.base); expect(held).toBeTruthy();
  try {
    const error = await confirmPlacementCheckpoint(f.base, preview, f.opts).catch(caught => caught);
    expect(error).toBeInstanceOf(PlacementInventoryFenceError);
    expect((error as PlacementInventoryFenceError).causeClass).toBe("busy");
    expect((error as Error).message).toBe(PLACEMENT_CHECKPOINT_BUSY_MESSAGE);
    const plan = join(f.root, "checkpoint-plan.json"); writeFileSync(plan, JSON.stringify(preview), { mode: 0o600 });
    const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = f.base;
    try {
      const marked = await runCli(["migrate", "--sync-placement", "--checkpoint", "--confirm", "--plan", plan, "--writer-root", activationOwnRoot],
        { cwd: f.root, env: { CODEX_THREAD_ID: "t" }, stdinTTY: false }).catch(caught => caught as Error);
      expect(marked).toBeInstanceOf(Error);
      expect((marked as Error).message).toBe(PLACEMENT_CHECKPOINT_BUSY_MESSAGE);
      expect((marked as Error).message).not.toContain("Memory operation unavailable or refused");
    } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
  } finally { held!(); }
  // Activation keeps its own text: the checkpoint wording never leaks to the other callers.
  expect(new PlacementInventoryFenceError("busy").message).toContain("--dry-run before retrying");
  expect(PLACEMENT_CHECKPOINT_PENDING_MESSAGE).not.toBe(PLACEMENT_CHECKPOINT_BUSY_MESSAGE);
}, 240_000);

test("#578: the confirm on a 254-object live window, with a live reader, reports how long the fence is held", async () => {
  const f = await fixture(); expect((await f.sync()).ok).toBe(true);
  const epochDir = join(f.base, "sync-placement", "epochs", f.epochHash), initial = readPlacementJournal(f.base, f.epochHash);
  const hold = initial.records.find(record => record.kind === "hold");
  if (!hold || hold.kind !== "hold") throw Error("isolated fixture needs a real hold");
  const { schema: _schema, epochHash: _epoch, sequence: _sequence, previousHash: _previous, seal: _seal, ...event } = hold;
  const chunks = readdirSync(epochDir).filter(name => /^records-\d{5}\.jsonl$/.test(name)).length;
  let head = initial.headHash, sequence = initial.sequence;
  // One valid, chained hold per closed chunk brings the live window to 254 objects (the live home's count, #462).
  for (let index = 0; index < 254 - initial.objects; index++) {
    const record = createPlacementRecord(f.epochHash, ++sequence, head, { ...event, requestId: sha(`fence request ${index}`), effectHash: sha(`fence effect ${index}`) });
    writeFileSync(join(epochDir, `records-${String(chunks + index).padStart(5, "0")}.jsonl`), canonicalJSON(record) + "\n", { mode: 0o600 });
    head = record.seal;
  }
  releasePlacementStorageCaches();
  expect(readPlacementJournal(f.base, f.epochHash).objects).toBe(254);
  const reader = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  try {
    const preview = await previewPlacementCheckpoint(f.base, f.opts);
    const begun = performance.now();
    expect(await confirmPlacementCheckpoint(f.base, preview, f.opts)).toMatchObject({ window: 1, renewed: true });
    console.log(JSON.stringify({ diagnostic: "checkpoint-fence-hold/v1", liveObjects: 254, confirmMs: Math.round(performance.now() - begun) }));
  } finally { reader.close(); }
}, 240_000);
