import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { canonicalJSON } from "../src/memory/generation.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { writerInventoryGenesis } from "../src/memory/sync-placement-writer-revision-format.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA, type RealmExtensionBody } from "../src/memory/sync-placement-realm-extension-format.ts";
import { REALM_EXTENSION_LOG } from "../src/memory/sync-placement-realm-extension-storage.ts";
import { readEffectiveRealmInventory } from "../src/memory/sync-placement-realm-effective.ts";
import { createRealmIntent, REALM_INTENT_SCHEMA } from "../src/memory/sync-placement-realm-intent-format.ts";
import { createPlacementInspectionFixture, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const homes: PlacementInspectionFixture[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); });
const hex = (n: string) => n.repeat(64);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const f = await createPlacementInspectionFixture(); homes.push(f);
  const markers = readPlacementRuntimeMarkers(f.home), active = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  const body: RealmExtensionBody = { schema: REALM_EXTENSION_SCHEMA, epochHash: f.epochHash, activationHash: active.activation.seal, homeHash: active.epoch.homeHash,
    generation: f.generation, sequence: 1, previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal),
    realm: { scope: "project" as const, keyHash: hex("1"), bindingHash: hex("2") }, sourceHash: hex("3"), aliasesHash: hex("4"), policyHash: hex("5"),
    writerHash: writerInventoryGenesis(f.epochHash, active.activation.seal), journal: { sequence: 0, headHash: f.epochHash } };
  return { f, active, body, file: join(f.home, REALM_EXTENSION_LOG) };
}
const write = (file: string, value: unknown) => writeFileSync(file, canonicalJSON(value) + "\n", { mode: 0o600 });

test("#448: effective inventory adds the sealed realm without changing original activation", async () => {
  const { f, active, body, file } = await fixture(), original = canonicalJSON(active.activation), record = createRealmExtension(body);
  write(file, record); const effective = readEffectiveRealmInventory(f.home, active);
  expect(effective.realms).toContainEqual(record.realm); expect(effective.realms).toHaveLength(active.activation.realms.length + 1);
  expect(canonicalJSON(active.activation)).toBe(original); effective.assertCurrent();
  write(file, createRealmExtension({ ...body, realm: { ...body.realm, keyHash: hex("9") } })); expect(() => effective.assertCurrent()).toThrow();
});

test("#448: effective inventory rejects a forged writer prefix or missing journal anchor", async () => {
  const { f, active, body, file } = await fixture();
  write(file, createRealmExtension({ ...body, writerHash: hex("a") })); expect(() => readEffectiveRealmInventory(f.home, active)).toThrow();
  write(file, createRealmExtension({ ...body, journal: { sequence: 1, headHash: hex("b") } })); expect(() => readEffectiveRealmInventory(f.home, active)).toThrow();
});

test("#448: an attributed interrupted admission keeps the activation realms in force", async () => {
  const { f, active, body, file } = await fixture(), project = "/scratch/admitted-project", key = sha(project);
  const partial = canonicalJSON(createRealmExtension(body)).slice(0, -12);
  writeFileSync(file, partial, { mode: 0o600 });
  expect(() => readEffectiveRealmInventory(f.home, active)).toThrow();
  writeFileSync(join(f.home, `placement-realm-intent-${key}.json`), canonicalJSON(createRealmIntent({ schema: REALM_INTENT_SCHEMA, home: f.home, project,
    keyHash: key, machine: "0".repeat(16), epochHash: f.epochHash, activationHash: active.activation.seal, homeHash: active.epoch.homeHash, generation: f.generation,
    sequence: 1, previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal), previousLogBytes: 0, previousLogHash: sha(""),
    mode: "new", descriptorHash: null, sourceHash: null, aliasesHash: body.aliasesHash, policyHash: body.policyHash, writerHash: body.writerHash,
    journal: { sequence: 0, headHash: f.epochHash } })) + "\n", { mode: 0o600 });
  const effective = readEffectiveRealmInventory(f.home, active);
  expect(effective.realms).toEqual(active.activation.realms); effective.assertCurrent();
});
