/**
 * The one resolver for placement history windows (#288 step 2). Window 0 is the frozen v1 epoch directory; each committed
 * checkpoint W adds `<home>/sync-placement-checkpoints/<E>/windows/<W>/`. Journal storage, writer history, effective
 * writers and inspection evidence all read archived and live members through this function, never by joining paths.
 * Read-only: it never repairs, removes or completes anything.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "./generation.ts";
import { realPath } from "./platform.ts";
import { SyncPlacementJournalError, type SyncPlacementJournalErrorCode } from "./sync-placement-journal-format.ts";
import {
  PLACEMENT_CHECKPOINT_DIR, PLACEMENT_CHECKPOINT_COMMITS, PLACEMENT_CHECKPOINT_INTENT, PLACEMENT_CHECKPOINT_WINDOWS, PLACEMENT_CHECKPOINT_MANIFEST,
  PLACEMENT_CHECKPOINT_PROJECTION, PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES, PLACEMENT_CHECKPOINT_INTENT_MAX_BYTES, PLACEMENT_CHECKPOINT_MANIFEST_MAX_BYTES,
  PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES, PLACEMENT_CHECKPOINT_ARCHIVE_MAX_MEMBERS, PLACEMENT_CHECKPOINT_ARCHIVE_MAX_BYTES, PLACEMENT_CHECKPOINT_LIMIT,
  checkpointCommitGenesis, checkpointWindowName, checkpointWriterGenesis, validateCheckpointCatalogPage, validateCheckpointCommit, validateCheckpointIntent,
  validateCheckpointManifest, validateCheckpointProjection,
  type CheckpointCommit, type CheckpointIntent, type CheckpointManifest, type CheckpointMember, type CheckpointProjectionDigest,
} from "./sync-placement-checkpoint-format.ts";
import {
  WRITER_COMMIT_LOG, WRITER_COMMIT_MAX_BYTES, WRITER_REVISION_MAX_BYTES, validateWriterCommit, validateWriterRevision, writerRevisionFile,
} from "./sync-placement-writer-revision-format.ts";

/** Largest single archived member: the writer revision ceiling (512 KiB) with headroom; every v1 family is smaller. */
const MEMBER_MAX_BYTES = 1024 * 1024;
export interface ArchivedPlacementWindow { window: number; dir: string; members: readonly CheckpointMember[] }
export interface CatalogedPublication { attemptHash: string; window: number; dir: string; members: readonly CheckpointMember[] }
export interface ResolvedPlacementWindow {
  home: string; epochHash: string;
  /** Window 0: the v1 epoch directory. epoch.json and activation.json are always read from here. */
  epochDir: string;
  /** The checkpoint directory of this epoch; present only once a checkpoint was started. */
  checkpointDir: string;
  /** The selected live window and its directory: the only members charged against the 256-object allowance. */
  window: number; dir: string;
  /** Ancestors of `dir` from the home down, for identity checks and parent fsyncs. */
  parents: readonly string[];
  archived: readonly ArchivedPlacementWindow[];
  manifests: readonly CheckpointManifest[];
  commits: readonly CheckpointCommit[];
  catalog: ReadonlyMap<string, CatalogedPublication>;
  projection?: CheckpointProjectionDigest;
  /** A checkpoint intent or torn commit line exists: every placement effect refuses until resume or abandon. */
  pending: boolean;
  intent?: CheckpointIntent;
  logBytes: number; logHash: string;
  /** Changes whenever any checkpoint byte or window identity changes; folded into journal inventory tokens. */
  token: string;
}
function fail(code: SyncPlacementJournalErrorCode = "corrupt"): never { throw new SyncPlacementJournalError(code); }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
const hex = (value: string) => value.length === 64 && /^[a-f0-9]+$/.test(value);
function owned(s: BigIntStats, directory = false): void {
  const uid = process.getuid?.();
  if (uid === undefined || s.uid !== BigInt(uid) || (s.mode & 0o077n) !== 0n || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n)) fail();
}
function state(file: string, directory = false): BigIntStats | undefined {
  const s = lstatSync(file, { bigint: true, throwIfNoEntry: false }); if (s) owned(s, directory); return s;
}
function list(dir: string, maximum: number): string[] {
  const reader = opendirSync(dir), out: string[] = [];
  try { for (;;) { const entry = reader.readSync(); if (!entry) break; if (out.length >= maximum) fail("bound"); out.push(entry.name); } } finally { reader.closeSync(); }
  return out.sort();
}
function read(file: string, maximum: number): { bytes: Buffer; stat: BigIntStats } | undefined {
  const before = state(file); if (!before) return undefined; if (before.size > BigInt(maximum)) fail("bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }); owned(opened); if (stamp(opened) !== stamp(before)) fail("changed");
    const bytes = Buffer.alloc(Number(opened.size) + 1); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) break; at += n; }
    if (at !== Number(opened.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(state(file) ?? before) !== stamp(opened)) fail("changed");
    return { bytes: bytes.subarray(0, at), stat: opened };
  } finally { closeSync(fd); }
}
function decode<T>(bytes: Buffer, validate: (value: unknown) => T): T {
  if (!bytes.length || bytes.at(-1) !== 10) fail("pending");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); let value: T;
  try { value = validate(JSON.parse(text)); } catch { return fail(); }
  if (canonicalJSON(value) + "\n" !== text) fail(); return value;
}
function sealedMember(dir: string, expected: CheckpointMember, maximum: number): Buffer {
  const found = read(join(dir, expected.name), maximum);
  if (!found || found.bytes.length !== expected.size || sha(found.bytes) !== expected.sha256) fail(); return found.bytes;
}
/**
 * Content proof of the frozen windows, keyed by every member's stat stamp (the same trust the journal prefix cache uses).
 * ponytail: one entry per process; a same-size in-place rewrite inside one timestamp tick is caught only on the next miss.
 */
let archiveProof: string | undefined;
function verifyArchive(archived: readonly ArchivedPlacementWindow[]): string {
  const stamps: unknown[] = []; let members = 0, bytes = 0;
  for (const window of archived) {
    const names = list(window.dir, 4097);
    if (canonicalJSON(names) !== canonicalJSON(window.members.map(member => member.name))) fail();
    for (const member of window.members) {
      const s = state(join(window.dir, member.name)); if (!s || s.size !== BigInt(member.size)) fail();
      stamps.push([window.window, member.name, member.sha256, stamp(s)]); members++; bytes += member.size;
    }
  }
  if (members > PLACEMENT_CHECKPOINT_ARCHIVE_MAX_MEMBERS || bytes > PLACEMENT_CHECKPOINT_ARCHIVE_MAX_BYTES) fail("bound");
  const key = canonicalJSON(stamps);
  if (archiveProof !== key) {
    for (const window of archived) for (const member of window.members) sealedMember(window.dir, member, MEMBER_MAX_BYTES);
    archiveProof = key;
  }
  return sha(Buffer.from(key));
}
export function releasePlacementCheckpointCaches(): void { archiveProof = undefined; }

/** Resolve the live window of one epoch and verify every frozen window, manifest, catalog page and projection snapshot. */
export function resolvePlacementWindow(homeInput: string, epochHash: string): ResolvedPlacementWindow {
  if (typeof epochHash !== "string" || !hex(epochHash)) fail("invalid");
  const home = realPath(homeInput); const homeStat = state(home, true); if (!homeStat) fail("changed");
  const epochDir = join(home, "sync-placement", "epochs", epochHash), root = join(home, PLACEMENT_CHECKPOINT_DIR), checkpointDir = join(root, epochHash);
  const windowsDir = join(checkpointDir, PLACEMENT_CHECKPOINT_WINDOWS), empty = sha(Buffer.alloc(0));
  const base = { home, epochHash, epochDir, checkpointDir, window: 0, dir: epochDir, parents: [home, join(home, "sync-placement"), join(home, "sync-placement", "epochs")],
    archived: [], manifests: [], commits: [], catalog: new Map(), pending: false, logBytes: 0, logHash: empty };
  const rootStat = state(root, true);
  if (!rootStat) return { ...base, token: placementWindowToken(home, epochHash) };
  for (const name of list(root, 4096)) if (!hex(name)) fail();
  const dirStat = state(checkpointDir, true);
  if (!dirStat) return { ...base, token: placementWindowToken(home, epochHash) };
  for (const name of list(checkpointDir, 4)) if (![PLACEMENT_CHECKPOINT_COMMITS, PLACEMENT_CHECKPOINT_INTENT, PLACEMENT_CHECKPOINT_WINDOWS].includes(name)) fail();
  // The intent: complete canonical bytes are a validated plan; a torn file is a pending checkpoint with no owned staging yet.
  const intentFile = read(join(checkpointDir, PLACEMENT_CHECKPOINT_INTENT), PLACEMENT_CHECKPOINT_INTENT_MAX_BYTES);
  let intent: CheckpointIntent | undefined;
  if (intentFile && intentFile.bytes.length && intentFile.bytes.at(-1) === 10) intent = decode(intentFile.bytes, validateCheckpointIntent);
  if (intent && intent.epochHash !== epochHash) fail();
  // The commit log: only complete lines are authority. A torn tail without an intent is corruption, never a commit.
  const logFile = read(join(checkpointDir, PLACEMENT_CHECKPOINT_COMMITS), PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES), log = logFile?.bytes ?? Buffer.alloc(0);
  const complete = log.lastIndexOf(10) + 1, torn = complete !== log.length;
  if (torn && !intentFile) fail("pending");
  if (logFile && !log.length && !intentFile) fail("pending");
  const commits: CheckpointCommit[] = []; let head = checkpointCommitGenesis(epochHash), at = 0;
  while (at < complete) {
    const end = log.indexOf(10, at), commit = decode(log.subarray(at, end + 1), validateCheckpointCommit); at = end + 1;
    if (commits.length >= PLACEMENT_CHECKPOINT_LIMIT) fail("bound");
    if (commit.epochHash !== epochHash || commit.window !== commits.length + 1 || commit.previousHash !== head) fail();
    commits.push(commit); head = commit.seal;
  }
  if (intent && (intent.window < commits.length || intent.window > commits.length + 1)) fail();
  const windows = state(windowsDir, true) ? list(windowsDir, PLACEMENT_CHECKPOINT_LIMIT + 1) : [];
  const expected = commits.map(commit => checkpointWindowName(commit.window));
  if (intent && intent.window === commits.length + 1 && windows.length === expected.length + 1) expected.push(checkpointWindowName(intent.window));
  if (canonicalJSON(windows) !== canonicalJSON(expected) || (commits.length && !state(windowsDir, true))) fail();
  // Committed manifests chain from window 1 and each freezes exactly the window before it.
  const manifests: CheckpointManifest[] = [], archived: ArchivedPlacementWindow[] = [], catalog = new Map<string, CatalogedPublication>();
  let projection: CheckpointProjectionDigest | undefined;
  for (const commit of commits) {
    const dir = join(windowsDir, checkpointWindowName(commit.window)); state(dir, true) ?? fail();
    const bytes = read(join(dir, PLACEMENT_CHECKPOINT_MANIFEST), PLACEMENT_CHECKPOINT_MANIFEST_MAX_BYTES)?.bytes ?? fail();
    const manifest = decode(bytes, validateCheckpointManifest), previous = manifests.at(-1);
    if (manifest.seal !== commit.manifestHash || manifest.epochHash !== epochHash || manifest.window !== commit.window
      || manifest.previousManifestHash !== (previous?.seal ?? null)) fail();
    if (previous && (manifest.journal.sequence < previous.journal.sequence || manifest.writer.sequence < previous.writer.sequence)) fail();
    const frozen = { window: manifest.archived.window, dir: manifest.archived.window ? join(windowsDir, checkpointWindowName(manifest.archived.window)) : epochDir, members: manifest.archived.members };
    if (frozen.members.some(member => member === undefined || member.name === "append-intent.json")) fail();
    archived.push(frozen);
    // Catalog pages: every completed publication the frozen window holds, by attempt, with exact members; nothing else.
    const publications = new Map<string, CheckpointMember[]>();
    for (const member of frozen.members) {
      const match = /^publication-([a-f0-9]{64})-/.exec(member.name); if (!match) continue;
      publications.set(match[1]!, [...publications.get(match[1]!) ?? [], member]);
    }
    let cataloged = 0;
    for (const [index, page] of manifest.catalog.entries()) {
      const value = decode(sealedMember(dir, page, PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES), validateCheckpointCatalogPage);
      if (value.epochHash !== epochHash || value.window !== commit.window || value.page !== index) fail();
      for (const entry of value.entries) {
        const held = publications.get(entry.attemptHash);
        if (entry.window !== frozen.window || !held || catalog.has(entry.attemptHash) || canonicalJSON(held) !== canonicalJSON(entry.members)) fail();
        catalog.set(entry.attemptHash, { attemptHash: entry.attemptHash, window: frozen.window, dir: frozen.dir, members: entry.members }); cataloged++;
      }
    }
    if (cataloged !== publications.size) fail();
    projection = decode(sealedMember(dir, manifest.projection, PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES), validateCheckpointProjection);
    if (projection.epochHash !== epochHash || projection.window !== commit.window || canonicalJSON(projection.journal) !== canonicalJSON({ sequence: manifest.journal.sequence, headHash: manifest.journal.headHash })) fail();
    // The commit line binds the window's (W, 1) writer revision and the first line of its writer commit log; a substituted
    // internally valid pair would otherwise pass the local chain check from the window genesis.
    const genesis = checkpointWriterGenesis(epochHash, manifest.activationHash, manifest.seal, manifest.writer.headHash);
    const revision = decode(read(join(dir, writerRevisionFile(1)), WRITER_REVISION_MAX_BYTES)?.bytes ?? fail(), value => validateWriterRevision(value, genesis));
    const writerLog = read(join(dir, WRITER_COMMIT_LOG), WRITER_COMMIT_MAX_BYTES)?.bytes ?? fail(), first = writerLog.indexOf(10);
    if (first < 0) fail();
    const writerCommit = decode(writerLog.subarray(0, first + 1), validateWriterCommit);
    if (revision.seal !== commit.writerRevisionHash || writerCommit.seal !== commit.writerCommitHash) fail();
    manifests.push(manifest);
  }
  if (archived.length) verifyArchive(archived);
  const window = commits.length, dir = window ? join(windowsDir, checkpointWindowName(window)) : epochDir;
  const token = placementWindowToken(home, epochHash);
  if (logFile && !token.includes(stamp(logFile.stat)) || intentFile && !token.includes(stamp(intentFile.stat))) fail("changed");
  return { home, epochHash, epochDir, checkpointDir, window, dir, archived, manifests, commits, catalog, ...(projection ? { projection } : {}),
    parents: window ? [home, root, checkpointDir, windowsDir] : base.parents,
    pending: !!intentFile || torn, ...(intent ? { intent } : {}), logBytes: log.length, logHash: sha(log), token };
}
/**
 * Cheap identity of the checkpoint state: directory identities, commit log and intent stamps. Archived window contents are
 * immutable and content-verified by every `resolvePlacementWindow`; this token detects a checkpoint that starts, commits or
 * is abandoned between two reads of the same operation.
 */
export function placementWindowToken(home: string, epochHash: string): string {
  const root = join(home, PLACEMENT_CHECKPOINT_DIR), dir = join(root, epochHash), windows = join(dir, PLACEMENT_CHECKPOINT_WINDOWS);
  const rootStat = state(root, true); if (!rootStat) return canonicalJSON(["none"]);
  const dirStat = state(dir, true); if (!dirStat) return canonicalJSON(["root", String(rootStat.dev), String(rootStat.ino)]);
  const log = state(join(dir, PLACEMENT_CHECKPOINT_COMMITS)), intent = state(join(dir, PLACEMENT_CHECKPOINT_INTENT)), windowsStat = state(windows, true);
  const rows: unknown[] = [String(rootStat.dev), String(rootStat.ino), stamp(dirStat), log ? stamp(log) : null, intent ? stamp(intent) : null];
  if (windowsStat) { rows.push(stamp(windowsStat)); for (const name of list(windows, PLACEMENT_CHECKPOINT_LIMIT + 1)) { const s = state(join(windows, name), true); if (!s) fail("changed"); rows.push([name, String(s.dev), String(s.ino)]); } }
  return canonicalJSON(["checkpoint", rows]);
}
/** The checkpoint preview command; refusals name it as their next step. */
export const PLACEMENT_CHECKPOINT_COMMAND = "amem migrate --sync-placement --checkpoint";
/** The one 'checkpoint pending' refusal every placement effect shares while a checkpoint intent or torn commit line exists (#288 step 3). */
export const PLACEMENT_CHECKPOINT_PENDING_MESSAGE = `A placement checkpoint is pending; placement effects are paused until it finishes. Run ${PLACEMENT_CHECKPOINT_COMMAND} --resume to complete its recorded bytes, or ${PLACEMENT_CHECKPOINT_COMMAND} --abandon if its commit line has not started.`;
/** True while a checkpoint is started and not finished; any other resolver failure is left to the caller's own read. */
export function placementCheckpointPending(home: string, epochHash: string): boolean {
  try { return resolvePlacementWindow(home, epochHash).pending; }
  catch (error) { return error instanceof SyncPlacementJournalError && Object.getOwnPropertyDescriptor(error, "code")?.value === "pending"; }
}
