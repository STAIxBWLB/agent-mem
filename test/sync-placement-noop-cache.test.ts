import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openShardStore } from "../src/memory/store.ts";
import { runCli } from "../src/cli.ts";
import { syncMemory, type SyncResult } from "../src/memory/sync.ts";
import { SyncProgress, type SyncProgressSnapshot } from "../src/memory/sync-progress.ts";
import { deterministicRowScreen, type RowScreen } from "../src/memory/sync-screen.ts";
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
  const base = { version: "0.38.0", screenIdentity: null, writersHash: "a".repeat(64), policyHash: "b".repeat(64), sourceHash: "c".repeat(64), aliasesHash: "d".repeat(64), contextHash: "e".repeat(64),
    markerHash: "f".repeat(64), remoteHash: "0".repeat(64), journal: { sequence: 1, headHash: "1".repeat(64) }, targets: [{ remote: "2".repeat(40), local: null, pruned: [], fetched: [] }] };
  const key = placementNoopKey(base), seen = new Set([key]);
  for (const changed of [{ screenIdentity: "8".repeat(64) }, { version: "0.39.0" }, { writersHash: "9".repeat(64) }, { policyHash: "9".repeat(64) }, { sourceHash: "9".repeat(64) }, { journal: { sequence: 2, headHash: "1".repeat(64) } },
    { targets: [{ remote: "3".repeat(40), local: null, pruned: [], fetched: [] }] }, { targets: [{ remote: "2".repeat(40), local: null, pruned: ["x"], fetched: [] }] }]) seen.add(placementNoopKey({ ...base, ...changed }));
  expect(seen.size).toBe(9);
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

test("#612 an arbitrary host screen never caches; the package's deterministic screen does", async () => {
  const f = await inventoryFixture(2), remote = bareRemote();
  const host = async (screen: RowScreen) => { const phases = new Set<string>(); const progress = new SyncProgress({ sink: s => { phases.add(s.phase); }, intervalMs: 0 });
    const result = await syncMemory(f.entry(), { ...f.opts(remote), progress, screen }); return { result, phases }; };
  await host(() => true);
  expect((await host(() => true)).result.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
  expect(cacheFiles(f.home)).toEqual([]);
  expect((await host(() => true)).phases.has("policy-evaluation")).toBe(true);
  const options = { piiPatterns: ["NEVER_PUBLIC_"] };
  await host(deterministicRowScreen(options));
  expect(cacheFiles(f.home).length).toBeGreaterThan(0);
  expect((await host(deterministicRowScreen(options))).phases.has("policy-evaluation")).toBe(false);
  expect((await host(deterministicRowScreen({ piiPatterns: ["NEVER_PUBLIC_", "OTHER_"] }))).phases.has("policy-evaluation")).toBe(true);
  expect((await host(() => true)).phases.has("policy-evaluation")).toBe(true);
}, 300_000);

test("#612 cache I/O stays confined: loose modes, foreign links and an outside target are a miss and are never touched", async () => {
  const f = await inventoryFixture(1), remote = bareRemote();
  await run(f, remote); await run(f, remote);
  const dir = join(f.home, PLACEMENT_NOOP_CACHE_DIR), [name] = cacheFiles(f.home), path = join(dir, name!);
  chmodSync(path, 0o644); expect((await run(f, remote)).phases.has("policy-evaluation")).toBe(true); // a loose file is a miss, then rewritten privately
  expect(lstatSync(join(dir, name!)).mode & 0o777).toBe(0o600);
  chmodSync(dir, 0o755);
  const loose = await run(f, remote); expect(loose.phases.has("policy-evaluation")).toBe(true); expect(loose.result.ok).toBe(true);
  expect(lstatSync(dir).mode & 0o777).toBe(0o755); // never repaired or written through
  chmodSync(dir, 0o700); await run(f, remote);
  const outside = join(f.root, "outside-target"); writeFileSync(outside, "keep\n", { mode: 0o600 });
  unlinkSync(join(dir, name!)); symlinkSync(outside, join(dir, name!));
  const linked = await run(f, remote); expect(linked.result.ok).toBe(true); expect(linked.phases.has("policy-evaluation")).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("keep\n"); expect(lstatSync(join(dir, name!)).isSymbolicLink()).toBe(true);
  rmSync(dir, { recursive: true }); symlinkSync(f.root, dir);
  const linkedDir = await run(f, remote); expect(linkedDir.result.ok).toBe(true); expect(linkedDir.phases.has("policy-evaluation")).toBe(true);
  expect(readdirSync(f.root).some(item => item.endsWith(".json") && /^[a-f0-9]{64}/.test(item))).toBe(false);
}, 300_000);

test("#612 a failed attempt after a cached no-op clears its slot", async () => {
  const f = await inventoryFixture(1), remote = bareRemote();
  await run(f, remote); await run(f, remote); expect(cacheFiles(f.home).length).toBe(1);
  const controller = new AbortController();
  // Stop after capture starts, so the attempt is past initialization and holds the sync lock and home fence.
  const progress = new SyncProgress({ sink: snapshot => { if (snapshot.phase === "source-capture") controller.abort(); }, intervalMs: 0 });
  const stopped = await syncMemory(f.entry(), { ...f.opts(remote), signal: controller.signal, progress });
  expect(stopped.ok).toBe(false);
  expect(cacheFiles(f.home)).toEqual([]);
}, 300_000);

test("#612 AC2 CLI: `amem sync --json` over 20 realms in 10 publications finishes a cached no-op within 120 s, all not-needed", async () => {
  const f = await inventoryFixture(19, undefined, true), remote = bareRemote();
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["NEVER_PUBLIC_"], privateRemotes: [remote] }) + "\n", { mode: 0o600 });
  const saved = process.env.AMEM_HOME; process.env.AMEM_HOME = f.home;
  const sync = async (args: string[]) => JSON.parse(await runCli(["sync", ...args, "--json"], { cwd: f.root, env: {} })) as SyncResult;
  try {
    expect((await sync(["--remote", remote])).ok).toBe(true);
    let started = performance.now(); const full = await sync([]); const fullMs = performance.now() - started;
    started = performance.now(); const hit = await sync([]); const hitMs = performance.now() - started;
    console.log(`#612 AC2 CLI: full-path no-op ${Math.round(fullMs)} ms, cached no-op ${Math.round(hitMs)} ms`);
    expect(hit.placementRealms!.length).toBe(20); expect(new Set(hit.placementRealms!.map(item => item.publication)).size).toBe(10);
    expect(hit.placementRealms!.every(item => item.outcome === "not-needed")).toBe(true);
    expect(cacheFiles(f.home).length).toBe(10);
    expect(receipt(hit)).toEqual(receipt(full));
    expect(hitMs).toBeLessThan(120_000);
  } finally { if (saved === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = saved; }
}, 900_000);
