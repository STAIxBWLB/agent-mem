/** Synthetic Git graph; only selected proof paths are retained, never sibling bodies. */
import { createHash } from "node:crypto";
import frozen from "./public-prune-witness.json";
import { canonicalJSON, hashJSON } from "../../src/memory/generation.ts";
import { entryId, type NoteEntry } from "../../src/memory/store.ts";
import { pruneId, pruneRowHash } from "../../src/memory/prune.ts";
import { shardSyncRef } from "../../src/memory/shard-sync-format.ts";
import type { PublicPruneObject, PublicPruneInputOptions } from "../../src/memory/public-prune-inputs.ts";
import type { PublicPruneWitnessV1 } from "../../src/memory/public-prune-witness.ts";

type Source = NonNullable<PublicPruneInputOptions["input"]>["source"];
export function rawGitObject(type: "blob" | "tree" | "commit", body: Uint8Array | string): PublicPruneObject {
  const content = typeof body === "string" ? Buffer.from(body) : Buffer.from(body), bytes = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
  return { oid: createHash("sha1").update(bytes).digest("hex"), bytes };
}
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
interface Node { entries: Map<string, Node | PublicPruneObject> }
export interface PublicPruneGraphOptions {
  note?: Partial<NoteEntry>;
  manifest?: (manifest: PublicPruneWitnessV1) => void;
  provenance?: Partial<Source>;
  descriptor?: unknown;
  /** Include a sibling directory reference in the root, but never retain its objects. */
  sibling?: boolean;
  mode?: "100644" | "100755" | "120000";
}
export function publicPruneGraph(options: PublicPruneGraphOptions = {}) {
  const manifest = structuredClone(frozen.manifest) as PublicPruneWitnessV1;
  let note = JSON.parse(frozen.packs[1]!.text) as NoteEntry;
  let packs = frozen.packs.map(pack => ({ pack: pack.pack, bytes: Buffer.from(pack.text) }));
  if (options.note) {
    const { id: _id, ...body } = { ...note, ...options.note };
    note = { ...body, id: entryId(body) };
    manifest.prune.targets = [{ id: note.id, rowHash: pruneRowHash(note), expiredAt: note.expires!, basis: { kind: "note", id: note.id, rowHash: pruneRowHash(note) } }];
    const { id: _prune, ...prune } = manifest.prune;
    manifest.prune.id = pruneId(prune);
    packs = [manifest.prune, note].map(row => {
      const bytes = Buffer.from(canonicalJSON(row) + "\n");
      return { pack: `rows/${sha(row.machine)}/${sha(bytes)}.jsonl`, bytes };
    });
    manifest.pruneOccurrence = { pack: packs[0]!.pack, blob: rawGitObject("blob", packs[0]!.bytes).oid };
    manifest.witnesses = [{ id: note.id, rowHash: pruneRowHash(note), pack: packs[1]!.pack, blob: rawGitObject("blob", packs[1]!.bytes).oid }];
  }
  options.manifest?.(manifest);
  const witnessHash = hashJSON(manifest), manifestPath = `prune-witnesses/${witnessHash}.json`;
  const objects = new Map<string, PublicPruneObject>(), paths = new Map<string, string>();
  const keep = (object: PublicPruneObject): PublicPruneObject => { objects.set(object.oid, object); return object; };
  const files = new Map<string, PublicPruneObject>([
    ["shard.json", keep(rawGitObject("blob", canonicalJSON(options.descriptor ?? { schema: "agent-mem.shard-sync/v2", ...manifest.realm }) + "\n"))],
    [manifestPath, keep(rawGitObject("blob", canonicalJSON(manifest) + "\n"))],
    ...packs.map(pack => [pack.pack, keep(rawGitObject("blob", pack.bytes))] as const),
  ]);
  const root: Node = { entries: new Map() };
  for (const [name, object] of files) {
    paths.set(name, object.oid);
    const parts = name.split("/"); let current = root;
    for (const part of parts.slice(0, -1)) {
      let next = current.entries.get(part);
      if (!next) { next = { entries: new Map() }; current.entries.set(part, next); }
      if (!("entries" in next)) throw new Error("fixture path collision");
      current = next;
    }
    current.entries.set(parts.at(-1)!, object);
  }
  const siblingBlob = rawGitObject("blob", "UNOPENED-SIBLING-PRIVATE-CANARY\n");
  const siblingTree = rawGitObject("tree", Buffer.concat([Buffer.from("100644 private.txt\0"), Buffer.from(siblingBlob.oid, "hex")]));
  const tree = (node: Node, prefix = ""): PublicPruneObject => {
    const entries: Buffer[] = [];
    for (const [name, item] of [...node.entries].sort(([a, x], [b, y]) => {
      const left = a + ("entries" in x ? "/" : ""), right = b + ("entries" in y ? "/" : ""); return left < right ? -1 : left > right ? 1 : 0;
    })) {
      const branch = "entries" in item, child = branch ? tree(item, prefix + name + "/") : item;
      entries.push(Buffer.from(`${branch ? "40000" : options.mode ?? "100644"} ${name}\0`), Buffer.from(child.oid, "hex"));
    }
    if (!prefix && options.sibling) entries.push(Buffer.from("40000 unopened\0"), Buffer.from(siblingTree.oid, "hex"));
    const object = keep(rawGitObject("tree", Buffer.concat(entries))); paths.set(prefix || "/", object.oid); return object;
  };
  const rootTree = tree(root), commit = keep(rawGitObject("commit", `tree ${rootTree.oid}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nSynthetic public prune proof\n`));
  const source: Source = { remoteHash: "a".repeat(64), ref: shardSyncRef(manifest.realm), commit: commit.oid, manifestPath, manifestBlob: files.get(manifestPath)!.oid, ...options.provenance };
  return { manifest, note, paths, siblingBlob, siblingTree, rootTree, commit,
    input: { source, witnessHash, objects: [...objects.values()] } satisfies NonNullable<PublicPruneInputOptions["input"]> };
}
