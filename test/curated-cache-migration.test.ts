import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBriefCache } from "../src/brief-cache.ts";
import { curatedProfileBinding } from "../src/memory/curated-cache-state.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { shardMachineDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore } from "../src/memory/store.ts";

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
