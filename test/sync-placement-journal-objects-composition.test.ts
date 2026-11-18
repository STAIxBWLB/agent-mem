import { afterEach, expect, test } from "bun:test";
import { placementJournalObjectComposition, placementJournalObjectCompositionText, type PlacementJournalObjectComposition } from "../src/memory/sync-placement-journal-storage.ts";
import { PlacementSyncBoundError, placementSyncBoundReceipt } from "../src/memory/sync-placement-bound.ts";
import { activateSyncPlacement } from "../src/memory/sync-placement-activation.ts";
import { renewSyncPlacementWriters } from "../src/memory/sync-placement-writer-renewal.ts";
import { publicationFileNames, type PlacementPublicationRoot } from "../src/memory/sync-placement-publication-plan.ts";
import { activationOwnRoot, placementActivationFixture } from "./fakes/sync-placement-activation.ts";

const clean:(()=>void)[]=[];
afterEach(()=>{for(const close of clean.splice(0).reverse())close();});

const sum = (composition:PlacementJournalObjectComposition) => composition.epochFixed + composition.writerHistory + composition.journalChunks
  + composition.completedPublications.objects + (composition.newPlan ? composition.newPlan.slots + composition.newPlan.reservedJournalChunks : 0);
const hex = (value:number) => value.toString(16).padStart(64, "0");
const publication = (attempt:string) => [`publication-${attempt}-root.json`, `publication-${attempt}-chunk-00000.json`, `publication-${attempt}-artifact.json`,
  `publication-${attempt}-intent.json`, `publication-${attempt}-receipt.json`];
/** Only `seal` and `chunks` are read by the composition; a real bundle is pinned by the preview arm below. */
const plan = (chunks:number) => ({ seal: hex(255), chunks: Array.from({ length: chunks }, (_, index) => ({ index })) }) as unknown as PlacementPublicationRoot;

test("#288: the composition's parts sum to the counted total on a name set over 256 objects", () => {
  // 3 fixed (2 present + the always-reserved active.json slot) + 41 writer history + 150 journal chunks
  // + 20 completed publications of 5 objects + the plan's 6 slots and 2 reserved journal chunks = 302 objects.
  const names = ["epoch.json", "activation.json",
    "writer-revisions.jsonl", ...Array.from({ length: 40 }, (_, index) => `writer-revision-${String(index + 1).padStart(5, "0")}.json`),
    ...Array.from({ length: 150 }, (_, index) => `records-${String(index).padStart(5, "0")}.jsonl`),
    ...Array.from({ length: 20 }, (_, index) => publication(hex(index))).flat()];
  const root = plan(2), reserved = ["records-00199.jsonl", "append-intent.json"];
  // Exactly the expression `assertPlanCapacity` counts: the epoch's names, this plan's files and its reserved chunks.
  const planned = publicationFileNames(root);
  const counted = new Set([...names, ...planned, ...reserved]).size + 1;
  expect(counted).toBeGreaterThan(256);
  const composition = placementJournalObjectComposition({ names, plan: { root, reserved } });
  expect(composition).toEqual({ epochFixed: 3, writerHistory: 41, journalChunks: 150, completedPublications: { count: 20, objects: 100 },
    newPlan: { chunks: 2, slots: 6, reservedJournalChunks: 2 } });
  expect(sum(composition)).toBe(counted);
  // The refusal's own clause reports the same total it is about to refuse.
  expect(placementJournalObjectCompositionText(composition)).toContain(`Objects by holder (${counted}):`);
  expect(placementJournalObjectCompositionText(composition)).toContain("completed publications 20 (100 objects), new plan 2 chunks/6 slots/2 reserved journal chunks");
});

test("#288: a real home's preview reports the composition the journal counts, with no plan yet", async () => {
  const f = await placementActivationFixture();clean.push(f.close);
  await activateSyncPlacement(f.options("apply"));
  const preview = await renewSyncPlacementWriters(f.options("dry-run")) as { objectSlotsRemaining?: number; journalObjects?: PlacementJournalObjectComposition };
  const composition = preview.journalObjects!;
  expect(composition.newPlan).toBeNull();
  expect(composition.epochFixed).toBeGreaterThanOrEqual(1);
  // Two independent reads of the same home agree: the journal snapshot's own count and the name classification.
  expect(sum(composition)).toBe(256 - preview.objectSlotsRemaining!);
  expect(composition.completedPublications).toEqual({ count: 0, objects: 0 });
});

test("#288: the refusal's composition clause stays out of the bound receipt", () => {
  const bound = { phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 312 } as const;
  const error = new PlacementSyncBoundError(bound, placementJournalObjectCompositionText(placementJournalObjectComposition({ names: ["epoch.json"] })));
  expect(error.message).toStartWith("Placement sync refused before any publication attempt: publication planning exceeds its supported journal-objects bound (observed 312, limit 256).");
  expect(error.message).toContain("Objects by holder (2): epoch fixed 2");
  // The receipt is still exactly the allowlisted four fields, so no caller learns a composition it did not ask for.
  expect(placementSyncBoundReceipt(error)).toEqual(bound);
});
