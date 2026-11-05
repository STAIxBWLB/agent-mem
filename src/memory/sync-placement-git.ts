/** Pure Git object planning. Bytes are unchanged object bodies; no object is installed or published here. */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { PUBLIC_PRUNE_REPLAY_MAX_BYTES } from "./public-prune-input-chain.ts";
import { decodePlacementTransportDescriptor, decodeShardManifest, isShardManifestPath, SHARD_PACK_MAX_BYTES, type ShardSyncRealm } from "./shard-sync-format.ts";

export interface PlannedGitObject { type: "blob" | "tree" | "commit"; oid: string; bytes: Buffer; path: string | null }
export interface PlacementGitObjects { objects: PlannedGitObject[]; tree: string; commit: string }
export class PlacementGitObjectError extends Error {
  constructor() { super("Sync placement Git objects are invalid or exceed supported bounds; rebuild the exact verified publication plan."); this.name = "PlacementGitObjectError"; }
}
function fail(): never { throw new PlacementGitObjectError(); }
const oid = (v: unknown): v is string => typeof v === "string" && v.length === 40 && /^[a-f0-9]+$/.test(v);
const PACK = /^rows\/([a-f0-9]{64})\/([a-f0-9]{64})\.jsonl$/;
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
interface TreeNode { directories: Map<string, TreeNode>; blobs: Map<string, string> }
function node(): TreeNode { return { directories: new Map(), blobs: new Map() }; }
function object(type: PlannedGitObject["type"], bytes: Buffer, path: string | null): PlannedGitObject {
  return { type, oid: createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"), bytes, path };
}
/** Exact Git object bodies and identities, with frozen commit metadata and no-op tree reuse.
 * Retained public bytes share the existing replay bound; new source's separate 8MiB allowance is the caller's proof. */
export function compilePlacementGitObjects(files: ReadonlyMap<string, Uint8Array>, parent: string | null, createdUnixSeconds: number,
  previous?: { tree: string; commit: string }): PlacementGitObjects {
  try { return compile(files, parent, createdUnixSeconds, previous); } catch { return fail(); }
}
function compile(files: ReadonlyMap<string, Uint8Array>, parent: string | null, createdUnixSeconds: number,
  previous?: { tree: string; commit: string }): PlacementGitObjects {
  if (!files || typeof files !== "object" || types.isProxy(files) || Object.getPrototypeOf(files) !== Map.prototype
    || !Number.isSafeInteger(createdUnixSeconds) || createdUnixSeconds < 0 || parent !== null && !oid(parent)) return fail();
  const count = mapSize.call(files);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20000) return fail();
  if (previous !== undefined) {
    if (!previous || typeof previous !== "object" || types.isProxy(previous) || Object.getOwnPropertySymbols(previous).length) return fail();
    const fields = Object.getOwnPropertyDescriptors(previous);
    if (Object.keys(fields).sort().join() !== "commit,tree" || !fields.tree || !fields.commit || !("value" in fields.tree) || !("value" in fields.commit)
      || !oid(fields.tree.value) || !oid(fields.commit.value)) return fail();
    previous = { tree: fields.tree.value, commit: fields.commit.value };
  }
  const entries: { path: string; bytes: Buffer }[] = []; let total = 0;
  for (const [path, value] of Map.prototype.entries.call(files) as Iterable<[unknown, unknown]>) {
    if (typeof path !== "string" || types.isProxy(value) || !(value instanceof Uint8Array)) return fail();
    const pack = PACK.exec(path), validPack = pack?.[0] === path;
    if (path !== "shard.json" && !validPack && !isShardManifestPath(path)) return fail();
    const length = getLength.call(value) as number, maximum = validPack ? SHARD_PACK_MAX_BYTES : 64 * 1024;
    if (length < 1 || length > maximum || (total += length) > PUBLIC_PRUNE_REPLAY_MAX_BYTES) return fail();
    const bytes = Buffer.from(Buffer.from(getBuffer.call(value) as ArrayBuffer, getOffset.call(value) as number, length));
    if (bytes.at(-1) !== 10 || validPack && hash(bytes) !== pack![2]) return fail();
    if (isShardManifestPath(path)) decodeShardManifest(path, bytes);
    if (path === "shard.json") {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail();
      const realm: ShardSyncRealm = parsed.scope === "user" ? { scope: "user" }
        : parsed.scope === "project" && typeof parsed.key === "string" ? { scope: "project", key: parsed.key } : fail();
      decodePlacementTransportDescriptor(bytes, realm);
    }
    entries.push({ path, bytes });
  }
  if (entries.length !== count || !entries.some(entry => entry.path === "shard.json")) return fail();
  entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const objects: PlannedGitObject[] = [], trees: PlannedGitObject[] = [], root = node();
  for (const entry of entries) {
    const blob = object("blob", entry.bytes, entry.path); objects.push(blob);
    const parts = entry.path.split("/"); let target = root;
    for (const name of parts.slice(0, -1)) { if (target.blobs.has(name)) return fail(); let next = target.directories.get(name); if (!next) target.directories.set(name, next = node()); target = next; }
    const name = parts.at(-1)!; if (target.directories.has(name) || target.blobs.has(name)) return fail(); target.blobs.set(name, blob.oid);
  }
  const buildTree = (tree: TreeNode, path: string): string => {
    const children: { name: string; oid: string; directory: boolean }[] = [...tree.blobs].map(([name, id]) => ({ name, oid: id, directory: false }));
    for (const [name, directory] of [...tree.directories].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      children.push({ name, oid: buildTree(directory, path ? `${path}/${name}` : name), directory: true });
    children.sort((a,b) => Buffer.compare(Buffer.from(a.name + (a.directory ? "/" : "")), Buffer.from(b.name + (b.directory ? "/" : ""))));
    let length = 0; const chunks: Buffer[] = [];
    for (const child of children) {
      const prefix = Buffer.from(`${child.directory ? "40000" : "100644"} ${child.name}\0`);
      length += prefix.length + 20; if (length > SHARD_PACK_MAX_BYTES) return fail(); chunks.push(prefix, Buffer.from(child.oid, "hex"));
    }
    const result = object("tree", Buffer.concat(chunks, length), path); trees.push(result); return result.oid;
  };
  const tree = buildTree(root, "");
  trees.sort((a,b) => (b.path ? b.path.split("/").length : 0) - (a.path ? a.path.split("/").length : 0)
    || (a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0));
  objects.push(...trees);
  if (previous?.tree === tree) return { objects, tree, commit: previous.commit };
  const identity = `agent-mem <agent-mem@sync.invalid> ${createdUnixSeconds} +0000`;
  const body = Buffer.from(`tree ${tree}\n${parent === null ? "" : `parent ${parent}\n`}author ${identity}\ncommitter ${identity}\n\nmemory: placement shard append\n`);
  if (body.length > 64 * 1024) return fail();
  const commit = object("commit", body, null); objects.push(commit);
  return { objects, tree, commit: commit.oid };
}
