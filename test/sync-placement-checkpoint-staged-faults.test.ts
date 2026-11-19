import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const crashBoundaries: [PlacementCheckpointPhase, number][] = ([1, 2, 3, 4, 5] as const).flatMap(n => [["staged-file", n], ["staged-file-fsync", n], ["staged-fsync", n]] as [PlacementCheckpointPhase, number][]);

for (const [phase, ordinal] of crashBoundaries) for (const mode of ["throw", "SIGKILL"] as const) {
  test(`#288: ${mode} at ${phase}:${ordinal} recovers safely`, async () => {
    const f = await fixture(); await f.sync();
    const frozen = tree(f.epochDir), records = readPlacementJournal(f.base, f.epochHash).records;
    if (mode === "throw") {
      let seen = 0;
      expect(() => f.checkpoint(at => { if (at === phase && ++seen === ordinal) throw Error("injected checkpoint interruption"); })).toThrow("injected checkpoint interruption");
    } else {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fakes/sync-placement-checkpoint-crash.ts"), f.base, f.epochHash, JSON.stringify(f.input()), phase, String(ordinal)], { cwd: f.root, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      expect(child.exitCode).not.toBe(0);
      expect(child.stdout.toString(), child.stderr.toString()).toContain(`${phase}:${ordinal}`);
    }
    const beforeCommit = phase.startsWith("intent-") && phase !== "intent-cleared" || phase.startsWith("staged-");
    if (mode === "throw" && beforeCommit) {
      f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts));
      releasePlacementStorageCaches();
      expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 0, pending: false });
      expect(tree(f.epochDir)).toEqual(frozen);
      expect(f.checkpoint()).toEqual({ window: 1 });
    } else {
      if (phase.startsWith("commit-")) expect(code(() => f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts)))).toBe("pending");
      const resumed = f.withMutation(opts => resumePlacementCheckpoint(f.base, f.epochHash, opts));
      if (phase === "intent-cleared") expect(resumed).toBeUndefined();
      else expect(resumed).toEqual({ window: 1 });
    }
    expect(f.withMutation(opts => resumePlacementCheckpoint(f.base, f.epochHash, opts))).toBeUndefined();
    releasePlacementStorageCaches();
    expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 1, pending: false });
    expect(tree(f.epochDir)).toEqual(frozen);
    expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(records);
  }, 180_000);
}

