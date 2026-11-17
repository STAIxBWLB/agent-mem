import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "../src/memory/generation.ts";
import { acquireMutation } from "../src/memory/mutation.ts";
import { realPath } from "../src/memory/platform.ts";
import { createRealmExtension, realmExtensionGenesis, REALM_EXTENSION_SCHEMA } from "../src/memory/sync-placement-realm-extension-format.ts";
import { createRealmIntent, REALM_INTENT_SCHEMA } from "../src/memory/sync-placement-realm-intent-format.ts";
import { clearRealmProof, readRealmProof, writeRealmProof } from "../src/memory/sync-placement-realm-proof.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hex = (value: string) => value.repeat(64);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const home = realPath(mkdtempSync(join(tmpdir(), "amem-realm-proof-"))); roots.push(home);
  const project = "example.test/proof", epochHash = hex("1"), activationHash = hex("2"), homeHash = hex("3"), generation = "4".repeat(32);
  const intent = createRealmIntent({ schema: REALM_INTENT_SCHEMA, home, project, keyHash: sha(project), machine: "0".repeat(16),
    epochHash, activationHash, homeHash, generation, sequence: 1, previousHash: realmExtensionGenesis(epochHash, activationHash),
    previousLogBytes: 0, previousLogHash: sha(""), mode: "new", descriptorHash: null, sourceHash: null,
    aliasesHash: hex("5"), policyHash: hex("6"), writerHash: hex("7"), journal: { sequence: 0, headHash: epochHash } });
  const record = createRealmExtension({ schema: REALM_EXTENSION_SCHEMA, epochHash, activationHash, homeHash, generation,
    sequence: 1, previousHash: intent.previousHash, realm: { scope: "project", keyHash: intent.keyHash, bindingHash: hex("8") },
    sourceHash: hex("9"), aliasesHash: intent.aliasesHash, policyHash: intent.policyHash, writerHash: intent.writerHash, journal: intent.journal });
  const body = { schema: "agent-mem.sync-placement-realm-proof/v1", intent: intent.seal, record };
  const text = canonicalJSON({ ...body, seal: hashJSON(body) }) + "\n", file = join(home, `placement-realm-proof-${intent.seal}.json`);
  const mutation = acquireMutation(home); if (!mutation) throw Error("fixture mutation unavailable");
  return { home, intent, record, text, file, mutation, proof: { mutation, assertCurrent: () => {} } };
}

test("a frozen proof resumes an exact staging prefix and validates private bytes", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.file}.pending`, Buffer.from(f.text).subarray(0, 80), { mode: 0o600 });
    writeRealmProof(f.home, f.intent, f.record, f.proof);
    expect(readFileSync(f.file, "utf8")).toBe(f.text);
    expect(readRealmProof(f.home, f.intent)).toEqual(f.record);
    writeRealmProof(f.home, f.intent, f.record, f.proof);
    clearRealmProof(f.home, f.intent, f.proof);
    expect(readRealmProof(f.home, f.intent)).toBeUndefined();
  } finally { f.mutation(); }
});

test("foreign staging and unsafe proof files refuse without replacing them", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.file}.pending`, "foreign", { mode: 0o600 });
    expect(() => writeRealmProof(f.home, f.intent, f.record, f.proof)).toThrow();
    expect(readFileSync(`${f.file}.pending`, "utf8")).toBe("foreign");
    rmSync(`${f.file}.pending`);
    symlinkSync(join(f.home, "missing"), `${f.file}.pending`);
    expect(() => writeRealmProof(f.home, f.intent, f.record, f.proof)).toThrow();
    rmSync(`${f.file}.pending`);
    writeRealmProof(f.home, f.intent, f.record, f.proof);
    chmodSync(f.file, 0o644);
    expect(() => readRealmProof(f.home, f.intent)).toThrow();
    expect(() => clearRealmProof(f.home, f.intent, f.proof)).toThrow();
  } finally { f.mutation(); }
});
