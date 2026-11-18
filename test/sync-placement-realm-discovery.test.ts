import { expect, test } from "bun:test";
import { listRemotePlacementRealms, remoteOnlyPlacementRealms } from "../src/memory/sync-placement-realm-discovery.ts";
import type { SyncPlacementRealmBinding } from "../src/memory/sync-placement-plan.ts";
import type { ShardSyncRow } from "../src/memory/shard-sync-format.ts";

const ref = (hash: string) => `${"a".repeat(40)}\trefs/heads/amem/p/${hash}\n`;
const inventory: SyncPlacementRealmBinding[] = [
  { scope: "user", bindingHash: "b".repeat(64) },
  { scope: "project", keyHash: "1".repeat(64), bindingHash: "c".repeat(64) },
];

test("remote-only listing returns sorted scope and hashes, excluding the effective inventory", () => {
  const listed = remoteOnlyPlacementRealms(Buffer.from(ref("3".repeat(16)) + ref("1".repeat(16)) + ref("2".repeat(16))), inventory);
  expect(listed).toEqual([{ scope: "project", keyHash: "2".repeat(16) }, { scope: "project", keyHash: "3".repeat(16) }]);
  expect(remoteOnlyPlacementRealms(Buffer.alloc(0), inventory)).toEqual([]);
});

test("remote-only listing refuses malformed, duplicate, truncated, oversized and ambiguous inventories", () => {
  for (const raw of [ref("1".repeat(16)) + ref("1".repeat(16)), ref("x".repeat(16)), ref("1".repeat(16)).trimEnd(), "private project name\n", "a".repeat(256 * 1024 + 1)])
    expect(() => remoteOnlyPlacementRealms(Buffer.from(raw), inventory)).toThrow();
  expect(() => remoteOnlyPlacementRealms(Buffer.from([255]), inventory)).toThrow();
  const collision = [...inventory, { scope: "project" as const, keyHash: "1".repeat(16) + "2".repeat(48), bindingHash: "d".repeat(64) }];
  expect(() => remoteOnlyPlacementRealms(Buffer.alloc(0), collision)).toThrow();
});

test("remote listing refuses an inventory change during the transport call", async () => {
  let current = true;
  const binding = { realms: inventory, extensionHead: "a".repeat(64), assertCurrent() { if (!current) throw Error("inventory changed"); } };
  await expect(listRemotePlacementRealms(binding, async () => { current = false; return Buffer.from(ref("2".repeat(16))); })).rejects.toThrow("inventory changed");
});

// Baseline 0.29 admission ignores any future sidecar: an older resume can commit before a new protocol imports data.
test("baseline admission resumes without consulting an unknown adoption companion", async () => {
  const { inventoryFixture, closeInventoryFixtures, digest } = await import("./fakes/sync-placement-inventory.ts");
  const { applyRealmAdmission } = await import("../src/memory/sync-placement-realm-admission.ts");
  const { shardDir } = await import("../src/memory/shard.ts");
  const { existsSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await inventoryFixture(1, undefined, true), project = "example.test/remote-admission/n1";
  try {
    await expect(applyRealmAdmission(f.home, project, { mode: "apply", checkpoint: stage => {
      if (stage === "after-intent") throw Error("synthetic interruption before remote materialization");
    } })).rejects.toThrow();
    const companion = join(f.home, `placement-remote-adoption-${digest(project)}.json`), marker = "pending remote materialization\n";
    writeFileSync(companion, marker, { mode: 0o600 });
    await expect(applyRealmAdmission(f.home, project, { mode: "resume" })).resolves.toMatchObject({ state: "admitted" });
    expect(existsSync(companion)).toBe(true);
    expect(readFileSync(companion, "utf8")).toBe(marker);
    expect(readdirSync(join(shardDir(f.home, project), "log"))).toEqual([]);
  } finally { closeInventoryFixtures(); }
}, 240_000);

test("baseline admission can apply an empty realm while an unknown remote adoption is staged", async () => {
  const { inventoryFixture, closeInventoryFixtures, digest } = await import("./fakes/sync-placement-inventory.ts");
  const { applyRealmAdmission } = await import("../src/memory/sync-placement-realm-admission.ts");
  const { shardDir } = await import("../src/memory/shard.ts");
  const { mkdirSync, readFileSync, readdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await inventoryFixture(1, undefined, true), project = "example.test/remote-admission/staging-n1";
  try {
    const staged = join(f.root, "remote-adoption-stage"), companion = join(f.home, `placement-remote-adoption-${digest(project)}.json`);
    mkdirSync(staged, { mode: 0o700 }); writeFileSync(join(staged, "pending"), "remote data", { mode: 0o600 });
    writeFileSync(companion, "pending\n", { mode: 0o600 });
    await expect(applyRealmAdmission(f.home, project, { mode: "apply" })).resolves.toMatchObject({ state: "admitted" });
    expect(readdirSync(join(shardDir(f.home, project), "log"))).toEqual([]);
    expect(readFileSync(companion, "utf8")).toBe("pending\n");
    expect(readFileSync(join(staged, "pending"), "utf8")).toBe("remote data");
  } finally { closeInventoryFixtures(); }
}, 240_000);

test("pre-admission selection omits verified prune targets and refuses unsupported witnesses", async () => {
  const { publicPruneGraph } = await import("./fixtures/public-prune-graph.ts");
  const { selectRemoteMaterialization } = await import("../src/memory/sync-placement-remote-materialization.ts");
  const graph = publicPruneGraph(), prune = graph.manifest.prune;
  const safe = publicPruneGraph({ note: { text: "safe staged fixture" } }).note;
  const manifest = { path: "fixture", bytes: Buffer.alloc(0), value: graph.manifest, row: prune, eligible: true, commit: "a".repeat(40), blob: "b".repeat(40) };
  const history = { version: "v3" as const, rows: new Map<string, ShardSyncRow>([[graph.note.id, graph.note], [safe.id, safe], [prune.id, prune]]),
    files: new Map(), origins: new Map(), manifests: new Map([["fixture", manifest]]) };
  expect(selectRemoteMaterialization(history)).toEqual({ rows: [safe], omitted: 2 });
  expect(() => selectRemoteMaterialization({ ...history, manifests: new Map([["fixture", { ...manifest, eligible: false }]]) })).toThrow();
  expect(() => selectRemoteMaterialization({ ...history, manifests: new Map() })).toThrow();
});
