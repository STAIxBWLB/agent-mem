import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBriefCache } from "../src/brief-cache.ts";
import { sessionStartBrief } from "../src/session-brief.ts";
import { curatedProfileBinding } from "../src/memory/curated-cache-state.ts";
import { migrate } from "../src/memory/migrate.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { aliasedKeys, appendAlias, shardDir, shardMachineDir } from "../src/memory/shard.ts";
import { machineId, MemoryStore, openShardStore } from "../src/memory/store.ts";
import { readMetrics } from "../src/memory/metrics.ts";
import { processSignature } from "../src/memory/platform.ts";
import { WorkListStore } from "../src/memory/work-lists.ts";
import { prepareCuratedBriefCache } from "../src/index.ts";

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

test("generation profile changes leave caches missing until explicit off-hook preparation", async () => {
  const f = fixture();
  seed(f.home, f.project, "project", "legacy curated source");
  const legacyBinding = curatedProfileBinding(f.base, f.project);
  expect(f.cache()?.curated?.binding).toBe(legacyBinding);

  await migrate({ memoryDir: f.base, mode: "apply", generation: "a".repeat(32), ...authorized });
  const activeBinding = curatedProfileBinding(f.base, f.project);
  expect(activeBinding).not.toBe(legacyBinding);
  expect(f.cache()).toBeUndefined();
  prepareCuratedBriefCache(f.base, f.project);
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
  expect(f.cache()).toBeUndefined();
  prepareCuratedBriefCache(f.base, f.project);
  expect(f.cache()?.curated?.binding).toBe(deactivatedBinding);
  expect(f.texts()).toEqual(["legacy curated source"]);
});

test("shard migration leaves caches missing until explicit project preparation", async () => {
  const f = fixture();
  seed(f.home, f.project, "project", "legacy project source");
  seed(f.home, f.project, "shared", "legacy shared source");
  const oldBinding = curatedProfileBinding(f.base, f.project);
  expect(f.cache()?.curated?.binding).toBe(oldBinding);

  await migrateShards({ memoryDir: f.base, mode: "apply", ...authorized });
  const selectedBinding = curatedProfileBinding(f.base, f.project);
  expect(selectedBinding).not.toBe(oldBinding);
  expect(f.cache()).toBeUndefined();
  prepareCuratedBriefCache(f.base, f.project);
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
  expect(f.cache()).toBeUndefined();
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
  expect(f.cache()).toBeUndefined();
  expect(sourceSegmentBytes(f.base)).toEqual(sourceBefore);

  prepareCuratedBriefCache(f.base, f.project);
  expect(existsSync(join(f.directory(), "brief-curated.json"))).toBe(true);
  expect(f.texts()).toContain("v1 shared user source");
  expect(sourceSegmentBytes(f.base)).toEqual(sourceBefore);
});

test("writes publish both native caches in an aliased generation without explicit preparation", async () => {
  const f = fixture(), alias = "former-project-key";
  seed(f.home, f.project, "project", "initial generation source");
  await migrateShards({ memoryDir: f.base, mode: "apply", ...authorized });
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "curated", minReader: "0.24.0", since: "fixture" }]));
  appendAlias(f.base, { alias, key: f.project, actor: "person", machine: machineId(f.base).id });
  const aliases = aliasedKeys(f.base, f.project);
  const store = openShardStore({ memoryDir: f.base, project: f.project, reconcile: { canonical: f.project, aliases }, deferPromotions: true });
  try {
    store.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision", peer: "person",
      source: "person", text: "fresh curated marker", about: [] });
  } finally { store.close(); }
  const work = new WorkListStore({ base: f.base, project: alias, aliases, policy: () => true });
  try { await work.write("queue", { task: "fresh work marker", status: "doing" }); }
  finally { work.close(); }

  const result = await sessionStartBrief({ cwd: f.home, base: f.base, project: alias,
    nativeSession: { signature: processSignature(process.pid)! }, timeRemaining: () => 1000 });
  expect(result.coverage).toMatchObject({ curated: "complete", work: "complete" });
  expect(result.context).toContain("fresh curated marker");
  expect(result.context).toContain("fresh work marker");
  expect(result.context).not.toContain("curated cache missing");
  expect(result.context).not.toContain("work cache missing");
});

test("shared mutations rotate the two recovery slots across warm and cold projects", async () => {
  const f = fixture(), extra = Array.from({ length: 5 }, (_, index) => `recovery-project-${index}`);
  for (const project of [f.project, ...extra]) seed(f.home, project, "project", "project note");
  await migrateShards({ memoryDir: f.base, mode: "apply", ...authorized });
  const machine = machineId(f.base).id;
  const binding = (project: string) => ({ directory: shardMachineDir(f.base, project, machine), project, section: "curated" as const });
  for (const project of [f.project, ...extra]) prepareCuratedBriefCache(f.base, project);

  const recovered = new Set<string>();
  for (let iteration = 0; iteration < Math.ceil(extra.length / 2); iteration++) {
    // Repeat with a fresh handle so recovery cannot depend on the writer retaining a cursor.
    const store = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
    try {
      store.note({ op: "note", project: f.project, scope: "shared", tier: "long", kind: "decision", peer: "person",
        source: "person", text: `shared mutation ${iteration}`, about: [] });
    } finally { store.close(); }
    expect(f.cache()).toBeDefined();
    const warm = extra.filter(project => readBriefCache(binding(project)) !== undefined);
    expect(warm).toHaveLength(2);
    for (const project of warm) recovered.add(project);
  }
  expect(recovered.size).toBe(extra.length);
});

test("failed publication records fixed reasons after the source writes commit", async () => {
  const f = fixture();
  seed(f.home, f.project, "project", "initial source");
  await migrateShards({ memoryDir: f.base, mode: "apply", ...authorized });
  // The source shard is writable while the machine-local cache directory is obstructed.
  const directory = f.directory();
  mkdirSync(join(directory, ".."), { recursive: true });
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(directory, "cache obstruction");
  const curated = openShardStore({ memoryDir: f.base, project: f.project, deferPromotions: true });
  const text = "publication private fixture marker";
  try {
    const id = curated.note({ op: "note", project: f.project, scope: "project", tier: "long", kind: "decision",
      peer: "person", source: "person", text, about: [] });
    expect(curated.get(id)?.text).toBe(text);
  } finally { curated.close(); }
  const work = new WorkListStore({ base: f.base, project: f.project, policy: () => true });
  try {
    await work.write("queue", { task: text, status: "doing" });
    expect((await work.read())[0]?.items[0]?.task).toBe(text);
  } finally { work.close(); }

  const samples = () => readMetrics(f.base).filter(sample => sample.kind === "brief-publication");
  const deadline = performance.now() + 1000;
  while (samples().length < 2 && performance.now() < deadline) await Bun.sleep(10);
  expect(samples().map(sample => sample.briefPublication)).toEqual([
    { section: "curated", reason: "write_failed" }, { section: "work", reason: "write_failed" },
  ]);
  expect(JSON.stringify(samples())).not.toContain(text);
  expect(samples().map(sample => Object.keys(sample).sort())).toEqual([
    ["at", "briefPublication", "kind"], ["at", "briefPublication", "kind"],
  ]);
});
