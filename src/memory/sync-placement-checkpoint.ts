/**
 * Placement checkpoint writer (#288 step 2): plan, confirm, resume and abandon as library calls. The person CLI that
 * previews and authorizes them is a later step; nothing here runs on the capture or hook path or is automatic.
 *
 * Write order: outside intent -> staged window (catalog pages, projection snapshot, (W, 1) writer revision and commit
 * log, manifest last) -> one complete line in commits.jsonl (the commit point) -> intent cleared. The frozen window is
 * never touched, no log line is rewritten and nothing is deleted except the intent's own staging before the commit byte.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, rmdirSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { SyncPlacementJournalError, type SyncPlacementJournalErrorCode } from "./sync-placement-journal-format.ts";
import { rebuildPlacementProjection } from "./sync-placement-projection.ts";
import { readPlacementJournal, readPlacementPublicationMetadata, releasePlacementStorageCaches } from "./sync-placement-journal-storage.ts";
import { readWriterHistory, type WriterHistoryBinding } from "./sync-placement-writer-history.ts";
import { createWriterCommit, createWriterRevision, WRITER_COMMIT_LOG, WRITER_REVISION_SCHEMA, writerRevisionFile } from "./sync-placement-writer-revision-format.ts";
import type { MeasuredSyncPlacementWriterRoot } from "./sync-placement-writers.ts";
import { resolvePlacementWindow, type ResolvedPlacementWindow } from "./sync-placement-checkpoint-storage.ts";
import {
  PLACEMENT_CHECKPOINT_DIR, PLACEMENT_CHECKPOINT_COMMITS, PLACEMENT_CHECKPOINT_INTENT, PLACEMENT_CHECKPOINT_WINDOWS, PLACEMENT_CHECKPOINT_MANIFEST,
  PLACEMENT_CHECKPOINT_PROJECTION, PLACEMENT_CHECKPOINT_MANIFEST_SCHEMA, PLACEMENT_CHECKPOINT_PROJECTION_SCHEMA, PLACEMENT_CHECKPOINT_COMMIT_SCHEMA,
  PLACEMENT_CHECKPOINT_INTENT_SCHEMA, PLACEMENT_CHECKPOINT_LIMIT, PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES,
  checkpointCatalogName, checkpointCommitGenesis, checkpointWindowName, checkpointWriterGenesis, createCheckpointCommit, createCheckpointIntent,
  createCheckpointManifest, paginateCheckpointCatalog, validateCheckpointIntent,
  type CheckpointCatalogEntry, type CheckpointIntent, type CheckpointMember,
} from "./sync-placement-checkpoint-format.ts";

export type PlacementCheckpointPhase = "intent-written" | "intent-fsync" | "staged-file" | "staged-fsync" | "commit-started" | "commit-written" | "commit-fsync" | "intent-cleared";
export interface PlacementCheckpointOptions { mutation: MutationHandle; assertCurrent(): void; phase?(phase: PlacementCheckpointPhase): void }
export interface PlacementCheckpointInput {
  binding: WriterHistoryBinding & { initialLocatorHash: string };
  /** The measured writer roots for the combined (W, 1) renewal; a caller measures them fresh. */
  roots: MeasuredSyncPlacementWriterRoot[];
  requestId: string;
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const line = (value: unknown) => Buffer.from(canonicalJSON(value) + "\n");
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
function fail(code: SyncPlacementJournalErrorCode = "corrupt"): never { throw new SyncPlacementJournalError(code); }
function owned(s: BigIntStats, directory = false): void {
  const uid = process.getuid?.();
  if (uid === undefined || s.uid !== BigInt(uid) || (s.mode & 0o077n) !== 0n || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n)) fail();
}
function readFile(file: string, maximum: number): Buffer | undefined {
  const before = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (!before) return undefined; owned(before); if (before.size > BigInt(maximum)) fail("bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); if (stamp(opened) !== stamp(before)) fail("changed");
    const bytes = Buffer.alloc(Number(opened.size) + 1); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) break; at += n; }
    if (at !== Number(opened.size)) fail("changed"); return bytes.subarray(0, at);
  } finally { closeSync(fd); }
}
function list(dir: string): string[] {
  const reader = opendirSync(dir), out: string[] = [];
  try { for (;;) { const entry = reader.readSync(); if (!entry) break; if (out.length > 4096) fail("bound"); out.push(entry.name); } } finally { reader.closeSync(); }
  return out.sort();
}
function proof(home: string, opts: PlacementCheckpointOptions): void {
  try { assertMutationHandle(opts.mutation, home); } catch { fail("busy"); }
  try { opts.assertCurrent(); } catch (error) { if (error instanceof SyncPlacementJournalError) throw error; fail("changed"); }
  try { assertMutationHandle(opts.mutation, home); } catch { fail("busy"); }
}
function syncDir(home: string, dir: string, opts: PlacementCheckpointOptions): void {
  proof(home, opts); const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { owned(fstatSync(fd, { bigint: true }), true); fsyncSync(fd); } finally { closeSync(fd); }
}
function ensureDir(home: string, dir: string, parent: string, opts: PlacementCheckpointOptions): void {
  const s = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
  if (s) { owned(s, true); return; }
  proof(home, opts); mkdirSync(dir, { mode: 0o700 }); owned(lstatSync(dir, { bigint: true }), true); syncDir(home, parent, opts);
}
/** Exact prefix completion, the only recovery write: an existing file must be a prefix of `expected`; nothing is truncated. */
function complete(home: string, file: string, dir: string, expected: Buffer, opts: PlacementCheckpointOptions, written: PlacementCheckpointPhase, synced: PlacementCheckpointPhase, startPhase?: { at: number; phase: PlacementCheckpointPhase }): void {
  proof(home, opts); const prior = readFile(file, expected.length + 1);
  if (prior && (prior.length > expected.length || !expected.subarray(0, prior.length).equals(prior))) fail("conflict");
  if (prior?.equals(expected)) { const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } syncDir(home, dir, opts); return; }
  const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (prior ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (Number(opened.size) !== (prior?.length ?? 0)) fail("changed");
    let at = prior?.length ?? 0;
    while (at < expected.length) {
      proof(home, opts); const first = startPhase !== undefined && at === startPhase.at;
      const n = writeSync(fd, expected, at, first ? 1 : expected.length - at, at); if (n < 1) fail(); at += n; if (first) opts.phase?.(startPhase!.phase);
    }
    opts.phase?.(written); proof(home, opts); fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDir(home, dir, opts); opts.phase?.(synced);
  if (!readFile(file, expected.length)?.equals(expected)) fail("changed");
}

/** Every member of the live window, by exact content. A member that is not settled history refuses the checkpoint. */
function liveMembers(window: ResolvedPlacementWindow): CheckpointMember[] {
  return list(window.dir).map(name => {
    if (name === "append-intent.json") fail("pending");
    const bytes = readFile(join(window.dir, name), 1024 * 1024) ?? fail("changed");
    return { name, size: bytes.length, sha256: sha(bytes) };
  });
}
/**
 * Readonly plan of the next checkpoint: freezes the live window, catalogs its completed publications, seals the replayed
 * projection and prepares the combined (W, 1) renewal. Refuses any open obligation (pending append, publication,
 * reservation or renewal) instead of carrying it across windows.
 */
export function planPlacementCheckpoint(homeInput: string, epochHash: string, input: PlacementCheckpointInput): CheckpointIntent {
  const home = realPath(homeInput), window = resolvePlacementWindow(home, epochHash);
  if (window.pending) fail("pending");
  if (window.window + 1 > PLACEMENT_CHECKPOINT_LIMIT) fail("bound");
  const journal = readPlacementJournal(home, epochHash);
  if (journal.pending || journal.publicationReservation) fail("pending");
  if (journal.activation.seal !== input.binding.activationHash || journal.epoch.homeHash !== input.binding.homeHash || journal.epoch.generation !== input.binding.generation) fail("changed");
  const history = readWriterHistory(home, input.binding);
  if (history.pending) fail("pending");
  const members = liveMembers(window), entries: CheckpointCatalogEntry[] = [];
  readPlacementPublicationMetadata(home, epochHash, io => {
    const attempts = new Set(members.flatMap(member => /^publication-([a-f0-9]{64})-/.exec(member.name)?.[1] ?? []));
    for (const attempt of [...attempts].sort()) {
      const publication = io.publication(attempt);
      if (publication.phase !== "completed" || publication.pending) fail("pending");
      entries.push({ attemptHash: attempt, window: window.window, members: members.filter(member => member.name.startsWith(`publication-${attempt}-`)) });
    }
  });
  const next = window.window + 1, pages = paginateCheckpointCatalog(epochHash, next, entries);
  const projection = { schema: PLACEMENT_CHECKPOINT_PROJECTION_SCHEMA, epochHash, window: next, journal: { sequence: journal.sequence, headHash: journal.headHash },
    projectionHash: rebuildPlacementProjection(journal.epoch, journal.records).digest() } as const;
  const digest = (name: string, value: unknown): CheckpointMember => { const bytes = line(value); return { name, size: bytes.length, sha256: sha(bytes) }; };
  const archivedChunks = (window.manifests.at(-1)?.journal.chunks ?? 0) + members.filter(member => /^records-\d{5}\.jsonl$/.test(member.name)).length;
  const manifest = createCheckpointManifest({ schema: PLACEMENT_CHECKPOINT_MANIFEST_SCHEMA, epochHash, activationHash: input.binding.activationHash, window: next,
    previousManifestHash: window.manifests.at(-1)?.seal ?? null, archived: { window: window.window, members },
    journal: { sequence: journal.sequence, headHash: journal.headHash, chunks: archivedChunks },
    writer: { sequence: history.commits.length, headHash: history.headHash },
    catalog: pages.map((page, index) => digest(checkpointCatalogName(index), page)), projection: digest(PLACEMENT_CHECKPOINT_PROJECTION, projection) });
  const genesis = checkpointWriterGenesis(epochHash, input.binding.activationHash, manifest.seal, history.headHash);
  const writerRevision = createWriterRevision({ schema: WRITER_REVISION_SCHEMA, epochHash, generation: input.binding.generation, homeHash: input.binding.homeHash,
    activationHash: input.binding.activationHash, initialLocatorHash: input.binding.initialLocatorHash, sequence: 1, previousHash: genesis,
    journal: { sequence: journal.sequence, headHash: journal.headHash }, roots: input.roots, requestId: input.requestId }, genesis);
  const writerCommit = createWriterCommit(writerRevision, genesis);
  const previous = window.commits.at(-1)?.seal ?? checkpointCommitGenesis(epochHash);
  const commit = createCheckpointCommit({ schema: PLACEMENT_CHECKPOINT_COMMIT_SCHEMA, epochHash, window: next, previousHash: previous, manifestHash: manifest.seal,
    writerRevisionHash: writerRevision.seal, writerCommitHash: writerCommit.seal });
  const log = readFile(join(window.checkpointDir, PLACEMENT_CHECKPOINT_COMMITS), PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES) ?? Buffer.alloc(0);
  return createCheckpointIntent({ schema: PLACEMENT_CHECKPOINT_INTENT_SCHEMA, epochHash, window: next, previousLogBytes: log.length, previousLogHash: sha(log),
    manifest, commit, pages, projection, writerRevision, writerCommit });
}

function staged(intent: CheckpointIntent): [string, Buffer][] {
  return [...intent.pages.map((page, index): [string, Buffer] => [checkpointCatalogName(index), line(page)]),
    [PLACEMENT_CHECKPOINT_PROJECTION, line(intent.projection)], [writerRevisionFile(1), line(intent.writerRevision)],
    [WRITER_COMMIT_LOG, line(intent.writerCommit)], [PLACEMENT_CHECKPOINT_MANIFEST, line(intent.manifest)]];
}
function layout(home: string, epochHash: string, window: number) {
  const root = join(home, PLACEMENT_CHECKPOINT_DIR), dir = join(root, epochHash), windows = join(dir, PLACEMENT_CHECKPOINT_WINDOWS);
  return { root, dir, windows, window: join(windows, checkpointWindowName(window)), intent: join(dir, PLACEMENT_CHECKPOINT_INTENT), log: join(dir, PLACEMENT_CHECKPOINT_COMMITS) };
}
/** Completes the frozen bytes of one intent: staging, then the commit line, then the intent. Idempotent after a lost acknowledgement. */
function finish(home: string, intent: CheckpointIntent, opts: PlacementCheckpointOptions): void {
  const l = layout(home, intent.epochHash, intent.window);
  ensureDir(home, l.windows, l.dir, opts); ensureDir(home, l.window, l.windows, opts);
  for (const [name, bytes] of staged(intent)) complete(home, join(l.window, name), l.window, bytes, opts, "staged-file", "staged-fsync");
  // Reread the closure before the commit point: every staged name, nothing else.
  if (canonicalJSON(list(l.window)) !== canonicalJSON(staged(intent).map(([name]) => name).sort())) fail("changed");
  const prefix = readFile(l.log, PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES) ?? Buffer.alloc(0);
  if (prefix.length < intent.previousLogBytes || sha(prefix.subarray(0, intent.previousLogBytes)) !== intent.previousLogHash) fail("changed");
  complete(home, l.log, l.dir, Buffer.concat([prefix.subarray(0, intent.previousLogBytes), line(intent.commit)]), opts, "commit-written", "commit-fsync", { at: intent.previousLogBytes, phase: "commit-started" });
  proof(home, opts); unlinkSync(l.intent); syncDir(home, l.dir, opts); opts.phase?.("intent-cleared");
  releasePlacementStorageCaches();
  const resolved = resolvePlacementWindow(home, intent.epochHash);
  if (resolved.pending || resolved.window !== intent.window || resolved.manifests.at(-1)?.seal !== intent.manifest.seal) fail("changed");
}
/**
 * Confirm one exact planned checkpoint.
 * ponytail: the person-raised `minReader` 0.30.0 floor gate on confirm is #288 item 4 (task 312), added with the N-1
 * matrices; until then this library call has no CLI caller and runs only in isolated tests. Code never writes formats.json.
 */
export function applyPlacementCheckpoint(homeInput: string, plan: CheckpointIntent, input: PlacementCheckpointInput, opts: PlacementCheckpointOptions): { window: number } {
  const home = realPath(homeInput), intent = validateCheckpointIntent(plan);
  proof(home, opts);
  if (canonicalJSON(planPlacementCheckpoint(home, intent.epochHash, { ...input, requestId: intent.writerRevision.requestId })) !== canonicalJSON(intent)) fail("changed");
  const l = layout(home, intent.epochHash, intent.window);
  ensureDir(home, l.root, home, opts); ensureDir(home, l.dir, l.root, opts);
  complete(home, l.intent, l.dir, line(intent), opts, "intent-written", "intent-fsync");
  // From here on every placement effect refuses with the pending cause until finish or abandon.
  finish(home, intent, opts);
  return { window: intent.window };
}
/** Resume a written intent from its own frozen bytes; metadata only, no fresh source, policy or install measurement. */
export function resumePlacementCheckpoint(homeInput: string, epochHash: string, opts: PlacementCheckpointOptions): { window: number } | undefined {
  const home = realPath(homeInput), l = layout(home, epochHash, 1), bytes = readFile(l.intent, 1024 * 1024);
  if (!bytes) return undefined;
  if (!bytes.length || bytes.at(-1) !== 10) fail("pending"); // A torn intent has no staging: abandon it.
  const intent = validateCheckpointIntent(JSON.parse(bytes.toString("utf8")));
  if (intent.epochHash !== epochHash || !line(intent).equals(bytes)) fail();
  proof(home, opts); finish(home, intent, opts); return { window: intent.window };
}
/**
 * Before the first commit byte, remove only the intent's own staging and then the intent. After it, refuse: only resume
 * may finish a checkpoint whose commit line has started.
 */
export function abandonPlacementCheckpoint(homeInput: string, epochHash: string, opts: PlacementCheckpointOptions): { removed: number } {
  const home = realPath(homeInput), l0 = layout(home, epochHash, 1), bytes = readFile(l0.intent, 1024 * 1024);
  if (!bytes) return { removed: 0 };
  let removed = 0;
  if (bytes.length && bytes.at(-1) === 10) {
    const intent = validateCheckpointIntent(JSON.parse(bytes.toString("utf8"))), l = layout(home, epochHash, intent.window);
    const log = readFile(l.log, PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES) ?? Buffer.alloc(0);
    if (log.length > intent.previousLogBytes) fail("pending");
    if (lstatSync(l.window, { throwIfNoEntry: false })) {
      // Check every name first: a foreign file refuses before anything is removed.
      const owned = new Map(staged(intent)), names = list(l.window);
      for (const name of names) {
        const expected = owned.get(name); if (!expected) fail("conflict");
        const found = readFile(join(l.window, name), expected.length); if (!found || !expected.subarray(0, found.length).equals(found)) fail("conflict");
      }
      for (const name of names) { proof(home, opts); unlinkSync(join(l.window, name)); removed++; }
      syncDir(home, l.window, opts); proof(home, opts); rmdirSync(l.window); syncDir(home, l.windows, opts);
    }
  } else if (lstatSync(l0.windows, { throwIfNoEntry: false })) {
    // A torn intent was never followed by staging (the intent is fsynced first); a window beyond the commits is foreign.
    const commits = (readFile(l0.log, PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES) ?? Buffer.alloc(0)).toString("utf8").split("\n").filter(Boolean).length;
    if (list(l0.windows).length !== commits) fail("conflict");
  }
  proof(home, opts); unlinkSync(l0.intent); syncDir(home, l0.dir, opts); releasePlacementStorageCaches();
  return { removed };
}
