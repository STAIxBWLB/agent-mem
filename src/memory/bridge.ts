import { createHash, randomBytes, type Hash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { memoryGitArgv, memoryGitEnv, realPath } from "./platform.ts";
import { canonicalJSON, fsyncDirectory, readProfileJSON, writeProfileJSON } from "./generation.ts";
import { OP_CONTRACTS } from "./ops-contract.ts";
import { entryId, type Entry } from "./store.ts";

export interface LegacyCheckpoint { source: string; path: string; offset: number; hash: string; commit?: string; tailBytes?: number; stamp?: string }
export interface LegacySegment extends LegacyCheckpoint { bytes: Buffer; local: boolean; tailBytes: number; start?: number }
export interface LegacySnapshotOptions {
  generation?: string;
  commit?: string;
  previousCommit?: string;
  /** Count skipped complete legacy lines; authoritative generation callers use legacyEntries strict mode. */
  onMalformed?: () => void;
  checkpoints?: readonly LegacyCheckpoint[];
  reader?: SegmentReader;
  incremental?: boolean;
  /** A migration replay reads exactly these captured complete prefixes, ignoring later suffixes/new segments. */
  limits?: readonly LegacyCheckpoint[];
}
const diskSource = "legacy-local", remoteSource = "legacy-main";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
class LegacyInputError extends Error {
  constructor(readonly malformed = false) { super("legacy bridge input changed or is invalid; person inspection required"); }
}
function failure(): never { throw new LegacyInputError(); }
function malformed(): never { throw new LegacyInputError(true); }
const key = (row: LegacyCheckpoint) => `${row.source}:${row.path}`;
const segmentPath = (path: string) => /^(log|local)\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(path);
const commitId = (value: string) => /^[a-f0-9]{40}$/.test(value);

function directory(path: string, optional = false): boolean {
  try { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isDirectory()) failure(); return true; }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export interface SegmentReadMetrics { bytesRead: number; bytesHashed: number; coldChanged: number }
interface PrefixState { offset: number; hash: string; hasher: Hash; bytes: Buffer }
type SegmentBytes = Pick<LegacySegment, "bytes" | "offset" | "hash" | "tailBytes" | "stamp" | "start">;
const statStamp = (stat: { dev: bigint | number; ino: bigint | number; size: bigint | number; mtimeNs?: bigint; ctimeNs?: bigint }) => JSON.stringify([String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);

/** Handle-local SHA state: unchanged persisted metadata costs no data read or hashing, including reopen. */
export class SegmentReader {
  private readonly prefixes = new Map<string, PrefixState>();
  private measured: SegmentReadMetrics = { bytesRead: 0, bytesHashed: 0, coldChanged: 0 };
  metrics(): SegmentReadMetrics { return { ...this.measured }; }
  resetMetrics(): void { this.measured = { bytesRead: 0, bytesHashed: 0, coldChanged: 0 }; }
  read(path: string, prior?: LegacyCheckpoint, full = false, immutable = false): SegmentBytes {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || !Number.isSafeInteger(Number(before.size))) failure();
    const stamp = statStamp(before), size = Number(before.size);
    if (prior && size < prior.offset) failure();
    if (!full && prior?.stamp === stamp) return { bytes: Buffer.alloc(0), start: prior.offset, offset: prior.offset, hash: prior.hash, tailBytes: size - prior.offset, stamp };
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (statStamp(opened) !== stamp) failure();
      const read = (length: number): Buffer => {
        const bytes = Buffer.alloc(length); let at = 0;
        while (at < length) { const n = readSync(fd, bytes, at, length - at, at); if (!n) failure(); at += n; this.measured.bytesRead += n; }
        return bytes;
      };
      const all = read(size), end = all.lastIndexOf(10) + 1, bytes = all.subarray(0, end);
      if (prior && end < prior.offset) failure();
      if (!read(end).equals(bytes) || fstatSync(fd, { bigint: true }).size < opened.size) failure();
      const after = lstatSync(path, { bigint: true });
      if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) failure();
      const cached = immutable ? undefined : this.prefixes.get(path);
      let hasher: Hash;
      if (!full && prior && cached && cached.offset === prior.offset && cached.hash === prior.hash) {
        // Changed live input still reads/compares the old bytes, so rewrite-plus-growth cannot masquerade as append.
        // ponytail: the generation counterpart of C02: O(segment) I/O per changed refresh (13 MB at 20K entries, p50 247 ms,
        // docs/bench/p9-generation-read.md). Upgrade, measured first: a per-block hash chain or a tail window plus inode/size check.
        if (!cached.bytes.equals(bytes.subarray(0, prior.offset))) failure();
        hasher = cached.hasher.copy(); const suffix = bytes.subarray(prior.offset); hasher.update(suffix); this.measured.bytesHashed += suffix.length;
      } else {
        // ponytail: a cold changed segment verifies/seeds its whole prefix once (O(segment)); unchanged reopens are O(metadata).
        // Serialize SHA state or retain per-block receipts only if measured cold-change cost warrants that additional format.
        hasher = createHash("sha256");
        if (prior) {
          hasher.update(bytes.subarray(0, prior.offset)); this.measured.bytesHashed += prior.offset;
          if (hasher.copy().digest("hex") !== prior.hash) failure();
          if (!full) this.measured.coldChanged++;
          hasher.update(bytes.subarray(prior.offset)); this.measured.bytesHashed += bytes.length - prior.offset;
        } else { hasher.update(bytes); this.measured.bytesHashed += bytes.length; }
      }
      const hash = hasher.copy().digest("hex");
      if (!immutable) this.prefixes.set(path, { offset: end, hash, hasher, bytes: Buffer.from(bytes) });
      const start = !full && prior ? prior.offset : 0;
      // A concurrent append is outside the captured length; retain the earlier stamp so the next read notices it.
      return { bytes: Buffer.from(bytes.subarray(start)), ...(start ? { start } : {}), offset: end, hash, tailBytes: size - end, stamp };
    } finally { closeSync(fd); }
  }
}

function checkpointMap(rows: readonly LegacyCheckpoint[] = []): Map<string, LegacyCheckpoint> {
  const map = new Map<string, LegacyCheckpoint>();
  for (const row of rows) {
    if (![diskSource, remoteSource].includes(row.source) || !segmentPath(row.path) || row.source === remoteSource && !row.path.startsWith("log/")
      || !Number.isSafeInteger(row.offset) || row.offset < 0 || !/^[a-f0-9]{64}$/.test(row.hash)
      || row.tailBytes !== undefined && (!Number.isSafeInteger(row.tailBytes) || row.tailBytes < 0)
      || row.stamp !== undefined && (typeof row.stamp !== "string" || row.stamp.length > 1024)
      || row.source === remoteSource && (!row.commit || !commitId(row.commit)) || row.source === diskSource && row.commit !== undefined || map.has(key(row))) failure();
    map.set(key(row), row);
  }
  return map;
}

function checkedEntry(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const row = value as Record<string, unknown>;
  const operation = row.op;
  if (typeof operation !== "string") return malformed();
  if (!Object.hasOwn(OP_CONTRACTS, operation)) return malformed();
  const contract = OP_CONTRACTS[operation]!;
  const schema = contract.payloadSchema;
  if (!contract.implemented || contract.status !== "v1-equal" || !schema) malformed();
  if (row.schema !== "agent-hub.memory/v1" || typeof row.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id)) malformed();
  const { id, ...body } = row;
  if (entryId(body as unknown as Omit<Entry, "id">) !== id) malformed();
  for (const name of schema.required) if (row[name] === undefined && !schema.legacyOptional.includes(name)) malformed();
  for (const [name, field] of Object.entries(schema.fields)) {
    const value = row[name];
    if (value === undefined || value === null && (!schema.required.includes(name) || schema.legacyOptional.includes(name))) continue;
    if (field.type === "string-array") { if (!Array.isArray(value) || !value.every(item => typeof item === "string")) malformed(); continue; }
    if (typeof value !== "string" || field.maxLength !== undefined && value.length > field.maxLength || field.values && !field.values.includes(value)) malformed();
    if (field.format === "id" && !/^[a-f0-9]{32}$/.test(value)) malformed();
    if (field.format === "utc" && Number.isNaN(Date.parse(value))) malformed();
  }
  if (typeof row.at !== "string" || new Date(row.at).toISOString() !== row.at) malformed();
  return row as unknown as Entry;
}

function* completeLines(bytes: Buffer): Generator<Buffer> {
  let start = 0;
  while (start < bytes.length) { const end = bytes.indexOf(10, start); if (end < 0) failure(); yield bytes.subarray(start, end); start = end + 1; }
}

/** Preserve original IDs; row order and JSON key order never produce duplicate evidence. */
export function legacyEntries(segments: readonly LegacySegment[], options: { strict?: boolean; onMalformed?: () => void } = {}): Entry[] {
  const rows = new Map<string, Entry>();
  for (const segment of segments) {
    if (segment.bytes.length !== segment.offset || digest(segment.bytes) !== segment.hash || segment.offset && segment.bytes.at(-1) !== 10) failure();
    for (const bytes of completeLines(segment.bytes)) {
      let row: Entry;
      try {
        let line: string;
        try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { malformed(); }
        if (!line!.trim()) continue;
        let value: unknown; try { value = JSON.parse(line!); } catch { malformed(); }
        row = checkedEntry(value);
      } catch (error) {
        if (!(error instanceof LegacyInputError) || !error.malformed || options.strict) throw error;
        options.onMalformed?.();
        continue;
      }
      const prior = rows.get(row.id);
      if (prior && !isDeepStrictEqual(JSON.parse(JSON.stringify(prior)), JSON.parse(JSON.stringify(row)))) failure();
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

/** Raw authoritative inputs only: never constructs a legacy store, opens its index or performs network I/O. */
function snapshot(homeM: string, options: LegacySnapshotOptions): LegacySegment[] {
  const root = realPath(homeM);
  directory(root);
  const checkpoints = checkpointMap(options.checkpoints), limits = options.limits === undefined ? undefined : checkpointMap(options.limits);
  const result: LegacySegment[] = [];
  const accept = (source: string, path: string, complete: Buffer, commit?: string, tailBytes = 0, stamp?: string) => {
    if (!segmentPath(path)) failure();
    const identity = `${source}:${path}`, prior = checkpoints.get(identity), limit = limits?.get(identity);
    if (limits && !limit) return;
    const verify = (receipt: LegacyCheckpoint) => {
      if (receipt.offset > complete.length || receipt.offset > 0 && complete[receipt.offset - 1] !== 10 || digest(complete.subarray(0, receipt.offset)) !== receipt.hash) failure();
    };
    if (prior) verify(prior);
    if (limit) { verify(limit); if (prior && limit.offset < prior.offset || limit.commit !== commit) failure(); }
    const bytes = Buffer.from(limit ? complete.subarray(0, limit.offset) : complete);
    result.push({ source, path, bytes, offset: bytes.length, hash: digest(bytes), local: path.startsWith("local/"), tailBytes: limit ? limit.tailBytes ?? 0 : tailBytes, ...((limit ? limit.stamp : stamp) ? { stamp: limit ? limit.stamp : stamp } : {}), ...(commit ? { commit } : {}) });
  };
  // Identity is read without invoking machineId(), which can initialize or repair local state.
  let machine: unknown;
  try { machine = JSON.parse(capturedIdentity(join(root, "machine.json"))); } catch { failure(); }
  const machineId = (machine as { id?: unknown } | undefined)?.id;
  if (typeof machineId !== "string" || !/^[a-f0-9]{16}$/.test(machineId)) failure();
  for (const folder of ["log", "local"]) {
    const dir = join(root, folder);
    if (!directory(dir, true)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const path = `${folder}/${name}`;
      if (!segmentPath(path)) failure();
      if (folder === "local" && name !== `${machineId}.jsonl`) continue;
      const reader = options.reader ?? new SegmentReader();
      const incremental = options.incremental && !limits;
      const data = reader.read(join(dir, name), incremental ? checkpoints.get(`${diskSource}:${path}`) : undefined, !incremental);
      if (incremental) result.push({ ...data, source: diskSource, path, local: folder === "local" });
      else accept(diskSource, path, data.bytes, undefined, data.tailBytes, data.stamp);
    }
  }
  if ((options.commit || options.previousCommit) && !options.generation || options.previousCommit && !commitId(options.previousCommit)) failure();
  if (options.generation !== undefined) {
    const commit = options.commit ?? legacyHead(root, options.generation);
    if (commit) {
      const manifest = archived(root, options.generation, commit);
      directory(join(archiveDir(root, options.generation, commit), "log"));
      for (const prior of new Set([...(options.previousCommit ? [options.previousCommit] : []), ...[...checkpoints.values()].filter(row => row.source === remoteSource).map(row => row.commit!)])) if (!archivedAncestor(root, options.generation, prior, commit)) failure();
      for (const segment of manifest.segments) {
        const reader = options.reader ?? new SegmentReader(), incremental = options.incremental && !limits;
        const data = reader.read(join(archiveDir(root, options.generation, commit), segment.path), incremental ? checkpoints.get(`${remoteSource}:${segment.path}`) : undefined, !incremental, true);
        if (data.offset !== segment.offset || data.hash !== segment.hash || data.tailBytes) failure();
        if (incremental) result.push({ ...data, source: remoteSource, path: segment.path, local: false, tailBytes: segment.tailBytes, commit });
        else accept(remoteSource, segment.path, data.bytes, commit, segment.tailBytes, data.stamp);
      }
    } else if (options.previousCommit) failure();
  }
  const returned = new Set(result.map(key));
  for (const receipt of [...checkpoints.values(), ...(limits?.values() ?? [])]) if (!returned.has(key(receipt))) failure();
  // Checkpointed complete prefixes were already validated; their full hashes prove unchanged bytes.
  // Only newly completed suffixes need parsing on an incremental read.
  const suffixes = result.map(segment => {
    const start = checkpoints.get(key(segment))?.offset ?? 0;
    const bytes = segment.bytes.subarray(Math.max(0, start - (segment.start ?? 0)));
    return { ...segment, bytes, offset: bytes.length, hash: digest(bytes) };
  });
  legacyEntries(suffixes, { onMalformed: options.onMalformed });
  return result;
}

function capturedIdentity(path: string): string {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) failure();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 4096) failure();
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) failure();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}


function cacheDirectory(root: string, generation: string): string | undefined {
  if (!/^[a-f0-9]{32}$/.test(generation)) failure();
  const cache = join(root, "generations", generation, "bridge.git");
  for (const path of [join(root, "generations"), join(root, "generations", generation), cache]) if (!directory(path, true)) return undefined;
  return cache;
}
function cachedGit(cache: string, args: string[], allowMissing = false): Buffer | undefined {
  const argv = memoryGitArgv(["--git-dir", cache, ...args]);
  const run = spawnSync(argv[0]!, argv.slice(1), { env: memoryGitEnv({ ...process.env, GIT_OPTIONAL_LOCKS: "0" }, { repositoryIsolation: true }), encoding: "buffer", timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
  if (run.error || run.signal || run.status !== 0) { if (allowMissing && !run.error && !run.signal && run.status === 1) return undefined; failure(); }
  return run.stdout;
}
/** Last explicitly fetched legacy main, not a claim about the current remote state. Never fetches or writes. */
function head(homeM: string, generation: string): string | undefined {
  const root = realPath(homeM); directory(root);
  const dir = fixedGeneration(root, generation);
  if (!directory(dir, true)) return undefined;
  const active = readProfileJSON(join(dir, "bridge-snapshot.json"), 4096) as { schema?: unknown; generation?: unknown; commit?: unknown } | undefined;
  if (!active) return undefined;
  if (active.schema !== "agent-mem.legacy-head/v1" || active.generation !== generation || typeof active.commit !== "string" || !commitId(active.commit)) failure();
  archived(root, generation, active.commit);
  return active.commit;
}


export function readLegacySnapshot(homeM: string, options: LegacySnapshotOptions = {}): LegacySegment[] {
  try { return snapshot(homeM, options); } catch { return failure(); }
}
export function legacyHead(homeM: string, generation: string): string | undefined {
  try { return head(homeM, generation); } catch { return failure(); }
}


// ponytail: immutable historical snapshots remain while migration/resume and prior-commit receipts can reference them.
// Disk use grows with sync history; add explicit journal-aware GC or content-addressed reuse if measurements justify it.
interface ArchivedSegment { path: string; offset: number; hash: string; tailBytes: number }
interface LegacyArchive { schema: "agent-mem.legacy-snapshot/v1"; generation: string; commit: string; previousCommit?: string; segments: ArchivedSegment[] }
function fixedGeneration(root: string, generation: string): string {
  if (!/^[a-f0-9]{32}$/.test(generation)) failure();
  const parent = join(root, "generations");
  if (directory(parent, true)) directory(join(parent, generation), true);
  return join(parent, generation);
}
function archiveDir(root: string, generation: string, commit: string): string {
  if (!commitId(commit)) failure();
  const dir = join(fixedGeneration(root, generation), "bridge-snapshots");
  directory(dir); const target = join(dir, commit); directory(target); return target;
}
function archived(root: string, generation: string, commit: string): LegacyArchive {
  const value = readProfileJSON(join(archiveDir(root, generation, commit), "snapshot.json"), 32 * 1024 * 1024) as LegacyArchive | undefined;
  if (!value || value.schema !== "agent-mem.legacy-snapshot/v1" || value.generation !== generation || value.commit !== commit || value.previousCommit !== undefined && !commitId(value.previousCommit) || !Array.isArray(value.segments)) failure();
  const paths = new Set<string>();
  for (const segment of value.segments) {
    if (!segment || !segmentPath(segment.path) || !segment.path.startsWith("log/") || paths.has(segment.path) || !Number.isSafeInteger(segment.offset) || segment.offset < 0 || !/^[a-f0-9]{64}$/.test(segment.hash) || !Number.isSafeInteger(segment.tailBytes) || segment.tailBytes < 0) failure();
    paths.add(segment.path);
  }
  return value;
}
function archivedAncestor(root: string, generation: string, previous: string, commit: string): boolean {
  const visited = new Set<string>();
  for (let cursor: string | undefined = commit; cursor && !visited.has(cursor); cursor = archived(root, generation, cursor).previousCommit) {
    if (cursor === previous) return true;
    visited.add(cursor);
  }
  return false;
}

/** Explicit sync-only Git capture. Ordinary readLegacySnapshot/legacyHead never call Git. */
export function readLegacyGitSnapshot(homeM: string, generation: string, commit: string, previousCommit?: string): LegacySegment[] {
  try {
    const root = realPath(homeM), cache = cacheDirectory(root, generation);
    if (!cache || !commitId(commit) || previousCommit !== undefined && !commitId(previousCommit)) failure();
    if (cachedGit(cache, ["cat-file", "-t", commit])?.toString("utf8").trim() !== "commit") failure();
    if (previousCommit && previousCommit !== commit) cachedGit(cache, ["merge-base", "--is-ancestor", previousCommit, commit]);
    const result: LegacySegment[] = [];
    for (const record of cachedGit(cache, ["ls-tree", "-rz", "--full-tree", commit, "--", "log"])!.toString("utf8").split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
      if (!match || match[1] !== "100644" && match[1] !== "100755" || !segmentPath(match[3]!) || !match[3]!.startsWith("log/")) return failure();
      const blob = cachedGit(cache, ["cat-file", "blob", match[2]!])!, end = blob.lastIndexOf(10) + 1, bytes = blob.subarray(0, end);
      result.push({ source: remoteSource, path: match[3]!, offset: end, hash: digest(bytes), bytes, local: false, tailBytes: blob.length - end, commit });
    }
    if (previousCommit) for (const old of archived(root, generation, previousCommit).segments) {
      const next = result.find(segment => segment.path === old.path);
      if (!next || next.offset < old.offset || digest(next.bytes.subarray(0, old.offset)) !== old.hash) failure();
    }
    legacyEntries(result); return result;
  } catch { return failure(); }
}
function immutable(path: string, bytes: Buffer): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try { let at = 0; while (at < bytes.length) { const wrote = writeSync(fd, bytes, at, bytes.length - at); if (wrote <= 0) failure(); at += wrote; } fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink()) failure();
      const existing = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(existing);
        if (stat.dev !== before.dev || stat.ino !== before.ino || !readFileSync(existing).equals(bytes)) failure();
        // Matching bytes after an interrupted capture still need a durable-data fence before activation.
        fsyncSync(existing);
      } finally { closeSync(existing); }
    }
    fsyncDirectory(dirname(path));
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
/** Under the generation mutation fence, publish immutable cached blobs only after explicit sync's fixed-ref CAS. */
export function captureLegacyMain(homeM: string, generation: string, commit: string, previousCommit?: string): void {
  try {
    const root = realPath(homeM), current = legacyHead(root, generation), cache = cacheDirectory(root, generation);
    if (!cache || previousCommit !== current && current !== commit) failure();
    if (cachedGit(cache, ["rev-parse", "--verify", "refs/remotes/legacy/main^{commit}"])?.toString("utf8").trim() !== commit) failure();
    const segments = readLegacyGitSnapshot(root, generation, commit, current);
    const dir = join(fixedGeneration(root, generation), "bridge-snapshots");
    for (const target of [dir, join(dir, commit), join(dir, commit, "log")]) {
      if (!directory(target, true)) mkdirSync(target, { mode: 0o700 });
    }
    for (const segment of segments) immutable(join(dir, commit, segment.path), segment.bytes);
    const prior = current === commit ? archived(root, generation, commit).previousCommit : current;
    const manifest: LegacyArchive = { schema: "agent-mem.legacy-snapshot/v1", generation, commit, ...(prior ? { previousCommit: prior } : {}), segments: segments.map(({ path, offset, hash, tailBytes }) => ({ path, offset, hash, tailBytes })) };
    immutable(join(dir, commit, "snapshot.json"), Buffer.from(canonicalJSON(manifest) + "\n"));
    for (const target of [join(dir, commit, "log"), join(dir, commit), dir]) fsyncDirectory(target);
    writeProfileJSON(join(fixedGeneration(root, generation), "bridge-snapshot.json"), { schema: "agent-mem.legacy-head/v1", generation, commit });
  } catch { return failure(); }
}
