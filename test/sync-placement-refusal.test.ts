import { expect, test } from "bun:test";
import { PLACEMENT_REFUSAL_CATEGORIES, PlacementSyncRefusal, placementRefusalCategoryOf, placementRefusalMessage, placementRefusalNextStep } from "../src/memory/sync-placement-refusal.ts";

test("#426: every category names its phase and one next step, and only other keeps the generic wording", () => {
  const steps = new Set<string>();
  for (const category of PLACEMENT_REFUSAL_CATEGORIES) {
    const message = placementRefusalMessage(category, "source-capture");
    expect(message).toContain(`category ${category}, phase source capture`); expect(message).toContain(placementRefusalNextStep(category));
    expect(message.includes("verify the active epoch, selected sources")).toBe(category === "other");
    steps.add(placementRefusalNextStep(category));
  }
  expect(steps.size).toBe(PLACEMENT_REFUSAL_CATEGORIES.length);
});
test("#426: only a real refusal's own allowlisted category is read; forged or unknown values fall back", () => {
  for (const category of PLACEMENT_REFUSAL_CATEGORIES) expect(placementRefusalCategoryOf(new PlacementSyncRefusal(category))).toBe(category);
  expect(placementRefusalCategoryOf(new PlacementSyncRefusal("nope" as never))).toBe("other");
  expect(placementRefusalCategoryOf(Object.assign(new Error("x"), { category: "remote" }))).toBeUndefined();
  expect(placementRefusalCategoryOf(new Proxy(new PlacementSyncRefusal("lock"), {}))).toBeUndefined();
  expect(new PlacementSyncRefusal("epoch").message).toBe("placement sync unavailable");
});
test("#426: foreign errors map by class and allowlisted code only, never by message text", async () => {
  const { classifyPlacementError } = await import("../src/memory/sync-placement-transport.ts");
  const { SyncPlacementJournalError } = await import("../src/memory/sync-placement-journal-format.ts");
  const { SharedWriterRevisionError } = await import("../src/memory/sync-placement-writer-revision-format.ts");
  const { ShardSourceChangedError } = await import("../src/memory/shard-sync.ts");
  expect(classifyPlacementError(new SyncPlacementJournalError("bound"))).toBe("size-bound");
  expect(classifyPlacementError(new SyncPlacementJournalError("changed"))).toBe("source-selection");
  expect(classifyPlacementError(new SyncPlacementJournalError("invalid"))).toBe("epoch");
  expect(classifyPlacementError(new SharedWriterRevisionError("changed"))).toBe("writer-pin");
  // #462: a collector that found its authored source changed under its own yield names that cause, by class.
  expect(classifyPlacementError(new ShardSourceChangedError("authored segment changed during the preflight round trip"))).toBe("source-selection");
  expect(classifyPlacementError(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe("lock");
  expect(classifyPlacementError(new Error("remote epoch policy lock writer"))).toBeUndefined();
});


test("writer-pin remedy keeps the preview and exact-command approval without actor gating", () => {
  const text = placementRefusalNextStep("writer-pin");
  expect(text).toContain("amem migrate --sync-placement --dry-run --writer-root <install root>");
  expect(text).toContain("exact command is approved"); expect(text).not.toMatch(/have the person/i);
});
