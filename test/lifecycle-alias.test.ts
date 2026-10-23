import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore, captureShardStats } from "../src/memory/capture.ts";
import { appendAlias, appendUnalias, shardDir, shardMachineDir } from "../src/memory/shard.ts";
import { appendLifecycle, lifecycleResolver, projectState } from "../src/memory/lifecycle.ts";
import { searchAllProjects } from "../src/memory/cross-project.ts";
import { planGc, runGc } from "../src/memory/gc.ts";
import { scanCatalog } from "../src/memory/catalog.ts";
import { capacityReport } from "../src/memory/capacity.ts";
import { machineId, openShardStore } from "../src/memory/store.ts";

// #15 T5 review (alias-bypasses-lifecycle): lifecycle ops are recorded on the canonical key, but a shard can exist under an alias of it (captured before
// the alias was added). Every walk resolves through the alias table, and an alias op cannot undo a forget.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const NOW = Date.parse("2026-10-23T00:00:00.000Z"), DAY = 24 * 3600_000;
const A = "github.com/o/a", OLD = "old-a";
function world() {
  const dir = mkdtempSync(join(tmpdir(), "amem-alias-life-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, "memory");
  for (const project of [A, OLD]) {
    const store = new CaptureStore({ home: dir, project, now: () => NOW, retentionDays: 100_000, capMb: 100_000 });
    for (let i = 0; i < 3; i++) store.append({ project, agent: "kimi", event: "PostToolUse", excerpt: `needle in ${project} ${i} ${"x".repeat(100)}`, at: new Date(NOW - (200 + i) * DAY).toISOString() });
    store.close();
  }
  const person = (op: "archive" | "unarchive" | "forget", key: string) => appendLifecycle(base, { op, key, actor: "person", machine: "m1" });
  const alias = () => appendAlias(base, { alias: OLD, key: A, actor: "person", machine: "m1" });
  const rows = (key: string) => captureShardStats(shardMachineDir(base, key, machineId(base).id)).rows;
  return { dir, base, person, alias, rows };
}

test("an alias of an archived project is archived: the resolver, search, the catalog and the split all see it", () => {
  const w = world(); w.alias(); w.person("archive", A);
  expect(projectState(w.base, OLD)).toBe("archived"); expect(lifecycleResolver(w.base)(OLD)).toBe("archived");
  const found = searchAllProjects(w.base, "needle");
  expect(found.projects).toEqual([]);                                              // neither the canonical shard nor the alias shard is read
  expect(searchAllProjects(w.base, "needle", { includeArchived: true }).projects.sort()).toEqual([A, OLD].sort());
  expect(scanCatalog(w.base).map(p => [p.key, p.state]).sort()).toEqual([[A, "archived"], [OLD, "archived"]]);
});

test("an alias of a forgotten project is forgotten: search never reads it, gc never opens either shard, and the split and capacity leave it out", () => {
  const w = world(); w.alias(); w.person("forget", A);
  expect(searchAllProjects(w.base, "needle", { includeArchived: true }).projects).toEqual([]);
  expect(planGc(w.base, { now: () => NOW })).toEqual([]);
  const result = runGc(w.base, { now: () => NOW });
  expect(result.shards).toEqual([]);
  expect(result.skipped.map(s => s.key).sort()).toEqual([A, OLD].sort());
  expect([w.rows(A), w.rows(OLD)]).toEqual([3, 3]);                              // nothing evicted: the forgotten shards were not opened for writing
  const report = capacityReport({ memoryDir: w.base, now: () => NOW, inject: { disk: { freeBytes: 1e12, totalBytes: 2e12 }, memoryPressure: null, metrics: [] } });
  expect((report.split ?? []).map(row => row.key)).toEqual([]);
});

test("a key forgotten before it became an alias stays forgotten: a later alias line cannot erase its own op", () => {
  const w = world(); w.person("forget", OLD);
  expect(() => w.alias()).toThrow(/forgotten/);                                   // refused outright (b), and the resolver agrees either way
  expect(projectState(w.base, OLD)).toBe("forgotten");
});

test("alias add is refused to or from a forgotten key, with nothing written; unaliasing a live alias still works", () => {
  const w = world();
  w.person("forget", A);
  expect(() => w.alias()).toThrow(/forgotten/);                                   // alias OLD -> forgotten A would bring A back under OLD
  expect(() => appendAlias(w.base, { alias: A, key: OLD, actor: "person", machine: "m1" })).toThrow(/forgotten/);
  expect(projectState(w.base, OLD)).toBe("active");

  const live = world();
  live.alias(); appendUnalias(live.base, { alias: OLD, actor: "person", machine: "m1" });
  expect(projectState(live.base, OLD)).toBe("active");
});

test("an unaliased key is its own state again, so removing the alias returns the old shard to its own lifecycle", () => {
  const w = world(); w.alias(); w.person("archive", A);
  appendUnalias(w.base, { alias: OLD, actor: "person", machine: "m1" });
  expect(projectState(w.base, OLD)).toBe("active"); expect(projectState(w.base, A)).toBe("archived");
});

// #15 T5 review (hub-recall-not-gated): agent-hub opens curated stores directly with openShardStore, so the gate sits at the open, not in each caller.
test("openShardStore refuses an archived or forgotten project, and an alias of one, and creates nothing for a project it refuses", () => {
  const w = world();
  w.alias(); w.person("archive", A);
  for (const key of [A, OLD]) expect(() => openShardStore({ memoryDir: w.base, project: key })).toThrow(/archived/);
  w.person("unarchive", A); w.person("forget", A);
  for (const key of [A, OLD]) expect(() => openShardStore({ memoryDir: w.base, project: key })).toThrow(/forgotten/);
});

test("the gate refuses before the shard is initialized and lifecycle ignore passes the gate (catalog, export, --include-archived)", () => {
  const dir = mkdtempSync(join(tmpdir(), "amem-open-gate-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, "memory"), key = "github.com/o/fresh";
  const store = new CaptureStore({ home: dir, project: key }); store.close();      // a capture-only shard: no generation.json yet
  appendLifecycle(base, { op: "archive", key, actor: "person", machine: "m1" });
  expect(() => openShardStore({ memoryDir: base, project: key })).toThrow(/archived/);
  expect(existsSync(join(shardDir(base, key), "generation.json"))).toBe(false);   // refused before initializeShard wrote anything
  // lifecycle "ignore" passes the gate: this unsplit home then fails on the missing migration, which is not the lifecycle refusal
  expect(() => openShardStore({ memoryDir: base, project: key, lifecycle: "ignore" })).toThrow(/no active curated shard migration/);
});
