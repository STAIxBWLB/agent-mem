import { expect, test } from "bun:test";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_LIMIT, REALM_EXTENSION_SCHEMA, validateRealmExtension, type RealmExtensionBody } from "../src/memory/sync-placement-realm-extension-format.ts";

const hex = (n: string) => n.repeat(64), epochHash = hex("a"), activationHash = hex("b");
function body(): RealmExtensionBody {
  return { schema: REALM_EXTENSION_SCHEMA, epochHash, activationHash, homeHash: hex("c"), generation: "d".repeat(32), sequence: 1,
    previousHash: realmExtensionGenesis(epochHash, activationHash), realm: { scope: "project", keyHash: hex("e"), bindingHash: hex("f") },
    sourceHash: hex("1"), aliasesHash: hex("2"), policyHash: hex("3"), writerHash: hex("4"), journal: { sequence: 0, headHash: epochHash } };
}

test("#448: extension seals bind one realm, epoch, source, policy, writers and journal without raw project keys", () => {
  const record = createRealmExtension(body()); expect(validateRealmExtension(record)).toEqual(record);
  expect(JSON.stringify(record)).not.toContain("project-name");
  for (const changed of [{ ...record, homeHash: hex("9") }, { ...record, extra: true }, { ...record, realm: { ...record.realm, key: "project-name" } },
    { ...record, sequence: REALM_EXTENSION_LIMIT + 1 }, { ...record, previousHash: hex("0") }, { ...record, journal: { sequence: 0, headHash: hex("9") } }]) expect(() => validateRealmExtension(changed)).toThrow();
});

test("#448: extension validation never invokes a getter or accepts proxy metadata", () => {
  let called = false; const input = { ...createRealmExtension(body()) } as Record<string, unknown>;
  Object.defineProperty(input, "policyHash", { enumerable: true, get() { called = true; return hex("3"); } });
  expect(() => validateRealmExtension(input)).toThrow(); expect(called).toBe(false);
  expect(() => validateRealmExtension(new Proxy(createRealmExtension(body()), {}))).toThrow();
});
