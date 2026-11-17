import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { entryId } from "../src/memory/store.ts";
import { syncMemory, SYNC_FAILURE_CAUSES } from "../src/memory/sync.ts";
import { PlacementSyncBoundError } from "../src/memory/sync-placement-bound.ts";
import { PLACEMENT_JOURNAL_CHUNK_MAX_BYTES } from "../src/memory/sync-placement-journal-format.ts";
import { PLACEMENT_PUBLICATION_CHUNK_SCHEMA, planPlacementPublication, publicationBytes, validatePlacementPublicationChunk, type PlacementPublicationChunk } from "../src/memory/sync-placement-publication-plan.ts";
import { cooperativeYield, PLACEMENT_SLICE_MS } from "../src/memory/sync-placement-yield.ts";
import { createPlacementInspectionFixture, inspectionNote, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

/** #462 AC1: the longest stretch a library caller's event loop can be held by one placement sync, on this fixture. */
const STRETCH_BOUND_MS = 250;
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
test("#462 AC3: linear publication-plan packing produces the same chunks and root as the quadratic packing", () => {
  const h = (value: string) => hashJSON(value), realm = { scope: "user" as const };
  const decisions = Array.from({ length: 1500 }, (_, index) => ({ key: { realm, id: index.toString(16).padStart(32, "0"), rowHash: h(`row ${index}`) },
    eligible: index % 3 !== 0, hold: index % 3 === 0, sourcePlacement: "synced" as const, reason: index % 3 === 0 ? "person-local" as const : null, dependencies: [] }));
  const objects = Array.from({ length: 400 }, (_, index) => ({ targetIndex: 0, type: "blob" as const, path: `rows/${h("m")}/${h(String(index))}.jsonl`, oid: index.toString(16).padStart(40, "0"), sha256: h(`o${index}`), size: 100 + index }));
  const sources = [{ realm, source: "generation" as const, pathHash: h("path"), dev: "1", ino: "2", byteLength: 4, hash: h("prefix"), mtimeNs: "3", ctimeNs: "4" }];
  const input = { epochHash: h("epoch"), generation: "a".repeat(32), homeHash: h("home"), contextHash: h("context"), markerHash: h("markers"), sourceHash: h("source"), aliasesHash: h("aliases"),
    policyHash: h("policy"), remoteHash: h("remote"), journal: { sequence: 0, headHash: h("epoch") }, reservedRecords: 0, reservedRecordBytes: [], createdUnixSeconds: 1, policySnapshotUnixMs: 1000,
    targets: [{ realm, publish: true, refHash: h("ref"), expectedRemoteHead: null, expectedCacheHead: null, descriptorHash: h("d"), exportSetHash: h("e"), tree: "1".repeat(40), commit: "2".repeat(40) }] };
  const bundle = planPlacementPublication(input, { sources, decisions, objects });
  const expected = [...quadraticChunks("sources", sources), ...quadraticChunks("decisions", decisions), ...quadraticChunks("objects", objects)];
  // The quadratic reference numbers each kind from 0; the plan numbers chunks across kinds.
  expect(bundle.chunks.map(chunk => canonicalJSON(chunk.items))).toEqual(expected.map(chunk => canonicalJSON(chunk.items)));
  expect(bundle.chunks.filter(chunk => chunk.kind === "decisions").length).toBeGreaterThan(1);
  for (const chunk of bundle.chunks) expect(publicationBytes(chunk).length).toBeLessThanOrEqual(PLACEMENT_JOURNAL_CHUNK_MAX_BYTES);
});

async function largeFixture(rows: number): Promise<PlacementInspectionFixture> {
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
      const prior = process.env.AMEM_HOME; process.env.AMEM_HOME = home;
      try { await runCli(["formats", "raise", "sync", "0.28.0", "--confirm"], { cwd: home, env: {}, processTable: () => "" }); }
      finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
    },
  }); homes.push(f); return f;
}
/** Loop-delay probe: the longest gap between 10 ms timer ticks while `work` runs. */
async function longestStretch<T>(work: () => Promise<T>): Promise<{ value: T; longest: number }> {
  let last = performance.now(), longest = 0;
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);
  try { const value = await work(); return { value, longest }; } finally { clearInterval(timer); }
}
const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* synthetic per-row policy cost */ } };

test("#462 AC1/AC3: a long placement sync never holds the caller's event loop past the documented stretch, and publishes every row", async () => {
  // 600 rows at 2 ms of synthetic policy cost each: about 1.2 s of evaluation that ran as one unbroken call before #462.
  const f = await largeFixture(600);
  const { value: result, longest } = await longestStretch(() => syncMemory(f.store, { ...f.opts(), screen: () => { busy(2); return true; } }));
  expect(result.ok, JSON.stringify(result.failure)).toBe(true); expect(result.placementPublication?.outcome).toBe("committed"); expect(result.failure).toBeUndefined();
  expect(f.reachableIds().length).toBe(600);
  expect(longest).toBeLessThan(STRETCH_BOUND_MS);
}, 600_000);

test("#462 AC2: a failed placement sync names a closed cause instead of leaving the host to parse text", async () => {
  expect([...SYNC_FAILURE_CAUSES].sort()).toEqual(["bound", "refusal", "remote", "stopped", "unavailable", "unknown-outcome", "writer-renewal"]);
  const f = await largeFixture(3);
  const materialize = await import("../src/memory/sync-placement-materialize.ts");
  const spy = spyOn(materialize, "materializePlacementRows").mockImplementation(async () => { throw new PlacementSyncBoundError({ phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 280 }); });
  try {
    const bound = await syncMemory(f.store, f.opts());
    expect(bound.ok).toBe(false); expect(bound.failure).toEqual({ cause: "bound" });
    expect(bound.placementPublication?.bound).toEqual({ phase: "publication-plan", kind: "journal-objects", limit: 256, observed: 280 });
  } finally { spy.mockRestore(); }
  const refused = await syncMemory(f.store, { ...f.opts(), visibility: async () => "public" });
  expect(refused.ok).toBe(false); expect(refused.failure).toEqual({ cause: "refusal", category: "remote" });
  const stop = new AbortController(); stop.abort();
  const stopped = await syncMemory(f.store, { ...f.opts(), signal: stop.signal });
  expect(stopped.ok).toBe(false); expect(stopped.failure?.cause).toBe("stopped");
}, 600_000);
