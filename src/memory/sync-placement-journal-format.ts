import { canonicalJSON, hashJSON } from "./generation.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import type { SyncPolicyCategory } from "./sync-screen.ts";

export const PLACEMENT_EPOCH_SCHEMA = "agent-mem.sync-placement-epoch/v1";
export const PLACEMENT_RECORD_SCHEMA = "agent-mem.sync-placement-record/v1";
export const PLACEMENT_ACTIVE_FENCE_SCHEMA = "agent-mem.sync-placement-fence/v1";
export const PLACEMENT_JOURNAL_MAX_RECORDS = 20_000, PLACEMENT_JOURNAL_MAX_OBJECTS = 256;
export const PLACEMENT_JOURNAL_CHUNK_MAX_BYTES = 64 * 1024, PLACEMENT_JOURNAL_ROOT_MAX_BYTES = 256 * 1024;
export type SyncPlacementJournalErrorCode = "invalid" | "corrupt" | "bound" | "conflict" | "pending" | "changed" | "authorization" | "policy" | "local" | "busy";
const messages: Record<SyncPlacementJournalErrorCode, string> = {
  invalid: "Sync placement journal data is invalid or unsupported; inspect the retained state and use a compatible runtime.",
  corrupt: "Sync placement journal evidence is incomplete or inconsistent; restore the exact retained evidence before continuing.",
  bound: "Sync placement journal exceeds its supported bounds; a person-reviewed bounded epoch transition is required.",
  conflict: "Sync placement journal identity or request conflicts with retained evidence; inspect the exact request before retrying.",
  pending: "Sync placement journal has an unfinished transaction; resume its exact recorded request before continuing.",
  changed: "Sync placement journal or source bindings changed; capture and review a fresh request before continuing.",
  authorization: "Sync placement change requires explicit person authorization of the exact reviewed request.",
  policy: "Current mandatory policy refuses this sync placement change; inspect its safe policy classification.",
  local: "An intrinsically local source cannot be released for publication; preserve its source placement.",
  busy: "Sync placement journal is busy or its owner is unavailable; wait for the existing transaction before retrying.",
};
export class SyncPlacementJournalError extends Error {
  readonly code: SyncPlacementJournalErrorCode;
  constructor(code: SyncPlacementJournalErrorCode = "invalid") {
    const safe = typeof code === "string" && Object.hasOwn(messages, code) ? code : "invalid";
    super(messages[safe]); this.code = safe; this.name = "SyncPlacementJournalError";
  }
}
export interface PlacementEpoch {
  schema: typeof PLACEMENT_EPOCH_SCHEMA; publicationFormat: typeof PLACEMENT_FORMAT;
  generation: string; homeHash: string; contextHash: string; nonce: string;
}
export interface PlacementActiveFence { schema: typeof PLACEMENT_ACTIVE_FENCE_SCHEMA; epochHash: string; homeHash: string; generation: string }
export type PlacementRealm = { scope: "user" } | { scope: "project"; keyHash: string };
export interface PlacementKey { realm: PlacementRealm; id: string; rowHash: string }
export type PlacementHoldReason = SyncPolicyCategory | "person-local" | "related-local";
export interface PlacementAmbiguousOutcome { attemptHash: string; remoteHash: string; refHash: string }
export interface PlacementCommittedOutcome extends PlacementAmbiguousOutcome { commit: string; proofHash: string }
interface EventFields { requestId: string; key: PlacementKey; sourcePlacement: "local" | "synced"; effectHash: string }
export type PlacementEvent = EventFields & (
  { kind: "hold"; reason: PlacementHoldReason } | { kind: "release" }
  | { kind: "publication-committed"; outcome: PlacementCommittedOutcome }
  | { kind: "publication-ambiguous"; outcome: PlacementAmbiguousOutcome }
);
export type PlacementRecord = PlacementEvent & { schema: typeof PLACEMENT_RECORD_SCHEMA; epochHash: string; sequence: number; previousHash: string; seal: string };
const eventFields = ["requestId", "key", "sourcePlacement", "effectHash", "kind"];
const reasons: readonly PlacementHoldReason[] = ["secret", "personal-data", "deny-path", "private-or-invalid", "host", "person-local", "related-local"];
const fail = (code: SyncPlacementJournalErrorCode = "invalid"): never => { throw new SyncPlacementJournalError(code); };
const hex = (value: unknown, length: number): value is string => typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  // Shared descriptor-only snapshot rejects proxies, getters, functions, private flags and unbounded structure without running caller code.
  const copy = memoryPolicySnapshot(value);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return fail();
  const keys = Object.keys(copy), allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.length > allowed.size || required.some(key => !Object.hasOwn(copy, key)) || keys.some(key => !allowed.has(key))) return fail();
  return copy as Record<string, unknown>;
}
function bounded<T>(value: T): T { if (Buffer.byteLength(canonicalJSON(value) + "\n") > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) return fail("bound"); return value; }
export function validatePlacementEpoch(value: unknown): PlacementEpoch {
  const row = object(value, ["schema", "publicationFormat", "generation", "homeHash", "contextHash", "nonce"]);
  if (row.schema !== PLACEMENT_EPOCH_SCHEMA || row.publicationFormat !== PLACEMENT_FORMAT || !hex(row.generation, 32) || !hex(row.homeHash, 64) || !hex(row.contextHash, 64) || !hex(row.nonce, 32)) return fail();
  return bounded<PlacementEpoch>({ schema: PLACEMENT_EPOCH_SCHEMA, publicationFormat: PLACEMENT_FORMAT, generation: row.generation, homeHash: row.homeHash, contextHash: row.contextHash, nonce: row.nonce });
}
export function validatePlacementActiveFence(value: unknown): PlacementActiveFence {
  const row = object(value, ["schema", "epochHash", "homeHash", "generation"]);
  if (row.schema !== PLACEMENT_ACTIVE_FENCE_SCHEMA || !hex(row.epochHash, 64) || !hex(row.homeHash, 64) || !hex(row.generation, 32)) return fail();
  return bounded<PlacementActiveFence>({ schema: PLACEMENT_ACTIVE_FENCE_SCHEMA, epochHash: row.epochHash, homeHash: row.homeHash, generation: row.generation });
}
export function validatePlacementKey(value: unknown): PlacementKey {
  const row = object(value, ["realm", "id", "rowHash"]), realm = object(row.realm, ["scope"], ["keyHash"]);
  if (!hex(row.id, 32) || !hex(row.rowHash, 64)) return fail();
  if (realm.scope === "user" && !Object.hasOwn(realm, "keyHash")) return { realm: { scope: "user" }, id: row.id, rowHash: row.rowHash };
  if (realm.scope === "project" && hex(realm.keyHash, 64)) return { realm: { scope: "project", keyHash: realm.keyHash }, id: row.id, rowHash: row.rowHash };
  return fail();
}
function outcome(value: unknown, committed: boolean): PlacementAmbiguousOutcome | PlacementCommittedOutcome {
  const row = object(value, ["attemptHash", "remoteHash", "refHash", ...(committed ? ["commit", "proofHash"] : [])]);
  if (!hex(row.attemptHash, 64) || !hex(row.remoteHash, 64) || !hex(row.refHash, 64)) return fail();
  const base = { attemptHash: row.attemptHash, remoteHash: row.remoteHash, refHash: row.refHash };
  if (!committed) return base;
  if (!hex(row.commit, 40) || !hex(row.proofHash, 64)) return fail();
  return { ...base, commit: row.commit, proofHash: row.proofHash };
}
export function validatePlacementEvent(value: unknown): PlacementEvent {
  const row = object(value, eventFields, ["reason", "outcome"]);
  if (!hex(row.requestId, 64) || !hex(row.effectHash, 64) || !["local", "synced"].includes(row.sourcePlacement as string)) return fail();
  const base: EventFields = { requestId: row.requestId, key: validatePlacementKey(row.key), sourcePlacement: row.sourcePlacement as "local" | "synced", effectHash: row.effectHash };
  if (row.kind === "hold" && !Object.hasOwn(row, "outcome") && typeof row.reason === "string" && reasons.includes(row.reason as PlacementHoldReason)) return bounded<PlacementEvent>({ ...base, kind: "hold", reason: row.reason as PlacementHoldReason });
  if (Object.hasOwn(row, "reason")) return fail();
  if (row.kind === "release" && !Object.hasOwn(row, "outcome")) return bounded<PlacementEvent>({ ...base, kind: "release" });
  if (row.kind === "publication-committed") return bounded<PlacementEvent>({ ...base, kind: row.kind, outcome: outcome(row.outcome, true) as PlacementCommittedOutcome });
  if (row.kind === "publication-ambiguous") return bounded<PlacementEvent>({ ...base, kind: row.kind, outcome: outcome(row.outcome, false) });
  return fail();
}
export function validatePlacementRecord(value: unknown): PlacementRecord {
  const row = object(value, ["schema", "epochHash", "sequence", "previousHash", "seal", ...eventFields], ["reason", "outcome"]);
  if (row.schema !== PLACEMENT_RECORD_SCHEMA || !hex(row.epochHash, 64) || !hex(row.previousHash, 64) || !hex(row.seal, 64)
    || typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return fail();
  if (row.sequence > PLACEMENT_JOURNAL_MAX_RECORDS) return fail("bound");
  const rawEvent: Record<string, unknown> = {}; for (const field of [...eventFields, "reason", "outcome"]) if (Object.hasOwn(row, field)) rawEvent[field] = row[field];
  const event = validatePlacementEvent(rawEvent), body = { ...event, schema: PLACEMENT_RECORD_SCHEMA as typeof PLACEMENT_RECORD_SCHEMA, epochHash: row.epochHash, sequence: row.sequence, previousHash: row.previousHash };
  if (row.sequence === 1 && row.previousHash !== row.epochHash || hashJSON(body) !== row.seal) return fail("corrupt");
  return bounded<PlacementRecord>({ ...body, seal: row.seal });
}
export function createPlacementRecord(epochHash: string, sequence: number, previousHash: string, value: PlacementEvent): PlacementRecord {
  if (!hex(epochHash, 64) || !hex(previousHash, 64) || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return fail();
  if (sequence > PLACEMENT_JOURNAL_MAX_RECORDS) return fail("bound");
  const event = validatePlacementEvent(value), body = { ...event, schema: PLACEMENT_RECORD_SCHEMA, epochHash, sequence, previousHash };
  return validatePlacementRecord({ ...body, seal: hashJSON(body) });
}
export const placementEpochHash = (epoch: PlacementEpoch): string => hashJSON(validatePlacementEpoch(epoch));
export const placementKeyId = (key: PlacementKey): string => hashJSON(validatePlacementKey(key));
