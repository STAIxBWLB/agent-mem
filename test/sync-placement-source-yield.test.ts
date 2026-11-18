import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { legacySnapshotSteps, readLegacySnapshot, type LegacySegment } from "../src/memory/bridge.ts";
import { shardSourceRows, shardSourceRowsAsync, type ShardSyncSourceRows } from "../src/memory/shard-sync.ts";
import { entryId } from "../src/memory/store.ts";
import { drainSteps } from "../src/memory/sync-placement-yield.ts";
import { createPlacementInspectionFixture, inspectionNote, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";
import { appendAuthoredLine, appendedAuthoredLine } from "./fakes/sync-placement-source-change.ts";

/**
 * #462: the placement preflight yields inside its wire round trip, so the collector re-proves the authored metadata it
 * exported. A source that changed during the yield refuses; rows read before it are never returned.
 */
const fixtures: PlacementInspectionFixture[] = [], roots: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function placement(rows = 3): Promise<PlacementInspectionFixture> {
  const fixture = await createPlacementInspectionFixture({ seed(store, project) {
    const ids: Record<string, string> = { first: store.note(inspectionNote("synthetic allowed project original", project)) };
    for (let index = 1; index < rows; index++) ids[`row${index}`] = store.note(inspectionNote(`synthetic source row ${index}`, project));
    return ids;
  } });
  fixtures.push(fixture);
  // One row authored through the shard store, so the realm has a segment of its own to append to.
  fixture.store.note(inspectionNote("synthetic authored segment row", fixture.project));
  return fixture;
}
const realm = (fixture: PlacementInspectionFixture) => ({ scope: "project" as const, key: fixture.project });
const ids = (source: ShardSyncSourceRows) => source.rows.map(row => row.id);

/** A pause that changes the realm once, on the first step after the collector has stamped its sources. */
function mutateOn(change: () => void): { pause: () => Promise<void>; turns: () => number } {
  let turns = 0;
  return { pause: async () => { if (++turns === 2) change(); }, turns: () => turns };
}

test("the async collector returns exactly the rows the synchronous one does", async () => {
  const fixture = await placement(), target = realm(fixture);
  const sync = shardSourceRows(fixture.store, target), yielded = await shardSourceRowsAsync(fixture.store, target);
  expect(ids(yielded)).toEqual(ids(sync)); expect(yielded.rows.length).toBeGreaterThan(0);
  expect(yielded.sources).toEqual(sync.sources); expect(yielded.pending).toEqual(sync.pending);
});

test("an authored row appended during the yield refuses instead of returning the rows read before it", async () => {
  const fixture = await placement(), target = realm(fixture);
  const { pause } = mutateOn(() => appendAuthoredLine(fixture.store.dir));
  await expect(shardSourceRowsAsync(fixture.store, target, pause)).rejects.toThrow("authored segment changed during the preflight round trip");
});

test("a segment created during the yield refuses instead of trusting the listing it read", async () => {
  const fixture = await placement(), target = realm(fixture);
  const { pause } = mutateOn(() => writeFileSync(join(fixture.store.dir, "log", `${"c".repeat(16)}.jsonl`), appendedAuthoredLine(fixture.store.dir)));
  await expect(shardSourceRowsAsync(fixture.store, target, pause)).rejects.toThrow("realm listing changed during the preflight round trip");
});

test("a pending prune claim that appears during the yield refuses instead of exporting the earlier claim set", async () => {
  const fixture = await placement(), target = realm(fixture);
  const { pause } = mutateOn(() => {
    mkdirSync(join(fixture.store.dir, "prune-plans"), { recursive: true });
    writeFileSync(join(fixture.store.dir, "prune-plans", `pending-log-${"d".repeat(16)}.json`), "{\"schema\":\"agent-mem.prune-append/v1\"}\n");
  });
  await expect(shardSourceRowsAsync(fixture.store, target, pause)).rejects.toThrow("pending prune changed during the preflight round trip");
});

test("an unchanged source passes the same re-proof, so the refusal is the change and not the yield", async () => {
  const fixture = await placement(), target = realm(fixture);
  const { pause, turns } = mutateOn(() => {});
  const source = await shardSourceRowsAsync(fixture.store, target, pause);
  expect(turns()).toBeGreaterThan(1); expect(source.rows.length).toBeGreaterThan(0);
});

/** The legacy bridge half: the same segments from the step form, and one yield per segment rather than one per call. */
const other = "2222222222222222";
function legacyHome(): string {
  const root = mkdtempSync(join(tmpdir(), "amem-source-yield-")); roots.push(root);
  for (const path of ["log", "local"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "machine.json"), JSON.stringify({ id: "1".repeat(16), label: "fixture" }) + "\n");
  const body = { schema: "agent-hub.memory/v1" as const, op: "note" as const, at: "2026-10-16T00:00:00.000Z", machine: other, project: "agent-hub", scope: "project" as const,
    tier: "long" as const, kind: "contract" as const, peer: "person", source: "person" as const, text: "legacy contract", about: ["path:src/public.ts"] };
  writeFileSync(join(root, "log", `${other}.jsonl`), JSON.stringify({ ...body, id: entryId(body) }) + "\n");
  return root;
}
const prefixes = (rows: LegacySegment[]) => rows.map(({ source, path, offset, hash, tailBytes }) => ({ source, path, offset, hash, tailBytes }));

test("the step-driven legacy snapshot reads the same segments as the synchronous call", () => {
  const root = legacyHome();
  const sync = readLegacySnapshot(root), stepped = drainSteps(legacySnapshotSteps(root));
  expect(prefixes(stepped)).toEqual(prefixes(sync)); expect(sync.length).toBeGreaterThan(0);
  // The same bytes, proved by the receipt's own prefix hash rather than by re-reading through the reader.
  for (const segment of stepped) expect(createHash("sha256").update(segment.bytes).digest("hex")).toBe(segment.hash);
});

test("the legacy snapshot hands the caller's loop back between its segments", () => {
  const root = legacyHome(), steps = legacySnapshotSteps(root);
  let turns = 0;
  for (let next = steps.next(); !next.done; next = steps.next()) turns++;
  expect(turns).toBeGreaterThanOrEqual(2);
});
