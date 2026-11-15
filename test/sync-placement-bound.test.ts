import { expect, test } from "bun:test";
import { materializePlacementRows, type PlacementMaterializeInput } from "../src/memory/sync-placement-materialize.ts";
import { PLACEMENT_SOURCE_MAX_BYTES, PLACEMENT_SOURCE_MAX_ROWS, PlacementSyncBoundError, placementSyncBoundReceipt } from "../src/memory/sync-placement-bound.ts";
import { PLACEMENT_CAPTURE_MAX_SOURCE_BYTES, PLACEMENT_CAPTURE_MAX_ROWS, PlacementSourceBoundError } from "../src/memory/sync-placement-capture.ts";
import { SyncPlacementJournalError } from "../src/memory/sync-placement-journal-format.ts";

/** Pure materialization input with one user realm; no store, journal or Git. */
function input(rows: { id: string; text: string }[], evaluate: () => void): PlacementMaterializeInput {
  const map = new Map(rows.map(({ id, text }) => [id, { key: { realm: { scope: "user" as const }, id, rowHash: "0".repeat(64) }, row: { op: "note", id, text }, sourcePlacement: "synced" as const, intrinsicLocal: false }]));
  return { capture: { rows: map } as never, projection: { get: () => undefined } as never, generation: "a".repeat(32),
    targets: [{ realm: { scope: "user" }, generation: "a".repeat(32), fetched: new Set(), localPrunes: new Map(), pruned: new Set() }], old: [undefined],
    verifiedPrunes: new Set(), evaluate: () => { evaluate(); return { ok: true }; }, readTree: async () => "", publisherLineages: () => new Map(), createdUnixSeconds: 0 };
}
async function refusal(rows: { id: string; text: string }[]) {
  let evaluations = 0, error: unknown;
  try { await materializePlacementRows(input(rows, () => { evaluations++; })); } catch (caught) { error = caught; }
  return { evaluations, error };
}

test("#419: activation capture, publication sources and materialization share one documented source envelope", () => {
  expect(PLACEMENT_CAPTURE_MAX_SOURCE_BYTES).toBe(PLACEMENT_SOURCE_MAX_BYTES); expect(PLACEMENT_CAPTURE_MAX_ROWS).toBe(PLACEMENT_SOURCE_MAX_ROWS);
  expect(PLACEMENT_SOURCE_MAX_BYTES).toBe(64 * 1024 * 1024); expect(PLACEMENT_SOURCE_MAX_ROWS).toBe(20000);
});

test("#419: a source set above the row bound refuses before the first policy evaluation", async () => {
  const rows = Array.from({ length: PLACEMENT_SOURCE_MAX_ROWS + 1 }, (_, index) => ({ id: index.toString(16).padStart(32, "0"), text: "r" }));
  const { evaluations, error } = await refusal(rows);
  expect(evaluations).toBe(0); expect(error).toBeInstanceOf(PlacementSyncBoundError);
  expect(placementSyncBoundReceipt(error)).toEqual({ phase: "materialization", kind: "source-rows", limit: 20000, observed: 20001 });
});

test("#419: many individually small rows whose aggregate exceeds 64 MiB refuse before the first policy evaluation", async () => {
  const text = "b".repeat(1_700_000), rows = Array.from({ length: 40 }, (_, index) => ({ id: index.toString(16).padStart(32, "0"), text }));
  const { evaluations, error } = await refusal(rows);
  expect(evaluations).toBe(0);
  const bound = placementSyncBoundReceipt(error)!; expect(bound).toMatchObject({ phase: "materialization", kind: "source-bytes", limit: PLACEMENT_SOURCE_MAX_BYTES });
  expect(bound.observed).toBeGreaterThan(PLACEMENT_SOURCE_MAX_BYTES);
  expect((error as Error).message).not.toContain("bbbb"); expect((error as Error).message).toContain("No source, selector, epoch, journal or remote ref was changed");
});

test("#419: receipts admit only allowlisted numeric bound fields; capture bounds keep their phase", () => {
  expect(placementSyncBoundReceipt(new SyncPlacementJournalError("bound"))).toBeUndefined();
  expect(placementSyncBoundReceipt(new Error("bound"))).toBeUndefined();
  const forged = Object.assign(new SyncPlacementJournalError("bound"), { bound: { phase: "materialization", kind: "source-bytes\u001b[2J", limit: 1, observed: 2 } });
  expect(placementSyncBoundReceipt(forged)).toBeUndefined();
  expect(placementSyncBoundReceipt(new PlacementSourceBoundError({ kind: "bytes", limit: 1, observed: 2 }))).toEqual({ phase: "source-capture", kind: "bytes", limit: 1, observed: 2 });
});
