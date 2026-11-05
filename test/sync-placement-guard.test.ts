import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { canonicalJSON, hashJSON, readProfileJSON, readSelector } from "../src/memory/generation.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { syncGenerationMemory } from "../src/memory/generation-sync.ts";
import { syncShardedMemory } from "../src/memory/shard-sync.ts";
import { decodeShardDescriptor, shardSyncDescriptor } from "../src/memory/shard-sync-format.ts";
import { PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA, PLACEMENT_SHARDS_SCHEMA, PLACEMENT_DESCRIPTOR_SCHEMA, validatePlacementProfile, validatePlacementShards } from "../src/memory/sync-placement-format.ts";
import { PLACEMENT_STAGE1_REFUSAL, PLACEMENT_MARKER_REFUSAL, placementMarkerRefusal, placementRuntimeRefusal } from "../src/memory/sync-placement-guard.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const G = "e".repeat(32), project = "placement-guard-project";
function home(): string { const dir = mkdtempSync(join(tmpdir(), "amem-placement-guard-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function markers() {
  const profile = validatePlacementProfile({ schema: PLACEMENT_PROFILE_SCHEMA, kind: "generation", generation: G,
    foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "a".repeat(64), publicationFormat: PLACEMENT_FORMAT, placementHead: "b".repeat(64) });
  const shards = validatePlacementShards({ schema: PLACEMENT_SHARDS_SCHEMA, generation: G, phase: "active", selectorRevision: hashJSON(profile),
    sources: [], machine: { id: "c".repeat(16), label: "synthetic guard" }, publicationFormat: PLACEMENT_FORMAT, placementHead: profile.placementHead }, profile);
  return { profile, shards };
}
function seedMarkers(dir: string): void {
  const value = markers();
  writeFileSync(join(dir, "profile.json"), canonicalJSON(value.profile) + "\n", { mode: 0o600 });
  writeFileSync(join(dir, "shards.json"), canonicalJSON(value.shards) + "\n", { mode: 0o600 });
}
function tree(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (folder: string, prefix: string) => {
    for (const name of readdirSync(folder).sort()) {
      const relative = prefix + name, file = join(folder, name), stat = statSync(file);
      if (stat.isDirectory()) walk(file, relative + "/");
      else result[relative] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  walk(dir, ""); return result;
}
async function opened(kind: "shared-v1" | "generation" | "sharded-v2") {
  const root = home(), memoryDir = join(root, "memory");
  let store = new MemoryStore({ memoryDir, deferPromotions: true });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "synthetic guard row", about: [] });
  if (kind === "generation") {
    store.close(); await migrate({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
    store = new MemoryStore({ memoryDir, deferPromotions: true });
  } else if (kind === "sharded-v2") {
    store.close(); await migrateShards({ memoryDir, generation: G, mode: "apply", authorizedPerson: true, tty: true });
    await activatePublicPruneView({ memoryDir, mode: "apply", authorizedPerson: true, tty: true });
    store = openShardStore({ memoryDir, project, deferPromotions: true });
  }
  cleanup.push(() => store.close()); return { store, memoryDir };
}

test("stage1 v3 markers are recognized but selector and store opens refuse before effects", () => {
  const memoryDir = home(); seedMarkers(memoryDir);
  writeFileSync(join(memoryDir, "profile.lock"), "synthetic invalid lock must remain unopened", { mode: 0o600 });
  const before = tree(memoryDir);
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_STAGE1_REFUSAL);
  expect(() => readSelector(memoryDir)).toThrow(PLACEMENT_STAGE1_REFUSAL);
  expect(() => new MemoryStore({ memoryDir })).toThrow(PLACEMENT_STAGE1_REFUSAL);
  expect(() => openShardStore({ memoryDir, project })).toThrow(PLACEMENT_STAGE1_REFUSAL);
  expect(tree(memoryDir)).toEqual(before);
});

for (const kind of ["shared-v1", "generation", "sharded-v2"] as const) test(`all sync entrypoints refuse manually installed v3 before effects on a preopened ${kind} store`, async () => {
  const { store, memoryDir } = await opened(kind); seedMarkers(memoryDir); const tables = store.derivedTables(), before = tree(memoryDir);
  let attempts = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { attempts++; throw Error("must not spawn under placement markers"); });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => { attempts++; throw Error("must not spawnSync under placement markers"); });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { attempts++; throw Error("must not fetch under placement markers"); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    const opts = { remote: "https://example.invalid/private.git", visibility: async () => { attempts++; return "private" as const; }, screen: () => { attempts++; return true; } };
    for (const sync of [syncMemory, syncGenerationMemory, syncShardedMemory]) expect(await sync(store, opts)).toEqual({ ok: false, pushed: false, entries: 0, error: PLACEMENT_STAGE1_REFUSAL });
    expect(attempts).toBe(0); expect(tree(memoryDir)).toEqual(before); expect(store.derivedTables()).toEqual(tables);
  } finally { spawn.mockRestore(); spawnSync.mockRestore(); fetch.mockRestore(); }
});

test("unknown, malformed and split placement markers refuse without disclosing input", () => {
  const memoryDir = home(), value = markers();
  writeFileSync(join(memoryDir, "profile.json"), '{"schema":"private-canary-do-not-echo"}');
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_MARKER_REFUSAL);
  writeFileSync(join(memoryDir, "profile.json"), "not-json private-canary-do-not-echo");
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_MARKER_REFUSAL);
  writeFileSync(join(memoryDir, "profile.json"), canonicalJSON(value.profile));
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_MARKER_REFUSAL);
  writeFileSync(join(memoryDir, "shards.json"), canonicalJSON({ ...value.shards, placementHead: "d".repeat(64) }));
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_MARKER_REFUSAL);
  truncateSync(join(memoryDir, "profile.json"), 256 * 1024 + 1);
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_MARKER_REFUSAL);
  let getter = 0;
  expect(placementMarkerRefusal({ get schema() { getter++; return PLACEMENT_PROFILE_SCHEMA; } }, value.shards)).toBe(PLACEMENT_MARKER_REFUSAL);
  expect(getter).toBe(0);
});

test("legacy v1 selectors and captured-v1 journal remain on their existing path", () => {
  const memoryDir = home(), profile = { schema: "agent-mem.profile/v1", kind: "shared-v1" } as const;
  expect(placementRuntimeRefusal(memoryDir)).toBeUndefined();
  writeFileSync(join(memoryDir, "profile.json"), canonicalJSON(profile) + "\n");
  writeFileSync(join(memoryDir, "shards.json"), canonicalJSON({ schema: "agent-mem.shards/v1", generation: G, phase: "captured", selectorRevision: hashJSON(profile), sources: [], machine: { id: "c".repeat(16), label: "legacy" } }) + "\n");
  const before = tree(memoryDir);
  expect(placementRuntimeRefusal(memoryDir)).toBeUndefined();
  expect(readSelector(memoryDir)).toEqual({ selector: profile, revision: hashJSON(profile) });
  expect(tree(memoryDir)).toEqual(before);
});

test("valid v2 selector/view remains readable and byte-identical", async () => {
  const { memoryDir } = await opened("sharded-v2"), before = tree(memoryDir), profile = readProfileJSON(join(memoryDir, "profile.json"));
  expect(placementRuntimeRefusal(memoryDir)).toBeUndefined();
  expect(profile).toEqual(readSelector(memoryDir).selector); expect(tree(memoryDir)).toEqual(before);
});

test("descriptor decoder recognizes valid v3 syntax but never enables the existing transport", () => {
  for (const realm of [{ scope: "user" as const }, { scope: "project" as const, key: project }]) {
    for (const version of ["v1", "v2"] as const) {
      const before = shardSyncDescriptor(realm, version), expected = canonicalJSON({ schema: `agent-mem.shard-sync/${version}`, ...realm }) + "\n";
      expect(before).toBe(expected); expect(decodeShardDescriptor(Buffer.from(before), realm)).toBe(version);
    }
    const bytes = Buffer.from(canonicalJSON({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...realm, publicationFormat: PLACEMENT_FORMAT }) + "\n");
    expect(() => decodeShardDescriptor(bytes, realm)).toThrow(PLACEMENT_STAGE1_REFUSAL);
    expect(() => shardSyncDescriptor(realm, "v3" as never)).toThrow("unsupported descriptor version");
  }
  expect(() => decodeShardDescriptor(Buffer.from('{"schema":"private-canary"}\n'), { scope: "user" })).toThrow("schema mismatch");
});


test("sync --if-due refuses v3 before cadence/cache shortcuts", async () => {
  const { runCli } = await import("../src/cli.ts");
  const memoryDir = home(); seedMarkers(memoryDir); const before = tree(memoryDir), saved = process.env.AMEM_HOME;
  process.env.AMEM_HOME = memoryDir;
  try {
    await expect(runCli(["sync", "--if-due"], { cwd: memoryDir, env: {}, stdinTTY: true })).rejects.toThrow(PLACEMENT_STAGE1_REFUSAL);
    expect(tree(memoryDir)).toEqual(before);
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
});


test("ordinary constructor preserves the legacy selector diagnostic for malformed non-v3 profiles (N1)", () => {
  for (const value of ["not json", '{"schema":"agent-mem.profile/v1","kind":"invalid"}', '{"schema":"future"}']) {
    const memoryDir = home(); writeFileSync(join(memoryDir, "profile.json"), value, { mode: 0o600 });
    const before = tree(memoryDir);
    let expected: string | undefined;
    try { readSelector(memoryDir); } catch (error) { expected = (error as Error).message; }
    expect(expected).toBeDefined(); expect(expected).not.toContain("sync placement");
    expect(() => new MemoryStore({ memoryDir })).toThrow(expected!);
    expect(tree(memoryDir)).toEqual(before);
  }
});

test("a durable placement fence refuses marker rollback before raw legacy store effects", () => {
  const memoryDir = home();
  mkdirSync(join(memoryDir, "sync-placement"), { mode: 0o700 });
  writeFileSync(join(memoryDir, "sync-placement", "active.json"), "invalid fence is also fail closed", { mode: 0o600 });
  const before = tree(memoryDir);
  expect(placementRuntimeRefusal(memoryDir)).toBe(PLACEMENT_MARKER_REFUSAL);
  expect(() => new MemoryStore({ memoryDir })).toThrow(PLACEMENT_MARKER_REFUSAL);
  expect(() => readSelector(memoryDir)).toThrow(PLACEMENT_MARKER_REFUSAL);
  expect(tree(memoryDir)).toEqual(before);
});
