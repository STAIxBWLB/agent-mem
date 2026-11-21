import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The fixture is imported before the capture module so the journal error base class initializes first.
import { createPlacementInspectionFixture, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";
import { PlacementSourceBoundError, previewSelectedSyncPlacementSources, previewSyncPlacementSources } from "../src/memory/sync-placement-capture.ts";
import { shardKeyHash } from "../src/memory/shard.ts";

const fixtures: PlacementInspectionFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0).reverse()) fixture.close(); });

/** Clones the fixture's activated project realm under new keys, then adds project.json-only scaffolds. */
function grow(home: string, realms: number, scaffolds: number): void {
  const projects = join(home, "projects"), source = readdirSync(projects)[0]!;
  const rekey = (dir: string, key: string) => {
    const descriptor = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    writeFileSync(join(dir, "project.json"), JSON.stringify({ ...descriptor, key }), { mode: 0o600 });
  };
  for (let i = 0; i < realms; i++) {
    const key = `example.test/placement/bound/realm-${i}`, dir = join(projects, shardKeyHash(key));
    cpSync(join(projects, source), dir, { recursive: true }); rekey(dir, key);
  }
  const descriptor = readFileSync(join(projects, source, "project.json"), "utf8");
  for (let i = 0; i < scaffolds; i++) {
    const key = `example.test/placement/bound/scaffold-${i}`, dir = join(projects, shardKeyHash(key));
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, "project.json"), descriptor, { mode: 0o600 }); rekey(dir, key);
  }
}

test("#550: a home past 256 metadata objects captures when each scope stays within its bound", async () => {
  const f = await createPlacementInspectionFixture(); fixtures.push(f);
  // 31 activated project realms (8 or 9 objects each), 62 scaffolds (1 each), the user realm and the home markers.
  grow(f.home, 30, 62);
  const preview = previewSyncPlacementSources(f.home), captured = f.capture();
  expect(preview.base.realms.length).toBe(32);
  expect(preview.base.sourceHash).toBe(captured.context.sourceHash);
  expect([...preview.rows.keys()]).toEqual([...captured.rows.keys()]);
  preview.assertSourcesUnchanged();
});

test("#550: per-scope attribution leaves the sealed source hash of a small home unchanged", async () => {
  const f = await createPlacementInspectionFixture(); fixtures.push(f);
  const first = previewSyncPlacementSources(f.home).base.sourceHash;
  expect(previewSyncPlacementSources(f.home).base.sourceHash).toBe(first);
  expect(f.capture().context.sourceHash).toBe(first);
});

test("#550: a projects directory past its listing bound refuses with the typed source-files next step", async () => {
  const f = await createPlacementInspectionFixture(); fixtures.push(f);
  grow(f.home, 0, 256);
  const before = f.snapshot();
  let error: unknown; try { previewSyncPlacementSources(f.home); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(PlacementSourceBoundError);
  expect((error as PlacementSourceBoundError).bound).toEqual({ kind: "source-files", limit: 256, observed: 257 });
  expect((error as Error).message).toContain("retain the inputs and report this bound");
  expect((error as Error).message).toContain("at most 16 metadata objects");
  expect(f.snapshot()).toEqual(before);
});

test("#550: a selection past 256 realms keeps its separate source-files refusal", async () => {
  const f = await createPlacementInspectionFixture(); fixtures.push(f);
  const selected = Array.from({ length: 257 }, (_, i) => ({ scope: "project" as const, keyHash: i.toString(16).padStart(64, "0") }));
  expect(() => previewSelectedSyncPlacementSources(f.home, selected)).toThrow(PlacementSourceBoundError);
});
