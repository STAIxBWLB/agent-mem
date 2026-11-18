import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "../src/memory/generation.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA } from "../src/memory/sync-placement-realm-extension-format.ts";
import { REALM_EXTENSION_LOG } from "../src/memory/sync-placement-realm-extension-storage.ts";
import { previewRealmAdmission } from "../src/memory/sync-placement-realm-admission.ts";
import { writerInventoryGenesis } from "../src/memory/sync-placement-writer-revision-format.ts";
import { shardDir } from "../src/memory/shard.ts";
import { closeInventoryFixtures, digest, installSyntheticRealm, inventoryFixture } from "./fakes/sync-placement-inventory.ts";

afterEach(closeInventoryFixtures);
const admitted = "example.test/placement/preview-realm";

test("#448: a curated realm outside the activation previews the exact append it would make, and writes nothing", async () => {
  const f = await inventoryFixture(1), markers = readPlacementRuntimeMarkers(f.home), active = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  installSyntheticRealm(f.home, active.epoch.generation, admitted);
  const before = readdirSync(f.home).sort(), preview = previewRealmAdmission(f.home, admitted);
  expect(preview.state).toBe("admissible"); expect(preview.realm).toBe(digest(admitted));
  expect(preview.next).toMatchObject({ sequence: 1, previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal),
    previousLogBytes: 0, previousLogHash: digest(""), writerHash: writerInventoryGenesis(f.epochHash, active.activation.seal),
    journal: { sequence: 0, headHash: f.epochHash } });
  expect(preview.next!.bindingHash).toMatch(/^[a-f0-9]{64}$/); expect(preview.next!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  // A preview is a report: no extension log, no intent, no new file of any kind.
  expect(readdirSync(f.home).sort()).toEqual(before); expect(existsSync(join(f.home, REALM_EXTENSION_LOG))).toBe(false);
});

test("#448: the preview names a realm it cannot admit instead of inventing an append", async () => {
  const f = await inventoryFixture(1), markers = readPlacementRuntimeMarkers(f.home), active = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  // No curated shard on this machine: the same not-local state 0.28.2 and the #450 driver report.
  expect(previewRealmAdmission(f.home, "example.test/placement/never-received")).toMatchObject({ state: "not-local" });
  // An activated realm is never re-appended, and an admitted one is reported the same way.
  expect(previewRealmAdmission(f.home, f.projects[0]!)).toMatchObject({ state: "already-admitted" });
  installSyntheticRealm(f.home, active.epoch.generation, admitted);
  writeFileSync(join(f.home, REALM_EXTENSION_LOG), canonicalJSON(createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: f.epochHash,
    activationHash: active.activation.seal, homeHash: active.epoch.homeHash, generation: active.epoch.generation, sequence: 1,
    previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal), realm: { scope: "project", keyHash: digest(admitted), bindingHash: digest("binding") },
    sourceHash: digest("source"), aliasesHash: digest("aliases"), policyHash: digest("policy"), writerHash: writerInventoryGenesis(f.epochHash, active.activation.seal),
    journal: { sequence: 0, headHash: f.epochHash } })) + "\n", { mode: 0o600 });
  expect(previewRealmAdmission(f.home, admitted)).toMatchObject({ state: "already-admitted" });
  // The next realm's previewed position is one past the appended record.
  installSyntheticRealm(f.home, active.epoch.generation, "example.test/placement/second-realm");
  expect(previewRealmAdmission(f.home, "example.test/placement/second-realm").next).toMatchObject({ sequence: 2 });
  // A torn tail is not something a preview may append over.
  const log = join(f.home, REALM_EXTENSION_LOG);
  writeFileSync(log, canonicalJSON(createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: f.epochHash, activationHash: active.activation.seal,
    homeHash: active.epoch.homeHash, generation: active.epoch.generation, sequence: 1, previousHash: realmExtensionGenesis(f.epochHash, active.activation.seal),
    realm: { scope: "project", keyHash: digest(admitted), bindingHash: digest("binding") }, sourceHash: digest("source"), aliasesHash: digest("aliases"),
    policyHash: digest("policy"), writerHash: writerInventoryGenesis(f.epochHash, active.activation.seal), journal: { sequence: 0, headHash: f.epochHash } })).slice(0, -12), { mode: 0o600 });
  expect(previewRealmAdmission(f.home, "example.test/placement/second-realm")).toMatchObject({ state: "unavailable" });
  expect(existsSync(shardDir(f.home, admitted))).toBe(true);
});
