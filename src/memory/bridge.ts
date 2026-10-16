import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { memoryGitArgv, memoryGitEnv, realPath } from "./platform.ts";
import { OP_CONTRACTS } from "./ops-contract.ts";
import { entryId, type Entry } from "./store.ts";

export interface LegacyCheckpoint { source: string; path: string; offset: number; hash: string; commit?: string; tailBytes?: number }
export interface LegacySegment extends LegacyCheckpoint { bytes: Buffer; local: boolean; tailBytes: number }
export interface LegacySnapshotOptions {
  generation?: string;
  commit?: string;
  previousCommit?: string;
  /** Dry-run inspection only; ordinary store reads leave this absent and fail closed. */
  onMalformed?: () => void;
  checkpoints?: readonly LegacyCheckpoint[];
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

/** Capture one length, ignore appends past it, and recheck the consumed prefix through the same open descriptor. */
function capturedFile(path: string): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) failure();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) failure();
    const read = (size: number): Buffer => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) { const n = readSync(fd, bytes, offset, size - offset, offset); if (!n) failure(); offset += n; }
      return bytes;
    };
    const all = read(opened.size), end = all.lastIndexOf(10) + 1;
    const complete = all.subarray(0, end);
    if (!read(end).equals(complete) || fstatSync(fd).size < opened.size) failure();
    const after = lstatSync(path);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) failure();
    return all;
  } finally { closeSync(fd); }
}

function checkpointMap(rows: readonly LegacyCheckpoint[] = []): Map<string, LegacyCheckpoint> {
  const map = new Map<string, LegacyCheckpoint>();
  for (const row of rows) {
    if (![diskSource, remoteSource].includes(row.source) || !segmentPath(row.path) || row.source === remoteSource && !row.path.startsWith("log/")
      || !Number.isSafeInteger(row.offset) || row.offset < 0 || !/^[a-f0-9]{64}$/.test(row.hash)
      || row.tailBytes !== undefined && (!Number.isSafeInteger(row.tailBytes) || row.tailBytes < 0)
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
  if (!Object.hasOwn(OP_CONTRACTS, operation)) return failure();
  const contract = OP_CONTRACTS[operation]!;
  const schema = contract.payloadSchema;
  if (!contract.implemented || contract.status !== "v1-equal" || !schema) failure();
  if (row.schema !== "agent-hub.memory/v1" || typeof row.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id)) malformed();
  const { id, ...body } = row;
  if (entryId(body as unknown as Omit<Entry, "id">) !== id) failure();
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

/** Preserve original IDs; row order and JSON key order never produce duplicate evidence. */
export function legacyEntries(segments: readonly LegacySegment[], options: { onMalformed?: () => void } = {}): Entry[] {
  const rows = new Map<string, Entry>();
  for (const segment of segments) {
    if (segment.bytes.length !== segment.offset || digest(segment.bytes) !== segment.hash || segment.offset && segment.bytes.at(-1) !== 10) failure();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(segment.bytes); } catch { failure(); }
    for (const line of text!.split("\n")) {
      if (!line.trim()) continue;
      let row: Entry;
      try {
        let value: unknown; try { value = JSON.parse(line); } catch { malformed(); }
        row = checkedEntry(value);
      } catch (error) {
        if (!(error instanceof LegacyInputError) || !error.malformed || !options.onMalformed) throw error;
        options.onMalformed();
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
  const accept = (source: string, path: string, complete: Buffer, commit?: string, tailBytes = 0) => {
    if (!segmentPath(path)) failure();
    const identity = `${source}:${path}`, prior = checkpoints.get(identity), limit = limits?.get(identity);
    if (limits && !limit) return;
    const verify = (receipt: LegacyCheckpoint) => {
      if (receipt.offset > complete.length || receipt.offset > 0 && complete[receipt.offset - 1] !== 10 || digest(complete.subarray(0, receipt.offset)) !== receipt.hash) failure();
    };
    if (prior) verify(prior);
    if (limit) { verify(limit); if (prior && limit.offset < prior.offset || limit.commit !== commit) failure(); }
    const bytes = Buffer.from(limit ? complete.subarray(0, limit.offset) : complete);
    result.push({ source, path, bytes, offset: bytes.length, hash: digest(bytes), local: path.startsWith("local/"), tailBytes: limit ? limit.tailBytes ?? 0 : tailBytes, ...(commit ? { commit } : {}) });
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
      const bytes = capturedFile(join(dir, name)), end = bytes.lastIndexOf(10) + 1;
      accept(diskSource, path, bytes.subarray(0, end), undefined, bytes.length - end);
    }
  }
  if ((options.commit || options.previousCommit) && !options.generation || options.previousCommit && !commitId(options.previousCommit)) failure();
  if (options.generation !== undefined) {
    const cache = cacheDirectory(root, options.generation);
    if (!cache) { if (options.commit || options.previousCommit || [...checkpoints.values(), ...(limits?.values() ?? [])].some(row => row.source === remoteSource)) failure(); }
    else {
      const git = (args: string[], allowMissing = false) => cachedGit(cache, args, allowMissing);
      const pinned = options.commit ?? git(["rev-parse", "--verify", "--quiet", "refs/remotes/legacy/main^{commit}"], true)?.toString("utf8").trim();
      if (pinned) {
        if (!commitId(pinned) || git(["cat-file", "-t", pinned])?.toString("utf8").trim() !== "commit") failure();
        const predecessors = new Set([...(options.previousCommit ? [options.previousCommit] : []), ...[...checkpoints.values()].filter(row => row.source === remoteSource).map(row => row.commit!)]);
        for (const previous of predecessors) if (previous !== pinned) git(["merge-base", "--is-ancestor", previous, pinned]);
        for (const receipt of limits?.values() ?? []) if (receipt.source === remoteSource && receipt.commit !== pinned) failure();
        const tree = git(["ls-tree", "-rz", "--full-tree", pinned, "--", "log"])!;
        for (const record of tree.toString("utf8").split("\0").filter(Boolean)) {
          const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
          if (!match) return failure();
          if (match[1] !== "100644" && match[1] !== "100755" || !segmentPath(match[3]!) || !match[3]!.startsWith("log/")) failure();
          const blob = git(["cat-file", "blob", match[2]!])!;
          const end = blob.lastIndexOf(10) + 1;
          accept(remoteSource, match[3]!, blob.subarray(0, end), pinned, blob.length - end);
        }
      } else if (options.previousCommit) failure();
    }
  }
  const returned = new Set(result.map(key));
  for (const receipt of [...checkpoints.values(), ...(limits?.values() ?? [])]) if (!returned.has(key(receipt))) failure();
  // Checkpointed complete prefixes were already validated; their full hashes prove unchanged bytes.
  // Only newly completed suffixes need parsing on an incremental read.
  const suffixes = result.map(segment => {
    const start = checkpoints.get(key(segment))?.offset ?? 0;
    const bytes = segment.bytes.subarray(start);
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
  const cache = cacheDirectory(root, generation);
  if (!cache) return undefined;
  const head = cachedGit(cache, ["rev-parse", "--verify", "--quiet", "refs/remotes/legacy/main^{commit}"], true)?.toString("utf8").trim();
  if (head && !commitId(head)) failure();
  return head;
}


export function readLegacySnapshot(homeM: string, options: LegacySnapshotOptions = {}): LegacySegment[] {
  try { return snapshot(homeM, options); } catch { return failure(); }
}
export function legacyHead(homeM: string, generation: string): string | undefined {
  try { return head(homeM, generation); } catch { return failure(); }
}
