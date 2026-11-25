import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { releasePlacementStorageCaches } from "../src/memory/sync-placement-journal-storage.ts";
import { resolvePlacementWindow } from "../src/memory/sync-placement-checkpoint-storage.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { realPath } from "../src/memory/platform.ts";
import { confirmPlacementCheckpoint, previewPlacementCheckpoint, PlacementCheckpointError, CHECKPOINT_PREVIEW } from "../src/memory/sync-placement-checkpoint-person.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); releasePlacementStorageCaches(); });
async function refusal(work: () => Promise<unknown>): Promise<PlacementCheckpointError> {
  try { await work(); } catch (error) { if (error instanceof PlacementCheckpointError) return error; throw error; }
  throw Error("expected a refusal");
}
function writer(dir: string, version: string): string {
  mkdirSync(join(dir, "src"), { recursive: true, mode: 0o755 }); mkdirSync(join(dir, "bin"), { mode: 0o755 });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@staix/agent-mem", version }), { mode: 0o644 });
  writeFileSync(join(dir, "src", "index.ts"), "// isolated writer\n", { mode: 0o644 });
  writeFileSync(join(dir, "bin", "amem.js"), "// isolated writer\n", { mode: 0o755 });
  return realPath(dir);
}
/** An active placement whose writer inventory was renewed to include a second, separate install. */
async function renewedWithRetired() {
  const f = await placementActivationFixture(); cleanup.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  writeFileSync(join(f.base, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.30.0", since: "2026-11-19" }]) + "\n", { mode: 0o600 });
  const retired = writer(join(f.root, "retired writer"), "0.38.0");
  const both = { writerRoots: [activationOwnRoot, retired], ownRoot: activationOwnRoot };
  expect(await confirmPlacementCheckpoint(f.base, await previewPlacementCheckpoint(f.base, both), both)).toMatchObject({ window: 1, renewed: true });
  expect(readEffectiveSyncPlacementWriters(f.base).roots).toContain(retired);
  return { f, retired, own: { writerRoots: [activationOwnRoot], ownRoot: activationOwnRoot }, both };
}

test("#634 AC1: a renewal drops an inventoried install already removed from disk; preview and confirm both succeed", async () => {
  const { f, retired, own } = await renewedWithRetired();
  rmSync(join(f.root, "retired writer"), { recursive: true });
  const preview = await previewPlacementCheckpoint(f.base, own);
  expect(preview.floorReady).toBe(true);
  expect(await confirmPlacementCheckpoint(f.base, preview, own)).toMatchObject({ window: 2, renewed: true });
  expect(readEffectiveSyncPlacementWriters(f.base).roots).not.toContain(retired);
}, 240_000);

test("#634 AC2: an inventoried install that still exists with an unreadable version keeps refusing as writer-below-floor", async () => {
  const { f, own } = await renewedWithRetired();
  writeFileSync(join(f.root, "retired writer", "package.json"), "{ not json", { mode: 0o644 });
  const preview = await previewPlacementCheckpoint(f.base, own);
  expect((await refusal(() => confirmPlacementCheckpoint(f.base, preview, own))).causeClass).toBe("writer-below-floor");
  expect(resolvePlacementWindow(f.base, readEffectiveSyncPlacementWriters(f.base).epochHash).window).toBe(1);
}, 240_000);

test("#634 AC3: a removed install still passed as --writer-root refuses in preview and confirm with a cause naming it", async () => {
  const { f, retired, own, both } = await renewedWithRetired();
  const saved = await previewPlacementCheckpoint(f.base, own);
  rmSync(join(f.root, "retired writer"), { recursive: true });
  const expected = `The install at ${retired} no longer exists; drop that --writer-root, then save the preview again with (umask 077; set -C; ${CHECKPOINT_PREVIEW} --writer-root <install root> --json > checkpoint-plan.json), repeating --writer-root for every remaining install, and confirm it with ${CHECKPOINT_PREVIEW} --confirm --plan checkpoint-plan.json with the same --writer-root list.`;
  for (const error of [await refusal(() => previewPlacementCheckpoint(f.base, both)), await refusal(() => confirmPlacementCheckpoint(f.base, saved, both))]) {
    expect(error.causeClass).toBe("writer-missing");
    expect(error.message).toBe(expected);
  }
  expect(resolvePlacementWindow(f.base, readEffectiveSyncPlacementWriters(f.base).epochHash).window).toBe(1);
}, 240_000);
