/**
 * Shared activated-placement fixture for the inventory and realm-admission tests.
 *
 * One real home per call: seeded stores, a shard migration, a public prune view, the placement journal, the v3 markers
 * and the epoch fence, all through the production APIs. Real local-Git remotes are created by the tests themselves.
 */
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore, type NoteInput } from "../../src/memory/store.ts";
import { memoryGitSync, realPath } from "../../src/memory/platform.ts";
import { canonicalJSON, generationDescriptor, hashJSON, writeProfileJSON } from "../../src/memory/generation.ts";
import { migrateShards } from "../../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../../src/memory/public-prune-activation.ts";
import { captureSyncPlacementContext } from "../../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, type PlacementJournalPort } from "../../src/memory/sync-placement-journal.ts";
import { acquireMutation } from "../../src/memory/mutation.ts";
import { ensurePlacementFence } from "../../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../../src/memory/sync-placement-format.ts";
import { ensureShardDescriptor, shardDir, shardKeyHash } from "../../src/memory/shard.ts";
import type { SyncOptions } from "../../src/memory/sync.ts";

const cleanup: (() => void)[] = [];
export function closeInventoryFixtures(): void { for (const close of cleanup.splice(0).reverse()) close(); }
const temp = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "amem-placement-inventory-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const git = (dir: string, ...args: string[]) => { const r = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" }); if (r.status !== 0) throw Error(`git ${args[0]} failed`); return r.stdout.trim(); };
const json = (value: unknown) => canonicalJSON(value) + "\n";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const noteRow = (text: string, project: string, scope: "project" | "shared" = "project"): NoteInput => ({ op: "note", project, scope, tier: "long", kind: "finding", peer: "person", source: "person", text, about: [] });
export const note = noteRow;
export const refsOf = (remote: string) => git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter(Boolean).sort();
export const bareRemote = () => { const dir = temp(); git(dir, "init", "--bare", "-q"); return dir; };
let generations = 900;

/** One activated home with the user realm and `count` project realms, prepared through the real APIs (like the transport fixture). */
export async function inventoryFixture(count: number) {
  const root = temp(), home = join(root, "memory"), projects = Array.from({ length: count }, (_, index) => `example.test/placement/inventory-${String(index).padStart(2, "0")}`);
  const seed = new MemoryStore({ memoryDir: home, deferPromotions: true });
  try {
    seed.note(note("inventory shared fact", projects[0]!, "shared"));
    for (const project of projects) seed.note(note(`inventory note for ${project}`, project));
  } finally { seed.close(); }
  const generation = (++generations).toString(16).padStart(32, "0");
  expect(await migrateShards({ memoryDir: home, generation, mode: "apply", authorizedPerson: true, tty: true })).toMatchObject({ active: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  writeFileSync(join(home, "amem.config.json"), json({ piiPatterns: ["NEVER_PUBLIC_"] }), { mode: 0o600 });
  const port: PlacementJournalPort = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }),
    policyVersion: () => "initial", authorize: () => true };
  const preview = planPlacementJournal(home, port), { epochHash } = preparePlacementJournal(home, preview, port);
  const oldShards = JSON.parse(readFileSync(join(home, "shards.json"), "utf8")), profile = preview.plan.targetProfile;
  writeFileSync(join(home, "profile.json"), json(profile), { mode: 0o600 });
  writeFileSync(join(home, "shards.json"), json({ ...oldShards, schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash }), { mode: 0o600 });
  const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home); if (!mutation) throw Error("synthetic home mutation unavailable");
  try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
  const opts = (remote: string): SyncOptions => ({ remote, visibility: async () => "private", placementAttestation: port.attest, policyVersion: port.policyVersion });
  const plans = () => readdirSync(join(home, "sync-placement", "epochs", epochHash)).filter(name => /^publication-[a-f0-9]{64}-root\.json$/.test(name)).sort();
  const entry = () => { const store = openShardStore({ memoryDir: home, user: true, deferPromotions: true }); cleanup.push(() => store.close()); return store; };
  return { root, home, projects, epochHash, opts, plans, entry, close: closeInventoryFixtures };
}
export const expectedRefs = (projects: readonly string[]) => ["refs/heads/amem/u", ...projects.map(project => `refs/heads/amem/p/${shardKeyHash(project)}`)].sort();
/** Every realm order after the user realm is by full key hash. */
export const expectedOrder = (projects: readonly string[]) => ["user", ...projects.map(digest).sort()];

/** A curated realm this machine already holds, written the way a migration leaves it (temp fixture only). */
export function installSyntheticRealm(home: string, generation: string, project: string): void {
  const dir = shardDir(home, project); ensureShardDescriptor(home, project);
  for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
  const machine = JSON.parse(readFileSync(join(home, "machine.json"), "utf8")), descriptor = generationDescriptor(generation), sources: unknown[] = [];
  for (const [name, value] of [["generation.json", descriptor], ["machine.json", machine], ["legacy/machine.json", machine], ["legacy-main/machine.json", machine],
    ["migration-sources.json", { schema: "agent-mem.migration-sources/v1", sources }], ["generation-seal.json", { schema: "agent-mem.generation-seal/v1", generation,
      descriptorHash: hashJSON(descriptor), sourceDigest: hashJSON({ sources, legacyCommit: undefined }) }]] as const) writeProfileJSON(join(dir, name), value);
}
