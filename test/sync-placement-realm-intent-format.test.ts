import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRealmIntent, REALM_INTENT_SCHEMA, validateRealmIntent, type RealmIntentBody } from "../src/memory/sync-placement-realm-intent-format.ts";
import { createRealmExtension, REALM_EXTENSION_SCHEMA, realmExtensionGenesis } from "../src/memory/sync-placement-realm-extension-format.ts";
import { canonicalJSON } from "../src/memory/generation.ts";
import { verifyTornRealmAppend } from "../src/memory/sync-placement-realm-torn.ts";

const hex = (n: string) => n.repeat(64), sha = (text: string) => createHash("sha256").update(text).digest("hex");
function input(): RealmIntentBody {
  const epochHash = hex("a"), activationHash = hex("b"), project = "example.test/synthetic/project";
  return { schema: REALM_INTENT_SCHEMA, home: "/synthetic/memory", project, keyHash: sha(project), machine: "c".repeat(16), epochHash, activationHash,
    homeHash: hex("d"), generation: "e".repeat(32), sequence: 1, previousHash: realmExtensionGenesis(epochHash, activationHash), previousLogBytes: 0, previousLogHash: sha(""),
    mode: "new", descriptorHash: null, sourceHash: null, aliasesHash: hex("1"), policyHash: hex("2"), writerHash: hex("3"), journal: { sequence: 0, headHash: epochHash } };
}

test("#448: a sealed intent binds identity, prior chain, writer and journal without granting authority", () => {
  const intent = createRealmIntent(input()); expect(validateRealmIntent(intent)).toEqual(intent);
  for (const value of [{ ...intent, project: "different" }, { ...intent, home: "/a/../b" }, { ...intent, previousLogHash: hex("9") },
    { ...intent, previousLogBytes: 1 }, { ...intent, mode: "existing" }, { ...intent, journal: { sequence: 0, headHash: hex("8") } }, { ...intent, extra: true }])
    expect(() => validateRealmIntent(value)).toThrow();
});

test("#448: intent parsing rejects accessors and proxies without invoking them", () => {
  let invoked = false; const value = { ...createRealmIntent(input()) } as Record<string, unknown>;
  Object.defineProperty(value, "project", { enumerable: true, get() { invoked = true; return "secret"; } });
  expect(() => validateRealmIntent(value)).toThrow(); expect(invoked).toBe(false);
  expect(() => validateRealmIntent(new Proxy(createRealmIntent(input()), {}))).toThrow();
});

test("#448: only an exact incomplete frozen record may be treated as a torn append", () => {
  const intent = createRealmIntent(input());
  const record = createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash: intent.epochHash, activationHash: intent.activationHash,
    homeHash: intent.homeHash, generation: intent.generation, sequence: intent.sequence, previousHash: intent.previousHash,
    realm: { scope: "project", keyHash: intent.keyHash, bindingHash: hex("4") }, sourceHash: hex("5"), aliasesHash: intent.aliasesHash,
    policyHash: intent.policyHash, writerHash: intent.writerHash, journal: intent.journal });
  const line = Buffer.from(canonicalJSON(record) + "\n"), partial = line.subarray(0, line.length - 1);
  expect(verifyTornRealmAppend(partial, intent, record)).toEqual(Buffer.alloc(0));
  expect(() => verifyTornRealmAppend(line, intent, record)).toThrow();
  expect(() => verifyTornRealmAppend(Buffer.concat([partial, Buffer.from("x")]), intent, record)).toThrow();
  expect(() => verifyTornRealmAppend(Buffer.alloc(0), intent, record)).toThrow();
  const { seal: _seal, ...body } = record;
  const other = createRealmExtension({ ...body, realm: { ...record.realm, keyHash: hex("6") } });
  expect(() => verifyTornRealmAppend(partial, intent, other)).toThrow();
});
