import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ShardHistoryAuditor, ShardHistoryError, type ShardHistoryAuditorOptions } from "../src/memory/shard-sync-history.ts";
import { encodeShardPacks, shardSyncDescriptor, shardSyncRef, type ShardSyncRealm, type ShardSyncRow } from "../src/memory/shard-sync-format.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { PLACEMENT_DESCRIPTOR_SCHEMA, PLACEMENT_FORMAT } from "../src/memory/sync-placement-format.ts";
import { entryId, type NoteEntry } from "../src/memory/store.ts";
import { publicPruneGraph } from "./fixtures/public-prune-graph.ts";

const realm: ShardSyncRealm = { scope: "project", key: "synthetic-history" }, G = "1".repeat(32);
const C = (index: number) => index.toString(16).padStart(40, "0");
function note(text: string): NoteEntry {
  const body: Omit<NoteEntry, "id"> = { schema: "agent-hub.memory/v1", op: "note", at: "2026-10-01T00:00:00.000Z", machine: "2".repeat(16), project: realm.scope === "project" ? realm.key : "", scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] };
  return { ...body, id: entryId(body) };
}
function descriptor(version: "v1" | "v2" | "v3", selected = realm): Buffer {
  return Buffer.from(version === "v3" ? canonicalJSON({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...selected, publicationFormat: PLACEMENT_FORMAT }) + "\n" : shardSyncDescriptor(selected, version));
}
function tree(version: "v1" | "v2" | "v3", rows: ShardSyncRow[], selected = realm) { return new Map([["shard.json", descriptor(version, selected)], ...encodeShardPacks(rows)]); }
function fixture(selected = realm) {
  const commits = new Map<string, { parents: string[]; files: Map<string, Buffer> }>(), blobs = new Map<string, Buffer>();
  let reads = 0;
  const blobId = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const add = (id: string, parents: string[], files: Map<string, Buffer>) => { commits.set(id, { parents, files }); for (const bytes of files.values()) blobs.set(blobId(bytes), bytes); return id; };
  const options: ShardHistoryAuditorOptions = { realm: selected, generation: G, placement: true,
    git: async args => {
      const tip = args.at(-1)!, commit = commits.get(tip); if (!commit) throw Error("missing synthetic commit");
      if (args[0] === "ls-tree") return [...commit.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => `100644 blob ${blobId(bytes)}\t${path}\0`).join("");
      const seen = new Set<string>(), lines: string[] = [];
      const visit = (id: string) => { if (seen.has(id)) return; const current = commits.get(id); if (!current) throw Error("missing synthetic parent"); for (const parent of current.parents) visit(parent); seen.add(id); lines.push([id, ...current.parents].join(" ")); };
      visit(tip); return lines.join("\n");
    },
    blob: async object => { reads++; const bytes = blobs.get(object); if (!bytes) throw Error("missing synthetic blob"); return Buffer.from(bytes); } };
  return { add, options, blobId, reads: () => reads };
}

test("complete selected DAG audits v1 to v2 to v3 and keeps first verified row origins", async () => {
  const f = fixture(), a = note("synthetic a"), b = note("synthetic b");
  f.add(C(1), [], tree("v1", [a]));
  const second = tree("v2", [a]); for (const [path, bytes] of encodeShardPacks([b])) second.set(path, bytes);
  f.add(C(2), [C(1)], second); f.add(C(3), [C(2)], new Map([...second].map(([path, bytes]) => [path, path === "shard.json" ? descriptor("v3") : bytes])));
  const auditor = new ShardHistoryAuditor(f.options), first = await auditor.history(C(1)), latest = await auditor.history(C(3));
  expect(latest.version).toBe("v3"); expect([...latest.rows.keys()].sort()).toEqual([a.id, b.id].sort());
  expect(latest.origins.get(a.id)?.commit).toBe(C(1)); expect(latest.origins.get(b.id)?.commit).toBe(C(2));
  expect(latest.origins.get(a.id)?.ref).toBe(shardSyncRef(realm));
  const reads = f.reads(); first.rows.clear(); latest.files.clear(); latest.origins.get(a.id)!.commit = C(9);
  const again = await auditor.history(C(3));
  expect(again.rows.size).toBe(2); expect(again.files.size).toBe(second.size); expect(again.origins.get(a.id)?.commit).toBe(C(1)); expect(f.reads()).toBe(reads);
});

for (const [from, to] of [["v2", "v1"], ["v3", "v1"], ["v3", "v2"]] as const)
  test(`${from} history cannot downgrade to ${to}`, async () => {
    const f = fixture(), a = note("synthetic original"); f.add(C(1), [], tree(from, [a])); f.add(C(2), [C(1)], tree(to, [a]));
    await expect(new ShardHistoryAuditor(f.options).history(C(2))).rejects.toThrow(ShardHistoryError);
  });

test("legacy descriptor admission still refuses v3 and a v1 home still refuses v2", async () => {
  const f = fixture(); f.add(C(1), [], tree("v3", [])); f.add(C(2), [], tree("v2", []));
  await expect(new ShardHistoryAuditor({ ...f.options, placement: false, publicPrune: true }).history(C(1))).rejects.toThrow();
  await expect(new ShardHistoryAuditor({ ...f.options, placement: false, publicPrune: false }).history(C(2))).rejects.toThrow();
  expect((await new ShardHistoryAuditor({ ...f.options, placement: false, publicPrune: true }).history(C(2))).version).toBe("v2");
});

test("v1 can repack retained originals but v2 and v3 retain every immutable artifact", async () => {
  const a = note("synthetic a"), b = note("synthetic b");
  for (const version of ["v1", "v2", "v3"] as const) {
    const f = fixture(); f.add(C(1), [], tree(version, [a])); f.add(C(2), [C(1)], tree(version, [a, b]));
    const result = new ShardHistoryAuditor(f.options).history(C(2));
    if (version === "v1") expect((await result).rows.size).toBe(2); else await expect(result).rejects.toThrow();
  }
});

test("every parent of a merge must retain its complete original rows", async () => {
  const f = fixture(), a = note("synthetic a"), b = note("synthetic b");
  f.add(C(1), [], tree("v1", [])); f.add(C(2), [C(1)], tree("v1", [a])); f.add(C(3), [C(1)], tree("v1", [b])); f.add(C(4), [C(2), C(3)], tree("v1", [a]));
  await expect(new ShardHistoryAuditor(f.options).history(C(4))).rejects.toThrow();
});

test("forbidden tree entries and invalid blob identity fail with a fixed safe error", async () => {
  const f = fixture(), files = tree("v3", []); files.set("private-canary.txt", Buffer.from("private-canary\n")); f.add(C(1), [], files);
  try { await new ShardHistoryAuditor(f.options).history(C(1)); throw Error("accepted forbidden tree"); }
  catch (error) { expect(error).toBeInstanceOf(ShardHistoryError); expect((error as Error).message).not.toContain("private-canary"); }
  const good = fixture(); good.add(C(1), [], tree("v3", []));
  await expect(new ShardHistoryAuditor({ ...good.options, blob: async () => Buffer.from("wrong identity\n") }).history(C(1))).rejects.toThrow(ShardHistoryError);
});

function manifestFixture(version: "v1" | "v2" | "v3") {
  const graph = publicPruneGraph(), f = fixture(graph.manifest.realm), files = new Map<string, Buffer>();
  const objects = new Map(graph.input.objects.map(item => [item.oid, Buffer.from(item.bytes)]));
  for (const [path, object] of graph.paths) {
    if (path !== "shard.json" && !path.startsWith("rows/") && !path.startsWith("prune-witnesses/")) continue;
    const raw = objects.get(object); if (!raw || raw.subarray(0, 5).toString() !== "blob ") continue;
    files.set(path, path === "shard.json" ? descriptor(version, graph.manifest.realm) : raw.subarray(raw.indexOf(0) + 1));
  }
  f.add(C(1), [], files); return { f, graph, files };
}

test("v2 and v3 manifest audit reuses complete public proof and preserves manifest occurrence origin", async () => {
  const { f, graph, files } = manifestFixture("v2"), second = new Map(files); second.set("shard.json", descriptor("v3", graph.manifest.realm)); f.add(C(2), [C(1)], second);
  const history = await new ShardHistoryAuditor(f.options).history(C(2));
  expect(history.manifests.size).toBe(1);
  const manifest = [...history.manifests.values()][0]!;
  expect(manifest.eligible).toBe(true); expect(manifest.row).toEqual(graph.manifest.prune); expect(manifest.commit).toBe(C(1));
  expect(history.origins.get(manifest.row.id)?.commit).toBe(C(1));
});

test("v1 manifests, missing proof packs and disappeared v2 manifests remain refused", async () => {
  const legacy = manifestFixture("v1"); await expect(new ShardHistoryAuditor(legacy.f.options).history(C(1))).rejects.toThrow();
  const missing = manifestFixture("v3"), absent = new Map(missing.files); absent.delete(missing.graph.manifest.witnesses[0]!.pack); missing.f.add(C(2), [], absent);
  await expect(new ShardHistoryAuditor(missing.f.options).history(C(2))).rejects.toThrow();
  const retained = manifestFixture("v2"), without = new Map(retained.files);
  for (const path of without.keys()) if (path.startsWith("prune-witnesses/")) without.delete(path);
  retained.f.add(C(2), [C(1)], without);
  await expect(new ShardHistoryAuditor(retained.f.options).history(C(2))).rejects.toThrow();
});
