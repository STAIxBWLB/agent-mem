/** Private local recovery evidence for an explicitly reviewed remote realm adoption. */
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { PLACEMENT_SOURCE_MAX_BYTES, PLACEMENT_SOURCE_MAX_ROWS } from "./sync-placement-bound.ts";

const SCHEMA = "agent-mem.sync-placement-remote-adoption/v1", MAX_BYTES = 4 * 1024 * 1024;
export interface RemoteAdoptionBody {
  schema: typeof SCHEMA;
  homeHash: string; epochHash: string; generation: string; keyHash: string;
  remoteHash: string; remoteHead: string; sourceHash: string; policyHash: string; aliasesHash: string;
  omitted: number; packs: { name: string; bytes: number }[];
}
export interface RemoteAdoption extends RemoteAdoptionBody { seal: string }
const unavailable = (): never => { throw new Error("Remote placement adoption evidence is invalid or exceeds its bound; retain it for inspection."); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || Object.getOwnPropertySymbols(value).length
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable();
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(entries).length !== keys.length || Object.getOwnPropertyNames(value).length !== keys.length) return unavailable();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const entry = entries[key]; if (!entry || !("value" in entry) || !entry.enumerable) return unavailable(); result[key] = entry.value; }
  return result;
}
function hex(value: unknown, length: number): string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) return unavailable(); return value;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) return unavailable(); return value;
}
function checked(value: unknown, sealed: boolean): RemoteAdoption {
  const row = object(value, ["schema", "homeHash", "epochHash", "generation", "keyHash", "remoteHash", "remoteHead", "sourceHash", "policyHash", "aliasesHash", "omitted", "packs", ...(sealed ? ["seal"] : [])]);
  if (row.schema !== SCHEMA || !Array.isArray(row.packs) || row.packs.length > PLACEMENT_SOURCE_MAX_ROWS) return unavailable();
  let previous = "", total = 0;
  const packs = row.packs.map(item => {
    const pack = object(item, ["name", "bytes"]);
    if (typeof pack.name !== "string" || !/^sync-[a-f0-9]{64}\.jsonl$/.test(pack.name) || pack.name <= previous) return unavailable();
    previous = pack.name; const bytes = integer(pack.bytes, PLACEMENT_SOURCE_MAX_BYTES); total += bytes;
    if (!bytes || total > PLACEMENT_SOURCE_MAX_BYTES) return unavailable(); return { name: pack.name, bytes };
  });
  const body: RemoteAdoptionBody = { schema: SCHEMA, homeHash: hex(row.homeHash, 64), epochHash: hex(row.epochHash, 64), generation: hex(row.generation, 32),
    keyHash: hex(row.keyHash, 64), remoteHash: hex(row.remoteHash, 64), remoteHead: hex(row.remoteHead, 40), sourceHash: hex(row.sourceHash, 64), policyHash: hex(row.policyHash, 64), aliasesHash: hex(row.aliasesHash, 64),
    omitted: integer(row.omitted, PLACEMENT_SOURCE_MAX_ROWS), packs };
  const result = { ...body, seal: hashJSON(body) };
  if (sealed && hex(row.seal, 64) !== result.seal || Buffer.byteLength(canonicalJSON(result) + "\n") > MAX_BYTES) return unavailable();
  return result;
}
export function createRemoteAdoption(body: RemoteAdoptionBody): RemoteAdoption { return checked(body, false); }
export function validateRemoteAdoption(value: unknown): RemoteAdoption { return checked(value, true); }
export const REMOTE_ADOPTION_SCHEMA = SCHEMA;
export const REMOTE_ADOPTION_MAX_BYTES = MAX_BYTES;
