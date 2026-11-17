import { afterEach, expect, test } from "bun:test";
import { chmodSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON } from "../src/memory/generation.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA } from "../src/memory/sync-placement-realm-extension-format.ts";
import { readRealmExtensionHistory, REALM_EXTENSION_LOG, type RealmExtensionBinding } from "../src/memory/sync-placement-realm-extension-storage.ts";
import { createPlacementInspectionFixture, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const homes: PlacementInspectionFixture[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); });
const hex = (n: string) => n.repeat(64);
async function fixture() {
  const f = await createPlacementInspectionFixture(); homes.push(f);
  const markers = readPlacementRuntimeMarkers(f.home), active = readActivePlacementBinding(f.home, markers.profile, markers.shards)!;
  const binding: RealmExtensionBinding = { epochHash: f.epochHash, activationHash: active.activation.seal, homeHash: active.epoch.homeHash,
    generation: active.epoch.generation, initialProjectHashes: active.activation.realms.flatMap(realm => realm.scope === "project" ? [realm.keyHash] : []) };
  const make = (keyHash: string, sequence = 1, previousHash = realmExtensionGenesis(binding.epochHash, binding.activationHash)) => createRealmExtension({
    schema: REALM_EXTENSION_SCHEMA, epochHash: binding.epochHash, activationHash: binding.activationHash, homeHash: binding.homeHash, generation: binding.generation,
    sequence, previousHash, realm: { scope: "project", keyHash, bindingHash: hex("a") }, sourceHash: hex("b"), aliasesHash: hex("c"), policyHash: hex("d"), writerHash: hex("e"),
    journal: { sequence: 0, headHash: binding.epochHash },
  });
  return { f, binding, make, file: join(f.home, REALM_EXTENSION_LOG) };
}
const text = (value: unknown) => canonicalJSON(value) + "\n";

test("#448: extension chain verifies original binding, sequence and unchanged bytes", async () => {
  const { f, binding, make, file } = await fixture(), first = make(hex("1")), second = make(hex("2"), 2, first.seal);
  const absent = readRealmExtensionHistory(f.home, binding); expect(absent.records).toEqual([]); absent.assertCurrent();
  writeFileSync(file, text(first) + text(second), { mode: 0o600 }); expect(() => absent.assertCurrent()).toThrow();
  const history = readRealmExtensionHistory(f.home, binding); expect(history.records).toEqual([first, second]); expect(history.headHash).toBe(second.seal); history.assertCurrent();
  writeFileSync(file, text(first), { mode: 0o600 }); expect(() => history.assertCurrent()).toThrow();
});

test("#448: extension journal anchors cannot rewind or change at the same sequence", async () => {
  const { f, binding, make, file } = await fixture(), base = make(hex("1"));
  const { seal: _firstSeal, ...firstBody } = base;
  const first = createRealmExtension({ ...firstBody, journal: { sequence: 1, headHash: hex("5") } });
  const { seal: _secondSeal, ...secondBody } = make(hex("2"), 2, first.seal);
  for (const journal of [{ sequence: 0, headHash: binding.epochHash }, { sequence: 1, headHash: hex("6") }]) {
    const second = createRealmExtension({ ...secondBody, journal });
    writeFileSync(file, text(first) + text(second), { mode: 0o600 });
    expect(() => readRealmExtensionHistory(f.home, binding)).toThrow();
  }
});

test("#448: extension history fails closed on duplicate, foreign and unsafe evidence", async () => {
  const { f, binding, make, file } = await fixture(), first = make(hex("1"));
  const initial = binding.initialProjectHashes[0]!, collision = initial.slice(0, 16) + (initial.slice(16) === "f".repeat(48) ? "e" : "f").repeat(48);
  const cases = [text(first) + text(make(hex("1"), 2, first.seal)), text(make(initial)), text(make(collision)), text({ ...first, homeHash: hex("9") })];
  for (const value of cases) { writeFileSync(file, value, { mode: 0o600 }); expect(() => readRealmExtensionHistory(f.home, binding)).toThrow(); }
  writeFileSync(file, text(first), { mode: 0o600 }); chmodSync(file, 0o644); expect(() => readRealmExtensionHistory(f.home, binding)).toThrow();
  rmSync(file); symlinkSync(join(f.home, "profile.json"), file); expect(() => readRealmExtensionHistory(f.home, binding)).toThrow();
});

test("#448: an interrupted final append is reported torn instead of closing the chain to existing realms", async () => {
  const { f, binding, make, file } = await fixture(), first = make(hex("1")), second = make(hex("2"), 2, first.seal);
  const alone = text(second).slice(0, -12);                                     // no complete line at all: nothing is applied
  writeFileSync(file, alone, { mode: 0o600 });
  const empty = readRealmExtensionHistory(f.home, binding);
  expect(empty.records).toEqual([]); expect(empty.torn).toEqual(Buffer.from(alone));
  const tail = text(second).slice(0, -14);                                      // one complete record, then a torn second
  writeFileSync(file, text(first) + tail, { mode: 0o600 });
  const history = readRealmExtensionHistory(f.home, binding);
  expect(history.records).toEqual([first]); expect(history.headHash).toBe(first.seal);
  expect(history.torn).toEqual(Buffer.from(tail));
  history.assertCurrent();
});
