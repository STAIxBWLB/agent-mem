/** Inactive Layer 2. Only Layer 3 may commit a selector; Layer 4 owns sync admission. */
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJSON, fsyncDirectory, hashJSON } from "./generation.ts";
import { acquireMutation } from "./mutation.ts";
import { realPath } from "./platform.ts";
import { entryId, type Entry } from "./store.ts";
import { prunePayloadHash } from "./prune.ts";
import { shardSyncRef, type ShardSyncRealm } from "./shard-sync-format.ts";
import { verifyPublicPruneWitness, type VerifiedPublicPruneWitness } from "./public-prune-witness.ts";

export const PUBLIC_PRUNE_INPUT_MAX_BYTES = 65_536;
export const PUBLIC_PRUNE_GRAPH_MAX_BYTES = 80 * 1024 * 1024;
export const PUBLIC_PRUNE_GRAPH_MAX_OBJECTS = 256;
export const PUBLIC_PRUNE_REPLAY_MAX_BYTES = 256 * 1024 * 1024;
export const PUBLIC_PRUNE_MAX_SETS = 4096;
const OBJECT_MAX = 1024 * 1024 + 64, ARCHIVE_FILES_MAX = 16_384;
type Source = { remoteHash: string; ref: string; commit: string; manifestPath: string; manifestBlob: string };
export interface PublicPruneInputV1 {
  schema: "agent-mem.public-prune-input/v1"; realm: ShardSyncRealm; receivingGeneration: string;
  selectorRevision: string; witnessHash: string; source: Source;
}
export interface PublicPruneInputSetV1 {
  schema: "agent-mem.public-prune-input-set/v1"; receivingGeneration: string; previous: string | null; inputs: string[];
}
export interface PublicPruneBinding { realm: ShardSyncRealm; receivingGeneration: string; selectorRevision: string; inputSetHash: string | null }
/** Complete Git object bytes, including the uncompressed '<type> <size>\0' header. */
export interface PublicPruneObject { oid: string; bytes: Uint8Array }
export interface PublicPruneInputOptions {
  dir: string; binding: PublicPruneBinding; current: () => PublicPruneBinding;
  /** null prepares an explicit empty activation-set candidate, without activating it. */
  input: { source: Source; witnessHash: string; objects: readonly PublicPruneObject[] } | null;
}
declare const planBrand: unique symbol;
export interface PublicPruneInputPlan { readonly [planBrand]: true }
export interface PublicPruneInputRegistration { inputHash?: string; inputSetHash: string; previous: string | null }
export interface PublicPruneReplayInput {
  dir: string; realm: ShardSyncRealm; receivingGeneration: string; inputSetHash: string;
  nativeTargets?: readonly string[]; ordinary?: readonly Entry[];
}
export interface PublicPruneProjection {
  targets: Set<string>; rowHashes: Map<string, string>; authoredPrunes: number; inputs: string[]; commitments: string[];
}
export type PublicPrunePersistPhase = `${"object" | "input" | "set"}-${"temp" | "fsync" | "installed"}`;
export class PublicPruneInputError extends Error {
  constructor(readonly code: "unavailable" | "resource" | "binding" = "unavailable") {
    super(`public prune input ${code}`); this.name = "PublicPruneInputError";
  }
}
const fail = (code: PublicPruneInputError["code"] = "unavailable"): never => { throw new PublicPruneInputError(code); };
function guard(ok: unknown, code?: PublicPruneInputError["code"]): asserts ok { if (!ok) fail(code); }
function protectedCall<T>(work: () => T): T { try { return work(); } catch (error) { if (error instanceof PublicPruneInputError) throw error; return fail(); } }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hex = (v: unknown, n: number): v is string => typeof v === "string" && v.length === n && /^[a-f0-9]+$/.test(v);
const sha1 = (v: Uint8Array) => createHash("sha1").update(v).digest("hex");
function selectedRealm(v: unknown): ShardSyncRealm {
  guard(object(v));
  if (v.scope === "user") { guard(exact(v, ["scope"])); return { scope: "user" }; }
  guard(exact(v, ["scope", "key"]) && v.scope === "project" && typeof v.key === "string" && v.key.length > 0 && Buffer.byteLength(v.key) <= PUBLIC_PRUNE_INPUT_MAX_BYTES);
  return { scope: "project", key: v.key };
}
function boundedJSON(v: unknown): void { guard(Buffer.byteLength(canonicalJSON(v)) <= PUBLIC_PRUNE_INPUT_MAX_BYTES, "resource"); }
function source(v: unknown, realm: ShardSyncRealm, witnessHash: string): Source {
  guard(object(v) && exact(v, ["remoteHash", "ref", "commit", "manifestPath", "manifestBlob"]));
  guard(hex(v.remoteHash, 64) && hex(v.commit, 40) && hex(v.manifestBlob, 40) && v.ref === shardSyncRef(realm));
  guard(v.manifestPath === `prune-witnesses/${witnessHash}.json`);
  return { remoteHash: v.remoteHash, ref: v.ref, commit: v.commit, manifestPath: v.manifestPath as string, manifestBlob: v.manifestBlob };
}
export function validatePublicPruneInput(v: unknown): PublicPruneInputV1 {
  return protectedCall(() => {
    guard(object(v) && exact(v, ["schema", "realm", "receivingGeneration", "selectorRevision", "witnessHash", "source"])); boundedJSON(v);
    guard(v.schema === "agent-mem.public-prune-input/v1" && hex(v.receivingGeneration, 32) && (hex(v.selectorRevision, 64) || v.selectorRevision === "absent") && hex(v.witnessHash, 64));
    const realm = selectedRealm(v.realm);
    return { schema: v.schema, realm, receivingGeneration: v.receivingGeneration, selectorRevision: v.selectorRevision, witnessHash: v.witnessHash, source: source(v.source, realm, v.witnessHash) };
  });
}
export function validatePublicPruneInputSet(v: unknown): PublicPruneInputSetV1 {
  return protectedCall(() => {
    guard(object(v) && exact(v, ["schema", "receivingGeneration", "previous", "inputs"])); boundedJSON(v);
    guard(v.schema === "agent-mem.public-prune-input-set/v1" && hex(v.receivingGeneration, 32) && (v.previous === null || hex(v.previous, 64)) && Array.isArray(v.inputs));
    let previous = "";
    for (const id of v.inputs) { guard(hex(id, 64) && id > previous); previous = id; }
    return { schema: v.schema, receivingGeneration: v.receivingGeneration, previous: v.previous, inputs: [...v.inputs] as string[] };
  });
}
function binding(v: PublicPruneBinding): PublicPruneBinding {
  guard(object(v) && exact(v, ["realm", "receivingGeneration", "selectorRevision", "inputSetHash"]));
  guard(hex(v.receivingGeneration, 32) && (hex(v.selectorRevision, 64) || v.selectorRevision === "absent") && (v.inputSetHash === null || hex(v.inputSetHash, 64)));
  return { realm: selectedRealm(v.realm), receivingGeneration: v.receivingGeneration, selectorRevision: v.selectorRevision, inputSetHash: v.inputSetHash };
}
function json(bytes: Buffer): unknown {
  guard(bytes.length > 0 && bytes.length <= PUBLIC_PRUNE_INPUT_MAX_BYTES, "resource");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value: unknown = JSON.parse(text), canonical = canonicalJSON(value);
  guard(text === canonical || text === canonical + "\n"); return value;
}
interface GitObject { type: "commit" | "tree" | "blob"; body: Buffer }
function gitObject(oid: string, bytes: Buffer): GitObject {
  guard(hex(oid, 40) && bytes.length <= OBJECT_MAX, "resource"); guard(sha1(bytes) === oid);
  const end = bytes.indexOf(0); guard(end > 0 && end < 40);
  const header = bytes.subarray(0, end).toString("utf8"), match = /^(commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
  guard(match && match[0] === header && Number(match[2]) === bytes.length - end - 1);
  const body = bytes.subarray(end + 1);
  guard(match[1] !== "commit" || body.length <= PUBLIC_PRUNE_INPUT_MAX_BYTES, "resource");
  return { type: match[1] as GitObject["type"], body };
}
function treeEntries(body: Buffer): Map<string, { mode: string; oid: string }> {
  const entries = new Map<string, { mode: string; oid: string }>();
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(32, offset), end = body.indexOf(0, space + 1);
    guard(space > offset && end > space + 1 && end + 21 <= body.length);
    const mode = body.subarray(offset, space).toString("utf8"), name = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(space + 1, end));
    guard(["40000", "100644"].includes(mode) && name !== "." && name !== ".." && !name.includes("/") && !entries.has(name));
    entries.set(name, { mode, oid: body.subarray(end + 1, end + 21).toString("hex") }); offset = end + 21;
  }
  return entries;
}
/** Exact path closure only. Sibling object bodies are neither requested nor retained. */
function graph(input: PublicPruneInputV1, load: (oid: string) => Buffer): { proof: VerifiedPublicPruneWitness; used: Set<string> } {
  const used = new Set<string>(), cache = new Map<string, GitObject>(), trees = new Map<string, ReturnType<typeof treeEntries>>(); let total = 0;
  const get = (oid: string, type: GitObject["type"]): GitObject => {
    let item = cache.get(oid);
    if (!item) {
      const bytes = load(oid); total += bytes.length; guard(total <= PUBLIC_PRUNE_GRAPH_MAX_BYTES && used.size < PUBLIC_PRUNE_GRAPH_MAX_OBJECTS, "resource");
      item = gitObject(oid, bytes); used.add(oid); cache.set(oid, item);
    }
    guard(item.type === type); return item;
  };
  const commit = get(input.source.commit, "commit").body, end = commit.indexOf(10); guard(end > 0);
  const first = commit.subarray(0, end).toString("utf8");
  const root = /^tree ([a-f0-9]{40})$/.exec(first); guard(root && root[0] === first);
  const path = (name: string): { oid: string; body: Buffer } => {
    const parts = name.split("/"); let oid = root[1]!;
    for (let i = 0; i < parts.length; i++) {
      let entries = trees.get(oid); if (!entries) { entries = treeEntries(get(oid, "tree").body); trees.set(oid, entries); }
      const entry = entries.get(parts[i]!); guard(entry);
      const last = i === parts.length - 1; guard(entry.mode === (last ? "100644" : "40000")); oid = entry.oid;
    }
    return { oid, body: get(oid, "blob").body };
  };
  const expected = { schema: "agent-mem.shard-sync/v2", ...input.realm };
  guard(canonicalJSON(json(path("shard.json").body)) === canonicalJSON(expected));
  const manifest = path(input.source.manifestPath); guard(manifest.oid === input.source.manifestBlob);
  const raw = json(manifest.body); guard(object(raw) && Array.isArray(raw.witnesses) && raw.witnesses.length <= 64 && object(raw.pruneOccurrence));
  const refs = [raw.pruneOccurrence, ...raw.witnesses], packs = new Map<string, { pack: string; blob: string; bytes: Buffer }>();
  for (const ref of refs) {
    guard(object(ref) && typeof ref.pack === "string" && ref.pack.length === 140 && /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.exec(ref.pack)?.[0] === ref.pack && hex(ref.blob, 40));
    if (packs.has(ref.pack)) { guard(packs.get(ref.pack)!.blob === ref.blob); continue; }
    const found = path(ref.pack); guard(found.oid === ref.blob); packs.set(ref.pack, { pack: ref.pack, blob: ref.blob, bytes: found.body });
  }
  const proof = verifyPublicPruneWitness(raw, { realm: input.realm, packs: [...packs.values()] });
  guard(proof.status === "verified" && proof.hash === input.witnessHash);
  return { proof, used };
}
interface Prepared { dir: string; dev: number; ino: number; binding: PublicPruneBinding; current: () => PublicPruneBinding; input?: PublicPruneInputV1; objects: Map<string, Buffer> }
const plans = new WeakMap<PublicPruneInputPlan, Prepared>();
export function preparePublicPruneInput(options: PublicPruneInputOptions): PublicPruneInputPlan {
  return protectedCall(() => {
    const expected = binding(options.binding); guard(canonicalJSON(binding(options.current())) === canonicalJSON(expected), "binding");
    const objects = new Map<string, Buffer>(); let input: PublicPruneInputV1 | undefined;
    if (options.input !== null) {
      const value = options.input; guard(value && Array.isArray(value.objects)); guard(value.objects.length <= PUBLIC_PRUNE_GRAPH_MAX_OBJECTS, "resource");
      let total = 0;
      for (const item of value.objects) {
        guard(object(item) && exact(item, ["oid", "bytes"]) && hex(item.oid, 40) && item.bytes instanceof Uint8Array);
        total += item.bytes.byteLength; guard(item.bytes.byteLength <= OBJECT_MAX && total <= PUBLIC_PRUNE_GRAPH_MAX_BYTES, "resource"); guard(!objects.has(item.oid));
        objects.set(item.oid, Buffer.from(item.bytes));
      }
      input = validatePublicPruneInput({ schema: "agent-mem.public-prune-input/v1", realm: expected.realm, receivingGeneration: expected.receivingGeneration,
        selectorRevision: expected.selectorRevision, witnessHash: value.witnessHash, source: value.source });
      const checked = graph(input, oid => { const bytes = objects.get(oid); guard(bytes); return bytes; });
      guard(checked.used.size === objects.size); // never retain whole sibling subtrees or unrelated private bodies
    }
    guard(canonicalJSON(binding(options.current())) === canonicalJSON(expected), "binding");
    const token = Object.freeze({}) as PublicPruneInputPlan;
    const dir = rootDir(options.dir), stat = lstatSync(dir);
    plans.set(token, { dir, dev: stat.dev, ino: stat.ino, binding: expected, current: options.current, input, objects }); return token;
  });
}
type Kind = "object" | "input" | "set";
const folders: Record<Kind, string> = { object: "public-prune-objects", input: "public-prune-inputs", set: "public-prune-input-sets" };
function filename(kind: Kind, id: string): string { guard(hex(id, kind === "object" ? 40 : 64)); return `${id}.${kind === "object" ? "git" : "json"}`; }
function privateStat(stat: Stats, directory = false, links = 1): void {
  guard(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === links));
  guard(stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
}
function rootDir(dir: string): string { privateStat(lstatSync(dir), true); return realPath(dir); }
function folder(dir: string, kind: Kind, create = false): string {
  const name = join(dir, folders[kind]), stat = lstatSync(name, { throwIfNoEntry: false });
  if (!stat) { guard(create); mkdirSync(name, { mode: 0o700 }); fsyncDirectory(dir); }
  privateStat(lstatSync(name), true); return name;
}
function read(dir: string, kind: Kind, id: string, observed?: (file: string, stat: Stats) => void): Buffer {
  const file = join(folder(dir, kind), filename(kind, id)), before = lstatSync(file); privateStat(before);
  guard(before.size > 0 && before.size <= (kind === "object" ? OBJECT_MAX : PUBLIC_PRUNE_INPUT_MAX_BYTES), "resource");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd); privateStat(opened); guard(opened.dev === before.dev && opened.ino === before.ino);
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(file); privateStat(after); privateStat(named);
    guard(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && named.dev === before.dev && named.ino === before.ino); observed?.(file, before); return bytes;
  } finally { closeSync(fd); }
}
type Loader = (kind: Kind, id: string) => Buffer;
function replay(input: Omit<PublicPruneReplayInput, "dir">, load: Loader): PublicPruneProjection {
  const selected = selectedRealm(input.realm); guard(hex(input.receivingGeneration, 32) && hex(input.inputSetHash, 64));
  const cache = new Map<string, Buffer>(); let total = 0;
  const data: Loader = (kind, id) => {
    const key = `${kind}:${id}`; let bytes = cache.get(key);
    if (!bytes) { bytes = load(kind, id); total += bytes.length; guard(total <= PUBLIC_PRUNE_REPLAY_MAX_BYTES, "resource"); cache.set(key, bytes); } return bytes;
  };
  const sets = new Set<string>(); let id: string | null = input.inputSetHash, later: Set<string> | undefined, members: string[] = [];
  while (id !== null) {
    guard(!sets.has(id)); guard(sets.size < PUBLIC_PRUNE_MAX_SETS, "resource"); sets.add(id);
    const set = validatePublicPruneInputSet(json(data("set", id))); guard(hashJSON(set) === id && set.receivingGeneration === input.receivingGeneration);
    if (later) guard(set.inputs.every(hash => later!.has(hash))); else members = set.inputs;
    later = new Set(set.inputs); id = set.previous;
  }
  const targets = new Set<string>(), rowHashes = new Map<string, string>(), identities = new Map<string, string>();
  for (const member of members) {
    const descriptor = validatePublicPruneInput(json(data("input", member)));
    guard(hashJSON(descriptor) === member && descriptor.receivingGeneration === input.receivingGeneration && canonicalJSON(descriptor.realm) === canonicalJSON(selected));
    const { proof } = graph(descriptor, oid => data("object", oid)), prune = proof.manifest.prune, hash = prunePayloadHash(prune), key = `${canonicalJSON(selected)}:${prune.id}`;
    guard(!identities.has(key) || identities.get(key) === hash); identities.set(key, hash);
    for (const ref of proof.manifest.witnesses) { guard(!rowHashes.has(ref.id) || rowHashes.get(ref.id) === ref.rowHash); rowHashes.set(ref.id, ref.rowHash); }
    for (const target of prune.targets) targets.add(target.id);
  }
  for (const id of input.nativeTargets ?? []) { guard(hex(id, 32)); targets.add(id); }
  for (const row of input.ordinary ?? []) {
    const { id, ...body } = row; guard(hex(id, 32) && row.schema === "agent-hub.memory/v1" && entryId(body) === id);
    guard(!rowHashes.has(id) || rowHashes.get(id) === hashJSON(row));
  }
  return { targets, rowHashes, authoredPrunes: identities.size, inputs: [...members], commitments: [...sets] };
}
export function reducePublicPruneInputs(input: PublicPruneReplayInput): PublicPruneProjection {
  return protectedCall(() => { const dir = rootDir(input.dir); return replay(input, (kind, id) => read(dir, kind, id)); });
}
/** A crash after link, before temp unlink, leaves two names. Recover only that
 * exact complete pair under the kernel writer fence; external hardlinks refuse. */
function recoverLinkedTemps(dir: string): void {
  for (const kind of Object.keys(folders) as Kind[]) {
    const base = join(dir, folders[kind]); if (!lstatSync(base, { throwIfNoEntry: false })) continue;
    folder(dir, kind); const names = readdirSync(base); guard(names.length <= ARCHIVE_FILES_MAX, "resource");
    const inodes = new Map<string, { name: string; stat: Stats }[]>();
    for (const name of names) {
      const stat = lstatSync(join(base, name)); guard(stat.nlink === 1 || stat.nlink === 2); privateStat(stat, false, stat.nlink);
      const key = `${stat.dev}:${stat.ino}`, entries = inodes.get(key) ?? []; entries.push({ name, stat }); inodes.set(key, entries);
    }
    for (const entries of inodes.values()) {
      const pending = entries.find(item => item.name.length === 41 && /^\.pending-[a-f0-9]{32}$/.exec(item.name)?.[0] === item.name);
      // ponytail: single-link crash temps count toward the 256 MiB capacity ceiling;
      // future maintenance may reclaim them under this writer fence, never committed proof.
      if (!pending || pending.stat.nlink === 1) continue;
      guard(entries.length === 2); const final = entries.find(item => item !== pending); guard(final && final.stat.nlink === 2);
      const id = final.name.slice(0, kind === "object" ? 40 : 64); guard(filename(kind, id) === final.name);
      const file = join(base, final.name), temp = join(base, pending.name), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd); privateStat(opened, false, 2);
        guard(opened.dev === final.stat.dev && opened.ino === final.stat.ino && opened.size > 0 && opened.size <= (kind === "object" ? OBJECT_MAX : PUBLIC_PRUNE_INPUT_MAX_BYTES), "resource");
        const bytes = readFileSync(fd); guard(bytes.length === opened.size);
        if (kind === "object") gitObject(id, bytes);
        else {
          const value = kind === "input" ? validatePublicPruneInput(json(bytes)) : validatePublicPruneInputSet(json(bytes));
          guard(hashJSON(value) === id);
        }
        for (const name of [file, temp]) { const named = lstatSync(name); privateStat(named, false, 2); guard(named.dev === opened.dev && named.ino === opened.ino && named.size === opened.size && named.mtimeMs === opened.mtimeMs); }
        unlinkSync(temp); fsyncDirectory(base);
      } finally { closeSync(fd); }
    }
  }
}
function capacity(dir: string, writes: Map<string, { kind: Kind; id: string; bytes: Buffer }>): void {
  let total = 0, count = 0;
  for (const kind of Object.keys(folders) as Kind[]) {
    const name = join(dir, folders[kind]); if (!lstatSync(name, { throwIfNoEntry: false })) continue;
    folder(dir, kind);
    for (const entry of readdirSync(name)) {
      const stat = lstatSync(join(name, entry)); privateStat(stat); total += stat.size; count++;
      const candidate = [...writes.values()].find(value => value.kind === kind && filename(kind, value.id) === entry);
      if (candidate) { guard(read(dir, kind, candidate.id).equals(candidate.bytes)); writes.delete(`${kind}:${candidate.id}`); }
      guard(total <= PUBLIC_PRUNE_REPLAY_MAX_BYTES && count <= ARCHIVE_FILES_MAX, "resource");
    }
  }
  for (const value of writes.values()) { total += value.bytes.length; count++; }
  guard(total <= PUBLIC_PRUNE_REPLAY_MAX_BYTES && count <= ARCHIVE_FILES_MAX, "resource");
}
function write(dir: string, kind: Kind, id: string, bytes: Buffer, observe?: (phase: PublicPrunePersistPhase) => void): void {
  const base = folder(dir, kind, true), file = join(base, filename(kind, id));
  if (lstatSync(file, { throwIfNoEntry: false })) { guard(read(dir, kind, id).equals(bytes)); return; }
  const temp = join(base, `.pending-${randomBytes(16).toString("hex")}`), fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); guard(written > 0); offset += written; }
    observe?.(`${kind}-temp`); fsyncSync(fd); observe?.(`${kind}-fsync`);
    linkSync(temp, file); fsyncDirectory(base); observe?.(`${kind}-installed`);
  } finally { closeSync(fd); unlinkSync(temp); fsyncDirectory(base); }
}
/** Persist evidence under the existing writer fence. A returned hash is still only a candidate commitment. */
export function persistPublicPruneInput(plan: PublicPruneInputPlan, options: { observe?: (phase: PublicPrunePersistPhase) => void } = {}): PublicPruneInputRegistration {
  return protectedCall(() => {
    const prepared = plans.get(plan); guard(prepared); const expected = prepared.binding;
    const dir = rootDir(prepared.dir);
    const current = () => {
      const stat = lstatSync(dir); privateStat(stat, true);
      guard(stat.dev === prepared.dev && stat.ino === prepared.ino && canonicalJSON(binding(prepared.current())) === canonicalJSON(expected), "binding");
    }; current();
    // The shared SQLite lock is an ownership fence, never an archive or membership source.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) { const stat = lstatSync(join(dir, "mutation-lock.db" + suffix), { throwIfNoEntry: false }); if (stat) privateStat(stat); }
    const release = acquireMutation(dir); guard(release); try {
      current(); recoverLinkedTemps(dir); current(); const previous = expected.inputSetHash;
      const members = previous ? replay({ realm: expected.realm, receivingGeneration: expected.receivingGeneration, inputSetHash: previous }, (kind, id) => read(dir, kind, id)).inputs : [];
      const inputHash = prepared.input && hashJSON(prepared.input), includes = inputHash !== undefined && members.includes(inputHash);
      const set: PublicPruneInputSetV1 = { schema: "agent-mem.public-prune-input-set/v1", receivingGeneration: expected.receivingGeneration,
        previous, inputs: [...new Set([...members, ...(inputHash ? [inputHash] : [])])].sort() };
      validatePublicPruneInputSet(set);
      const inputSetHash = previous && (!inputHash || includes) ? previous : hashJSON(set);
      const writes = new Map<string, { kind: Kind; id: string; bytes: Buffer }>();
      for (const [oid, bytes] of prepared.objects) writes.set(`object:${oid}`, { kind: "object", id: oid, bytes });
      if (prepared.input && inputHash) writes.set(`input:${inputHash}`, { kind: "input", id: inputHash, bytes: Buffer.from(canonicalJSON(prepared.input) + "\n") });
      if (inputSetHash !== previous) writes.set(`set:${inputSetHash}`, { kind: "set", id: inputSetHash, bytes: Buffer.from(canonicalJSON(set) + "\n") });
      // Preflight the complete future committed view and byte budget before the first archive write.
      replay({ realm: expected.realm, receivingGeneration: expected.receivingGeneration, inputSetHash }, (kind, id) => writes.get(`${kind}:${id}`)?.bytes ?? read(dir, kind, id));
      capacity(dir, writes); current();
      for (const value of writes.values()) { write(dir, value.kind, value.id, value.bytes, options.observe); current(); }
      return { ...(inputHash ? { inputHash } : {}), inputSetHash, previous };
    } finally { release(); }
  });
}

/** In-process verified-byte frontier only. Never serialized or used as membership.
 * Immutable source changes/deletion force replay/refusal; every new handle replays. */
export function createPublicPruneReplayCache(input: Omit<PublicPruneReplayInput, "nativeTargets" | "ordinary">): () => PublicPruneProjection {
  let cached: PublicPruneProjection | undefined; const stamps = new Map<string, string>();
  const stamp = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.uid, stat.mode, stat.nlink].join(":");
  const root = rootDir(input.dir), original = lstatSync(root);
  return () => protectedCall(() => {
    const named = lstatSync(root); privateStat(named, true); guard(named.dev === original.dev && named.ino === original.ino);
    const current = () => {
      for (const parent of new Set([...stamps.keys()].map(file => dirname(file)))) privateStat(lstatSync(parent), true);
      return [...stamps].every(([file, expected]) => { const stat = lstatSync(file); privateStat(stat); return stamp(stat) === expected; });
    };
    if (!cached || !current()) {
      stamps.clear(); cached = replay(input, (kind, id) => read(root, kind, id, (file, stat) => stamps.set(file, stamp(stat))));
      guard(current());
    }
    return { targets: new Set(cached.targets), rowHashes: new Map(cached.rowHashes), authoredPrunes: cached.authoredPrunes, inputs: [...cached.inputs], commitments: [...cached.commitments] };
  });
}
