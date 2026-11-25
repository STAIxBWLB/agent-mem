import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openShardStore } from "../src/memory/store.ts";
import { syncMemory, type SyncResult } from "../src/memory/sync.ts";
import { SyncProgress, type SyncProgressSnapshot } from "../src/memory/sync-progress.ts";
import { PLACEMENT_NOOP_CACHE_DIR, PLACEMENT_NOOP_CACHE_MAX_BYTES, PLACEMENT_NOOP_CACHE_SCHEMA, placementNoopKey } from "../src/memory/sync-placement-noop-cache.ts";
import { bareRemote, closeInventoryFixtures, inventoryFixture, note } from "./fakes/sync-placement-inventory.ts";

// #612: real local-Git round trips over several realms; generous local allowance (global --timeout unchanged).
afterEach(closeInventoryFixtures);

async function run(f: Awaited<ReturnType<typeof inventoryFixture>>, remote: string): Promise<{ result: SyncResult; phases: Set<string>; last?: SyncProgressSnapshot }> {
  const phases = new Set<string>(); let last: SyncProgressSnapshot | undefined;
  const progress = new SyncProgress({ sink: snapshot => { phases.add(snapshot.phase); last = snapshot; }, intervalMs: 0 });
  const result = await syncMemory(f.entry(), { ...f.opts(remote), progress });
  return { result, phases, ...(last ? { last } : {}) };
}
const cacheFiles = (home: string) => existsSync(join(home, PLACEMENT_NOOP_CACHE_DIR)) ? readdirSync(join(home, PLACEMENT_NOOP_CACHE_DIR)).filter(name => name.endsWith(".json")) : [];
/** The receipt fields a person or host reads; timestamps of the last policy check legitimately move. */
const receipt = (result: SyncResult) => ({ ok: result.ok, pushed: result.pushed, entries: result.entries,
  realms: result.placementRealms?.map(item => ({ realm: item.realm, outcome: item.outcome, publication: item.publication })),
  outcome: result.placementPublication?.outcome, withheld: result.placementPublication?.withheld, exported: result.placementPublication?.exported });

test("#612 a repeated no-op sync skips policy evaluation and returns the identical not-needed receipt and counts", async () => {
  const f = await inventoryFixture(3), remote = bareRemote();
  expect((await run(f, remote)).result.ok).toBe(true); // publishes
  expect(cacheFiles(f.home)).toEqual([]); // a publishing run never leaves a cache
  const full = await run(f, remote); // full-path no-op: evaluates policy, writes the cache
  expect(full.result.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
  expect(full.phases.has("policy-evaluation")).toBe(true);
  expect(cacheFiles(f.home).length).toBeGreaterThan(0);
  const hit = await run(f, remote);
  expect(hit.phases.has("policy-evaluation")).toBe(false);
  expect(hit.phases.has("writer-verification") && hit.phases.has("remote-verification")).toBe(true);
  expect(receipt(hit.result)).toEqual(receipt(full.result));
  expect(hit.last?.counts).toEqual(full.last?.counts);
  for (const name of cacheFiles(f.home)) {
    const path = join(f.home, PLACEMENT_NOOP_CACHE_DIR, name), stat = lstatSync(path);
    expect(stat.mode & 0o777).toBe(0o600); expect(lstatSync(join(f.home, PLACEMENT_NOOP_CACHE_DIR)).mode & 0o777).toBe(0o700);
    expect(stat.size).toBeLessThanOrEqual(PLACEMENT_NOOP_CACHE_MAX_BYTES);
    const value = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(value).sort()).toEqual(["counts", "key", "schema"]); expect(value.schema).toBe(PLACEMENT_NOOP_CACHE_SCHEMA);
  }
}, 300_000);

test("#612 AC3: a new row after a cached no-op takes the full path and publishes with today's committed receipt", async () => {
  const f = await inventoryFixture(2), remote = bareRemote();
  await run(f, remote); await run(f, remote); expect(cacheFiles(f.home).length).toBeGreaterThan(0);
  const store = openShardStore({ memoryDir: f.home, deferPromotions: true, project: f.projects[0]! });
  try { store.note(note("a later allowed original", f.projects[0]!)); } finally { store.close(); }
  const published = await run(f, remote);
  expect(published.phases.has("policy-evaluation")).toBe(true);
  expect(published.result).toMatchObject({ ok: true, pushed: true });
  expect(published.result.placementRealms!.some(item => item.outcome === "committed")).toBe(true);
  const after = await run(f, remote);
  expect(after.result.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
  expect(after.phases.has("policy-evaluation")).toBe(true); // the publish cleared that slot
}, 300_000);

test("#612 a policy change or a moved remote head misses the cache", async () => {
  const f = await inventoryFixture(2), remote = bareRemote();
  await run(f, remote); await run(f, remote);
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["NEVER_PUBLIC_", "ANOTHER_PATTERN_"] }) + "\n", { mode: 0o600 });
  expect((await run(f, remote)).phases.has("policy-evaluation")).toBe(true);
  expect((await run(f, remote)).phases.has("policy-evaluation")).toBe(false);
  // another machine publishes to the same remote: fresh remote heads differ
  const other = await inventoryFixture(2);
  const store = openShardStore({ memoryDir: other.home, deferPromotions: true, user: true });
  try { store.note(note("an independent shared original", other.projects[0]!, "shared")); } finally { store.close(); }
  await run(other, remote);
  expect((await run(f, remote)).phases.has("policy-evaluation")).toBe(true);
}, 300_000);

test("#612 a corrupt, oversized, unknown-schema or bad-count cache takes the full path and never fails the sync", async () => {
  const f = await inventoryFixture(2), remote = bareRemote();
  await run(f, remote); await run(f, remote);
  const files = cacheFiles(f.home).map(name => join(f.home, PLACEMENT_NOOP_CACHE_DIR, name));
  const original = files.map(path => JSON.parse(readFileSync(path, "utf8")));
  const variants: ((value: any) => string)[] = [
    () => "{not json", value => JSON.stringify({ ...value, schema: "agent-mem.placement-noop-cache/v2" }),
    value => JSON.stringify({ ...value, counts: { ...value.counts, held: -1 } }), value => JSON.stringify({ ...value, counts: { ...value.counts, local: 1.5 } }),
    value => JSON.stringify({ ...value, extra: "x".repeat(PLACEMENT_NOOP_CACHE_MAX_BYTES) }),
  ];
  for (const variant of variants) {
    files.forEach((path, index) => { chmodSync(path, 0o600); writeFileSync(path, variant(original[index])); });
    const next = await run(f, remote);
    expect(next.result.ok).toBe(true); expect(next.phases.has("policy-evaluation")).toBe(true);
    expect(next.result.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
  }
}, 300_000);

test("#612 the key changes with every input and is order-independent", () => {
  const base = { version: "0.38.0", writersHash: "a".repeat(64), policyHash: "b".repeat(64), sourceHash: "c".repeat(64), aliasesHash: "d".repeat(64), contextHash: "e".repeat(64),
    markerHash: "f".repeat(64), remoteHash: "0".repeat(64), journal: { sequence: 1, headHash: "1".repeat(64) }, targets: [{ remote: "2".repeat(40), local: null, pruned: [], fetched: [] }] };
  const key = placementNoopKey(base), seen = new Set([key]);
  for (const changed of [{ version: "0.39.0" }, { writersHash: "9".repeat(64) }, { policyHash: "9".repeat(64) }, { sourceHash: "9".repeat(64) }, { journal: { sequence: 2, headHash: "1".repeat(64) } },
    { targets: [{ remote: "3".repeat(40), local: null, pruned: [], fetched: [] }] }, { targets: [{ remote: "2".repeat(40), local: null, pruned: ["x"], fetched: [] }] }]) seen.add(placementNoopKey({ ...base, ...changed }));
  expect(seen.size).toBe(8);
  expect(placementNoopKey({ ...base, targets: [{ remote: "2".repeat(40), local: null, pruned: ["b", "a"], fetched: [] }] })).toBe(placementNoopKey({ ...base, targets: [{ remote: "2".repeat(40), local: null, pruned: ["a", "b"], fetched: [] }] }));
});

test("#612 AC2 fixture: a no-op over 20 realms in 10 publications finishes within 120 s with every realm not-needed", async () => {
  const f = await inventoryFixture(19), remote = bareRemote();
  expect((await run(f, remote)).result.ok).toBe(true);
  let started = performance.now(); const full = await run(f, remote); const fullMs = performance.now() - started;
  started = performance.now(); const hit = await run(f, remote); const hitMs = performance.now() - started;
  console.log(`#612 AC2 fixture: full-path no-op ${Math.round(fullMs)} ms, cached no-op ${Math.round(hitMs)} ms`);
  expect(new Set(hit.result.placementRealms!.map(item => item.publication)).size).toBe(10);
  expect(hit.result.placementRealms!.length).toBe(20);
  expect(hit.result.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
  expect(hit.phases.has("policy-evaluation")).toBe(false);
  expect(receipt(hit.result)).toEqual(receipt(full.result));
  expect(hitMs).toBeLessThan(120_000);
}, 900_000);
