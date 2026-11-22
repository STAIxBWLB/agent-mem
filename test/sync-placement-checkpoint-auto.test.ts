import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory, type SyncOptions } from "../src/memory/sync.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { readPlacementJournal, releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { resolvePlacementWindow } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { createPlacementRecord } from "../src/memory/sync-placement-journal-format.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { createInspectionRemote } from "./fakes/sync-placement-inspection.ts";
import { checkpointOnBoundOptInChange } from "../src/memory/sync-placement-opt-in.ts";
import { runCli } from "../src/cli.ts";
import * as person from "../src/memory/sync-placement-checkpoint-person.ts";
import * as materialize from "../src/memory/sync-placement-materialize.ts";
import { PlacementSyncBoundError } from "../src/memory/sync-placement-bound.ts";

// #578 Q2 (owner choice c): an opted-in CLI sync runs one checkpoint at the journal-objects bound, then retries once.
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
/** The real publication refuses the journal-objects bound while window 0 is live; after a checkpoint it runs unchanged. */
const timing = { checkpointMs: -1 };
function boundInWindowZero(home: string, epochHash: string) {
  timing.checkpointMs = -1;
  const real = materialize.materializePlacementRows, realCheckpoint = person.checkpointOnBound;
  let inCheckpoint = false;
  // The checkpoint preview plans through the same materializer; only the sync publication sees the forced bound.
  const wrap = spyOn(person, "checkpointOnBound").mockImplementation(async (...args) => {
    inCheckpoint = true; const start = performance.now();
    try { return await realCheckpoint(...args); } finally { inCheckpoint = false; timing.checkpointMs = performance.now() - start; }
  });
  const spy = spyOn(materialize, "materializePlacementRows").mockImplementation(async (...args: Parameters<typeof real>) => {
    if (!inCheckpoint && resolvePlacementWindow(home, epochHash).window === 0)
      throw new PlacementSyncBoundError({ phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 280 });
    return real(...args);
  });
  cleanup.push(() => { spy.mockRestore(); wrap.mockRestore(); });
}

async function fixture() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
  const epochHash = readEffectiveSyncPlacementWriters(f.base).epochHash;
  const sync = async (extra: Partial<SyncOptions> = {}) => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { return await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest, ...extra }); } finally { store.close(); }
  };
  const optIn = (on: boolean) => writeFileSync(join(f.base, "amem.config.json"), JSON.stringify({ syncPlacement: { checkpointOnBound: on } }) + "\n", { mode: 0o600 });
  /** One valid chained hold per closed chunk until the live window holds `target` objects (the #462 live shape). */
  const fill = (target: number) => {
    const epochDir = join(f.base, "sync-placement", "epochs", epochHash), initial = readPlacementJournal(f.base, epochHash);
    const hold = initial.records.find(record => record.kind === "hold");
    if (!hold || hold.kind !== "hold") throw Error("isolated fixture needs a real hold");
    const { schema: _schema, epochHash: _epoch, sequence: _sequence, previousHash: _previous, seal: _seal, ...event } = hold;
    const chunks = readdirSync(epochDir).filter(name => /^records-\d{5}\.jsonl$/.test(name)).length;
    let head = initial.headHash, sequence = initial.sequence;
    for (let index = 0; index < target - initial.objects; index++) {
      const record = createPlacementRecord(epochHash, ++sequence, head, { ...event, requestId: sha(`auto request ${index}`), effectHash: sha(`auto effect ${index}`) });
      writeFileSync(join(epochDir, `records-${String(chunks + index).padStart(5, "0")}.jsonl`), canonicalJSON(record) + "\n", { mode: 0o600 });
      head = record.seal;
    }
    releasePlacementStorageCaches();
  };
  const first = await sync(); if (!first.ok) throw Error(JSON.stringify(first));
  const window = () => { releasePlacementStorageCaches(); return resolvePlacementWindow(f.base, epochHash).window; };
  boundInWindowZero(f.base, epochHash);
  return { ...f, sync, optIn, fill, window, epochHash };
}
const withHome = async <T>(home: string, work: () => Promise<T>) => {
  const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
  try { return await work(); } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
};

test("#578 Q2: without the opt-in, or without the caller flag, a bound refusal stays a person's checkpoint", async () => {
  const f = await fixture();
  f.fill(254);
  const off = await f.sync({ placementCheckpoint: true });
  expect(off.ok).toBe(false); expect(off.failure).toEqual({ cause: "bound" }); expect(off.checkpoint).toBeUndefined();
  f.optIn(true);
  const unflagged = await f.sync();
  expect(unflagged.failure).toEqual({ cause: "bound" }); expect(unflagged.checkpoint).toBeUndefined();
  expect(f.window()).toBe(0);
}, 300_000);

test("#578 Q2: opted in with identical pins, the bound runs one checkpoint and the retry publishes without a busy wait", async () => {
  const f = await fixture();
  f.fill(254); f.optIn(true);
  const begun = performance.now();
  const result = await f.sync({ placementCheckpoint: true });
  const elapsed = performance.now() - begun;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.checkpoint).toMatchObject({ window: 1 });
  expect(result.checkpoint!.objectsBefore).toBeGreaterThan(result.checkpoint!.objectsAfter);
  expect(f.window()).toBe(1);
  // The checkpoint retakes the locks the failed batch released; a self-wait would cost MUTATION_BUSY_TIMEOUT_MS (3000) per lock.
  console.log(JSON.stringify({ diagnostic: "sync-checkpoint-on-bound/v1", liveObjects: 254, syncMs: Math.round(elapsed) }));
  expect(elapsed).toBeLessThan(60_000);
  // A second sync needs no checkpoint.
  const again = await f.sync({ placementCheckpoint: true });
  expect(again.ok).toBe(true); expect(again.checkpoint).toBeUndefined();
}, 300_000);

test("#578 Q2: the bound-to-retry path holds no lock of its own while the checkpoint runs", async () => {
  const f = await fixture();
  f.fill(254); f.optIn(true);
  expect((await f.sync({ placementCheckpoint: true })).ok).toBe(true);
  expect(timing.checkpointMs).toBeGreaterThanOrEqual(0);
  expect(timing.checkpointMs).toBeLessThan(3000);
}, 300_000);

test("#578 Q2: a changed pin, a pending obligation or the cap refuse with checkpoint-refused and write nothing", async () => {
  const f = await fixture();
  f.fill(254); f.optIn(true);
  const refusal = async (cause: string, mock: () => Promise<person.CheckpointOnBoundResult>) => {
    const spy = spyOn(person, "checkpointOnBound").mockImplementation(mock);
    try {
      const result = await f.sync({ placementCheckpoint: true });
      expect(result.ok).toBe(false); expect(result.failure).toEqual({ cause: "checkpoint-refused" });
      expect(result.error).toContain("Sync-run placement checkpoint refused"); expect(result.checkpoint).toBeUndefined();
    } finally { spy.mockRestore(); }
    expect(f.window()).toBe(0);
    return cause;
  };
  for (const cause of ["pins", "cap", "fence"] as const)
    await refusal(cause, async () => ({ ok: false, cause, message: `Sync-run placement checkpoint refused: ${cause}` }));
  // Real checks: an attestation that fails is a changed pin.
  expect(await person.checkpointOnBound(f.base, () => { throw Error("changed"); }, activationOwnRoot)).toMatchObject({ ok: false, cause: "pins" });
  // An own root outside the effective writer set is a changed pin.
  expect(await person.checkpointOnBound(f.base, () => undefined, f.root)).toMatchObject({ ok: false, cause: "pins" });
  expect(f.window()).toBe(0);
}, 300_000);

test("#578 Q2: the opt-in command previews by default, writes atomically with --confirm and keeps other keys", async () => {
  const f = await fixture();
  const file = join(f.base, "amem.config.json");
  writeFileSync(file, JSON.stringify({ briefBytes: 4096 }) + "\n", { mode: 0o600 });
  const preview = checkpointOnBoundOptInChange(f.base, true, false);
  expect(preview).toMatchObject({ current: false, target: true, written: false });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ briefBytes: 4096 });
  expect(checkpointOnBoundOptInChange(f.base, true, true)).toMatchObject({ written: true });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ briefBytes: 4096, syncPlacement: { checkpointOnBound: true } });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(checkpointOnBoundOptInChange(f.base, true, true)).toMatchObject({ written: false });
  writeFileSync(file, "{ not json", { mode: 0o600 });
  expect(() => checkpointOnBoundOptInChange(f.base, false, true)).toThrow();
  expect(readFileSync(file, "utf8")).toBe("{ not json");
  // The CLI form, for a marked session too (no actor gate).
  writeFileSync(file, JSON.stringify({ briefBytes: 4096 }) + "\n", { mode: 0o600 });
  await withHome(f.base, async () => {
    const env = { CODEX_THREAD_ID: "t" };
    expect(await runCli(["migrate", "--sync-placement", "--checkpoint-on-bound", "on"], { cwd: f.root, env, stdinTTY: false })).toContain("preview only");
    expect(JSON.parse(readFileSync(file, "utf8")).syncPlacement).toBeUndefined();
    expect(await runCli(["migrate", "--sync-placement", "--checkpoint-on-bound", "on", "--confirm"], { cwd: f.root, env, stdinTTY: false })).toContain("written");
    expect(JSON.parse(readFileSync(file, "utf8")).syncPlacement).toEqual({ checkpointOnBound: true });
    await expect(runCli(["migrate", "--sync-placement", "--checkpoint-on-bound", "on", "--apply"], { cwd: f.root, env, stdinTTY: false })).rejects.toThrow();
  });
  expect(existsSync(join(f.base, "amem.config.json"))).toBe(true);
}, 300_000);

test("#578 Q2: hooks, amem mcp and capture never pass placementCheckpoint", () => {
  const src = join(import.meta.dir, "..", "src");
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
  const users = files(src).filter(file => /placementCheckpoint\s*:\s*true/.test(readFileSync(file, "utf8"))).map(file => file.slice(src.length + 1));
  expect(users).toEqual(["cli.ts"]);
  const cli = readFileSync(join(src, "cli.ts"), "utf8");
  expect(cli.match(/placementCheckpoint\s*:\s*true/g)?.length).toBe(1);
});
