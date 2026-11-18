import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { readCatalogFresh } from "../src/memory/catalog.ts";
import { withBriefSnapshot } from "../src/memory/doctor.ts";
import { ensureShardDescriptor, shardDir } from "../src/memory/shard.ts";
import { applyRealmAdmission } from "../src/memory/sync-placement-realm-admission.ts";
import { openShardStore } from "../src/memory/store.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { plugin } from "../src/ui/plugin.ts";
import { closeInventoryFixtures, installSyntheticRealm, inventoryFixture } from "./fakes/sync-placement-inventory.ts";
import { inspectionFilesystemSnapshot } from "./fakes/sync-placement-inspection.ts";

afterEach(closeInventoryFixtures);

test("legacy captured catalog keeps its diagnostic path when the profile is malformed", () => {
  const home = mkdtempSync(join(tmpdir(), "amem-catalog-legacy-"));
  try {
    writeFileSync(join(home, "profile.json"), "invalid json");
    writeFileSync(join(home, "shards.json"), JSON.stringify({ schema: "agent-mem.shards/v1", generation: "a".repeat(32), phase: "captured", selectorRevision: "legacy" }));
    expect(readCatalogFresh(home)).toEqual([]);
    writeFileSync(join(home, "shards.json"), JSON.stringify({ schema: "unknown" }));
    expect(() => readCatalogFresh(home)).toThrow("curated shard selection is unavailable or invalid");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("active placement catalog and Recap include an admitted realm without changing the source for its private snapshot", async () => {
  const initial = "example.test/catalog/initial", admitted = "example.test/catalog/admitted", captureOnly = "example.test/catalog/capture";
  const f = await inventoryFixture(1, [initial], true);
  expect(await applyRealmAdmission(f.home, admitted, { mode: "apply" })).toMatchObject({ state: "admitted" });
  const writer = openShardStore({ memoryDir: f.home, project: admitted, deferPromotions: true });
  try { writer.note({ op: "note", project: admitted, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "admitted recap evidence", about: [] }); }
  finally { writer.close(); }
  ensureShardDescriptor(f.home, captureOnly);
  const rows = readCatalogFresh(f.home);
  expect(rows.map(row => row.key)).toEqual([admitted, captureOnly, initial].sort());
  expect(rows.find(row => row.key === captureOnly)?.curatedEntries).toBe(0);
  expect(existsSync(join(shardDir(f.home, captureOnly), "generation.json"))).toBe(false);
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.home;
  try {
    const marked = JSON.parse(await runCli(["projects", "--json"], { cwd: f.root, env: { AGENTHUB_PEER_ID: "test" } }));
    expect(marked.map((row: { key: string }) => row.key)).toContain(admitted);
    const before = inspectionFilesystemSnapshot(f.home);
    const brief = await withBriefSnapshot(f.home, admitted, measureOnly => sessionStartBrief({ cwd: f.root, base: f.home, project: admitted, repository: false, measureOnly }));
    expect(JSON.stringify(brief)).toContain("admitted recap evidence");
    expect(inspectionFilesystemSnapshot(f.home)).toEqual(before);
    const messages: string[] = [], provider = await plugin.open({ home: f.root, log: line => messages.push(line) });
    try {
      const recap = await provider.snapshot({ panel: "recap", after: 0, project: admitted });
      expect(JSON.stringify(recap)).toContain("admitted recap evidence");
      expect(messages.some(line => line.includes("project catalog unavailable"))).toBe(false);
    } finally { await provider.close(); }
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}, 120_000);

test("damaged placement activation refuses the catalog and Recap without modifying the damaged home", async () => {
  const project = "example.test/catalog/damaged", f = await inventoryFixture(1, [project], true);
  rmSync(join(f.home, "sync-placement", "active.json"));
  const before = inspectionFilesystemSnapshot(f.home);
  expect(() => readCatalogFresh(f.home)).toThrow();
  await expect(withBriefSnapshot(f.home, project, async () => null)).rejects.toThrow();
  expect(inspectionFilesystemSnapshot(f.home)).toEqual(before);
}, 120_000);

test("either v3 marker activates the narrow selector check without permitting a mixed pair", async () => {
  const project = "example.test/catalog/marker", f = await inventoryFixture(1, [project], true);
  const profileFile = join(f.home, "profile.json"), shardsFile = join(f.home, "shards.json");
  const profile = readFileSync(profileFile), shards = readFileSync(shardsFile);
  for (const side of ["profile", "shards"] as const) {
    const file = side === "profile" ? profileFile : shardsFile, original = side === "profile" ? profile : shards;
    const value = JSON.parse(original.toString()); value.schema = side === "profile" ? "agent-mem.profile/v2" : "agent-mem.shards/v2";
    writeFileSync(file, JSON.stringify(value) + "\n");
    const before = inspectionFilesystemSnapshot(f.home);
    expect(() => readCatalogFresh(f.home)).toThrow();
    expect(inspectionFilesystemSnapshot(f.home)).toEqual(before);
    writeFileSync(file, original);
  }
  writeFileSync(shardsFile, "invalid json");
  const before = inspectionFilesystemSnapshot(f.home);
  expect(() => readCatalogFresh(f.home)).toThrow("sync placement metadata is invalid");
  expect(inspectionFilesystemSnapshot(f.home)).toEqual(before);
}, 120_000);

test("catalog never uses its narrow selector probe to open an unadmitted curated shard", async () => {
  const initial = "example.test/catalog/inside", outside = "example.test/catalog/outside", f = await inventoryFixture(1, [initial], true);
  const generation = JSON.parse(readFileSync(join(f.home, "profile.json"), "utf8")).generation;
  installSyntheticRealm(f.home, generation, outside);
  const dir = shardDir(f.home, outside), before = inspectionFilesystemSnapshot(dir);
  expect(() => readCatalogFresh(f.home)).toThrow("admit");
  expect(inspectionFilesystemSnapshot(dir)).toEqual(before);
}, 120_000);
