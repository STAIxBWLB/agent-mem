import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { collectPublicPruneGitGraph, type PublicPruneGitGraphOptions } from "../src/memory/shard-sync-graph.ts";
import { PublicPruneInputError, type PublicPruneObject } from "../src/memory/public-prune-inputs.ts";
import { publicPruneGraph, rawGitObject } from "./fixtures/public-prune-graph.ts";

type Fixture = ReturnType<typeof publicPruneGraph>;
function decoded(item: PublicPruneObject): Awaited<ReturnType<PublicPruneGitGraphOptions["readObject"]>> {
  const bytes = Buffer.from(item.bytes), end = bytes.indexOf(0), type = bytes.subarray(0, end).toString().split(" ")[0];
  if (type !== "blob" && type !== "tree" && type !== "commit") throw new Error("fixture type");
  return { type, body: bytes.subarray(end + 1) };
}
function harness(fixture: Fixture = publicPruneGraph({ sibling: true })) {
  const map = new Map(fixture.input.objects.map(item => [item.oid, item])), calls: string[] = [];
  const options: PublicPruneGitGraphOptions = { ...fixture.input.source, realm: fixture.manifest.realm,
    readObject: async oid => { calls.push(oid); const item = map.get(oid); if (!item) throw new Error("missing fixture object"); return decoded(item); } };
  return { fixture, map, calls, options, collect: () => collectPublicPruneGitGraph(options) };
}
function changedRoot(f: ReturnType<typeof harness>, body: Buffer): void {
  const tree = rawGitObject("tree", body), commitBody = decoded(f.fixture.commit).body;
  const commit = rawGitObject("commit", Buffer.concat([Buffer.from(`tree ${tree.oid}`), Buffer.from(commitBody).subarray(45)]));
  f.map.set(tree.oid, tree); f.map.set(commit.oid, commit); f.options.commit = commit.oid;
}

test("collector returns only complete required exact raw objects, caches trees and never opens sibling bodies", async () => {
  const f = harness(), result = await f.collect();
  expect(new Set(result.map(item => item.oid))).toEqual(new Set(f.fixture.input.objects.map(item => item.oid)));
  expect(f.calls.length).toBe(new Set(f.calls).size);
  expect(f.calls).not.toContain(f.fixture.siblingTree.oid); expect(f.calls).not.toContain(f.fixture.siblingBlob.oid);
  for (const item of result) {
    expect(Buffer.from(item.bytes)).toEqual(Buffer.from(f.map.get(item.oid)!.bytes));
    expect(createHash("sha1").update(item.bytes).digest("hex")).toBe(item.oid);
  }
});

test("collector preserves non-UTF8 commit message bytes and accepts unsupported lineage only after complete proof", async () => {
  const fixture = publicPruneGraph({ manifest: manifest => { (manifest as { lineage: unknown }).lineage = { kind: "future" }; } }), f = harness(fixture);
  const commit = rawGitObject("commit", Buffer.concat([Buffer.from(decoded(fixture.commit).body), Buffer.from([255, 0, 128, 10, 10])]));
  f.map.set(commit.oid, commit); f.options.commit = commit.oid;
  const result = await f.collect(); expect(Buffer.from(result.find(item => item.oid === commit.oid)!.bytes)).toEqual(Buffer.from(commit.bytes));
  for (const witness of fixture.manifest.witnesses) expect(f.calls).toContain(witness.blob);
});

for (const where of ["commit", "tree", "manifest", "pack"] as const) test(`collector refuses missing or SHA-mismatched ${where}`, async () => {
  for (const attack of ["missing", "bytes"] as const) {
    const f = harness(), oid = where === "commit" ? f.options.commit : where === "tree" ? f.fixture.rootTree.oid
      : where === "manifest" ? f.options.manifestBlob : f.fixture.manifest.witnesses[0]!.blob;
    const original = f.map.get(oid)!;
    if (attack === "missing") f.map.delete(oid);
    else f.map.set(oid, { oid, bytes: Buffer.concat([Buffer.from(original.bytes), Buffer.from("altered")]) });
    await expect(f.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  }
});

for (const mode of ["100755", "120000"] as const) test(`collector refuses unsupported tree mode ${mode}`, async () => {
  await expect(harness(publicPruneGraph({ mode })).collect()).rejects.toBeInstanceOf(PublicPruneInputError);
});

test("collector refuses malformed, duplicate, slash/dot and non-UTF8 names without opening sibling bodies", async () => {
  const oid = Buffer.from("a".repeat(40), "hex");
  for (const name of [Buffer.from("."), Buffer.from(".."), Buffer.from("bad/name"), Buffer.from([255]), Buffer.alloc(0)]) {
    const f = harness(), body = Buffer.concat([Buffer.from(decoded(f.fixture.rootTree).body), Buffer.from("100644 "), name, Buffer.from([0]), oid]);
    changedRoot(f, body); await expect(f.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  }
  const f = harness(), body = Buffer.from(decoded(f.fixture.rootTree).body);
  changedRoot(f, Buffer.concat([body, Buffer.from("100644 shard.json"), Buffer.from([0]), oid]));
  await expect(f.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  const truncated = harness(); changedRoot(truncated, Buffer.from("100644 shard.json"));
  await expect(truncated.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
});

test("collector rejects descriptor version, cross-realm, path, manifest binding and complete-proof violations", async () => {
  const old = harness(publicPruneGraph({ descriptor: { schema: "agent-mem.shard-sync/v1", scope: "user" } }));
  await expect(old.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  const realm = harness(); realm.options.realm = { scope: "user" }; await expect(realm.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  for (const suffix of ["/", "\n"]) { const f = harness(); f.options.manifestPath += suffix; await expect(f.collect()).rejects.toBeInstanceOf(PublicPruneInputError); expect(f.calls.length).toBe(0); }
  const wrong = harness(); wrong.options.manifestBlob = "0".repeat(40); await expect(wrong.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  const invalid = harness(publicPruneGraph({ manifest: manifest => { manifest.prune.targets[0]!.rowHash = "0".repeat(64); } }));
  await expect(invalid.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
  const missing = harness(publicPruneGraph({ manifest: manifest => { manifest.witnesses[0]!.pack = `rows/${"a".repeat(64)}/${"b".repeat(64)}.jsonl`; } }));
  await expect(missing.collect()).rejects.toBeInstanceOf(PublicPruneInputError);
});

test("collector refuses oversized object/commit and witness fanout before fetching packs", async () => {
  for (const [type, size] of [["commit", 65_537], ["tree", 1024 * 1024 + 1], ["blob", 1024 * 1024 + 1]] as const) {
    const f = harness(); f.options.readObject = async () => ({ type, body: Buffer.alloc(size) });
    await expect(f.collect()).rejects.toMatchObject({ code: "resource" });
  }
  const f = harness(publicPruneGraph({ manifest: manifest => { manifest.witnesses = Array.from({ length: 65 }, () => ({ ...manifest.witnesses[0]! })); } }));
  await expect(f.collect()).rejects.toMatchObject({ code: "resource" });
  for (const witness of f.fixture.manifest.witnesses) expect(f.calls).not.toContain(witness.blob);
});
