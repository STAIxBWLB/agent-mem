/** Closed, data-only same-epoch realm extension records. A seal is not authorization or fresh proof. */
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";

export const REALM_EXTENSION_SCHEMA = "agent-mem.sync-placement-realm-extension/v1";
export const REALM_EXTENSION_LIMIT = 64;
export const REALM_EXTENSION_LOG_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 4096;

export interface RealmExtensionBody {
  schema: typeof REALM_EXTENSION_SCHEMA;
  epochHash: string;
  activationHash: string;
  homeHash: string;
  generation: string;
  sequence: number;
  previousHash: string;
  realm: { scope: "project"; keyHash: string; bindingHash: string };
  sourceHash: string;
  aliasesHash: string;
  policyHash: string;
  writerHash: string;
  journal: { sequence: number; headHash: string };
}
export interface RealmExtension extends RealmExtensionBody { seal: string }

export class RealmExtensionFormatError extends Error {
  constructor() { super("sync placement realm extension metadata is invalid or exceeds its supported bounds; retain it for inspection"); this.name = "RealmExtensionFormatError"; }
}
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
function hex(value: unknown, width = 64): string {
  if (typeof value !== "string" || value.length !== width || !/^[a-f0-9]+$/.test(value)) return fail(); return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail(); return value;
}
/** The original activation seal anchors the first appended extension, without changing it. */
export function realmExtensionGenesis(epochHash: string, activationHash: string): string {
  return hashJSON(["agent-mem.sync-placement-realm-genesis/v1", hex(epochHash), hex(activationHash)]);
}
function checked(input: unknown, sealed: boolean): RealmExtension {
  const row = object(input, ["schema", "epochHash", "activationHash", "homeHash", "generation", "sequence", "previousHash", "realm", "sourceHash", "aliasesHash", "policyHash", "writerHash", "journal", ...(sealed ? ["seal"] : [])]);
  const realm = object(row.realm, ["scope", "keyHash", "bindingHash"]), journal = object(row.journal, ["sequence", "headHash"]);
  if (row.schema !== REALM_EXTENSION_SCHEMA || realm.scope !== "project") return fail();
  const body: RealmExtensionBody = { schema: REALM_EXTENSION_SCHEMA, epochHash: hex(row.epochHash), activationHash: hex(row.activationHash), homeHash: hex(row.homeHash),
    generation: hex(row.generation, 32), sequence: integer(row.sequence, 1, REALM_EXTENSION_LIMIT), previousHash: hex(row.previousHash),
    realm: { scope: "project", keyHash: hex(realm.keyHash), bindingHash: hex(realm.bindingHash) },
    sourceHash: hex(row.sourceHash), aliasesHash: hex(row.aliasesHash), policyHash: hex(row.policyHash), writerHash: hex(row.writerHash),
    journal: { sequence: integer(journal.sequence, 0, 20_000), headHash: hex(journal.headHash) } };
  if (body.sequence === 1 && body.previousHash !== realmExtensionGenesis(body.epochHash, body.activationHash)
    || body.journal.sequence === 0 && body.journal.headHash !== body.epochHash) return fail();
  const result = { ...body, seal: hashJSON(body) };
  if (sealed && hex(row.seal) !== result.seal || Buffer.byteLength(canonicalJSON(result) + "\n") > RECORD_MAX_BYTES) return fail();
  return result;
}
export function createRealmExtension(input: RealmExtensionBody): RealmExtension { return checked(input, false); }
export function validateRealmExtension(input: unknown): RealmExtension { return checked(input, true); }
