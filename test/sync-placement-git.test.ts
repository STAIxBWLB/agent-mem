import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compilePlacementGitObjects, PlacementGitObjectError } from "../src/memory/sync-placement-git.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { memoryGitArgv, memoryGitEnv } from "../src/memory/platform.ts";
import { encodeShardPacks } from "../src/memory/shard-sync-format.ts";
import { PLACEMENT_FORMAT, PLACEMENT_DESCRIPTOR_SCHEMA } from "../src/memory/sync-placement-format.ts";
import { entryId, type NoteEntry } from "../src/memory/store.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const WHEN = 1_793_836_800;
function files() {
  const body: Omit<NoteEntry, "id"> = { schema: "agent-hub.memory/v1", op: "note", at: "2026-10-01T00:00:00.000Z", machine: "1".repeat(16),
    project: "synthetic-git", scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "synthetic unchanged original", about: [] };
  const row = { ...body, id: entryId(body) }, result = encodeShardPacks([row]);
  result.set("shard.json", Buffer.from(canonicalJSON({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, scope: "project", key: body.project, publicationFormat: PLACEMENT_FORMAT }) + "\n"));
  return result;
}
function git(dir: string, args: string[], stdin?: Uint8Array): Buffer {
  const result = Bun.spawnSync(memoryGitArgv(args), { cwd: dir, stdin, stdout: "pipe", stderr: "pipe", timeout: 3000,
    env: memoryGitEnv({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_DEFAULT_HASH: "sha1" }, { repositoryIsolation: true }) });
  if (result.exitCode !== 0) throw Error("isolated Git object fixture failed: " + result.stderr.toString()); return Buffer.from(result.stdout);
}

test("planned body bytes hash exactly as Git objects and reconstruct the unchanged tree/commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-placement-git-")); cleanup.push(dir);
  git(dir, ["init", "--bare", "--template=", "--object-format=sha1", "-q"]);
  const original = files(), planned = compilePlacementGitObjects(original, null, WHEN);
  const seen = new Set<string>();
  for (const object of planned.objects) {
    const calculated = createHash("sha1").update(`${object.type} ${object.bytes.length}\0`).update(object.bytes).digest("hex");
    expect(object.oid).toBe(calculated);
    expect(git(dir, ["hash-object", "-w", "-t", object.type, "--stdin"], object.bytes).toString().trim()).toBe(object.oid);
    expect(git(dir, ["cat-file", object.type, object.oid])).toEqual(object.bytes);
    if (object.type === "blob") expect(object.bytes).toEqual(original.get(object.path!)!);
    if (object.type === "tree") {
      for (let at = 0; at < object.bytes.length;) {
        const end = object.bytes.indexOf(0, at); expect(end).toBeGreaterThan(at);
        const child = object.bytes.subarray(end + 1, end + 21).toString("hex"); expect(seen.has(child)).toBe(true); at = end + 21;
      }
    }
    seen.add(object.oid);
  }
  const listed = git(dir, ["ls-tree", "-r", "--name-only", planned.commit]).toString().trim().split("\n").sort();
  expect(listed).toEqual([...original.keys()].sort());
  const commit = git(dir, ["cat-file", "commit", planned.commit]).toString();
  expect(commit).toBe(`tree ${planned.tree}\nauthor agent-mem <agent-mem@sync.invalid> ${WHEN} +0000\ncommitter agent-mem <agent-mem@sync.invalid> ${WHEN} +0000\n\nmemory: placement shard append\n`);
});

test("map insertion order cannot change objects, binary trees or frozen commit identity", () => {
  const original = files(), normal = compilePlacementGitObjects(original, "a".repeat(40), WHEN);
  const reverse = compilePlacementGitObjects(new Map([...original].reverse()), "a".repeat(40), WHEN);
  expect(reverse).toEqual(normal);
  expect(normal.objects.at(-1)?.bytes.toString()).toContain(`parent ${"a".repeat(40)}\n`);
  const trees = normal.objects.filter(object => object.type === "tree");
  expect(trees.at(-1)?.path).toBe("");
  const root = trees.at(-1)!.bytes;
  expect(root.indexOf(Buffer.from("40000 rows\0"))).toBeLessThan(root.indexOf(Buffer.from("100644 shard.json\0")));
});

test("an unchanged tree reuses the existing commit without a new commit object or mutable input alias", () => {
  const original = files(), first = compilePlacementGitObjects(original, null, WHEN);
  const result = compilePlacementGitObjects(original, first.commit, WHEN + 1, { tree: first.tree, commit: first.commit });
  expect(result.tree).toBe(first.tree); expect(result.commit).toBe(first.commit);
  expect(result.objects.some(object => object.type === "commit")).toBe(false);
  const descriptor = original.get("shard.json")!, planned = result.objects.find(object => object.path === "shard.json")!.bytes;
  const expected = Buffer.from(descriptor); descriptor.fill(0);
  expect(planned).toEqual(expected);
});

test("path indirection, unsupported metadata and content-address mismatch refuse with a fixed safe error", () => {
  for (const path of ["../private-canary", "/shard.json", "rows/../shard.json", "shard.json/child", "shard.json\n", "rows/a/b.jsonl", "private-canary.txt"])
    expect(() => compilePlacementGitObjects(new Map([[path, Buffer.from("fixture\n")]]), null, WHEN)).toThrow(PlacementGitObjectError);
  const corrupt = files(), path = [...corrupt.keys()].find(key => key.startsWith("rows/"))!; corrupt.set(path, Buffer.from("different body\n"));
  expect(() => compilePlacementGitObjects(corrupt, null, WHEN)).toThrow(PlacementGitObjectError);
  const noDescriptor = files(); noDescriptor.delete("shard.json");
  expect(() => compilePlacementGitObjects(noDescriptor, null, WHEN)).toThrow(PlacementGitObjectError);
});

test("file, body, timestamp and parent bounds fail before any write or caller getter invocation", () => {
  for (const when of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
    expect(() => compilePlacementGitObjects(files(), null, when)).toThrow(PlacementGitObjectError);
  for (const parent of ["a".repeat(39), "a".repeat(40) + "\n", "private-canary"])
    expect(() => compilePlacementGitObjects(files(), parent, WHEN)).toThrow(PlacementGitObjectError);
  expect(() => compilePlacementGitObjects(new Map(), null, WHEN)).toThrow(PlacementGitObjectError);
  const many = new Map(Array.from({ length: 20001 }, (_, index) => [`invalid-${index}`, new Uint8Array()] as const));
  expect(() => compilePlacementGitObjects(many, null, WHEN)).toThrow(PlacementGitObjectError);
  expect(() => compilePlacementGitObjects(new Map([["shard.json", new Uint8Array(65537)]]), null, WHEN)).toThrow(PlacementGitObjectError);
  let calls = 0;
  const previous = Object.defineProperty({ tree: "a".repeat(40) }, "commit", { enumerable: true, get() { calls++; return "b".repeat(40); } });
  expect(() => compilePlacementGitObjects(files(), null, WHEN, previous as { tree: string; commit: string })).toThrow(PlacementGitObjectError);
  const proxied = new Proxy(files(), { get() { calls++; throw Error("must not run"); } });
  expect(() => compilePlacementGitObjects(proxied, null, WHEN)).toThrow(PlacementGitObjectError);
  expect(calls).toBe(0);
});
