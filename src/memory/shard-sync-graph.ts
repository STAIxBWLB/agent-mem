/** Bounded selected-path acquisition only. Transport admission and receiving binding stay with the caller. */
import { createHash } from "node:crypto";
import { PUBLIC_PRUNE_GRAPH_MAX_BYTES, PUBLIC_PRUNE_GRAPH_MAX_OBJECTS, PUBLIC_PRUNE_INPUT_MAX_BYTES, PublicPruneInputError, type PublicPruneObject } from "./public-prune-inputs.ts";
import { decodeShardDescriptor, decodeShardManifest, SHARD_PACK_MAX_BYTES, type ShardSyncRealm } from "./shard-sync-format.ts";
import { PUBLIC_PRUNE_MAX_PACKS, PUBLIC_PRUNE_MAX_WITNESSES, verifyPublicPruneWitness } from "./public-prune-witness.ts";

type ObjectType = "commit" | "tree" | "blob";
export interface PublicPruneGitGraphOptions {
  commit: string; manifestPath: string; manifestBlob: string; realm: ShardSyncRealm;
  readObject: (oid: string) => Promise<{ type: ObjectType; body: Uint8Array }>;
}
const hex = (v: unknown, n: number): v is string => typeof v === "string" && v.length === n && /^[a-f0-9]+$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function guard(ok: unknown, resource = false): asserts ok { if (!ok) throw new PublicPruneInputError(resource ? "resource" : "unavailable"); }
interface TreeEntry { mode: "40000" | "100644"; oid: string }
function parseTree(body: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(32, offset); guard(space > offset);
    const end = body.indexOf(0, space + 1); guard(end > space + 1 && end + 21 <= body.length);
    const modeBytes = body.subarray(offset, space), mode = modeBytes.toString("ascii");
    guard((mode === "40000" || mode === "100644") && modeBytes.equals(Buffer.from(mode)));
    const rawName = body.subarray(space + 1, end), name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawName);
    guard(name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !entries.has(name));
    entries.set(name, { mode, oid: body.subarray(end + 1, end + 21).toString("hex") }); offset = end + 21;
  }
  return entries;
}

/** Complete raw object graph for one manifest. Unsupported lineage still returns its complete verified public proof. */
export async function collectPublicPruneGitGraph(options: PublicPruneGitGraphOptions): Promise<PublicPruneObject[]> {
  try {
    const { commit, manifestPath, manifestBlob, readObject } = options, realm = structuredClone(options.realm);
    guard(hex(commit, 40) && hex(manifestBlob, 40));
    guard(typeof manifestPath === "string" && manifestPath.length === 85 && /^prune-witnesses\/[a-f0-9]{64}\.json$/.test(manifestPath));
    const objects = new Map<string, { type: ObjectType; body: Buffer; bytes: Buffer }>(), trees = new Map<string, Map<string, TreeEntry>>(); let total = 0;
    const get = async (oid: string, type: ObjectType) => {
      guard(hex(oid, 40)); let found = objects.get(oid);
      if (!found) {
        guard(objects.size < PUBLIC_PRUNE_GRAPH_MAX_OBJECTS, true);
        const value = await readObject(oid);
        guard(value && ["commit", "tree", "blob"].includes(value.type) && value.body instanceof Uint8Array);
        guard(value.body.byteLength <= (value.type === "commit" ? PUBLIC_PRUNE_INPUT_MAX_BYTES : SHARD_PACK_MAX_BYTES), true);
        const header = Buffer.from(`${value.type} ${value.body.byteLength}\0`);
        guard(header.length + value.body.byteLength <= SHARD_PACK_MAX_BYTES + 64 && total + header.length + value.body.byteLength <= PUBLIC_PRUNE_GRAPH_MAX_BYTES, true);
        const body = Buffer.from(value.body), bytes = Buffer.concat([header, body]);
        guard(createHash("sha1").update(bytes).digest("hex") === oid);
        found = { type: value.type, body, bytes }; total += bytes.length; objects.set(oid, found);
      }
      guard(found.type === type); return found;
    };
    const commitBody = (await get(commit, "commit")).body, lf = commitBody.indexOf(10);
    // Only the ASCII tree header is interpreted; arbitrary commit message bytes remain exact.
    guard(lf === 45 && commitBody.subarray(0, 5).equals(Buffer.from("tree ")));
    const rootBytes = commitBody.subarray(5, lf), root = rootBytes.toString("ascii");
    guard(hex(root, 40) && rootBytes.equals(Buffer.from(root)));
    const path = async (name: string) => {
      const parts = name.split("/"); guard(parts.length > 0 && parts.every(part => part && part !== "." && part !== ".."));
      let oid = root;
      for (let i = 0; i < parts.length; i++) {
        let entries = trees.get(oid);
        if (!entries) { entries = parseTree((await get(oid, "tree")).body); trees.set(oid, entries); }
        const entry = entries.get(parts[i]!); guard(entry && entry.mode === (i === parts.length - 1 ? "100644" : "40000")); oid = entry.oid;
      }
      const value = await get(oid, "blob"); return { oid, body: value.body };
    };
    guard(decodeShardDescriptor((await path("shard.json")).body, realm) === "v2");
    const manifest = await path(manifestPath); guard(manifest.oid === manifestBlob);
    const raw = decodeShardManifest(manifestPath, manifest.body);
    guard(object(raw) && object(raw.pruneOccurrence) && Array.isArray(raw.witnesses));
    guard(raw.witnesses.length <= PUBLIC_PRUNE_MAX_WITNESSES, true);
    const packs = new Map<string, { pack: string; blob: string; bytes: Buffer }>();
    for (const ref of [raw.pruneOccurrence, ...raw.witnesses]) {
      guard(object(ref) && typeof ref.pack === "string" && ref.pack.length === 140 && /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.test(ref.pack) && hex(ref.blob, 40));
      const previous = packs.get(ref.pack);
      if (previous) { guard(previous.blob === ref.blob); continue; }
      guard(packs.size < PUBLIC_PRUNE_MAX_PACKS, true);
      const found = await path(ref.pack); guard(found.oid === ref.blob && found.body.length <= SHARD_PACK_MAX_BYTES);
      packs.set(ref.pack, { pack: ref.pack, blob: ref.blob, bytes: found.body });
    }
    const proof = verifyPublicPruneWitness(raw, { realm, packs: [...packs.values()] }); guard(proof.status !== "invalid");
    return [...objects].map(([oid, item]) => ({ oid, bytes: item.bytes }));
  } catch (error) {
    if (error instanceof PublicPruneInputError) throw error;
    throw new PublicPruneInputError();
  }
}
