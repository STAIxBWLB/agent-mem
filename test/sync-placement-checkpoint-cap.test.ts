import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { inspectSyncPlacement } from "../src/memory/sync-placement-inspection.ts";
import { activePlacementWriterContext } from "../src/sync-placement-writer-context.ts";
import { readPlacementJournal, readPlacementPublicationMetadata, releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { readPlacementProjection } from "../src/memory/sync-placement-journal.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { readInitialSyncPlacementWriterLocator } from "../src/memory/sync-placement-writer-roots.ts";
import { readWriterHistory } from "../src/memory/sync-placement-writer-history.ts";
import { measureSyncPlacementWriters } from "../src/memory/sync-placement-writers.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { resolvePlacementWindow } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { abandonPlacementCheckpoint, applyPlacementCheckpoint, planPlacementCheckpoint, resumePlacementCheckpoint, type PlacementCheckpointPhase } from "../src/memory/sync-placement-checkpoint.ts";
import { validateCheckpointIntent, checkpointWriterGenesis } from "../src/memory/sync-placement-checkpoint-format.ts";
import { WRITER_COMMIT_LOG, createWriterCommit, createWriterRevision, validateWriterRevision, writerRevisionFile } from "../src/memory/sync-placement-writer-revision-format.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { createInspectionRemote, reachableInspectionRowIds } from "./fakes/sync-placement-inspection.ts";
import { SyncPlacementJournalError } from "../src/memory/sync-placement-journal-format.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Every byte under one directory, by relative path: proves window 0 stays frozen and nothing is rewritten. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (at: string, prefix: string) => { for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (entry.isDirectory()) visit(join(at, entry.name), prefix + entry.name + "/"); else out[prefix + entry.name] = sha(readFileSync(join(at, entry.name)));
  } };
  if (existsSync(dir)) visit(dir, ""); return out;
}
function code(work: () => unknown): string {
  try { work(); } catch (error) { if (error instanceof SyncPlacementJournalError) return error.code; return (error as { code?: string }).code ?? "thrown"; }
  throw Error("expected a refusal");
}
async function fixture() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  // The person's writer-renewal floor: a checkpoint carries a (W, 1) renewal, which every effective-writer read requires.
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.22.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const markers = readPlacementRuntimeMarkers(f.base), active = readActivePlacementBinding(f.base, markers.profile, markers.shards)!;
  const epochHash = active.profile.placementHead, locator = readInitialSyncPlacementWriterLocator(f.base);
  const binding = { epochHash, activationHash: active.activation.seal, homeHash: active.epoch.homeHash, generation: active.epoch.generation, initialLocatorHash: locator.seal };
  const remote = createInspectionRemote(f.root), attest = () => activePlacementWriterContext(f.base, activationOwnRoot).attest();
  const sync = async () => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { const result = await syncMemory(store, { remote, visibility: async () => "private", placementAttestation: attest }); expect(result.ok, JSON.stringify(result)).toBe(true); return result; }
    finally { store.close(); }
  };
  const inspect = async () => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { return await inspectSyncPlacement(store, { placementAttestation: attest }); } finally { store.close(); }
  };
  const note = (text: string) => {
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try { return store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] }); } finally { store.close(); }
  };
  const input = () => ({ binding, roots: measureSyncPlacementWriters([activationOwnRoot]).roots, requestId: sha("checkpoint request") });
  const checkpoint = (phase?: (phase: PlacementCheckpointPhase) => void) => {
    const mutation = acquireMutation(f.base); if (!mutation) throw Error("isolated checkpoint mutation unavailable");
    try { const plan = planPlacementCheckpoint(f.base, epochHash, input()); return applyPlacementCheckpoint(f.base, plan, input(), { mutation, assertCurrent() {}, ...(phase ? { phase } : {}) }); }
    finally { mutation(); }
  };
  const withMutation = <T>(work: (opts: { mutation: ReturnType<typeof acquireMutation> & {}; assertCurrent(): void }) => T): T => {
    const mutation = acquireMutation(f.base); if (!mutation) throw Error("isolated checkpoint mutation unavailable");
    try { return work({ mutation, assertCurrent() {} }); } finally { mutation(); }
  };
  return { ...f, epochHash, binding, remote, sync, inspect, note, input, checkpoint, withMutation, epochDir: join(f.base, "sync-placement", "epochs", epochHash) };
}

import { createPlacementRecord } from "../src/memory/sync-placement-journal-format.ts";
import { writerInventoryGenesis, WRITER_REVISION_SCHEMA } from "../src/memory/sync-placement-writer-revision-format.ts";

test("#288: a 256-object, 64-revision home checkpoints and renews without losing evidence", async () => {
  const f = await fixture(); await f.sync();
  const initial = readPlacementJournal(f.base, f.epochHash);
  const hold = initial.records.find(record => record.kind === "hold");
  if (!hold || hold.kind !== "hold") throw Error("isolated full-cap fixture needs a real hold");
  const { schema: _schema, epochHash: _epoch, sequence: _sequence, previousHash: _previous, seal: _seal, ...event } = hold;
  const chunks = readdirSync(f.epochDir).filter(name => /^records-\d{5}\.jsonl$/.test(name)).length;
  const additional = 256 - initial.objects - 65;
  expect(additional).toBeGreaterThan(0);
  let head = initial.headHash, sequence = initial.sequence;
  // The fake home starts with real sync evidence. Each additional closed chunk contains one valid, chained hold.
  for (let index = 0; index < additional; index++) {
    const record = createPlacementRecord(f.epochHash, ++sequence, head, { ...event, requestId: sha(`full-cap request ${index}`), effectHash: sha(`full-cap effect ${index}`) });
    writeFileSync(join(f.epochDir, `records-${String(chunks + index).padStart(5, "0")}.jsonl`), canonicalJSON(record) + "\n", { mode: 0o600 });
    head = record.seal;
  }
  const roots = f.input().roots, commits: string[] = [];
  let writerHead = writerInventoryGenesis(f.epochHash, f.binding.activationHash);
  for (let revision = 1; revision <= 64; revision++) {
    const body = { schema: WRITER_REVISION_SCHEMA as typeof WRITER_REVISION_SCHEMA, ...f.binding, sequence: revision, previousHash: writerHead,
      journal: { sequence, headHash: head }, roots, requestId: sha(`full-cap writer ${revision}`) };
    const entry = createWriterRevision(body), commit = createWriterCommit(entry);
    writeFileSync(join(f.epochDir, writerRevisionFile(revision)), canonicalJSON(entry) + "\n", { mode: 0o600 });
    commits.push(canonicalJSON(commit) + "\n"); writerHead = commit.seal;
  }
  writeFileSync(join(f.epochDir, WRITER_COMMIT_LOG), commits.join(""), { mode: 0o600 });
  releasePlacementStorageCaches();
  const before = readPlacementJournal(f.base, f.epochHash), projection = readPlacementProjection(f.base, f.epochHash);
  expect(before.objects).toBe(256);
  expect(readWriterHistory(f.base, f.binding).sequence).toBe(64);
  const frozen = tree(f.epochDir), inspection = await f.inspect();
  expect(inspection.complete).toBe(true);
  expect(f.checkpoint()).toEqual({ window: 1 });
  expect(tree(f.epochDir)).toEqual(frozen);
  expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(before.records);
  expect(readPlacementProjection(f.base, f.epochHash)).toEqual(projection);
  expect(await f.inspect()).toEqual(inspection);
  const measured = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/measure-checkpoint-archive.ts"), f.base, f.epochHash], { cwd: f.root, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(measured.exitCode, measured.stderr.toString()).toBe(0);
  const archive = JSON.parse(measured.stdout.toString()) as { windows: number; archiveBytes: number; archiveMembers: number; records: number; peakRssMB: number | null };
  expect(archive).toMatchObject({ windows: 1, archiveMembers: 255, records: before.records.length });
  expect(archive.archiveBytes).toBeGreaterThan(0);
  expect(archive.peakRssMB).not.toBeNull(); expect(archive.peakRssMB!).toBeLessThan(200);
  if (process.env.AMEM_MEASURE_ARCHIVE === "1") console.log("checkpoint archive measurement: " + JSON.stringify(archive));
  const next = join(f.root, "full-cap next writer");
  mkdirSync(next, { mode: 0o755 }); mkdirSync(join(next, "src"), { mode: 0o755 }); mkdirSync(join(next, "bin"), { mode: 0o755 });
  writeFileSync(join(next, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version: "0.22.0" }), { mode: 0o644 });
  writeFileSync(join(next, "src", "index.ts"), "// isolated writer\n", { mode: 0o644 });
  writeFileSync(join(next, "bin", "amem.js"), "// isolated writer\n", { mode: 0o755 });
  const renewal = f.options("apply"); renewal.writerRoots = [activationOwnRoot, next];
  expect(await activateSyncPlacement(renewal)).toMatchObject({ active: true, renewed: true, sequence: 2 });
  expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(before.records);
  expect(readPlacementProjection(f.base, f.epochHash)).toEqual(projection);
  expect(tree(f.epochDir)).toEqual(frozen);
}, 300_000);
