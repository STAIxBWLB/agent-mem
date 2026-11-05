import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { pruneId, validatePrunePlan, type PruneRow, type PrunePlan } from "../src/memory/prune.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { shardSelectorRetention, type ShardSyncApplicationTarget } from "../src/memory/shard-sync.ts";
import { PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA } from "../src/memory/sync-placement-format.ts";
import type { MemoryStore } from "../src/memory/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const work of cleanup.splice(0).reverse()) work(); });
const G = "1".repeat(32), AT = "2026-10-01T00:00:00.000Z";
function fixture(prior: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "amem-shard-application-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const history = join(dir, "prune-plans", "selector-history"); mkdirSync(history, { recursive: true, mode: 0o700 });
  const body: Omit<PruneRow, "id"> = { schema: "agent-mem.prune/v1", op: "prune", generation: G, at: AT, machine: "2".repeat(16), actor: "person", placement: "synced", cutoff: AT,
    targets: [{ id: "3".repeat(32), rowHash: "4".repeat(64), expiredAt: AT, basis: { kind: "note", id: "3".repeat(32), rowHash: "4".repeat(64) } }] };
  const row = { ...body, id: pruneId(body) }, realm = { scope: "user" as const };
  const planBody: Omit<PrunePlan, "seal"> = { schema: "agent-mem.prune-plan/v1", generation: G, selectorRevision: hashJSON(prior), project: "user", policyRevision: hashJSON({ schema: "agent-mem.shard-sync/v1", realm }),
    rows: [{ placement: "synced", payload: row }], counts: { eligible: 1, selected: 1, local: 0, synced: 1 }, hasMore: false };
  const plan = validatePrunePlan({ ...planBody, seal: hashJSON(planBody) }), bytes = canonicalJSON(prior) + "\n", file = join(history, plan.seal + ".json");
  writeFileSync(file, bytes, { mode: 0o600 }); writeFileSync(join(dir, "prune-plans", plan.seal + ".json"), canonicalJSON(plan) + "\n", { mode: 0o600 });
  // The application seam receives an already admitted store. This fixture isolates selector-copy validation,
  // not activation authority, append recovery or fetched-proof admission (covered by the real sync suites).
  const store = { dir, profile: { kind: "generation", home: dir, dir, generation: G, selectorRevision: "a".repeat(64),
    foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "b".repeat(64), publicationFormat: PLACEMENT_FORMAT, placementHead: "c".repeat(64) },
    prunePort: () => { throw Error("selector copy must not open an index"); } } as unknown as MemoryStore;
  const mutation = acquireMutation(dir); if (!mutation) throw Error("synthetic mutation unavailable"); cleanup.push(mutation);
  const target: ShardSyncApplicationTarget = { store, realm, generation: G, mutation, rows: new Map([[row.id, row]]), fetched: new Set(), sources: [],
    pending: [{ plan, row, line: canonicalJSON(row) + "\n", offset: 0, prefixHash: "d".repeat(64) }], origins: new Map(), holds: [], manifests: new Map(), eligible: new Set(), registered: [] };
  return { target, bytes, file };
}
function selector() { return { schema: PLACEMENT_PROFILE_SCHEMA, kind: "generation", generation: G,
  foreignPruneFormat: "agent-mem.public-prune-witness/v1", pruneInputSetHash: "e".repeat(64), publicationFormat: PLACEMENT_FORMAT, placementHead: "c".repeat(64) }; }

test("selector retention accepts exact historical v3 evidence and preserves its bytes without opening an index", () => {
  const f = fixture(selector()); shardSelectorRetention(f.target, false);
  expect(readFileSync(f.file, "utf8")).toBe(f.bytes);
  expect(f.target.selectorChecks?.length).toBeGreaterThan(0);
  for (const check of f.target.selectorChecks ?? []) check();
});

test("known historical v2 evidence remains retainable for an admitted v3 store without becoming current authority", () => {
  const { publicationFormat: _format, placementHead: _head, ...base } = selector();
  const f = fixture({ ...base, schema: "agent-mem.profile/v2" }); shardSelectorRetention(f.target, false);
  expect(readFileSync(f.file, "utf8")).toBe(f.bytes); expect(f.target.store.profile.publicationFormat).toBe(PLACEMENT_FORMAT);
});

for (const changed of [{ placementHead: "f".repeat(64) }, { publicationFormat: "future-format" }, { schema: "future-schema" }, { extra: true }])
  test(`historical selector ${Object.keys(changed)[0]} cannot change the current activation binding`, () => {
    const f = fixture({ ...selector(), ...changed });
    expect(() => shardSelectorRetention(f.target, false)).toThrow(); expect(readFileSync(f.file, "utf8")).toBe(f.bytes);
  });
