import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { readActivePlacementBinding } from "../src/memory/sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "../src/memory/sync-placement-guard.ts";
import { attributeTornRealmAppend } from "../src/memory/sync-placement-realm-attribution.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA } from "../src/memory/sync-placement-realm-extension-format.ts";
import { readRealmExtensionHistory, REALM_EXTENSION_LOG, type RealmExtensionBinding, type RealmExtensionOptions } from "../src/memory/sync-placement-realm-extension-storage.ts";
import { createRealmIntent, REALM_INTENT_SCHEMA, type RealmIntent, type RealmIntentBody } from "../src/memory/sync-placement-realm-intent-format.ts";
import type { RealmExtension } from "../src/memory/sync-placement-realm-extension-format.ts";
import { REALM_INTENT_PREFIX } from "../src/memory/sync-placement-realm-pending.ts";
import { createPlacementInspectionFixture, type PlacementInspectionFixture } from "./fakes/sync-placement-inspection.ts";

const homes: PlacementInspectionFixture[] = [];
afterEach(() => { for (const home of homes.splice(0).reverse()) home.close(); });
const hex = (n: string) => n.repeat(64);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const project = "/scratch/admitted-project", keyHash = sha(project);
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
  const intent = (overrides: Partial<RealmIntentBody> = {}) => createRealmIntent({ schema: REALM_INTENT_SCHEMA, home: f.home, project, keyHash,
    machine: "0".repeat(16), epochHash: binding.epochHash, activationHash: binding.activationHash, homeHash: binding.homeHash, generation: binding.generation,
    sequence: 1, previousHash: realmExtensionGenesis(binding.epochHash, binding.activationHash), previousLogBytes: 0, previousLogHash: sha(""),
    mode: "new", descriptorHash: null, sourceHash: null, aliasesHash: hex("c"), policyHash: hex("d"), writerHash: hex("e"),
    journal: { sequence: 0, headHash: binding.epochHash }, ...overrides });
  const pending = (body: RealmIntent, record?: RealmExtension) => {
    const path = join(f.home, `${REALM_INTENT_PREFIX}${keyHash}.json`);
    writeFileSync(path, canonicalJSON(body) + "\n", { mode: 0o600 });
    if (record) {
      const proof = { schema: "agent-mem.sync-placement-realm-proof/v1", intent: body.seal, record };
      writeFileSync(join(f.home, `placement-realm-proof-${body.seal}.json`), canonicalJSON({ ...proof, seal: hashJSON(proof) }) + "\n", { mode: 0o600 });
    }
    return path;
  };
  const options: RealmExtensionOptions = { attributeTorn: evidence => attributeTornRealmAppend(f.home, binding, evidence) };
  return { f, binding, make, intent, pending, options, file: join(f.home, REALM_EXTENSION_LOG) };
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

test("#448: an unattributed tail closes the chain instead of granting partial trust", async () => {
  const { f, binding, make, file, options } = await fixture(), first = make(hex("1"));
  const tail = text(make(hex("2"), 2, first.seal)).slice(0, -14);
  writeFileSync(file, text(first) + tail, { mode: 0o600 });
  expect(() => readRealmExtensionHistory(f.home, binding)).toThrow();
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
});

test("#448: a matching pending intent and proof keep the completed prefix readable", async () => {
  const { f, binding, make, file, intent, pending, options } = await fixture();
  const first = make(hex("1")), second = make(keyHash, 2, first.seal), tail = text(second).slice(0, -14);
  pending(intent({ sequence: 2, previousHash: first.seal, previousLogBytes: Buffer.byteLength(text(first)), previousLogHash: sha(text(first)) }), second);
  writeFileSync(file, text(first) + tail, { mode: 0o600 });
  const history = readRealmExtensionHistory(f.home, binding, options);
  expect(history.records).toEqual([first]); expect(history.headHash).toBe(first.seal); expect(history.torn).toEqual(Buffer.from(tail));
  history.assertCurrent();
});

test("#448: an intent cannot attribute an altered or different-realm tail", async () => {
  const { f, binding, make, file, intent, pending, options } = await fixture();
  const first = make(hex("1")), second = make(keyHash, 2, first.seal);
  const frozen = intent({ sequence: 2, previousHash: first.seal, previousLogBytes: Buffer.byteLength(text(first)), previousLogHash: sha(text(first)) });
  pending(frozen);
  writeFileSync(file, text(first) + text(second).slice(0, -14), { mode: 0o600 });
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow(); // intent alone is not a proof
  pending(frozen, second);
  const other = make(hex("2"), 2, first.seal);
  writeFileSync(file, text(first) + text(other).slice(0, -14), { mode: 0o600 });
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
  const { seal: _seal, ...body } = second;
  const altered = createRealmExtension({ ...body, sourceHash: hex("f") });
  writeFileSync(file, text(first) + text(altered).slice(0, -14), { mode: 0o600 });
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
});

test("#448: a truncated record is not attributed by an intent for another position", async () => {
  const { f, binding, make, file, intent, pending, options } = await fixture();
  const first = make(hex("1")), second = make(hex("2"), 2, first.seal), whole = text(first) + text(second);
  pending(intent({ sequence: 3, previousHash: second.seal, previousLogBytes: Buffer.byteLength(whole), previousLogHash: sha(whole) }));
  writeFileSync(file, whole.slice(0, -14), { mode: 0o600 });
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
});

test("#448: an intent that does not pin this prefix or is unsafe never attributes the tail", async () => {
  const { f, binding, make, file, intent, pending, options } = await fixture();
  const first = make(hex("1")), tail = text(make(hex("2"), 2, first.seal)).slice(0, -14);
  const exact = { sequence: 2, previousHash: first.seal, previousLogBytes: Buffer.byteLength(text(first)), previousLogHash: sha(text(first)) };
  const path = pending(intent({ ...exact, previousLogHash: hex("7") }));
  writeFileSync(file, text(first) + tail, { mode: 0o600 });
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
  pending(intent(exact)); chmodSync(path, 0o644);
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
  writeFileSync(path, "{torn", { mode: 0o600 }); chmodSync(path, 0o600);
  expect(() => readRealmExtensionHistory(f.home, binding, options)).toThrow();
});
