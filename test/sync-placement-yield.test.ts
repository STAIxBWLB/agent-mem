import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { entryId } from "../src/memory/store.ts";
import { syncMemory, SYNC_FAILURE_CAUSES } from "../src/memory/sync.ts";
import { syncPlacementMemory } from "../src/memory/sync-placement-transport.ts";
import { PlacementSyncBoundError } from "../src/memory/sync-placement-bound.ts";
import { placementJournalObjectComposition, placementJournalObjectCompositionText } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_JOURNAL_CHUNK_MAX_BYTES } from "../src/memory/sync-placement-journal-format.ts";
import { PLACEMENT_PUBLICATION_CHUNK_SCHEMA, planPlacementPublication, planPlacementPublicationAsync, publicationBytes, validatePlacementPublicationChunk, type PlacementPublicationChunk } from "../src/memory/sync-placement-publication-plan.ts";
import { cooperativeYield, drainSteps, drainStepsAsync, PLACEMENT_SLICE_MS } from "../src/memory/sync-placement-yield.ts";
import { captureSyncPlacementContext, captureSyncPlacementContextAsync } from "../src/memory/sync-placement-capture.ts";
import { createPlacementInspectionFixture, inspectionNote, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const homes: PlacementInspectionFixture[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); });

test("#462: a cooperative yield point is free inside its slice and one macrotask turn after it", async () => {
  let now = 0, turns = 0; const pause = cooperativeYield(PLACEMENT_SLICE_MS, () => now);
  const tick = setInterval(() => { turns++; }, 0);
  try {
    await pause(); await pause(); const before = turns;
    now += PLACEMENT_SLICE_MS; await pause(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(turns).toBeGreaterThan(before);
  } finally { clearInterval(tick); }
});

test("#462: cooperative source capture preserves the synchronous snapshot and host-call count", async () => {
  const f = await createPlacementInspectionFixture(); homes.push(f);
  let calls = 0;
  const port = { ...f.port, attest: () => { calls++; return f.port.attest(); } };
  const ordinary = captureSyncPlacementContext(f.home, port), ordinaryCalls = calls;
  calls = 0;
  const cooperative = await captureSyncPlacementContextAsync(f.home, port);
  expect(calls).toBe(ordinaryCalls);
  expect(cooperative.fingerprint).toBe(ordinary.fingerprint);
  expect(cooperative.context).toEqual(ordinary.context);
  expect([...cooperative.rows]).toEqual([...ordinary.rows]);
  expect(cooperative.prefixes).toEqual(ordinary.prefixes);
});

test("#462: cooperative source capture refuses a policy file changed during a yielded step", async () => {
  const f = await createPlacementInspectionFixture(); homes.push(f);
  const yields = await import("../src/memory/sync-placement-yield.ts");
  const spy = spyOn(yields, "cooperativeYield").mockImplementation(() => async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  try {
    const pending = captureSyncPlacementContextAsync(f.home, f.port);
    setImmediate(() => writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["changed"] }) + "\n", { mode: 0o600 }));
    await expect(pending).rejects.toThrow();
  } finally { spy.mockRestore(); }
});

/** The pre-#462 greedy packing (re-serializes the whole candidate chunk per row). The linear version must equal it. */
function quadraticChunks(kind: PlacementPublicationChunk["kind"], items: unknown[]): PlacementPublicationChunk[] {
  const chunks: PlacementPublicationChunk[] = []; let selected: unknown[] = [];
  const flush = () => { if (selected.length) { chunks.push(validatePlacementPublicationChunk({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind, index: chunks.length, items: selected })); selected = []; } };
  for (const row of items) {
    if (publicationBytes({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind, index: chunks.length, items: [...selected, row] }).length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) flush();
    selected.push(row);
  }
  flush(); return chunks;
}
/** Plan evidence shared by the packing test and the #470 async-equality test. */
function planEvidence(count = 1500, objectsCount = 400) {
  const h = (value: string) => hashJSON(value), realm = { scope: "user" as const };
  const decisions = Array.from({ length: count }, (_, index) => ({ key: { realm, id: index.toString(16).padStart(32, "0"), rowHash: h(`row ${index}`) },
    eligible: index % 3 !== 0, hold: index % 3 === 0, sourcePlacement: "synced" as const, reason: index % 3 === 0 ? "person-local" as const : null, dependencies: [] }));
  const objects = Array.from({ length: objectsCount }, (_, index) => ({ targetIndex: 0, type: "blob" as const, path: `rows/${h("m")}/${h(String(index))}.jsonl`, oid: index.toString(16).padStart(40, "0"), sha256: h(`o${index}`), size: 100 + index }));
  const sources = [{ realm, source: "generation" as const, pathHash: h("path"), dev: "1", ino: "2", byteLength: 4, hash: h("prefix"), mtimeNs: "3", ctimeNs: "4" }];
  const input = { epochHash: h("epoch"), generation: "a".repeat(32), homeHash: h("home"), contextHash: h("context"), markerHash: h("markers"), sourceHash: h("source"), aliasesHash: h("aliases"),
    policyHash: h("policy"), remoteHash: h("remote"), journal: { sequence: 0, headHash: h("epoch") }, reservedRecords: 0, reservedRecordBytes: [], createdUnixSeconds: 1, policySnapshotUnixMs: 1000,
    targets: [{ realm, publish: true, refHash: h("ref"), expectedRemoteHead: null, expectedCacheHead: null, descriptorHash: h("d"), exportSetHash: h("e"), tree: "1".repeat(40), commit: "2".repeat(40) }] };
  return { input, parts: { sources, decisions, objects } };
}
test("#462 AC3: linear publication-plan packing produces the same chunks and root as the quadratic packing", () => {
  const { input, parts } = planEvidence();
  const { sources, decisions, objects } = parts;
  const bundle = planPlacementPublication(input, { sources, decisions, objects });
  const expected = [...quadraticChunks("sources", sources), ...quadraticChunks("decisions", decisions), ...quadraticChunks("objects", objects)];
  // The quadratic reference numbers each kind from 0; the plan numbers chunks across kinds.
  expect(bundle.chunks.map(chunk => canonicalJSON(chunk.items))).toEqual(expected.map(chunk => canonicalJSON(chunk.items)));
  expect(bundle.chunks.filter(chunk => chunk.kind === "decisions").length).toBeGreaterThan(1);
  for (const chunk of bundle.chunks) expect(publicationBytes(chunk).length).toBeLessThanOrEqual(PLACEMENT_JOURNAL_CHUNK_MAX_BYTES);
});

test("#470: the async steps return exactly the synchronous value and stop at every step boundary", async () => {
  const { input, parts } = planEvidence();
  let boundaries = 0;
  const planned = await planPlacementPublicationAsync(input, parts, async () => { boundaries++; });
  expect(planned).toEqual(planPlacementPublication(input, parts));
  expect(boundaries).toBeGreaterThan(0);

  const values: number[] = [], steps = function* () { for (let index = 0; index < 5; index++) { yield; values.push(index); } return "done"; };
  let awaited = 0;
  expect(await drainStepsAsync(steps(), async () => { awaited++; })).toBe("done");
  expect(awaited).toBe(5);
  expect(drainSteps(steps())).toBe("done");
  expect(values).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
});

async function largeFixture(rows: number, syncFloor = true): Promise<PlacementInspectionFixture> {
  const pad = "synthetic body ".repeat(40);
  const f = await createPlacementInspectionFixture({
    seed(store, project) {
      const first = store.note(inspectionNote(`first ${pad}`, project));
      const log = join(store.profile.home, "log", readdirSync(join(store.profile.home, "log")).find(name => name.endsWith(".jsonl"))!);
      const { id: _id, ...template } = JSON.parse(readFileSync(log, "utf8").trim());
      let lines = "";
      for (let index = 1; index < rows; index++) { const body = { ...template, text: `row ${index} ${pad}` }; lines += JSON.stringify({ ...body, id: entryId(body) }) + "\n"; }
      appendFileSync(log, lines); return { first };
    },
    async beforeMigrate(home) {
      if (!syncFloor) return;
      const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
      try { await runCli(["formats", "raise", "sync", "0.28.0", "--confirm"], { cwd: home, env: {}, processTable: () => "" }); }
      finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
    },
  }); homes.push(f); return f;
}
test("#462 AC2: a failed placement sync names a closed cause instead of leaving the host to parse text", async () => {
  expect([...SYNC_FAILURE_CAUSES].sort()).toEqual(["bound", "checkpoint-pending", "checkpoint-refused", "refusal", "remote", "stopped", "unavailable", "unknown-outcome", "writer-renewal"]);
  const f = await largeFixture(3);
  const materialize = await import("../src/memory/sync-placement-materialize.ts");
  // #288 step 1: the clause the refusal throws must survive into the result a person reads, not only the receipt.
  const detail = placementJournalObjectCompositionText(placementJournalObjectComposition({ names: ["epoch.json", "activation.json"] }));
  const spy = spyOn(materialize, "materializePlacementRows").mockImplementation(async () => { throw new PlacementSyncBoundError({ phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 280 }, detail); });
  try {
    const bound = await syncMemory(f.store, f.opts());
    expect(bound.ok).toBe(false); expect(bound.failure).toEqual({ cause: "bound" });
    expect(bound.placementPublication?.bound).toEqual({ phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 280 });
    expect(bound.error).toStartWith("Placement sync refused before any publication attempt: publication planning exceeds its supported journal-objects bound (observed 280, limit 256).");
    expect(bound.error).toContain("Objects by holder (3): epoch fixed 3, writer history 0, journal chunks 0, completed publications 0 (0 objects).");
  } finally { spy.mockRestore(); }
  const refused = await syncMemory(f.store, { ...f.opts(), visibility: async () => "public" });
  expect(refused.ok).toBe(false); expect(refused.failure).toEqual({ cause: "refusal", category: "remote" });
  const stop = new AbortController(); stop.abort();
  const stopped = await syncMemory(f.store, { ...f.opts(), signal: stop.signal });
  expect(stopped.ok).toBe(false); expect(stopped.failure?.cause).toBe("stopped");
  // #657 AC1: a stop before any attempt names its phase and the command that finishes the run, never a category refusal.
  expect(stopped.placementPublication?.refusal).toBeUndefined(); expect(stopped.placementPublication?.attemptHash).toBeUndefined();
  expect(stopped.error).toBe("Placement sync stopped before publication (phase start of the run); nothing was published for this batch. Run amem sync to finish it.");
  const direct = await syncPlacementMemory(f.store, { ...f.opts(), signal: stop.signal });
  expect(direct.failure).toEqual({ cause: "stopped" }); expect(direct.placementPublication?.refusal).toBeUndefined();
  expect(direct.error).toBe("Placement sync stopped before publication (phase writer verification); nothing was published for this batch. Run amem sync to finish it.");
  // #657: a stop inside source capture or policy evaluation, where the failing step throws as the signal fires, is the same stopped result in its own phase.
  const capture = await import("../src/memory/sync-placement-capture.ts");
  for (const [phase, spy] of [
    ["source capture", () => spyOn(capture, "captureSyncPlacementContextAsync")],
    ["policy evaluation", () => spyOn(materialize, "materializePlacementRows")],
  ] as const) {
    const mid = new AbortController(), mock = (spy() as ReturnType<typeof spyOn>).mockImplementation(async (input: unknown) => {
      // The real materializer enters policy evaluation through its progress port before its first row.
      if (phase === "policy evaluation") (input as { progress?: { phase(name: "policy-evaluation"): void } }).progress?.phase("policy-evaluation");
      mid.abort(); throw Error("/secret/stopped/step");
    });
    try {
      const result = await syncMemory(f.store, { ...f.opts(), signal: mid.signal });
      expect(result.failure).toEqual({ cause: "stopped" }); expect(result.placementPublication?.refusal).toBeUndefined();
      expect(result.error).toBe(`Placement sync stopped before publication (phase ${phase}); nothing was published for this batch. Run amem sync to finish it.`);
    } finally { mock.mockRestore(); }
  }
});
