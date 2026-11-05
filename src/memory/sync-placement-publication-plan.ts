/** Body-free, deterministic publication evidence. This module grants no publication authority. */
import { types } from "node:util";
import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { validatePlacementKey, placementKeyId, SyncPlacementJournalError, PLACEMENT_JOURNAL_MAX_RECORDS, PLACEMENT_JOURNAL_MAX_OBJECTS,
  PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_ROOT_MAX_BYTES, type PlacementKey, type PlacementRealm, type PlacementHoldReason } from "./sync-placement-journal-format.ts";

export const PLACEMENT_PUBLICATION_PLAN_SCHEMA = "agent-mem.sync-placement-publication-plan/v1";
export const PLACEMENT_PUBLICATION_CHUNK_SCHEMA = "agent-mem.sync-placement-publication-chunk/v1";
export const PLACEMENT_PUBLICATION_FACT_SCHEMA = "agent-mem.sync-placement-publication-fact/v1";
/** Closed hold/outcome events fit this bound; reserve future journal capacity before any publication effect. */
export const PLACEMENT_PUBLICATION_RECORD_MAX_BYTES = 2048;
export interface PlacementPublicationSource {
  realm: PlacementRealm; source: "generation" | "legacy-local" | "legacy-main"; pathHash: string;
  dev: string; ino: string; byteLength: number; hash: string; mtimeNs: string; ctimeNs: string;
}
export type PlacementPublicationDecisionReason = PlacementHoldReason | "journal-hold" | "source-local" | "unsupported-reference" | "unverified-prune" | null;
export interface PlacementPublicationDecision { key: PlacementKey; sourcePlacement: "local" | "synced"; eligible: boolean; reason: PlacementPublicationDecisionReason; dependencies: PlacementKey[] }
export interface PlacementPublicationObject { targetIndex: number; type: "blob" | "tree" | "commit"; path: string | null; oid: string; sha256: string; size: number }
export interface PlacementPublicationTarget {
  realm: PlacementRealm; publish: boolean; refHash: string; expectedRemoteHead: string | null; expectedCacheHead: string | null;
  descriptorHash: string; exportSetHash: string; tree: string | null; commit: string | null;
}
export type PlacementPublicationChunkKind = "sources" | "decisions" | "objects";
export interface PlacementPublicationChunk { schema: typeof PLACEMENT_PUBLICATION_CHUNK_SCHEMA; kind: PlacementPublicationChunkKind; index: number; items: (PlacementPublicationSource | PlacementPublicationDecision | PlacementPublicationObject)[] }
export interface PlacementPublicationRoot {
  schema: typeof PLACEMENT_PUBLICATION_PLAN_SCHEMA; epochHash: string; generation: string; homeHash: string; contextHash: string;
  markerHash: string; sourceHash: string; aliasesHash: string; policyHash: string; remoteHash: string;
  journal: { sequence: number; headHash: string }; reservedRecords: number; reservedRecordBytes: number[]; createdUnixSeconds: number;
  targets: PlacementPublicationTarget[]; chunks: { kind: PlacementPublicationChunkKind; index: number; hash: string; count: number; bytes: number }[]; seal: string;
}
export interface PlacementPublicationBundle { root: PlacementPublicationRoot; chunks: PlacementPublicationChunk[] }
export type PlacementPublicationFact = {
  schema: typeof PLACEMENT_PUBLICATION_FACT_SCHEMA; attemptHash: string; previousHash: string; seal: string;
} & ({ phase: "artifact-built"; exportHash: string } | { phase: "publication-intent"; artifactFactHash: string; policyHash: string; policyCheckUnixMs: number }
  | { phase: "completed"; intentFactHash: string | null; journal: { sequence: number; headHash: string }; outcomeHash: string; outcome: "committed" | "unknown" });
export type PlacementPublicationPhase = PlacementPublicationFact["phase"];
const reasons: readonly PlacementPublicationDecisionReason[] = ["journal-hold", "source-local", "unsupported-reference", "unverified-prune", null, "secret", "personal-data", "deny-path", "private-or-invalid", "host", "person-local", "related-local"];
const kinds: readonly PlacementPublicationChunkKind[] = ["sources", "decisions", "objects"];
const fail = (code: "invalid" | "bound" | "corrupt" = "invalid"): never => { throw new SyncPlacementJournalError(code); };
export const publicationBytes = (value: unknown): Buffer => Buffer.from(canonicalJSON(value) + "\n");
export const publicationHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function hex(value: unknown, size = 64): value is string { return typeof value === "string" && value.length === size && /^[a-f0-9]+$/.test(value); }
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
/** Descriptor-only shallow access keeps multi-chunk inputs bounded without the policy snapshot's 4096-node ceiling. */
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).length !== keys.length) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const d = descriptors[key]; if (!d || !("value" in d) || !d.enumerable) return fail(); result[key] = d.value; }
  return result;
}
function array(input: unknown, maximum: number): unknown[] {
  if (!input || typeof input !== "object" || types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length) return fail();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!number(length, maximum)) return fail("bound");
  if (Object.getOwnPropertyNames(input).length !== length + 1) return fail();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(input, String(i)); if (!d || !("value" in d) || !d.enumerable) return fail(); result.push(d.value); }
  return result;
}
function realm(value: unknown): PlacementRealm { return validatePlacementKey({ realm: value, id: "0".repeat(32), rowHash: "0".repeat(64) }).realm; }
function frontier(value: unknown) { const v = object(value, ["sequence", "headHash"]); if (!number(v.sequence, PLACEMENT_JOURNAL_MAX_RECORDS) || !hex(v.headHash)) return fail(); return { sequence: v.sequence, headHash: v.headHash }; }
function bounded<T>(value: T, maximum: number): T { if (publicationBytes(value).length > maximum) return fail("bound"); return value; }
function item(kind: PlacementPublicationChunkKind, input: unknown): PlacementPublicationSource | PlacementPublicationDecision | PlacementPublicationObject {
  if (kind === "sources") {
    const v = object(input, ["realm", "source", "pathHash", "dev", "ino", "byteLength", "hash", "mtimeNs", "ctimeNs"]);
    if (!["generation", "legacy-local", "legacy-main"].includes(v.source as string) || !hex(v.pathHash) || !hex(v.hash) || !number(v.byteLength, 8 * 1024 * 1024)
      || ![v.dev, v.ino].every(x => typeof x === "string" && !/[\r\n]/.test(x) && /^(?:0|[1-9][0-9]{0,31})$/.test(x))
      || ![v.mtimeNs, v.ctimeNs].every(x => typeof x === "string" && !/[\r\n]/.test(x) && /^-?(?:0|[1-9][0-9]{0,31})$/.test(x))) return fail();
    return { realm: realm(v.realm), source: v.source as PlacementPublicationSource["source"], pathHash: v.pathHash, dev: v.dev as string, ino: v.ino as string, byteLength: v.byteLength, hash: v.hash, mtimeNs: v.mtimeNs as string, ctimeNs: v.ctimeNs as string };
  }
  if (kind === "decisions") {
    const v = object(input, ["key", "sourcePlacement", "eligible", "reason", "dependencies"]);
    if (!["local", "synced"].includes(v.sourcePlacement as string) || typeof v.eligible !== "boolean" || !reasons.includes(v.reason as PlacementPublicationDecisionReason) || v.eligible !== (v.reason === null)) return fail();
    const dependencies = array(v.dependencies, PLACEMENT_JOURNAL_MAX_RECORDS).map(validatePlacementKey);
    if (new Set(dependencies.map(placementKeyId)).size !== dependencies.length) return fail();
    return bounded({ key: validatePlacementKey(v.key), sourcePlacement: v.sourcePlacement as "local" | "synced", eligible: v.eligible, reason: v.reason as PlacementPublicationDecisionReason, dependencies }, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES - 256);
  }
  const v = object(input, ["targetIndex", "type", "path", "oid", "sha256", "size"]);
  const protocolPath = typeof v.path === "string" && !/[\r\n]/.test(v.path) && (v.path === "shard.json" || v.path === "rows" || v.path === "prune-witnesses" || /^rows\/[a-f0-9]{64}(?:\/[a-f0-9]{64}\.jsonl)?$/.test(v.path) || /^prune-witnesses\/[a-f0-9]{64}\.json$/.test(v.path));
  if (!number(v.targetIndex, 1) || !["blob", "tree", "commit"].includes(v.type as string) || v.path !== null && !protocolPath || !hex(v.oid, 40) || !hex(v.sha256) || !number(v.size, 8 * 1024 * 1024)
    || v.type === "commit" && v.path !== null || v.type === "blob" && v.path === null) return fail();
  return { targetIndex: v.targetIndex, type: v.type as PlacementPublicationObject["type"], path: v.path as string | null, oid: v.oid, sha256: v.sha256, size: v.size };
}
export function validatePlacementPublicationChunk(input: unknown): PlacementPublicationChunk {
  const v = object(input, ["schema", "kind", "index", "items"]);
  if (v.schema !== PLACEMENT_PUBLICATION_CHUNK_SCHEMA || !kinds.includes(v.kind as PlacementPublicationChunkKind) || !number(v.index, PLACEMENT_JOURNAL_MAX_OBJECTS - 1)) return fail();
  const items = array(v.items, PLACEMENT_JOURNAL_MAX_RECORDS).map(x => item(v.kind as PlacementPublicationChunkKind, x)); if (!items.length) return fail();
  return bounded({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind: v.kind as PlacementPublicationChunkKind, index: v.index, items }, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES);
}
function normalizedRoot(input: unknown, checkSeal = true): PlacementPublicationRoot {
  const keys = ["schema", "epochHash", "generation", "homeHash", "contextHash", "markerHash", "sourceHash", "aliasesHash", "policyHash", "remoteHash", "journal", "reservedRecords", "reservedRecordBytes", "createdUnixSeconds", "targets", "chunks", "seal"];
  const v = object(input, keys);
  if (v.schema !== PLACEMENT_PUBLICATION_PLAN_SCHEMA || !hex(v.generation, 32) || ![v.epochHash, v.homeHash, v.contextHash, v.markerHash, v.sourceHash, v.aliasesHash, v.policyHash, v.remoteHash, v.seal].every(x => hex(x))
    || !number(v.reservedRecords, PLACEMENT_JOURNAL_MAX_RECORDS) || !number(v.createdUnixSeconds)) return fail();
  const reservedRecordBytes = array(v.reservedRecordBytes, PLACEMENT_JOURNAL_MAX_RECORDS);
  if (reservedRecordBytes.length !== v.reservedRecords || reservedRecordBytes.some(x => !number(x, PLACEMENT_PUBLICATION_RECORD_MAX_BYTES) || x < 1)) return fail();
  const journal = frontier(v.journal); if (journal.sequence + v.reservedRecords > PLACEMENT_JOURNAL_MAX_RECORDS) return fail("bound");
  const targets = array(v.targets, 2).map(x => {
    const t = object(x, ["realm", "publish", "refHash", "expectedRemoteHead", "expectedCacheHead", "descriptorHash", "exportSetHash", "tree", "commit"]);
    if (typeof t.publish !== "boolean" || ![t.refHash, t.descriptorHash, t.exportSetHash].every(x => hex(x))
      || [t.expectedRemoteHead, t.expectedCacheHead].some(x => x !== null && !hex(x, 40))) return fail();
    if (t.publish ? !hex(t.tree, 40) || !hex(t.commit, 40)
      : t.expectedRemoteHead === null ? t.tree !== null || t.commit !== null || t.expectedCacheHead !== null
      : !hex(t.tree, 40) || t.commit !== t.expectedRemoteHead) return fail();
    return { realm: realm(t.realm), publish: t.publish, refHash: t.refHash as string, expectedRemoteHead: t.expectedRemoteHead as string | null, expectedCacheHead: t.expectedCacheHead as string | null, descriptorHash: t.descriptorHash as string, exportSetHash: t.exportSetHash as string, tree: t.tree as string | null, commit: t.commit as string | null };
  });
  if (!targets.length || new Set(targets.map(t => canonicalJSON(t.realm))).size !== targets.length || new Set(targets.map(t => t.refHash)).size !== targets.length) return fail();
  let lastKind = 0;
  const chunks = array(v.chunks, PLACEMENT_JOURNAL_MAX_OBJECTS - 1).map((x, index) => {
    const c = object(x, ["kind", "index", "hash", "count", "bytes"]), kindIndex = kinds.indexOf(c.kind as PlacementPublicationChunkKind);
    if (kindIndex < lastKind || kindIndex < 0 || c.index !== index || !hex(c.hash) || !number(c.count, PLACEMENT_JOURNAL_MAX_RECORDS) || c.count < 1 || !number(c.bytes, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) || c.bytes < 1) return fail();
    lastKind = kindIndex; return { kind: c.kind as PlacementPublicationChunkKind, index, hash: c.hash, count: c.count, bytes: c.bytes };
  });
  const normalized = { ...v, journal, targets, chunks, reservedRecordBytes } as unknown as PlacementPublicationRoot;
  const { seal, ...body } = normalized; if (checkSeal && hashJSON(body) !== seal) return fail("corrupt");
  return bounded(normalized, PLACEMENT_JOURNAL_ROOT_MAX_BYTES);
}
export function validatePlacementPublicationRoot(input: unknown): PlacementPublicationRoot { return normalizedRoot(input); }
export function validatePlacementPublicationBundle(input: unknown): PlacementPublicationBundle {
  const v = object(input, ["root", "chunks"]), root = validatePlacementPublicationRoot(v.root), chunks = array(v.chunks, PLACEMENT_JOURNAL_MAX_OBJECTS - 1).map(validatePlacementPublicationChunk);
  if (chunks.length !== root.chunks.length) return fail("corrupt");
  let sourceBytes = 0; const totals = { sources: 0, decisions: 0, objects: 0 }, seen = new Set<string>();
  for (const [index, chunk] of chunks.entries()) {
    const expected = root.chunks[index]!, bytes = publicationBytes(chunk);
    if (chunk.index !== index || chunk.kind !== expected.kind || chunk.items.length !== expected.count || bytes.length !== expected.bytes || publicationHash(bytes) !== expected.hash) return fail("corrupt");
    totals[chunk.kind] += chunk.items.length; if (totals[chunk.kind] > PLACEMENT_JOURNAL_MAX_RECORDS) return fail("bound");
    for (const row of chunk.items) {
      let identity: string;
      if (chunk.kind === "sources") { const s = row as PlacementPublicationSource; sourceBytes += s.byteLength; identity = canonicalJSON([s.realm, s.source, s.pathHash]); }
      else if (chunk.kind === "decisions") { const d = row as PlacementPublicationDecision; identity = canonicalJSON([d.key.realm, d.key.id]); }
      else { const o = row as PlacementPublicationObject; if (o.targetIndex >= root.targets.length || !root.targets[o.targetIndex]!.publish) return fail(); identity = canonicalJSON([o.targetIndex, o.type, o.path]); }
      const key = chunk.kind + identity; if (seen.has(key)) return fail(); seen.add(key);
    }
  }
  if (sourceBytes > 8 * 1024 * 1024) return fail("bound");
  return { root, chunks };
}
export function planPlacementPublication(input: Omit<PlacementPublicationRoot, "schema" | "chunks" | "seal">, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}): PlacementPublicationBundle {
  const values = object(items, kinds), chunks: PlacementPublicationChunk[] = [];
  for (const kind of kinds) {
    let selected: PlacementPublicationChunk["items"] = [];
    const flush = () => { if (selected.length) { chunks.push(validatePlacementPublicationChunk({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind, index: chunks.length, items: selected })); selected = []; } };
    for (const value of array(values[kind], PLACEMENT_JOURNAL_MAX_RECORDS)) {
      const row = item(kind, value), candidate = { schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind, index: chunks.length, items: [...selected, row] };
      if (publicationBytes(candidate).length > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) flush(); selected.push(row);
    }
    flush();
  }
  const body = { ...object(input, ["epochHash", "generation", "homeHash", "contextHash", "markerHash", "sourceHash", "aliasesHash", "policyHash", "remoteHash", "journal", "reservedRecords", "reservedRecordBytes", "createdUnixSeconds", "targets"]), schema: PLACEMENT_PUBLICATION_PLAN_SCHEMA,
    chunks: chunks.map(c => ({ kind: c.kind, index: c.index, hash: publicationHash(publicationBytes(c)), count: c.items.length, bytes: publicationBytes(c).length })) };
  const { seal: _seal, ...safeBody } = normalizedRoot({ ...body, seal: "0".repeat(64) }, false);
  return validatePlacementPublicationBundle({ root: { ...safeBody, seal: hashJSON(safeBody) }, chunks });
}
export function createPlacementPublicationFact(attemptHash: string, previousHash: string, phase: PlacementPublicationPhase, fact: unknown): PlacementPublicationFact {
  const keys = phase === "artifact-built" ? ["exportHash"] : phase === "publication-intent" ? ["artifactFactHash", "policyHash", "policyCheckUnixMs"] : ["intentFactHash", "journal", "outcomeHash", "outcome"];
  const body = { ...object(fact, keys), schema: PLACEMENT_PUBLICATION_FACT_SCHEMA, attemptHash, previousHash, phase };
  const { seal: _seal, ...safeBody } = normalizedFact({ ...body, seal: "0".repeat(64) }, false);
  return validatePlacementPublicationFact({ ...safeBody, seal: hashJSON(safeBody) });
}
function normalizedFact(input: unknown, checkSeal = true): PlacementPublicationFact {
  // Read phase through descriptors before choosing the exact closed field set.
  if (!input || typeof input !== "object" || types.isProxy(input)) return fail();
  const phase = Object.getOwnPropertyDescriptor(input, "phase")?.value;
  const extra = phase === "artifact-built" ? ["exportHash"] : phase === "publication-intent" ? ["artifactFactHash", "policyHash", "policyCheckUnixMs"] : phase === "completed" ? ["intentFactHash", "journal", "outcomeHash", "outcome"] : fail();
  const v = object(input, ["schema", "attemptHash", "previousHash", "phase", "seal", ...extra]);
  if (v.schema !== PLACEMENT_PUBLICATION_FACT_SCHEMA || ![v.attemptHash, v.previousHash, v.seal].every(x => hex(x))) return fail();
  if (phase === "artifact-built" && !hex(v.exportHash) || phase === "publication-intent" && (!hex(v.artifactFactHash) || !hex(v.policyHash) || !number(v.policyCheckUnixMs))
    || phase === "completed" && (v.intentFactHash !== null && !hex(v.intentFactHash) || !hex(v.outcomeHash) || !["committed", "unknown"].includes(v.outcome as string) || v.outcome === "committed" && v.intentFactHash === null)) return fail();
  if (phase === "completed") v.journal = frontier(v.journal);
  const { seal, ...body } = v; if (checkSeal && hashJSON(body) !== seal) return fail("corrupt");
  return bounded(v as unknown as PlacementPublicationFact, PLACEMENT_JOURNAL_ROOT_MAX_BYTES);
}
export function validatePlacementPublicationFact(input: unknown): PlacementPublicationFact { return normalizedFact(input); }
export function publicationFileNames(root: PlacementPublicationRoot): string[] {
  const stem = `publication-${root.seal}-`;
  return [`${stem}root.json`, ...root.chunks.map(c => `${stem}chunk-${String(c.index).padStart(5, "0")}.json`), `${stem}artifact.json`, `${stem}intent.json`, `${stem}receipt.json`];
}
