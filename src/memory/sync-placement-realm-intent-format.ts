/** Data-only frozen admission intent. The intent is evidence to recheck, not authorization. */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { REALM_EXTENSION_LIMIT, REALM_EXTENSION_LOG_MAX_BYTES, RealmExtensionFormatError, realmExtensionGenesis } from "./sync-placement-realm-extension-format.ts";

export const REALM_INTENT_SCHEMA = "agent-mem.sync-placement-realm-intent/v1";
export const REALM_INTENT_MAX_BYTES = 16 * 1024;
export interface RealmIntentBody {
  schema: typeof REALM_INTENT_SCHEMA;
  home: string; project: string; keyHash: string; machine: string;
  epochHash: string; activationHash: string; homeHash: string; generation: string;
  sequence: number; previousHash: string; previousLogBytes: number; previousLogHash: string;
  mode: "new" | "existing"; descriptorHash: string | null; sourceHash: string | null;
  aliasesHash: string; policyHash: string; writerHash: string; journal: { sequence: number; headHash: string };
}
export interface RealmIntent extends RealmIntentBody { seal: string }
const fail = (): never => { throw new RealmExtensionFormatError(); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== keys.length || Object.getOwnPropertyNames(value).length !== keys.length) return fail();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const field = fields[key]; if (!field || !("value" in field) || !field.enumerable) return fail(); copy[key] = field.value; }
  return copy;
}
function hex(value: unknown, width = 64): string { if (typeof value !== "string" || value.length !== width || !/^[a-f0-9]+$/.test(value)) return fail(); return value; }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail(); return value; }
function checked(input: unknown, sealed: boolean): RealmIntent {
  const row = object(input, ["schema", "home", "project", "keyHash", "machine", "epochHash", "activationHash", "homeHash", "generation", "sequence", "previousHash",
    "previousLogBytes", "previousLogHash", "mode", "descriptorHash", "sourceHash", "aliasesHash", "policyHash", "writerHash", "journal", ...(sealed ? ["seal"] : [])]);
  const journal = object(row.journal, ["sequence", "headHash"]);
  if (row.schema !== REALM_INTENT_SCHEMA || typeof row.home !== "string" || !isAbsolute(row.home) || resolve(row.home) !== row.home || row.home.includes("\0") || Buffer.byteLength(row.home) > 4096
    || typeof row.project !== "string" || !row.project.trim() || Buffer.byteLength(row.project) > 400 || /[\r\n\0]/.test(row.project)
    || (row.mode !== "new" && row.mode !== "existing")) return fail();
  const body: RealmIntentBody = { schema: REALM_INTENT_SCHEMA, home: row.home, project: row.project, keyHash: hex(row.keyHash), machine: hex(row.machine, 16),
    epochHash: hex(row.epochHash), activationHash: hex(row.activationHash), homeHash: hex(row.homeHash), generation: hex(row.generation, 32),
    sequence: integer(row.sequence, 1, REALM_EXTENSION_LIMIT), previousHash: hex(row.previousHash), previousLogBytes: integer(row.previousLogBytes, 0, REALM_EXTENSION_LOG_MAX_BYTES),
    previousLogHash: hex(row.previousLogHash), mode: row.mode, descriptorHash: row.descriptorHash === null ? null : hex(row.descriptorHash), sourceHash: row.sourceHash === null ? null : hex(row.sourceHash),
    aliasesHash: hex(row.aliasesHash), policyHash: hex(row.policyHash), writerHash: hex(row.writerHash), journal: { sequence: integer(journal.sequence, 0, 20_000), headHash: hex(journal.headHash) } };
  const empty = createHash("sha256").update("").digest("hex");
  if (createHash("sha256").update(body.project).digest("hex") !== body.keyHash
    || (body.sequence === 1) !== (body.previousLogBytes === 0) || body.previousLogBytes === 0 && body.previousLogHash !== empty
    || body.sequence === 1 && body.previousHash !== realmExtensionGenesis(body.epochHash, body.activationHash)
    || body.journal.sequence === 0 && body.journal.headHash !== body.epochHash
    || body.mode === "existing" && (!body.descriptorHash || !body.sourceHash)
    || body.mode === "new" && body.sourceHash !== null) return fail();
  const result = { ...body, seal: hashJSON(body) };
  if (sealed && hex(row.seal) !== result.seal || Buffer.byteLength(canonicalJSON(result) + "\n") > REALM_INTENT_MAX_BYTES) return fail();
  return result;
}
export function createRealmIntent(input: RealmIntentBody): RealmIntent { return checked(input, false); }
export function validateRealmIntent(input: unknown): RealmIntent { return checked(input, true); }
