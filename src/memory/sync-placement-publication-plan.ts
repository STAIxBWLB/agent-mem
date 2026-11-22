/** Body-free, deterministic publication evidence. This module grants no publication authority. */
import { types } from "node:util";
import { createHash } from "node:crypto";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { readFormatFloors, formatVersionBelow } from "./formats.ts";
import { validatePlacementKey, placementKeyId, SyncPlacementJournalError, PLACEMENT_JOURNAL_MAX_RECORDS, PLACEMENT_JOURNAL_MAX_OBJECTS,
  PLACEMENT_JOURNAL_CHUNK_MAX_BYTES, PLACEMENT_JOURNAL_ROOT_MAX_BYTES, type PlacementKey, type PlacementRealm, type PlacementHoldReason } from "./sync-placement-journal-format.ts";
import { drainSteps, drainStepsAsync, type CooperativeYield } from "./sync-placement-yield.ts";

export const PLACEMENT_PUBLICATION_PLAN_SCHEMA = "agent-mem.sync-placement-publication-plan/v1";
export const PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA = "agent-mem.sync-placement-publication-plan/v2";
export const PLACEMENT_DECISION_CHUNK_V2_SCHEMA = "agent-mem.sync-placement-decision-chunk/v2";
export function placementDecisionReuseEnabled(home: string): boolean {
  return !!readFormatFloors(home)?.some(floor => floor.surface === "home" && !formatVersionBelow(floor.minReader, "0.36.0"));
}
export const PLACEMENT_PUBLICATION_CHUNK_SCHEMA = "agent-mem.sync-placement-publication-chunk/v1";
export const PLACEMENT_PUBLICATION_FACT_SCHEMA = "agent-mem.sync-placement-publication-fact/v1";
/** Closed hold/outcome events fit this bound; reserve future journal capacity before any publication effect. */
import { PLACEMENT_SOURCE_MAX_BYTES } from "./sync-placement-bound.ts";
export const PLACEMENT_PUBLICATION_RECORD_MAX_BYTES = 2048;
export interface PlacementPublicationSource {
  realm: PlacementRealm; source: "generation" | "legacy-local" | "legacy-main"; pathHash: string;
  dev: string; ino: string; byteLength: number; hash: string; mtimeNs: string; ctimeNs: string;
}
export type PlacementPublicationDecisionReason = PlacementHoldReason | "journal-hold" | "source-local" | "unsupported-reference" | "unverified-prune" | null;
export interface PlacementPublicationDecision { key: PlacementKey; sourcePlacement: "local" | "synced"; eligible: boolean; hold: boolean; reason: PlacementPublicationDecisionReason; dependencies: PlacementKey[] }
export interface PlacementPublicationObject { targetIndex: number; type: "blob" | "tree" | "commit"; path: string | null; oid: string; sha256: string; size: number }
export interface PlacementPublicationTarget {
  realm: PlacementRealm; publish: boolean; refHash: string; expectedRemoteHead: string | null; expectedCacheHead: string | null;
  descriptorHash: string; exportSetHash: string; tree: string | null; commit: string | null;
}
export type PlacementPublicationChunkKind = "sources" | "decisions" | "objects";
export interface PlacementPublicationChunk { schema: typeof PLACEMENT_PUBLICATION_CHUNK_SCHEMA; kind: PlacementPublicationChunkKind; index: number; items: (PlacementPublicationSource | PlacementPublicationDecision | PlacementPublicationObject)[] }
export interface PlacementPublicationChunkDescriptor { kind: PlacementPublicationChunkKind; index: number; hash: string; count: number; bytes: number; bucket?: string | null; ownerAttemptHash?: string | null }
export interface PlacementPublicationRoot {
  schema: typeof PLACEMENT_PUBLICATION_PLAN_SCHEMA | typeof PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA; epochHash: string; generation: string; homeHash: string; contextHash: string;
  markerHash: string; sourceHash: string; aliasesHash: string; policyHash: string; remoteHash: string;
  journal: { sequence: number; headHash: string }; reservedRecords: number; reservedRecordBytes: number[]; createdUnixSeconds: number; policySnapshotUnixMs: number;
  targets: PlacementPublicationTarget[]; chunks: PlacementPublicationChunkDescriptor[]; seal: string;
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
export interface PlacementDecisionLeaf { bucket: string; items: PlacementPublicationDecision[] }
/** Stable hash-prefix leaves for v2 decisions; insertion only affects its leaf unless it must split. */
export function partitionPlacementDecisions(decisions: readonly PlacementPublicationDecision[], initialBits: 0 | 5): PlacementDecisionLeaf[] {
  return drainSteps(partitionPlacementDecisionSteps(decisions, initialBits));
}
function* partitionPlacementDecisionSteps(decisions: readonly PlacementPublicationDecision[], initialBits: 0 | 5): Generator<void, PlacementDecisionLeaf[], void> {
  const entries: { id: string; bits: string; decision: PlacementPublicationDecision }[] = [];
  for (const [index, value] of array(decisions, PLACEMENT_JOURNAL_MAX_RECORDS).entries()) {
    if (index && index % 64 === 0) yield;
    const decision = item("decisions", value) as PlacementPublicationDecision;
    const id = placementKeyId(decision.key);
    const bits = [...id].map(digit => parseInt(digit, 16).toString(2).padStart(4, "0")).join("");
    entries.push({ id, bits, decision });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) return fail();
  const leaves: PlacementDecisionLeaf[] = [];
  const split = function* (prefix: string, values: typeof entries): Generator<void, void, void> {
    if (!values.length) return;
    yield;
    const items = values.map(value => value.decision);
    const bytes = publicationBytes({ schema: PLACEMENT_DECISION_CHUNK_V2_SCHEMA, bucket: prefix, items });
    if (prefix.length >= initialBits && bytes.length <= PLACEMENT_JOURNAL_CHUNK_MAX_BYTES - 256) {
      leaves.push({ bucket: prefix, items }); return;
    }
    if (prefix.length >= 256) return fail("bound");
    yield* split(prefix + "0", values.filter(value => value.bits[prefix.length] === "0"));
    yield* split(prefix + "1", values.filter(value => value.bits[prefix.length] === "1"));
  };
  yield* split("", entries);
  return leaves;
}
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
    if (!["generation", "legacy-local", "legacy-main"].includes(v.source as string) || !hex(v.pathHash) || !hex(v.hash) || !number(v.byteLength, PLACEMENT_SOURCE_MAX_BYTES)
      || ![v.dev, v.ino].every(x => typeof x === "string" && !/[\r\n]/.test(x) && /^(?:0|[1-9][0-9]{0,31})$/.test(x))
      || ![v.mtimeNs, v.ctimeNs].every(x => typeof x === "string" && !/[\r\n]/.test(x) && /^-?(?:0|[1-9][0-9]{0,31})$/.test(x))) return fail();
    return { realm: realm(v.realm), source: v.source as PlacementPublicationSource["source"], pathHash: v.pathHash, dev: v.dev as string, ino: v.ino as string, byteLength: v.byteLength, hash: v.hash, mtimeNs: v.mtimeNs as string, ctimeNs: v.ctimeNs as string };
  }
  if (kind === "decisions") {
    const v = object(input, ["key", "sourcePlacement", "eligible", "hold", "reason", "dependencies"]);
    if (!["local", "synced"].includes(v.sourcePlacement as string) || typeof v.eligible !== "boolean" || typeof v.hold !== "boolean" || v.eligible && v.hold || !reasons.includes(v.reason as PlacementPublicationDecisionReason) || v.eligible !== (v.reason === null)) return fail();
    const dependencies = array(v.dependencies, PLACEMENT_JOURNAL_MAX_RECORDS).map(validatePlacementKey);
    if (new Set(dependencies.map(placementKeyId)).size !== dependencies.length) return fail();
    return bounded({ key: validatePlacementKey(v.key), sourcePlacement: v.sourcePlacement as "local" | "synced", eligible: v.eligible, hold: v.hold as boolean, reason: v.reason as PlacementPublicationDecisionReason, dependencies }, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES - 256);
  }
  const v = object(input, ["targetIndex", "type", "path", "oid", "sha256", "size"]);
  const path = typeof v.path === "string" && !/[\r\n]/.test(v.path) ? v.path : undefined;
  const pack = path !== undefined && /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.test(path);
  const manifest = path !== undefined && /^prune-witnesses\/[a-f0-9]{64}\.json$/.test(path);
  const blobPath = path === "shard.json" || pack || manifest;
  const treePath = v.path === null || path === "rows" || path === "prune-witnesses" || path !== undefined && /^rows\/[a-f0-9]{64}$/.test(path);
  const maximum = v.type === "commit" || v.type === "blob" && !pack ? 65536 : 1048576;
  if (!number(v.targetIndex, 1) || !["blob", "tree", "commit"].includes(v.type as string) || !hex(v.oid, 40) || !hex(v.sha256)
    || v.type === "commit" && v.path !== null || v.type === "blob" && !blobPath || v.type === "tree" && !treePath) return fail();
  if(!number(v.size,maximum))return fail("bound");
  if(v.type!=="tree"&&v.size===0)return fail();
  return { targetIndex: v.targetIndex, type: v.type as PlacementPublicationObject["type"], path: v.path as string | null, oid: v.oid, sha256: v.sha256, size: v.size };
}
export function validatePlacementPublicationChunk(input: unknown): PlacementPublicationChunk {
  const v = object(input, ["schema", "kind", "index", "items"]);
  if (v.schema !== PLACEMENT_PUBLICATION_CHUNK_SCHEMA || !kinds.includes(v.kind as PlacementPublicationChunkKind) || !number(v.index, PLACEMENT_JOURNAL_MAX_OBJECTS - 1)) return fail();
  const items = array(v.items, PLACEMENT_JOURNAL_MAX_RECORDS).map(x => item(v.kind as PlacementPublicationChunkKind, x)); if (!items.length) return fail();
  return bounded({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind: v.kind as PlacementPublicationChunkKind, index: v.index, items }, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES);
}
/** V2 decision content is independent of its position in a publication. */
export function placementPublicationChunkBytes(root: PlacementPublicationRoot, chunk: PlacementPublicationChunk): Buffer {
  const descriptor = root.chunks[chunk.index];
  if (!descriptor || descriptor.kind !== chunk.kind) return fail();
  return root.schema === PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA && chunk.kind === "decisions"
    ? publicationBytes({ schema: PLACEMENT_DECISION_CHUNK_V2_SCHEMA, bucket: descriptor.bucket, items: chunk.items })
    : publicationBytes(chunk);
}
export function decodePlacementPublicationChunk(root: PlacementPublicationRoot, descriptor: PlacementPublicationChunkDescriptor, value: unknown): PlacementPublicationChunk {
  if (root.schema !== PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA || descriptor.kind !== "decisions") return validatePlacementPublicationChunk(value);
  const v = object(value, ["schema", "bucket", "items"]);
  if (v.schema !== PLACEMENT_DECISION_CHUNK_V2_SCHEMA || v.bucket !== descriptor.bucket) return fail("corrupt");
  return validatePlacementPublicationChunk({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind: "decisions", index: descriptor.index, items: v.items });
}
function normalizedRoot(input: unknown, checkSeal = true): PlacementPublicationRoot {
  const keys = ["schema", "epochHash", "generation", "homeHash", "contextHash", "markerHash", "sourceHash", "aliasesHash", "policyHash", "remoteHash", "journal", "reservedRecords", "reservedRecordBytes", "createdUnixSeconds", "policySnapshotUnixMs", "targets", "chunks", "seal"];
  const v = object(input, keys);
  if (![PLACEMENT_PUBLICATION_PLAN_SCHEMA, PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA].includes(v.schema as string) || !hex(v.generation, 32) || ![v.epochHash, v.homeHash, v.contextHash, v.markerHash, v.sourceHash, v.aliasesHash, v.policyHash, v.remoteHash, v.seal].every(x => hex(x))
    || !number(v.reservedRecords, PLACEMENT_JOURNAL_MAX_RECORDS) || !number(v.createdUnixSeconds) || !number(v.policySnapshotUnixMs)) return fail();
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
    const v2 = v.schema === PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA;
    const c = object(x, v2 ? ["kind", "index", "hash", "count", "bytes", "bucket", "ownerAttemptHash"] : ["kind", "index", "hash", "count", "bytes"]), kindIndex = kinds.indexOf(c.kind as PlacementPublicationChunkKind);
    if (kindIndex < lastKind || kindIndex < 0 || c.index !== index || !hex(c.hash) || !number(c.count, PLACEMENT_JOURNAL_MAX_RECORDS) || c.count < 1 || !number(c.bytes, PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) || c.bytes < 1) return fail();
    if (v2 && (c.kind === "decisions" ? typeof c.bucket !== "string" || !/^[01]{0,256}$/.test(c.bucket) : c.bucket !== null || c.ownerAttemptHash !== null)) return fail();
    if (v2 && c.ownerAttemptHash !== null && !hex(c.ownerAttemptHash)) return fail();
    lastKind = kindIndex; return { kind: c.kind as PlacementPublicationChunkKind, index, hash: c.hash, count: c.count, bytes: c.bytes,
      ...(v2 ? { bucket: c.bucket as string | null, ownerAttemptHash: c.ownerAttemptHash as string | null } : {}) };
  });
  if (v.schema === PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA) {
    const buckets = chunks.filter(c => c.kind === "decisions").map(c => c.bucket!);
    if (buckets.some((bucket, i) => typeof bucket !== "string" || buckets.some((other, j) => i !== j && other!.startsWith(bucket)))) return fail();
    if (chunks.some(chunk => chunk.ownerAttemptHash === v.seal)) return fail("corrupt");
  }
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
    const expected = root.chunks[index]!, bytes = placementPublicationChunkBytes(root, chunk);
    if (chunk.index !== index || chunk.kind !== expected.kind || chunk.items.length !== expected.count || bytes.length !== expected.bytes || publicationHash(bytes) !== expected.hash) return fail("corrupt");
    totals[chunk.kind] += chunk.items.length; if (totals[chunk.kind] > PLACEMENT_JOURNAL_MAX_RECORDS) return fail("bound");
    for (const row of chunk.items) {
      let identity: string;
      if (chunk.kind === "sources") { const s = row as PlacementPublicationSource; sourceBytes += s.byteLength; identity = canonicalJSON([s.realm, s.source, s.pathHash]); }
      else if (chunk.kind === "decisions") { const d = row as PlacementPublicationDecision; identity = canonicalJSON([d.key.realm, d.key.id]);
        if (root.schema === PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA) {
          const bits = [...placementKeyId(d.key)].map(digit => parseInt(digit, 16).toString(2).padStart(4, "0")).join("");
          if (!bits.startsWith(expected.bucket!)) return fail("corrupt");
        }
      }
      else { const o = row as PlacementPublicationObject; if (o.targetIndex >= root.targets.length || !root.targets[o.targetIndex]!.publish) return fail(); identity = canonicalJSON([o.targetIndex, o.type, o.path]); }
      const key = chunk.kind + identity; if (seen.has(key)) return fail(); seen.add(key);
    }
  }
  // The selected prefixes are a subset of what capture admitted under the same ceiling (#419); 8 MiB before 0.26.3.
  if (sourceBytes > PLACEMENT_SOURCE_MAX_BYTES) return fail("bound");
  return { root, chunks };
}
export function planPlacementPublication(input: Omit<PlacementPublicationRoot, "schema" | "chunks" | "seal">, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}): PlacementPublicationBundle {
  return drainSteps(planSteps(input, items));
}
/** #470: the same bundle, awaiting the caller's event loop between chunk items; chunk boundaries and hashes are identical. */
export async function planPlacementPublicationAsync(input: Omit<PlacementPublicationRoot, "schema" | "chunks" | "seal">, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}, yieldPoint?: CooperativeYield): Promise<PlacementPublicationBundle> {
  return await drainStepsAsync(planSteps(input, items), yieldPoint);
}
export interface PlacementDecisionOwner { bucket: string; hash: string; count: number; bytes: number; ownerAttemptHash: string }
/** Build a v2 plan using only content-exact, already verified physical owners. */
export function planPlacementPublicationV2(input: Omit<PlacementPublicationRoot, "schema" | "chunks" | "seal">, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}, owners: readonly PlacementDecisionOwner[]): PlacementPublicationBundle {
  return buildPlacementPublicationV2(planPlacementPublication(input, items), items, owners);
}
export async function planPlacementPublicationV2Async(input: Omit<PlacementPublicationRoot, "schema" | "chunks" | "seal">, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}, owners: readonly PlacementDecisionOwner[], yieldPoint?: CooperativeYield): Promise<PlacementPublicationBundle> {
  const original = await planPlacementPublicationAsync(input, items, yieldPoint);
  const decisions = array(object(items, kinds).decisions, PLACEMENT_JOURNAL_MAX_RECORDS) as PlacementPublicationDecision[];
  const leaves = await drainStepsAsync(partitionPlacementDecisionSteps(decisions, decisions.length <= 200 ? 0 : 5), yieldPoint);
  return buildPlacementPublicationV2(original, items, owners, leaves);
}
function buildPlacementPublicationV2(original: PlacementPublicationBundle, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}, owners: readonly PlacementDecisionOwner[], partition?: PlacementDecisionLeaf[]): PlacementPublicationBundle {
  const sources = original.chunks.filter(chunk => chunk.kind === "sources"), objects = original.chunks.filter(chunk => chunk.kind === "objects");
  const decisions = array(object(items, kinds).decisions, PLACEMENT_JOURNAL_MAX_RECORDS) as PlacementPublicationDecision[];
  const leaves = partition ?? partitionPlacementDecisions(decisions, decisions.length <= 200 ? 0 : 5);
  const chunks: PlacementPublicationChunk[] = [...sources, ...leaves.map(leaf => ({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA as typeof PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind: "decisions" as const, index: 0, items: leaf.items })), ...objects]
    .map((chunk, index) => ({ ...chunk, index }));
  const descriptors: PlacementPublicationChunkDescriptor[] = chunks.map((chunk, index) => {
    const bucket = chunk.kind === "decisions" ? leaves[index - sources.length]!.bucket : null;
    const bytes = chunk.kind === "decisions" ? publicationBytes({ schema: PLACEMENT_DECISION_CHUNK_V2_SCHEMA, bucket, items: chunk.items }) : publicationBytes(chunk);
    const hash = publicationHash(bytes);
    const owner = chunk.kind === "decisions" ? owners.find(candidate => candidate.bucket === bucket && candidate.hash === hash && candidate.bytes === bytes.length && candidate.count === chunk.items.length && hex(candidate.ownerAttemptHash)) : undefined;
    return { kind: chunk.kind, index, hash, count: chunk.items.length, bytes: bytes.length, bucket, ownerAttemptHash: owner?.ownerAttemptHash ?? null };
  });
  const { schema: _schema, chunks: _chunks, seal: _seal, ...body } = original.root;
  const rootBody = { ...body, schema: PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA, chunks: descriptors };
  return validatePlacementPublicationBundle({ root: { ...rootBody, seal: hashJSON(rootBody) }, chunks });
}
/** Items between step boundaries: at most 64 canonicalized chunk items per uninterrupted stretch. */
const STEP_ITEMS = 64;
function* planSteps(input: Omit<PlacementPublicationRoot, "schema" | "chunks" | "seal">, items: {
  sources: readonly PlacementPublicationSource[]; decisions: readonly PlacementPublicationDecision[]; objects: readonly PlacementPublicationObject[];
}): Generator<void, PlacementPublicationBundle, void> {
  const values = object(items, kinds), chunks: PlacementPublicationChunk[] = [];
  let stepped = 0;
  for (const kind of kinds) {
    let selected: PlacementPublicationChunk["items"] = [], selectedBytes = 0;
    const flush = () => { if (selected.length) { chunks.push(validatePlacementPublicationChunk({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind, index: chunks.length, items: selected })); selected = []; selectedBytes = 0; } };
    for (const value of array(values[kind], PLACEMENT_JOURNAL_MAX_RECORDS)) {
      if (++stepped >= STEP_ITEMS) { stepped = 0; yield; }
      // #462: the candidate chunk's exact canonical size, summed per item instead of re-serializing the whole chunk per row
      // (quadratic). canonicalJSON of an array is its items' canonical forms joined by commas, so the sum is identical.
      const row = item(kind, value), rowBytes = Buffer.byteLength(canonicalJSON(row));
      const empty = publicationBytes({ schema: PLACEMENT_PUBLICATION_CHUNK_SCHEMA, kind, index: chunks.length, items: [] }).length;
      if (empty + selectedBytes + (selected.length ? 1 : 0) + rowBytes > PLACEMENT_JOURNAL_CHUNK_MAX_BYTES) flush();
      selectedBytes += (selected.length ? 1 : 0) + rowBytes; selected.push(row);
    }
    flush();
  }
  const body = { ...object(input, ["epochHash", "generation", "homeHash", "contextHash", "markerHash", "sourceHash", "aliasesHash", "policyHash", "remoteHash", "journal", "reservedRecords", "reservedRecordBytes", "createdUnixSeconds", "policySnapshotUnixMs", "targets"]), schema: PLACEMENT_PUBLICATION_PLAN_SCHEMA,
    // #470: each chunk is serialized once here; the descriptor only needs its hash and length.
    chunks: chunks.map(c => { const bytes = publicationBytes(c); return { kind: c.kind, index: c.index, hash: publicationHash(bytes), count: c.items.length, bytes: bytes.length }; }) };
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
  return [`${stem}root.json`, ...root.chunks.filter(c => !c.ownerAttemptHash).map(c => `${stem}chunk-${String(c.index).padStart(5, "0")}.json`), `${stem}artifact.json`, `${stem}intent.json`, `${stem}receipt.json`];
}
