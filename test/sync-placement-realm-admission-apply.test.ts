import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openShardStore } from "../src/memory/store.ts";
import type { SyncOptions } from "../src/memory/sync.ts";
import { memoryGitSync } from "../src/memory/platform.ts";
import { PlacementRealmRefusal, shardDir, shardKeyHash } from "../src/memory/shard.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { readEffectiveRealmInventory } from "../src/memory/sync-placement-realm-effective.ts";
import { readEffectiveSyncPlacementWriters } from "../src/memory/sync-placement-effective-writers.ts";
import { REALM_EXTENSION_LOG, readRealmExtensionHistory } from "../src/memory/sync-placement-realm-extension-storage.ts";
import { applyRealmAdmission, planRealmAbandon, previewRealmAdmission } from "../src/memory/sync-placement-realm-admission.ts";
import { REALM_INTENT_PREFIX } from "../src/memory/sync-placement-realm-pending.ts";
import { syncMemory } from "../src/memory/sync.ts";
import { bareRemote, closeInventoryFixtures, digest, expectedRefs, installSyntheticRealm, inventoryFixture, note, refsOf } from "./fakes/sync-placement-inventory.ts";

afterEach(closeInventoryFixtures);
const git = (dir: string, ...args: string[]) => { const result = memoryGitSync(["-C", dir, ...args], { encoding: "utf8" }); if (result.status !== 0) throw Error(`git ${args[0]} failed`); return result.stdout.trim(); };
/** A sync holds its own store open; a later migration fence needs it closed again. */
const syncing = (home: string) => async (options: SyncOptions) => {
  const store = openShardStore({ memoryDir: home, user: true, deferPromotions: true });
  try { return await syncMemory(store, options); } finally { store.close(); }
};
const intents = (home: string) => readdirSync(home).filter(name => name.startsWith(REALM_INTENT_PREFIX));
const bindingOf = (home: string) => {
  const markers = readPlacementRuntimeMarkers(home), active = readActivePlacementBinding(home, markers.profile, markers.shards)!;
  return { active, binding: { epochHash: active.profile.placementHead, activationHash: active.activation.seal, homeHash: active.epoch.homeHash,
    generation: active.epoch.generation, initialProjectHashes: active.activation.realms.flatMap(realm => realm.scope === "project" ? [realm.keyHash] : []) } };
};
const realmsOf = (home: string) => readEffectiveRealmInventory(home, bindingOf(home).active).realms;

test("#448: a retained writer inventory without current install evidence cannot authorize admission", async () => {
  const f = await inventoryFixture(1), realm = "example.test/placement/no-current-writer-proof";
  writeFileSync(join(f.home, "formats.json"), JSON.stringify([{ surface: "home", minReader: "0.21.0", since: "2026-11-06" }]) + "\n", { mode: 0o600 });
  expect(readEffectiveSyncPlacementWriters(f.home).roots).toBeUndefined();
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply" })).rejects.toThrow();
  expect(existsSync(join(f.home, REALM_EXTENSION_LOG))).toBe(false);
  expect(intents(f.home)).toEqual([]);
  expect(existsSync(join(shardDir(f.home, realm), "generation.json"))).toBe(false);
}, 240_000);

test("#448: a writer install changed after preview refuses before admission effects", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/writer-drift";
  expect(previewRealmAdmission(f.home, realm)).toMatchObject({ state: "not-local" });
  appendFileSync(join(f.extraWriterRoot!, "src", "index.ts"), "// changed after preview\n");
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply" })).rejects.toThrow();
  expect(existsSync(join(f.home, REALM_EXTENSION_LOG))).toBe(false);
  expect(intents(f.home)).toEqual([]);
  expect(existsSync(join(shardDir(f.home, realm), "generation.json"))).toBe(false);
}, 240_000);

test("#448: writer drift after intent refuses before curated metadata or append", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/writer-drift-after-intent";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-intent") appendFileSync(join(f.extraWriterRoot!, "src", "index.ts"), "// changed after intent\n");
  } })).rejects.toThrow();
  expect(existsSync(join(f.home, REALM_EXTENSION_LOG))).toBe(false);
  expect(intents(f.home)).toHaveLength(1);
  expect(existsSync(join(shardDir(f.home, realm), "generation.json"))).toBe(false);
}, 240_000);

test("#448: a policy change after intent refuses before appending an admission", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/policy-drift";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-intent") writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["DIFFERENT_POLICY_"] }) + "\n", { mode: 0o600 });
  } })).rejects.toThrow();
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(0);
  expect(intents(f.home)).toHaveLength(1);
}, 240_000);
test("#448: resume uses the frozen proof after interruption before append", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/proof-resume";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-proof") throw Error("fixture interruption");
  } })).rejects.toThrow();
  expect(intents(f.home)).toHaveLength(1);
  expect(readdirSync(f.home).filter(name => /^placement-realm-proof-.*\.json$/.test(name))).toHaveLength(1);
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(0);
  await expect(applyRealmAdmission(f.home, realm, { mode: "resume" })).resolves.toMatchObject({ state: "admitted", sequence: 1 });
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(1);
  expect(intents(f.home)).toHaveLength(0);
}, 240_000);

test("#448: resume refuses changed policy after a proof was retained", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/proof-policy-drift";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-proof") throw Error("fixture interruption");
  } })).rejects.toThrow();
  writeFileSync(join(f.home, "amem.config.json"), JSON.stringify({ piiPatterns: ["DIFFERENT_POLICY_"] }) + "\n", { mode: 0o600 });
  await expect(applyRealmAdmission(f.home, realm, { mode: "resume" })).rejects.toThrow();
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(0);
  expect(intents(f.home)).toHaveLength(1);
}, 240_000);

test("#448: a changed proof before append cannot authorize a record", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/proof-tamper";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-proof") {
      const name = readdirSync(f.home).find(item => /^placement-realm-proof-.*\.json$/.test(item))!;
      writeFileSync(join(f.home, name), "{}\n", { mode: 0o600 });
    }
  } })).rejects.toThrow();
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(0);
  expect(intents(f.home)).toHaveLength(1);
}, 240_000);

test("#448: confirmed abandon removes an attributable partial proof before append", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/proof-stage-abandon";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-proof") throw Error("fixture interruption");
  } })).rejects.toThrow();
  const name = readdirSync(f.home).find(item => /^placement-realm-proof-.*\.json$/.test(item))!;
  const file = join(f.home, name), bytes = readFileSync(file);
  rmSync(file); writeFileSync(`${file}.pending`, bytes.subarray(0, 80), { mode: 0o600 });
  expect(planRealmAbandon(f.home, realm)).toMatchObject({ state: "abandonable" });
  await expect(applyRealmAdmission(f.home, realm, { mode: "abandon", confirm: true })).resolves.toMatchObject({ state: "abandoned" });
  expect(existsSync(`${file}.pending`)).toBe(false);
  expect(intents(f.home)).toEqual([]);
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(0);
}, 240_000);

test("#448: abandon preview refuses a foreign proof stage", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/proof-stage-foreign";
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage === "after-proof") throw Error("fixture interruption");
  } })).rejects.toThrow();
  const name = readdirSync(f.home).find(item => /^placement-realm-proof-.*\.json$/.test(item))!;
  const file = join(f.home, name);
  rmSync(file); writeFileSync(`${file}.pending`, "foreign", { mode: 0o600 });
  expect(planRealmAbandon(f.home, realm)).toMatchObject({ state: "unavailable" });
  await expect(applyRealmAdmission(f.home, realm, { mode: "abandon", confirm: true })).rejects.toThrow();
  expect(readFileSync(`${file}.pending`, "utf8")).toBe("foreign");
  expect(intents(f.home)).toHaveLength(1);
}, 240_000);

/** The exact shape a kill between the append and the intent cleanup leaves: the frozen intent back and only a prefix of its record. */
function rewind(path: string, home: string, saved: { name: string; bytes: Buffer }, prefixBytes: number): void {
  const log = join(home, REALM_EXTENSION_LOG), bytes = readFileSync(log);
  writeFileSync(log, bytes.subarray(0, prefixBytes), { mode: 0o600 });
  writeFileSync(join(home, saved.name), saved.bytes, { mode: 0o600 });
}

test("#448 AC2: one apply appends the reviewed record for a curated realm and never repeats it", async () => {
  const f = await inventoryFixture(1, undefined, true), admitted = "example.test/placement/admitted-by-command";
  installSyntheticRealm(f.home, bindingOf(f.home).active.epoch.generation, admitted);
  const planned = previewRealmAdmission(f.home, admitted);
  expect(planned).toMatchObject({ state: "admissible", next: { mode: "existing", sequence: 1, previousLogBytes: 0 } });
  const result = await applyRealmAdmission(f.home, admitted, { mode: "apply" });
  expect(result).toMatchObject({ mode: "apply", state: "admitted", realm: digest(admitted), sequence: 1, created: false });
  // The intent is cleaned up last, so a completed admission retains no evidence of its own attempt.
  expect(intents(f.home)).toEqual([]);
  const history = readRealmExtensionHistory(f.home, bindingOf(f.home).binding);
  expect(history.records).toHaveLength(1);
  expect(history.records[0]).toMatchObject({ epochHash: f.epochHash, sequence: 1, realm: { scope: "project", keyHash: digest(admitted) } });
  expect(history.records[0]!.activationHash).toBe(bindingOf(f.home).active.activation.seal);
  expect(history.records[0]!.seal).toBe(result.headHash!);
  expect(realmsOf(f.home).some(realm => realm.scope === "project" && realm.keyHash === digest(admitted))).toBe(true);
  // The activation metadata that admitted the other realms is never rewritten by an admission.
  const before = bindingOf(f.home).active, markers = readPlacementRuntimeMarkers(f.home);
  const after = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  expect(after.activation.seal).toBe(before.activation.seal);
  expect(after.activation.realms).toEqual(before.activation.realms);
  expect(await applyRealmAdmission(f.home, admitted, { mode: "apply" })).toMatchObject({ state: "already-admitted" });
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(1);
}, 240_000);

test("#448 AC2: apply writes the realm's empty curated metadata, generation.json last, then admits it", async () => {
  const f = await inventoryFixture(1, undefined, true), fresh = "example.test/placement/arrived-after-activation", dir = shardDir(f.home, fresh);
  expect(previewRealmAdmission(f.home, fresh)).toMatchObject({ state: "not-local", next: { mode: "new", sequence: 1 } });
  expect(existsSync(join(dir, "generation.json"))).toBe(false);
  const result = await applyRealmAdmission(f.home, fresh, { mode: "apply" });
  expect(result).toMatchObject({ state: "admitted", created: true });
  for (const name of ["project.json", "machine.json", "legacy/machine.json", "legacy-main/machine.json", "migration-sources.json", "generation-seal.json", "generation.json"])
    expect(existsSync(join(dir, name))).toBe(true);
  // The realm is curated for every reader from that point: openable, inventorable and writable.
  const store = openShardStore({ memoryDir: f.home, project: fresh, deferPromotions: true });
  try { store.note(note("admitted after activation", fresh)); } finally { store.close(); }
  expect(realmsOf(f.home).some(realm => realm.scope === "project" && realm.keyHash === digest(fresh))).toBe(true);
  expect(intents(f.home)).toEqual([]);
}, 240_000);

test("#448 AC2: an interrupted append resumes from its frozen prefix, and a committed one resumes as cleanup only", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/interrupted";
  installSyntheticRealm(f.home, bindingOf(f.home).active.epoch.generation, realm);
  let saved: { name: string; bytes: Buffer } | undefined;
  await applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage !== "after-metadata") return;
    const name = intents(f.home)[0]!; saved = { name, bytes: readFileSync(join(f.home, name)) };
  } });
  expect(saved).toBeDefined();
  // A chain holding an unattributable tail is unavailable; this one is attributed to the retained intent.
  rewind(join(f.home, REALM_EXTENSION_LOG), f.home, saved!, 200);
  expect(previewRealmAdmission(f.home, realm)).toMatchObject({ state: "unavailable" });
  const resumed = await applyRealmAdmission(f.home, realm, { mode: "resume" });
  expect(resumed).toMatchObject({ mode: "resume", state: "admitted", sequence: 1 });
  expect(intents(f.home)).toEqual([]);
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(1);
  // Reinstating the intent over the already committed record is cleanup only: the same seal, no second line.
  writeFileSync(join(f.home, saved!.name), saved!.bytes, { mode: 0o600 });
  const cleanupOnly = await applyRealmAdmission(f.home, realm, { mode: "resume" });
  expect(cleanupOnly).toMatchObject({ state: "admitted", sequence: 1, headHash: resumed.headHash });
  expect(intents(f.home)).toEqual([]);
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toHaveLength(1);
  // An append for the same realm can never be applied twice.
  await expect(applyRealmAdmission(f.home, realm, { mode: "apply" })).resolves.toMatchObject({ state: "already-admitted" });
}, 240_000);

test("#448 AC2: a person abandon previews, then removes only the retained intent and its incomplete bytes", async () => {
  const f = await inventoryFixture(1, undefined, true), realm = "example.test/placement/abandoned";
  installSyntheticRealm(f.home, bindingOf(f.home).active.epoch.generation, realm);
  let saved: { name: string; bytes: Buffer } | undefined;
  await applyRealmAdmission(f.home, realm, { mode: "apply", checkpoint: stage => {
    if (stage !== "after-metadata") return;
    const name = intents(f.home)[0]!; saved = { name, bytes: readFileSync(join(f.home, name)) };
  } });
  rewind(join(f.home, REALM_EXTENSION_LOG), f.home, saved!, 180);
  expect(planRealmAbandon(f.home, realm)).toMatchObject({ state: "abandonable", sequence: 1, discards: 180 });
  const retained = await applyRealmAdmission(f.home, realm, { mode: "abandon" });
  expect(retained).toMatchObject({ state: "retained", sequence: 1, discarded: 180 });
  expect(intents(f.home)).toHaveLength(1);
  expect(readFileSync(join(f.home, REALM_EXTENSION_LOG))).toHaveLength(180);
  const abandoned = await applyRealmAdmission(f.home, realm, { mode: "abandon", confirm: true });
  expect(abandoned).toMatchObject({ state: "abandoned", discarded: 180 });
  expect(intents(f.home)).toEqual([]);
  expect(existsSync(join(f.home, REALM_EXTENSION_LOG))).toBe(false);
  expect(readRealmExtensionHistory(f.home, bindingOf(f.home).binding).records).toEqual([]);
  expect(planRealmAbandon(f.home, realm)).toMatchObject({ state: "none" });
  // Once the append committed, abandon refuses and names resume instead of removing committed evidence.
  const readmitted = await applyRealmAdmission(f.home, realm, { mode: "apply" });
  expect(readmitted).toMatchObject({ state: "admitted" });
  writeFileSync(join(f.home, saved!.name), saved!.bytes, { mode: 0o600 });
  expect(planRealmAbandon(f.home, realm)).toMatchObject({ state: "committed" });
  await expect(applyRealmAdmission(f.home, realm, { mode: "abandon", confirm: true })).rejects.toThrow(/--resume/);
  // Resume over a committed position is cleanup only: the same seal, no second line, no new effect.
  await expect(applyRealmAdmission(f.home, realm, { mode: "resume" })).resolves.toMatchObject({ state: "admitted", sequence: 1, headHash: readmitted.headHash });
}, 240_000);

test("#448 AC3: a realm outside B's inventory is refused and unpublished until B admits it, while A keeps publishing it", async () => {
  const shared = "example.test/placement/ac3-shared", onlyA = "example.test/placement/ac3-only-a";
  const a = await inventoryFixture(2, [shared, onlyA], true), b = await inventoryFixture(1, [shared], true);
  const remote = bareRemote(), syncA = syncing(a.home), syncB = syncing(b.home), synced = await syncA(a.opts(remote));
  expect(synced.ok).toBe(true);
  expect(refsOf(remote)).toEqual(expectedRefs([shared, onlyA]));
  // Both homes use the same remote, including the user and shared project refs.
  const ref = `refs/heads/amem/p/${shardKeyHash(onlyA)}`;
  const published = git(remote, "rev-parse", ref);
  installSyntheticRealm(b.home, bindingOf(b.home).active.epoch.generation, onlyA);
  const before = refsOf(remote), localState = () => ({
    extension: existsSync(join(b.home, REALM_EXTENSION_LOG)), intents: intents(b.home),
    activation: bindingOf(b.home).active.activation.seal, realms: realmsOf(b.home).map(realm => realm.scope === "user" ? "user" : realm.keyHash),
  });

  const local = localState();
  // B's ordinary sync covers its own two realms and never opens, publishes or removes the third.
  const first = await syncB(b.opts(remote));
  expect(first.ok).toBe(true);
  expect(first.placementRealms!.map(item => item.realm)).not.toContain(digest(onlyA));
  expect(refsOf(remote)).toEqual(before);
  expect(git(remote, "rev-parse", ref)).toBe(published);
  expect(localState()).toEqual(local);
  // An explicit open or curated write of that realm refuses before any effect and names the admission command.
  const open = () => openShardStore({ memoryDir: b.home, project: onlyA, deferPromotions: true });
  expect(open).toThrow(PlacementRealmRefusal);
  const refusal = (() => { try { open(); } catch (error) { return error as PlacementRealmRefusal; } })()!;
  expect(refusal.message).toContain("--admit");
  expect(refusal.message).toContain(`keyHash=${digest(onlyA)}`);
  expect(refusal.message).toContain("scope=project");
  expect(localState()).toEqual(local);
  // Once B admits it, the same command adds the realm to B's inventory and B publishes it alongside the rest.
  expect(await applyRealmAdmission(b.home, onlyA, { mode: "apply" })).toMatchObject({ state: "admitted" });
  const admitted = await syncB(b.opts(remote));
  expect(admitted.ok).toBe(true);
  expect(admitted.placementRealms!.map(item => item.realm)).toContain(digest(onlyA));
  expect(refsOf(remote)).toContain(ref);
  // B has no rows for that realm, so A's published history is left untouched rather than rewritten.
  expect(git(remote, "rev-parse", ref)).toBe(published);
  expect((await syncA(a.opts(remote))).ok).toBe(true);
}, 240_000);
