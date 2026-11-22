import { afterEach, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { syncPlacementMemory } from "../src/memory/sync-placement-transport.ts";
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
import { formatVersionBelow } from "../src/memory/formats.ts";
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

test("#288: a checkpoint freezes window 0, charges only the live window, and every reader resolves archived history", async () => {
  const f = await fixture();
  await f.sync();
  const before = { journal: readPlacementJournal(f.base, f.epochHash), projection: readPlacementProjection(f.base, f.epochHash), inspection: await f.inspect() };
  expect(before.inspection.complete).toBe(true);
  const frozen = tree(f.epochDir), objectsBefore = before.journal.objects;
  expect(objectsBefore).toBeGreaterThan(3);
  // The checkpoint itself never writes formats.json (the floor gate is #288 item 4).
  expect(existsSync(join(f.base, "sync-placement-checkpoints"))).toBe(false);
  const formats = readFileSync(join(f.base, "formats.json"));
  expect(f.checkpoint()).toEqual({ window: 1 });
  expect(readFileSync(join(f.base, "formats.json"))).toEqual(formats);
  // Window 0 is byte-identical, and the resolver now selects window 1.
  expect(tree(f.epochDir)).toEqual(frozen);
  const window = resolvePlacementWindow(f.base, f.epochHash);
  expect(window).toMatchObject({ window: 1, pending: false }); expect(window.dir).toEndWith(join("sync-placement-checkpoints", f.epochHash, "windows", "00001"));
  // Same logical journal: records, frontier and projection replay archive plus live tail.
  const after = readPlacementJournal(f.base, f.epochHash);
  expect(after.records).toEqual(before.journal.records); expect(after.headHash).toBe(before.journal.headHash);
  expect(readPlacementProjection(f.base, f.epochHash)).toEqual(before.projection);
  // Only the live window is charged: its sealed files plus the (W, 1) revision and log, never the archived members.
  expect(after.objects).toBeLessThan(objectsBefore);
  expect(after.objects).toBe(readdirSync(window.dir).length + 1);
  // Writer history continues logically: the (1, 1) revision is the effective inventory, chained from the frozen head.
  const history = readWriterHistory(f.base, f.binding);
  expect(history).toMatchObject({ window: 1, sequence: 1 }); expect(history.commits).toHaveLength(1);
  const effective = readEffectiveSyncPlacementWriters(f.base); effective.assertCurrent();
  expect(effective.revisionSequence).toBe(1); expect(effective.revisionHash).toBe(history.headHash);
  // Inspection evidence resolves the archived publication through the sealed catalog (io.publication(attempt)).
  const archived = readPlacementPublicationMetadata(f.base, f.epochHash, io => io.archivedPublications().map(attempt => io.publication(attempt).phase));
  expect(archived.length).toBeGreaterThan(0); expect(new Set(archived)).toEqual(new Set(["completed"]));
  expect(await f.inspect()).toEqual(before.inspection);
  // A later sync appends to the live window only, with globally continuous chunk names and sequence.
  const fresh = f.note("permitted after checkpoint");
  await f.sync();
  expect(tree(f.epochDir)).toEqual(frozen);
  const later = readPlacementJournal(f.base, f.epochHash);
  expect(later.records.slice(0, after.records.length)).toEqual(after.records); expect(later.sequence).toBeGreaterThan(after.sequence);
  const live = readdirSync(resolvePlacementWindow(f.base, f.epochHash).dir);
  const archivedChunks = readdirSync(f.epochDir).filter(name => /^records-/.test(name)).sort();
  expect(live.filter(name => /^records-/.test(name)).sort()[0]).toBe(`records-${String(archivedChunks.length).padStart(5, "0")}.jsonl`);
  expect(reachableInspectionRowIds(f.remote)).toContain(fresh);
  expect((await f.inspect()).complete).toBe(true);
}, 180_000);

test("#288: a started checkpoint refuses placement effects; abandon removes only owned staging before the commit byte", async () => {
  const f = await fixture(); await f.sync();
  const frozen = tree(f.epochDir), records = readPlacementJournal(f.base, f.epochHash).records;
  expect(() => f.checkpoint(phase => { if (phase === "staged-fsync") throw Error("isolated interruption after the first staged file"); })).toThrow();
  expect(resolvePlacementWindow(f.base, f.epochHash).pending).toBe(true);
  expect(code(() => readPlacementJournal(f.base, f.epochHash))).toBe("checkpoint-pending");
  expect(code(() => readWriterHistory(f.base, f.binding))).toBe("checkpoint-pending");
  // A foreign file in the staged window is never removed.
  const staging = join(f.base, "sync-placement-checkpoints", f.epochHash, "windows", "00001");
  writeFileSync(join(staging, "foreign.json"), "{}\n", { mode: 0o600 });
  expect(code(() => f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts)))).toBe("conflict");
  expect(existsSync(join(staging, "foreign.json"))).toBe(true);
  // ponytail: the test removes its own foreign file; a real person removes it after inspection.
  (await import("node:fs")).unlinkSync(join(staging, "foreign.json"));
  expect(f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts)).removed).toBeGreaterThan(0);
  releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 0, pending: false });
  expect(tree(f.epochDir)).toEqual(frozen); expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(records);
  await f.sync();
}, 180_000);

test("#288: after the first commit byte abandon refuses and resume finishes the frozen bytes idempotently", async () => {
  const f = await fixture(); await f.sync();
  const frozen = tree(f.epochDir), records = readPlacementJournal(f.base, f.epochHash).records;
  expect(() => f.checkpoint(phase => { if (phase === "commit-started") throw Error("isolated interruption inside the commit line"); })).toThrow();
  const window = resolvePlacementWindow(f.base, f.epochHash);
  expect(window).toMatchObject({ pending: true, window: 0 });
  expect(code(() => f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts)))).toBe("pending");
  expect(f.withMutation(opts => resumePlacementCheckpoint(f.base, f.epochHash, opts))).toEqual({ window: 1 });
  // A lost acknowledgement: a second resume finds no intent and changes nothing.
  const settled = tree(join(f.base, "sync-placement-checkpoints"));
  expect(f.withMutation(opts => resumePlacementCheckpoint(f.base, f.epochHash, opts))).toBeUndefined();
  expect(tree(join(f.base, "sync-placement-checkpoints"))).toEqual(settled);
  releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 1, pending: false });
  expect(tree(f.epochDir)).toEqual(frozen); expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(records);
}, 180_000);

test("#288: the resolver refuses a changed archived member, a torn commit line without an intent and an unknown window", async () => {
  const f = await fixture(); await f.sync(); f.checkpoint();
  const chunk = join(f.epochDir, readdirSync(f.epochDir).find(name => /^records-/.test(name))!), original = readFileSync(chunk);
  const changed = Buffer.from(original); changed[changed.length - 2] = changed[changed.length - 2] === 0x7d ? 0x5d : 0x7d;
  writeFileSync(chunk, changed, { mode: 0o600 }); releasePlacementStorageCaches();
  expect(code(() => resolvePlacementWindow(f.base, f.epochHash))).toBe("corrupt");
  writeFileSync(chunk, original, { mode: 0o600 }); releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash).window).toBe(1);
  const log = join(f.base, "sync-placement-checkpoints", f.epochHash, "commits.jsonl");
  appendFileSync(log, "{\"schema\":");
  expect(code(() => resolvePlacementWindow(f.base, f.epochHash))).toBe("pending");
  writeFileSync(log, readFileSync(log).subarray(0, readFileSync(log).lastIndexOf(10) + 1), { mode: 0o600 });
  (await import("node:fs")).mkdirSync(join(f.base, "sync-placement-checkpoints", f.epochHash, "windows", "00007"), { mode: 0o700 });
  expect(code(() => resolvePlacementWindow(f.base, f.epochHash))).toBe("corrupt");
}, 180_000);

test("#288: the intent binds every staged byte to the manifest and refuses an open obligation", async () => {
  const f = await fixture(); await f.sync();
  const plan = planPlacementCheckpoint(f.base, f.epochHash, f.input());
  expect(validateCheckpointIntent(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  const projection = { ...plan.projection, projectionHash: sha("other") };
  expect(() => validateCheckpointIntent({ ...plan, projection })).toThrow();
  expect(() => validateCheckpointIntent({ ...plan, writerRevision: { ...plan.writerRevision, requestId: sha("other") } })).toThrow();
  // A planned checkpoint never carries an open journal obligation across windows.
  writeFileSync(join(f.epochDir, "append-intent.json"), "{", { mode: 0o600 }); releasePlacementStorageCaches();
  expect(() => planPlacementCheckpoint(f.base, f.epochHash, f.input())).toThrow();
}, 120_000);

test("#288: abandon of the first checkpoint removes an empty commit log created before its first byte", async () => {
  const f = await fixture(); await f.sync();
  const frozen = tree(f.epochDir), records = readPlacementJournal(f.base, f.epochHash).records;
  expect(() => f.checkpoint(phase => { if (phase === "staged-fsync") throw Error("isolated interruption after the first staged file"); })).toThrow();
  // Simulates a crash between the exclusive create of commits.jsonl and its first byte.
  const log = join(f.base, "sync-placement-checkpoints", f.epochHash, "commits.jsonl");
  writeFileSync(log, "", { mode: 0o600, flag: "wx" });
  expect(f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts)).removed).toBeGreaterThan(0);
  expect(existsSync(log)).toBe(false);
  releasePlacementStorageCaches();
  expect(resolvePlacementWindow(f.base, f.epochHash)).toMatchObject({ window: 0, pending: false });
  expect(tree(f.epochDir)).toEqual(frozen); expect(readPlacementJournal(f.base, f.epochHash).records).toEqual(records);
  await f.sync();
}, 180_000);

test("#288: writer-history and effective-writer snapshots taken before a checkpoint refuse as changed (0->1 and 1->2)", async () => {
  const f = await fixture(); await f.sync();
  for (const window of [1, 2]) {
    releasePlacementStorageCaches();
    const history = readWriterHistory(f.base, f.binding), effective = readEffectiveSyncPlacementWriters(f.base);
    history.assertCurrent(); effective.assertCurrent();
    expect(f.checkpoint()).toEqual({ window });
    expect(code(() => history.assertCurrent())).toBe("changed");
    expect(code(() => effective.assertCurrent())).toBe("changed");
    releasePlacementStorageCaches();
    readEffectiveSyncPlacementWriters(f.base).assertCurrent();
    f.note(`after checkpoint ${window}`); await f.sync();
  }
}, 240_000);

test("#288: a committed window refuses a substituted, internally valid (W, 1) writer revision and commit pair", async () => {
  const f = await fixture(); await f.sync(); f.checkpoint();
  const window = resolvePlacementWindow(f.base, f.epochHash), manifest = window.manifests.at(-1)!;
  const revisionFile = join(window.dir, writerRevisionFile(1)), logFile = join(window.dir, WRITER_COMMIT_LOG);
  const genesis = checkpointWriterGenesis(f.epochHash, f.binding.activationHash, manifest.seal, manifest.writer.headHash);
  const original = validateWriterRevision(JSON.parse(readFileSync(revisionFile, "utf8")), genesis);
  const { seal: _seal, ...body } = original;
  const substitute = createWriterRevision({ ...body, requestId: sha("substituted request") }, genesis), commit = createWriterCommit(substitute, genesis);
  expect(substitute.seal).not.toBe(original.seal);
  const line = (value: unknown) => canonicalJSON(value) + "\n";
  writeFileSync(revisionFile, line(substitute), { mode: 0o600 }); writeFileSync(logFile, line(commit), { mode: 0o600 });
  releasePlacementStorageCaches();
  expect(code(() => resolvePlacementWindow(f.base, f.epochHash))).toBe("corrupt");
  // Writer history maps resolver corruption onto its own refusal class.
  expect(code(() => readWriterHistory(f.base, f.binding))).toBe("invalid");
  expect(() => readEffectiveSyncPlacementWriters(f.base)).toThrow();
}, 180_000);

test("v2 decision references survive a checkpoint archive", async () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string };
  if (formatVersionBelow(manifest.version, "0.36.0")) {
    const isolated = mkdtempSync(join(tmpdir(), "amem-v2-checkpoint-")); cleanup.push(() => rmSync(isolated, { recursive: true, force: true }));
    cpSync(join(import.meta.dir, "../src"), join(isolated, "src"), { recursive: true });
    cpSync(join(import.meta.dir, "../bin"), join(isolated, "bin"), { recursive: true });
    mkdirSync(join(isolated, "test/fakes"), { recursive: true }); mkdirSync(join(isolated, "home"));
    for (const name of ["sync-placement-activation.ts", "sync-placement-inspection.ts", "hooks-fixture.ts"]) copyFileSync(join(import.meta.dir, "fakes", name), join(isolated, "test/fakes", name));
    copyFileSync(import.meta.path, join(isolated, "test/checkpoint.test.ts"));
    writeFileSync(join(isolated, "package.json"), JSON.stringify({ ...manifest, version: "0.36.0" }));
    const child = Bun.spawnSync([process.execPath, "test", "--timeout", "180000", "test/checkpoint.test.ts", "--test-name-pattern", "v2 decision references survive"], { cwd: isolated, env: { ...process.env, HOME: join(isolated, "home"), AGENTHUB_HOME: join(isolated, "home/agenthub"), XDG_CONFIG_HOME: join(isolated, "home/config") }, stdout: "pipe", stderr: "pipe", timeout: 200000 });
    expect(child.stderr.toString()).toContain("1 pass"); expect(child.exitCode).toBe(0); return;
  }
  const f = await fixture();
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.36.0", since: "2026-11-22" }]) + "\n", { mode: 0o600 });
  for (let i = 0; i < 300; i++) f.note(`v2 stable decision fixture ${i}`);
  await f.sync();
  const first = readPlacementPublicationMetadata(f.base, f.epochHash, io => io.names().filter(name => /^publication-.*-root\.json$/.test(name)).map(name => io.publication(name.slice(12, 76))));
  expect(first.some(row => row.bundle.root.schema.endsWith("/v2"))).toBe(true);
  f.checkpoint(); f.note("v2 post-checkpoint insertion");
  const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true }); let interrupted = false;
  try {
    const result = await syncPlacementMemory(store, { remote: f.remote, visibility: async () => "private", placementAttestation: () => activePlacementWriterContext(f.base, activationOwnRoot).attest() }, at => {
      if (at === "plan-fsynced") { interrupted = true; throw Error("v2 publication interrupted"); }
    });
    expect(interrupted).toBe(true); expect(result.ok).toBe(false);
  } finally { store.close(); }
  await f.sync();
  const current = readPlacementPublicationMetadata(f.base, f.epochHash, io => io.names().filter(name => /^publication-.*-root\.json$/.test(name)).map(name => io.publication(name.slice(12, 76))));
  expect(current.some(row => row.bundle.root.chunks.some(chunk => chunk.ownerAttemptHash))).toBe(true);
  expect(() => f.checkpoint(phase => { if (phase === "staged-fsync") throw Error("v2 checkpoint staging interrupted"); })).toThrow();
  expect(f.withMutation(opts => abandonPlacementCheckpoint(f.base, f.epochHash, opts)).removed).toBeGreaterThan(0);
  expect(() => f.checkpoint(phase => { if (phase === "commit-started") throw Error("v2 checkpoint commit interrupted"); })).toThrow();
  expect(f.withMutation(opts => resumePlacementCheckpoint(f.base, f.epochHash, opts))).toEqual({ window: 2 });
  const archived = readPlacementPublicationMetadata(f.base, f.epochHash, io => io.archivedPublications().map(attempt => io.publication(attempt)));
  expect(archived.some(row => row.bundle.root.chunks.some(chunk => chunk.ownerAttemptHash))).toBe(true);
  expect((await f.inspect()).complete).toBe(true);
  const reference = archived.flatMap(row => row.bundle.root.chunks).find(chunk => chunk.ownerAttemptHash)!;
  const owner = resolvePlacementWindow(f.base, f.epochHash).catalog.get(reference.ownerAttemptHash!)!;
  const receipt = owner.members.find(item => item.name.endsWith("-receipt.json"))!, receiptFile = join(owner.dir, receipt.name), savedReceipt = readFileSync(receiptFile);
  writeFileSync(receiptFile, "corrupt\n", { mode: 0o600 }); releasePlacementStorageCaches();
  expect(() => readPlacementPublicationMetadata(f.base, f.epochHash, io => io.archivedPublications())).toThrow();
  writeFileSync(receiptFile, savedReceipt, { mode: 0o600 }); releasePlacementStorageCaches();
  const member = owner.members.find(item => item.sha256 === reference.hash && item.name.includes("-chunk-"))!;
  expect(member).toBeDefined(); writeFileSync(join(owner.dir, member.name), "corrupt\n", { mode: 0o600 });
  releasePlacementStorageCaches();
  expect(() => readPlacementPublicationMetadata(f.base, f.epochHash, io => io.archivedPublications())).toThrow();
}, 240_000);
