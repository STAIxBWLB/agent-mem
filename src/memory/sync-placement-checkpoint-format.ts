/**
 * Pure placement checkpoint codecs (#288 step 2). A checkpoint freezes the live placement window of one epoch and opens a
 * new one outside the v1 epoch directory, so only the live window is charged against the 256-object allowance.
 * Valid data and seals are neither person authority nor fresh install proof.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";
import { createWriterCommit, validateWriterCommit, validateWriterRevision, type WriterCommit, type WriterRevision } from "./sync-placement-writer-revision-format.ts";

export const PLACEMENT_CHECKPOINT_DIR = "sync-placement-checkpoints";
export const PLACEMENT_CHECKPOINT_COMMITS = "commits.jsonl";
export const PLACEMENT_CHECKPOINT_INTENT = "intent.json";
export const PLACEMENT_CHECKPOINT_WINDOWS = "windows";
export const PLACEMENT_CHECKPOINT_MANIFEST = "checkpoint-manifest.json";
export const PLACEMENT_CHECKPOINT_PROJECTION = "checkpoint-projection.json";
/** First minor whose readers resolve checkpoint windows; the person raises the floor (code never writes formats.json). */
export const PLACEMENT_CHECKPOINT_MIN_READER = "0.30.0";
export const PLACEMENT_CHECKPOINT_LIMIT = 256;
export const PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES = 64 * 1024;
export const PLACEMENT_CHECKPOINT_MANIFEST_MAX_BYTES = 256 * 1024;
export const PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES = PLACEMENT_CHECKPOINT_LIMIT * 1024;
export const PLACEMENT_CHECKPOINT_INTENT_MAX_BYTES = 1024 * 1024;
/** Archive bounds from the task 174 design: members of all frozen windows together. */
export const PLACEMENT_CHECKPOINT_ARCHIVE_MAX_MEMBERS = 65_536;
export const PLACEMENT_CHECKPOINT_ARCHIVE_MAX_BYTES = 8 * 1024 ** 3;
export const PLACEMENT_CHECKPOINT_MANIFEST_SCHEMA = "agent-mem.sync-placement-checkpoint-manifest/v1";
export const PLACEMENT_CHECKPOINT_CATALOG_SCHEMA = "agent-mem.sync-placement-checkpoint-catalog/v1";
export const PLACEMENT_CHECKPOINT_PROJECTION_SCHEMA = "agent-mem.sync-placement-checkpoint-projection/v1";
export const PLACEMENT_CHECKPOINT_COMMIT_SCHEMA = "agent-mem.sync-placement-checkpoint-commit/v1";
export const PLACEMENT_CHECKPOINT_INTENT_SCHEMA = "agent-mem.sync-placement-checkpoint-intent/v1";

export interface CheckpointMember { name: string; size: number; sha256: string }
export interface CheckpointCatalogEntry { attemptHash: string; window: number; members: CheckpointMember[] }
export interface CheckpointCatalogPage { schema: typeof PLACEMENT_CHECKPOINT_CATALOG_SCHEMA; epochHash: string; window: number; page: number; entries: CheckpointCatalogEntry[] }
export interface CheckpointProjectionDigest {
  schema: typeof PLACEMENT_CHECKPOINT_PROJECTION_SCHEMA; epochHash: string; window: number;
  journal: { sequence: number; headHash: string }; projectionHash: string;
}
export interface CheckpointManifestBody {
  schema: typeof PLACEMENT_CHECKPOINT_MANIFEST_SCHEMA; epochHash: string; activationHash: string; window: number;
  previousManifestHash: string | null;
  /** Every member of the window this checkpoint freezes (window - 1), with exact size and content hash. */
  archived: { window: number; members: CheckpointMember[] };
  journal: { sequence: number; headHash: string; chunks: number };
  /** The logical writer head and count the frozen windows end at; the new window's genesis binds this manifest and head. */
  writer: { sequence: number; headHash: string };
  catalog: CheckpointMember[];
  projection: CheckpointMember;
}
export interface CheckpointManifest extends CheckpointManifestBody { seal: string }
export interface CheckpointCommitBody {
  schema: typeof PLACEMENT_CHECKPOINT_COMMIT_SCHEMA; epochHash: string; window: number; previousHash: string;
  manifestHash: string; writerRevisionHash: string; writerCommitHash: string;
}
export interface CheckpointCommit extends CheckpointCommitBody { seal: string }
export interface CheckpointIntentBody {
  schema: typeof PLACEMENT_CHECKPOINT_INTENT_SCHEMA; epochHash: string; window: number;
  previousLogBytes: number; previousLogHash: string;
  manifest: CheckpointManifest; commit: CheckpointCommit;
  /** The exact staged content: resume rewrites these bytes only, abandon removes only these names. */
  pages: CheckpointCatalogPage[]; projection: CheckpointProjectionDigest;
  writerRevision: WriterRevision; writerCommit: WriterCommit;
}
export interface CheckpointIntent extends CheckpointIntentBody { seal: string }

function fail(code: "invalid" | "bound" = "invalid"): never { throw new SyncPlacementJournalError(code); }
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length) fail();
  const names = Object.getOwnPropertyNames(input); if (names.length !== keys.length) fail();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(input, key); if (!d || !("value" in d) || !d.enumerable) fail(); out[key] = d.value; }
  return out;
}
function array(input: unknown, maximum: number, minimum = 0): unknown[] {
  if (!input || typeof input !== "object" || types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length) fail();
  const length = input.length; if (length > maximum) fail("bound"); if (length < minimum) fail();
  if (Object.getOwnPropertyNames(input).length !== length + 1) fail();
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(input, String(i)); if (!d || !("value" in d) || !d.enumerable) fail(); out.push(d.value); }
  return out;
}
const hex = (input: unknown): string => { if (typeof input !== "string" || input.length !== 64 || !/^[a-f0-9]+$/.test(input)) fail(); return input; };
const integer = (input: unknown, minimum: number, maximum: number): number => {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) fail(); return input;
};
/** Member names never carry a separator; window members are the v1 families plus the checkpoint's own sealed files. */
export function checkpointMemberName(name: unknown): string {
  if (typeof name !== "string" || name.length > 128 || !/^[a-z0-9][a-z0-9.-]*$/.test(name) || name.includes("..")) fail(); return name;
}
export const checkpointWindowName = (window: number): string => String(integer(window, 1, PLACEMENT_CHECKPOINT_LIMIT)).padStart(5, "0");
export const checkpointCatalogName = (page: number): string => `checkpoint-catalog-${String(integer(page, 0, 4095)).padStart(5, "0")}.json`;
export const isCheckpointSealedName = (name: string): boolean =>
  name === PLACEMENT_CHECKPOINT_MANIFEST || name === PLACEMENT_CHECKPOINT_PROJECTION || /^checkpoint-catalog-\d{5}\.json$/.test(name);
function member(input: unknown): CheckpointMember {
  const v = object(input, ["name", "size", "sha256"]);
  return { name: checkpointMemberName(v.name), size: integer(v.size, 0, PLACEMENT_CHECKPOINT_MANIFEST_MAX_BYTES * 4), sha256: hex(v.sha256) };
}
function members(input: unknown, maximum: number, minimum = 0): CheckpointMember[] {
  const out = array(input, maximum, minimum).map(member);
  for (let i = 1; i < out.length; i++) if (out[i - 1]!.name >= out[i]!.name) fail();
  return out;
}
const bounded = (value: unknown, maximum: number) => { if (Buffer.byteLength(canonicalJSON(value) + "\n") > maximum) fail("bound"); };
function sealed<T extends object>(body: T, v: Record<string, unknown> | undefined, maximum: number): T & { seal: string } {
  const value = { ...body, seal: hashJSON(body) }; if (v && hex(v.seal) !== value.seal) fail(); bounded(value, maximum); return value;
}

/** The new window's writer genesis: domain-separated from the epoch genesis and bound to the manifest and the frozen head. */
export function checkpointWriterGenesis(epochHash: string, activationHash: string, manifestHash: string, previousHead: string): string {
  return hashJSON(["agent-mem.sync-placement-writer-window-genesis/v1", hex(epochHash), hex(activationHash), hex(manifestHash), hex(previousHead)]);
}
export function checkpointCommitGenesis(epochHash: string): string { return hashJSON(["agent-mem.sync-placement-checkpoint-genesis/v1", hex(epochHash)]); }

function catalogPage(input: unknown): CheckpointCatalogPage {
  const v = object(input, ["schema", "epochHash", "window", "page", "entries"]); if (v.schema !== PLACEMENT_CHECKPOINT_CATALOG_SCHEMA) fail();
  const window = integer(v.window, 1, PLACEMENT_CHECKPOINT_LIMIT), entries = array(v.entries, 4096).map(item => {
    const e = object(item, ["attemptHash", "window", "members"]);
    return { attemptHash: hex(e.attemptHash), window: integer(e.window, 0, window - 1), members: members(e.members, 4096, 1) };
  });
  for (let i = 1; i < entries.length; i++) if (entries[i - 1]!.attemptHash >= entries[i]!.attemptHash) fail();
  const page = { schema: PLACEMENT_CHECKPOINT_CATALOG_SCHEMA, epochHash: hex(v.epochHash), window, page: integer(v.page, 0, 4095), entries } as const;
  bounded(page, PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES); return page;
}
export function validateCheckpointCatalogPage(value: unknown): CheckpointCatalogPage { return catalogPage(value); }
export function validateCheckpointProjection(input: unknown): CheckpointProjectionDigest {
  const v = object(input, ["schema", "epochHash", "window", "journal", "projectionHash"]); if (v.schema !== PLACEMENT_CHECKPOINT_PROJECTION_SCHEMA) fail();
  const journal = object(v.journal, ["sequence", "headHash"]);
  const value = { schema: PLACEMENT_CHECKPOINT_PROJECTION_SCHEMA, epochHash: hex(v.epochHash), window: integer(v.window, 1, PLACEMENT_CHECKPOINT_LIMIT),
    journal: { sequence: integer(journal.sequence, 0, 20_000), headHash: hex(journal.headHash) }, projectionHash: hex(v.projectionHash) } as const;
  bounded(value, PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES); return value;
}
function manifest(input: unknown, isSealed: boolean): CheckpointManifest {
  const v = object(input, ["schema", "epochHash", "activationHash", "window", "previousManifestHash", "archived", "journal", "writer", "catalog", "projection", ...(isSealed ? ["seal"] : [])]);
  if (v.schema !== PLACEMENT_CHECKPOINT_MANIFEST_SCHEMA) fail();
  const window = integer(v.window, 1, PLACEMENT_CHECKPOINT_LIMIT), archived = object(v.archived, ["window", "members"]);
  const journal = object(v.journal, ["sequence", "headHash", "chunks"]), writer = object(v.writer, ["sequence", "headHash"]);
  const previous = v.previousManifestHash === null ? null : hex(v.previousManifestHash);
  if ((window === 1) !== (previous === null)) fail();
  const body: CheckpointManifestBody = { schema: PLACEMENT_CHECKPOINT_MANIFEST_SCHEMA, epochHash: hex(v.epochHash), activationHash: hex(v.activationHash), window,
    previousManifestHash: previous, archived: { window: integer(archived.window, 0, window - 1), members: members(archived.members, 4096, 1) },
    journal: { sequence: integer(journal.sequence, 0, 20_000), headHash: hex(journal.headHash), chunks: integer(journal.chunks, 0, 99_999) },
    writer: { sequence: integer(writer.sequence, 0, 64 * (PLACEMENT_CHECKPOINT_LIMIT + 1)), headHash: hex(writer.headHash) },
    catalog: members(v.catalog, 4096), projection: member(v.projection) };
  if (body.archived.window !== window - 1 || body.projection.name !== PLACEMENT_CHECKPOINT_PROJECTION
    || body.catalog.some((page, index) => page.name !== checkpointCatalogName(index))) fail();
  return sealed(body, isSealed ? v : undefined, PLACEMENT_CHECKPOINT_MANIFEST_MAX_BYTES);
}
export function createCheckpointManifest(body: CheckpointManifestBody): CheckpointManifest { return manifest(body, false); }
export function validateCheckpointManifest(value: unknown): CheckpointManifest { return manifest(value, true); }
function commit(input: unknown, isSealed: boolean): CheckpointCommit {
  const v = object(input, ["schema", "epochHash", "window", "previousHash", "manifestHash", "writerRevisionHash", "writerCommitHash", ...(isSealed ? ["seal"] : [])]);
  if (v.schema !== PLACEMENT_CHECKPOINT_COMMIT_SCHEMA) fail();
  const body: CheckpointCommitBody = { schema: PLACEMENT_CHECKPOINT_COMMIT_SCHEMA, epochHash: hex(v.epochHash), window: integer(v.window, 1, PLACEMENT_CHECKPOINT_LIMIT),
    previousHash: hex(v.previousHash), manifestHash: hex(v.manifestHash), writerRevisionHash: hex(v.writerRevisionHash), writerCommitHash: hex(v.writerCommitHash) };
  return sealed(body, isSealed ? v : undefined, 1024);
}
export function createCheckpointCommit(body: CheckpointCommitBody): CheckpointCommit { return commit(body, false); }
export function validateCheckpointCommit(value: unknown): CheckpointCommit { return commit(value, true); }
function intent(input: unknown, isSealed: boolean): CheckpointIntent {
  const v = object(input, ["schema", "epochHash", "window", "previousLogBytes", "previousLogHash", "manifest", "commit", "pages", "projection", "writerRevision", "writerCommit", ...(isSealed ? ["seal"] : [])]);
  if (v.schema !== PLACEMENT_CHECKPOINT_INTENT_SCHEMA) fail();
  const manifest = validateCheckpointManifest(v.manifest), genesis = checkpointWriterGenesis(manifest.epochHash, manifest.activationHash, manifest.seal, manifest.writer.headHash);
  let writerRevision: WriterRevision, writerCommit: WriterCommit;
  try { writerRevision = validateWriterRevision(v.writerRevision, genesis); writerCommit = validateWriterCommit(v.writerCommit); } catch { return fail(); }
  const body: CheckpointIntentBody = { schema: PLACEMENT_CHECKPOINT_INTENT_SCHEMA, epochHash: hex(v.epochHash), window: integer(v.window, 1, PLACEMENT_CHECKPOINT_LIMIT),
    previousLogBytes: integer(v.previousLogBytes, 0, PLACEMENT_CHECKPOINT_COMMITS_MAX_BYTES), previousLogHash: hex(v.previousLogHash),
    manifest, commit: validateCheckpointCommit(v.commit), pages: array(v.pages, 4096).map(catalogPage), projection: validateCheckpointProjection(v.projection), writerRevision, writerCommit };
  // Every staged file is bound to the manifest by name, size and hash, and the (W, 1) revision to the commit line.
  const digestOf = (value: unknown) => { const bytes = Buffer.from(canonicalJSON(value) + "\n"); return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  const pageOk = (page: CheckpointCatalogPage, index: number) => { const m = manifest.catalog[index], d = digestOf(page); return !!m && m.size === d.size && m.sha256 === d.sha256; };
  const projection = digestOf(body.projection);
  if (manifest.epochHash !== body.epochHash || manifest.window !== body.window || body.commit.epochHash !== body.epochHash || body.commit.window !== body.window
    || body.commit.manifestHash !== manifest.seal || body.pages.length !== manifest.catalog.length || !body.pages.every(pageOk)
    || manifest.projection.size !== projection.size || manifest.projection.sha256 !== projection.sha256
    || body.projection.window !== body.window || body.projection.epochHash !== body.epochHash
    || writerRevision.sequence !== 1 || writerRevision.epochHash !== body.epochHash || writerRevision.activationHash !== manifest.activationHash
    || writerRevision.journal.sequence !== manifest.journal.sequence || writerRevision.journal.headHash !== manifest.journal.headHash
    || canonicalJSON(createWriterCommit(writerRevision, genesis)) !== canonicalJSON(writerCommit)
    || body.commit.writerRevisionHash !== writerRevision.seal || body.commit.writerCommitHash !== writerCommit.seal) fail();
  return sealed(body, isSealed ? v : undefined, PLACEMENT_CHECKPOINT_INTENT_MAX_BYTES);
}
export function createCheckpointIntent(body: CheckpointIntentBody): CheckpointIntent { return intent(body, false); }
export function validateCheckpointIntent(value: unknown): CheckpointIntent { return intent(value, true); }
/** Catalog entries split into sealed 64 KiB pages in attempt order; pages carry no cross-page state. */
export function paginateCheckpointCatalog(epochHash: string, window: number, entries: readonly CheckpointCatalogEntry[]): CheckpointCatalogPage[] {
  const sorted = [...entries].sort((a, b) => a.attemptHash.localeCompare(b.attemptHash)), pages: CheckpointCatalogPage[] = [];
  let current: CheckpointCatalogEntry[] = [];
  const close = () => { pages.push(catalogPage({ schema: PLACEMENT_CHECKPOINT_CATALOG_SCHEMA, epochHash, window, page: pages.length, entries: current })); current = []; };
  for (const entry of sorted) {
    const next = [...current, entry];
    if (current.length && Buffer.byteLength(canonicalJSON({ schema: PLACEMENT_CHECKPOINT_CATALOG_SCHEMA, epochHash, window, page: pages.length, entries: next }) + "\n") > PLACEMENT_CHECKPOINT_PAGE_MAX_BYTES) close();
    current.push(entry);
  }
  if (current.length || !pages.length) close();
  return pages;
}
