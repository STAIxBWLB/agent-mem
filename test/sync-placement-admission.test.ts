import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, openShardStore } from "../src/memory/store.ts";
import { realPath } from "../src/memory/platform.ts";
import { canonicalJSON, hashJSON, readSelector } from "../src/memory/generation.ts";
import { migrateShards } from "../src/memory/shard-migration.ts";
import { activatePublicPruneView } from "../src/memory/public-prune-activation.ts";
import { advancePublicPruneView, type PublicPruneAdvanceStage } from "../src/memory/public-prune-advance.ts";
import { readPublicPruneViewForActivation, publicPruneViewHash, PUBLIC_PRUNE_INTENT } from "../src/memory/public-prune-view.ts";
import { preparePublicPruneInput, persistPublicPruneInput } from "../src/memory/public-prune-inputs.ts";
import { resolveShardProfile } from "../src/memory/shard.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { captureSyncPlacementContext } from "../src/memory/sync-placement-capture.ts";
import { planPlacementJournal, preparePlacementJournal, type PlacementJournalPort } from "../src/memory/sync-placement-journal.ts";
import { ensurePlacementFence } from "../src/memory/sync-placement-journal-storage.ts";
import { PLACEMENT_FORMAT, PLACEMENT_SHARDS_SCHEMA } from "../src/memory/sync-placement-format.ts";

const PROJECT = "placement-admission", G = "e".repeat(32), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function json(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
function write(file: string, value: unknown) { writeFileSync(file, canonicalJSON(value) + "\n", { mode: 0o600 }); }
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (folder: string, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name, file = join(folder, entry.name);
      if (entry.isDirectory()) walk(file, relative + "/"); else out[relative] = hashJSON(readFileSync(file).toString("base64"));
    }
  };
  walk(dir, ""); return out;
}
async function fixture(active = true) {
  const root = realPath(mkdtempSync(join(tmpdir(), "amem-placement-admission-"))); roots.push(root);
  const home = join(root, "memory"), original = new MemoryStore({ memoryDir: home, deferPromotions: true });
  const note = { op: "note" as const, project: PROJECT, scope: "project" as const, tier: "long" as const, kind: "finding" as const,
    peer: "person", source: "person" as const, text: "synthetic admission original", about: [] };
  const id = original.note(note); original.close();
  await migrateShards({ memoryDir: home, generation: G, mode: "apply", authorizedPerson: true, tty: true });
  await activatePublicPruneView({ memoryDir: home, mode: "apply", authorizedPerson: true, tty: true });
  const port: PlacementJournalPort = { attest: () => ({ writers: [{ writerId: "1".repeat(64), version: "0.22.0", pin: "2".repeat(64), publicationFormat: PLACEMENT_FORMAT, compatible: true }], legacySyncQuiesced: true }),
    policyVersion: () => "synthetic-policy-v1", authorize: () => true };
  const before = captureSyncPlacementContext(home, port), oldProfile = readFileSync(join(home, "profile.json"), "utf8"), oldShards = readFileSync(join(home, "shards.json"), "utf8");
  const preview = planPlacementJournal(home, port), alternative = planPlacementJournal(home, port);
  const { epochHash } = preparePlacementJournal(home, preview, port);
  if (active) {
    const profile = preview.plan.targetProfile;
    write(join(home, "profile.json"), profile);
    write(join(home, "shards.json"), { ...JSON.parse(oldShards), schema: PLACEMENT_SHARDS_SCHEMA, selectorRevision: hashJSON(profile), publicationFormat: PLACEMENT_FORMAT, placementHead: epochHash });
    // Explicit test-only activation. The production prepare API never installs these markers or a fence.
    const proof = captureSyncPlacementContext(home, port), mutation = acquireMutation(home);
    if (!mutation) throw Error("synthetic mutation unavailable");
    try { ensurePlacementFence(home, epochHash, { mutation, assertCurrent: proof.assertCurrent }); } finally { mutation(); }
  }
  const epochDir = join(home, "sync-placement", "epochs", epochHash);
  return { home, root, note, id, before, epochHash, preview, alternative, oldProfile, oldShards,
    files: { epoch: join(epochDir, "epoch.json"), activation: join(epochDir, "activation.json"), fence: join(home, "sync-placement", "active.json") } };
}
function refusedWithoutEffects(home: string): void {
  const before = tree(home);
  expect(() => openShardStore({ memoryDir: home, project: PROJECT, deferPromotions: true })).toThrow();
  expect(tree(home)).toEqual(before);
}

test("complete matching epoch, activation and active fence admit ordinary v3 reads/writes with unchanged original rows and indexes", async () => {
  const f = await fixture(), store = openShardStore({ memoryDir: f.home, project: PROJECT, deferPromotions: true });
  let added: string;
  try {
    expect(store.get(f.id, PROJECT)?.text).toBe(f.note.text);
    const original = store.prunePort().snapshot().rows.find(source => source.row.id === f.id)!.row;
    const captured = [...f.before.rows.values()].find(source => source.row.id === f.id)!.row;
    expect(original).toEqual(captured);
    added = store.note({ ...f.note, text: "synthetic admission new row" });
    expect(store.get(added, PROJECT)?.text).toBe("synthetic admission new row");
    expect(store.profile).toMatchObject({ publicationFormat: PLACEMENT_FORMAT, placementHead: f.epochHash });
  } finally { store.close(); }
  const reopened = openShardStore({ memoryDir: f.home, project: PROJECT, deferPromotions: true });
  try { expect(reopened.get(added!, PROJECT)?.text).toBe("synthetic admission new row"); expect(reopened.get(f.id, PROJECT)?.text).toBe(f.note.text); }
  finally { reopened.close(); }
});

for (const component of ["epoch", "activation", "fence"] as const) for (const fault of ["missing", "wrong", "altered"] as const)
  test(`${fault} ${component} refuses before any derived/index admission effect`, async () => {
    const f = await fixture(), file = f.files[component];
    if (fault === "missing") rmSync(file);
    if (fault === "altered") writeFileSync(file, readFileSync(file, "utf8") + " ");
    if (fault === "wrong") {
      if (component === "epoch") write(file, { ...json(file), nonce: "0".repeat(32) });
      else if (component === "activation") write(file, f.alternative.plan);
      else write(file, { ...json(file), homeHash: "0".repeat(64) });
    }
    refusedWithoutEffects(f.home);
  });

test("durable fence rejects selector rollback to the original valid v2 pair", async () => {
  const f = await fixture();
  writeFileSync(join(f.home, "profile.json"), f.oldProfile); writeFileSync(join(f.home, "shards.json"), f.oldShards);
  refusedWithoutEffects(f.home);
});

async function advanceEmptyUser(f: Awaited<ReturnType<typeof fixture>>, checkpoint?: (stage: PublicPruneAdvanceStage) => void | Promise<void>) {
  const selection = readSelector(f.home), user = resolveShardProfile(f.home, { user: true });
  const profile = json(join(f.home, "profile.json")), current = readPublicPruneViewForActivation(f.home, profile.pruneInputSetHash, G);
  const binding = { realm: { scope: "user" as const }, receivingGeneration: G, selectorRevision: selection.revision, inputSetHash: current.realms.user ?? null };
  const prepared = preparePublicPruneInput({ dir: user.dir, binding, current: () => binding, input: null });
  const registration = persistPublicPruneInput(prepared);
  const view = { ...current, realms: { ...current.realms, user: registration.inputSetHash } };
  const result = await advancePublicPruneView({ memoryDir: f.home, view, expectedRevision: selection.revision, ...(checkpoint ? { checkpoint } : {}) });
  return { result, view };
}

test("normal public-prune maintenance preserves v3 publication fields and admission facts while a live reader rebinds", async () => {
  const f = await fixture(), profile = json(join(f.home, "profile.json")), shards = json(join(f.home, "shards.json"));
  const facts = Object.fromEntries(Object.entries(f.files).map(([name, file]) => [name, readFileSync(file, "utf8")]));
  const store = openShardStore({ memoryDir: f.home, project: PROJECT, deferPromotions: true });
  try {
    const { result, view } = await advanceEmptyUser(f), next = json(join(f.home, "profile.json")), nextShards = json(join(f.home, "shards.json"));
    expect(result.viewHash).toBe(publicPruneViewHash(view));
    expect(next).toEqual({ ...profile, pruneInputSetHash: result.viewHash });
    expect(nextShards).toEqual({ ...shards, selectorRevision: hashJSON(next) });
    expect(next.publicationFormat).toBe(profile.publicationFormat); expect(next.placementHead).toBe(profile.placementHead);
    expect(store.get(f.id, PROJECT)?.text).toBe(f.note.text);
    expect(store.profile.pruneInputSetHash).toBe(result.viewHash);
    for (const [name, file] of Object.entries(f.files)) { expect(facts[name]).toBeDefined(); expect(readFileSync(file, "utf8")).toBe(facts[name]!); }
    const added = store.note({ ...f.note, text: "synthetic after v3 maintenance" });
    expect(store.get(added, PROJECT)?.text).toBe("synthetic after v3 maintenance");
  } finally { store.close(); }
  const reopened = openShardStore({ memoryDir: f.home, project: PROJECT, deferPromotions: true });
  try { expect(reopened.get(f.id, PROJECT)?.text).toBe(f.note.text); } finally { reopened.close(); }
});

test("the same public-prune maintenance writer leaves a v2 home explicitly v2", async () => {
  const f = await fixture(false), before = json(join(f.home, "profile.json")), shards = json(join(f.home, "shards.json"));
  const { result } = await advanceEmptyUser(f);
  const profile = json(join(f.home, "profile.json")), nextShards = json(join(f.home, "shards.json"));
  expect(profile).toEqual({ ...before, pruneInputSetHash: result.viewHash });
  expect(nextShards).toEqual({ ...shards, selectorRevision: hashJSON(profile) });
  expect(profile.schema).toBe("agent-mem.profile/v2"); expect(nextShards.schema).toBe("agent-mem.shards/v2");
  expect(profile.publicationFormat).toBeUndefined(); expect(profile.placementHead).toBeUndefined();
  expect(existsSync(f.files.fence)).toBe(false);
});

for (const field of ["publicationFormat", "placementHead"] as const) test(`maintenance refuses an intervening change of v3 ${field} without a further writer change`, async () => {
  const f = await fixture(); let checkpointBytes: Record<string, string> | undefined;
  const persisted = () => Object.fromEntries(["profile.json", "shards.json", PUBLIC_PRUNE_INTENT, ...Object.values(f.files)].map(name => {
    const file = name.startsWith(f.home + "/") ? name : join(f.home, name); return [name, readFileSync(file, "utf8")];
  }));
  await expect(advanceEmptyUser(f, stage => {
    if (stage !== "after-intent") return;
    const file = join(f.home, "profile.json"), profile = json(file);
    write(file, { ...profile, [field]: field === "placementHead" ? "0".repeat(64) : "future-placement-format" });
    checkpointBytes = persisted();
  })).rejects.toThrow();
  expect(checkpointBytes).toBeDefined(); expect(persisted()).toEqual(checkpointBytes!);
  refusedWithoutEffects(f.home);
});
