import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRealmIntent, REALM_INTENT_SCHEMA, validateRealmIntent, type RealmIntentBody } from "../src/memory/sync-placement-realm-intent-format.ts";
import { realmExtensionGenesis } from "../src/memory/sync-placement-realm-extension-format.ts";

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
