import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { previewSyncPlacementSources } from "../src/memory/sync-placement-capture.ts";
import { createPlacementInspectionFixture, inspectionFilesystemSnapshot, inspectionNote, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const fixtures: PlacementInspectionFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0).reverse()) fixture.close(); });

test("authority-free v2 preview shares source capture without writer or quiescence claims or effects", async () => {
  let previewed = false;
  const f = await createPlacementInspectionFixture({ prepared(home) {
    const before = inspectionFilesystemSnapshot(home), preview = previewSyncPlacementSources(home);
    expect(preview.base).not.toHaveProperty("writers"); expect(preview.base).not.toHaveProperty("legacySyncQuiesced");
    expect(preview.activeHead).toBeUndefined(); expect(preview.rows.size).toBe(3);
    preview.assertSourcesUnchanged(); expect(inspectionFilesystemSnapshot(home)).toEqual(before);
    previewed = true;
  } }); fixtures.push(f);
  expect(previewed).toBe(true);
  const before = f.snapshot(), preview = previewSyncPlacementSources(f.home), captured = f.capture();
  expect(preview.base.sourceHash).toBe(captured.context.sourceHash);
  expect([...preview.rows.keys()]).toEqual([...captured.rows.keys()]);
  expect(preview.activeHead).toBe(f.epochHash); expect(f.snapshot()).toEqual(before);
  f.store.note(inspectionNote("new source after isolated preview", f.project));
  expect(() => preview.assertSourcesUnchanged()).toThrow();
});

test("authority-free preview refuses a profile lock without taking ownership or modifying it", async () => {
  const f = await createPlacementInspectionFixture(); fixtures.push(f);
  writeFileSync(join(f.home, "profile.lock"), '{"synthetic":"owner"}', { mode: 0o600 });
  const before = f.snapshot(); expect(() => previewSyncPlacementSources(f.home)).toThrow();
  expect(f.snapshot()).toEqual(before);
});
