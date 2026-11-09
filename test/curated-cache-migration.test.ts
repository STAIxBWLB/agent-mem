import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBriefCache } from "../src/brief-cache.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { curatedProfileBinding } from "../src/memory/curated-cache-state.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { shardDir, shardMachineDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore, openShardStore } from "../src/memory/store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amem-curated-migration-")); roots.push(home);
  const base = join(home, "memory"), project = "github.com/example/cache-migration";
  const directory = () => shardMachineDir(base, project, machineId(base).id);
  const cache = () => readBriefCache({ directory: directory(), project, section: "curated" });
  const texts = () => cache()?.rows.map(row => (row.data as { text: string }).text) ?? [];
  return { home, base, project, directory, cache, texts };
}

function seed(home: string, project: string, scope: "project" | "shared", text: string): void {
  const store = new MemoryStore({ home, deferPromotions: true, profile: "shared-v1" });
  try {
    store.note({ op: "note", project, scope, tier: "long", kind: "decision", peer: "fixture", source: "person", text, about: [] });
  } finally { store.close(); }
}

function sourceSegmentBytes(base: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const folder of ["log", "local"]) for (const name of readdirSync(join(base, folder)).filter(name => name.endsWith(".jsonl")).sort()) {
    result[`${folder}/${name}`] = readFileSync(join(base, folder, name), "utf8");
  }
  return result;
}

const authorized = { authorizedPerson: true, tty: true } as const;

test("generation activation and deactivation invalidate then rebuild the selected curated cache", async () => {
  const f = fixture();
  seed(f.home, f.project, "project", "legacy curated source");
  const legacyBinding = curatedProfileBinding(f.base, f.project);
  expect(f.cache()?.curated?.binding).toBe(legacyBinding);

  await migrate({ memoryDir: f.base, mode: "apply", generation: "a".repeat(32), ...authorized });
  const activeBinding = curatedProfileBinding(f.base, f.project);
  expect(activeBinding).not.toBe(legacyBinding);
  expect(existsSync(join(f.directory(), "brief-curated.json"))).toBe(true);
  expect(f.cache()?.curated?.binding).toBe(activeBinding);
  expect(f.texts()).toContain("legacy curated source");

  const generation = new MemoryStore({ home: f.home, deferPromotions: true });
  try {
    generation.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "selected generation write", about: [] });
  } finally { generation.close(); }
  expect(f.cache()?.curated?.binding).toBe(activeBinding);
  expect(f.texts()).toEqual(expect.arrayContaining(["legacy curated source", "selected generation write"]));

  await migrate({ memoryDir: f.base, mode: "deactivate", ...authorized });
  const deactivatedBinding = curatedProfileBinding(f.base, f.project);
  expect(deactivatedBinding).not.toBe(activeBinding);
  expect(f.cache()?.curated?.binding).toBe(deactivatedBinding);
  expect(f.texts()).toEqual(["legacy curated source"]);
});

test("shard migration rebuilds the cache from active project data including shared user data", async () => {
  const f = fixture();
  seed(f.home, f.project, "project", "legacy project source");
  seed(f.home, f.project, "shared", "legacy shared source");
  const oldBinding = curatedProfileBinding(f.base, f.project);
  expect(f.cache()?.curated?.binding).toBe(oldBinding);

  await migrateShards({ memoryDir: f.base, mode: "apply", ...authorized });
  const selectedBinding = curatedProfileBinding(f.base, f.project);
  expect(selectedBinding).not.toBe(oldBinding);
  expect(existsSync(join(f.directory(), "brief-curated.json"))).toBe(true);
  expect(f.cache()?.curated?.binding).toBe(selectedBinding);
  expect(f.texts()).toEqual(expect.arrayContaining(["legacy project source", "legacy shared source"]));
});

test("shared user writes cannot create a missing project generation or cache after sharding", async () => {
  const f = fixture(), legacy = new MemoryStore({ home: f.home, profile: "shared-v1", deferPromotions: true });
  const base = legacy.dir; legacy.close();
  const sourceBefore = sourceSegmentBytes(base), projectDirectory = shardDir(base, f.project);
  await migrateShards({ memoryDir: base, mode: "apply", ...authorized });
  expect(existsSync(join(projectDirectory, "generation.json"))).toBe(false);

  const user = openShardStore({ memoryDir: base, user: true, deferPromotions: true });
  try {
    user.note({ op: "note", project: f.project, scope: "shared", tier: "long", kind: "decision", peer: "fixture", source: "person", text: "user row for missing project", about: [] });
  } finally { user.close(); }

  expect(existsSync(join(projectDirectory, "generation.json"))).toBe(false);
  expect(f.cache()).toBeUndefined();
  expect(sourceSegmentBytes(base)).toEqual(sourceBefore);

  // A normal off-hook read can initialize this v1 project through the existing source API.
  const brief = await sessionStartBrief({ cwd: f.home, base, project: f.project, repository: false });
  expect(brief.coverage.curated).toBe("complete");
  expect(existsSync(join(projectDirectory, "generation.json"))).toBe(true);
  expect(f.texts()).toContain("user row for missing project");
  expect(sourceSegmentBytes(base)).toEqual(sourceBefore);
});

test("ordinary library brief may initialize a v1 project cache and include shared user rows", async () => {
  const f = fixture();
  seed(f.home, f.project, "shared", "v1 shared user source");
  const sourceBefore = sourceSegmentBytes(f.base), projectDirectory = shardDir(f.base, f.project);
  expect(f.cache()).toBeDefined();
  expect(existsSync(join(projectDirectory, "generation.json"))).toBe(false);
  rmSync(projectDirectory, { recursive: true, force: true });
  expect(sourceSegmentBytes(f.base)).toEqual(sourceBefore);

  const brief = await sessionStartBrief({ cwd: f.home, base: f.base, project: f.project, repository: false });
  expect(brief.coverage.curated).toBe("complete");
  expect(existsSync(join(projectDirectory, "project.json"))).toBe(true);
  expect(existsSync(join(f.directory(), "brief-curated.json"))).toBe(true);
  expect(f.texts()).toContain("v1 shared user source");
  expect(sourceSegmentBytes(f.base)).toEqual(sourceBefore);
});
