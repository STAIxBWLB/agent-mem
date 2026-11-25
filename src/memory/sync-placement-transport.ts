/** Activated placement transport. The public sync entrypoint owns dispatch; this module never activates a profile. */
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON, readSelector } from "./generation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { generationSyncGit, generationSyncGitBytes, remoteVisibility, type SyncFailureCause, type SyncOptions, type SyncResult } from "./sync.ts";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { isLocalKey, localKeyOptInMessage, PlacementRealmRefusal, resolveShardProfile } from "./shard.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { outboundPolicyEvaluator, rowScreenIdentity } from "./sync-screen.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { captureSyncPlacementContextAsync, placementCaptureContextHash, previewSyncPlacementSources, type PlacementCapture, type PlacementPendingSource } from "./sync-placement-capture.ts";
import { readEffectiveSyncPlacementWriters, type EffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { SharedWriterRevisionError } from "./sync-placement-writer-revision-format.ts";
import { types } from "node:util";
import { RemoteRealmRefusal, type RemoteRealmCause } from "./sync-placement-remote-refusal.ts";
import type { PlannedGitObject } from "./sync-placement-git.ts";
import { PLACEMENT_FORMAT, PLACEMENT_PROFILE_SCHEMA, SyncPlacementFormatError } from "./sync-placement-format.ts";
import { PLACEMENT_JOURNAL_MAX_RECORDS, PLACEMENT_JOURNAL_MAX_OBJECTS, createPlacementRecord, placementKeyId, type PlacementEvent, type PlacementRealm, type PlacementRecord } from "./sync-placement-journal-format.ts";
import { rebuildPlacementProjection, type PlacementProjection } from "./sync-placement-projection.ts";
import { readPlacementJournal, readPlacementWriterJournalAnchors, placementWriterJournalToken, appendPlacementEvent, appendPlacementEvents, releasePlacementStorageCaches, ensurePlacementPublicationDurability, readPlacementPublicationMetadata, placementDecisionOwners, placementJournalObjectComposition, placementJournalObjectCompositionText, type PlacementJournalObjectComposition, type PlacementJournalRead, type PlacementStorageOptions } from "./sync-placement-journal-storage.ts";
import { amemReaderVersion, formatFloorAtLeast } from "./formats.ts";
import { clearPlacementNoopCache, placementNoopKey, readPlacementNoopCache, writePlacementNoopCache, type PlacementNoopCounts } from "./sync-placement-noop-cache.ts";
import { preparePlacementPublication, readPlacementPublication, recordPlacementPublicationPhase, type PlacementPublicationRead } from "./sync-placement-publication-storage.ts";
import { planPlacementPublication, planPlacementPublicationAsync, planPlacementPublicationV2Async, placementDecisionReuseEnabled, PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA, publicationBytes, publicationFileNames, type PlacementPublicationBundle, type PlacementPublicationDecision, type PlacementPublicationSource, type PlacementPublicationObject } from "./sync-placement-publication-plan.ts";
import { placementPublicationEventSteps } from "./sync-placement-publication-events.ts";
import { ShardHistoryAuditor, type ShardHistory } from "./shard-sync-history.ts";
import { ShardSyncApplications } from "./shard-sync-applications.ts";
import { ShardSourceChangedError, shardSourceRowsAsync, shardProvePrunes, shardImportRows, shardSelectorRetention, shardInstallHold, shardHoldWarning, type ShardSyncApplicationTarget } from "./shard-sync.ts";
import { shardSyncRef, SHARD_PACK_MAX_BYTES } from "./shard-sync-format.ts";
import { assertPublisherBoundary, ensurePublisherBoundary, publisherPruneLineages } from "./prune-publisher-lineage.ts";
import type { MemoryStore } from "./store.ts";
import type { PruneRow } from "./prune.ts";
import { materializePlacementRows, verifiedPlacementPrunes } from "./sync-placement-materialize.ts";
import { cooperativeYield, drainSteps, drainStepsAsync, PLACEMENT_APPEND_SLICE, yieldTurn, type CooperativeYield } from "./sync-placement-yield.ts";
import { placementCacheConfigStamp, placementCacheRootStamp, placementCacheTreePrivate, validatePlacementCacheConfig } from "./sync-placement-cache.ts";
import { PlacementSyncBoundError, placementSyncBoundDetail, placementSyncBoundMessage, placementSyncBoundReceipt, type PlacementSyncBound } from "./sync-placement-bound.ts";
import { PLACEMENT_CHECKPOINT_PENDING_MESSAGE, placementCheckpointPending } from "./sync-placement-checkpoint-storage.ts";
import type { SyncProgress, SyncProgressPhase } from "./sync-progress.ts";
import { PlacementSyncRefusal, placementRefusalCategoryOf, placementRefusalMessage, type PlacementRefusalCategory } from "./sync-placement-refusal.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";
import { readEffectiveRealmInventory } from "./sync-placement-realm-effective.ts";
import { listRemotePlacementRealms, REMOTE_REALM_ADVERTISEMENT_BYTES, type RemoteOnlyRealm } from "./sync-placement-realm-discovery.ts";
import { realPath } from "./platform.ts";
import { createRemoteAdoption, REMOTE_ADOPTION_SCHEMA, validateRemoteAdoption, type RemoteAdoption } from "./sync-placement-remote-adoption-format.ts";
import { remoteStagedPacks, selectRemoteMaterialization, type RemoteStagedPack } from "./sync-placement-remote-materialization.ts";

/**
 * #417 proof scope. A complete proof (full writer-install measurement, source, policy and selector recheck) is taken
 * at every effect boundary (`prove`) and may be reused by the fence checks in between (`check`) for at most this long.
 * Every check still verifies mutation ownership, the active epoch, writer revisions, the cache identity and
 * selectors, so a change that persists is refused at the next boundary before publication or import. Not configurable.
 */
export const PLACEMENT_PROOF_REUSE_MS = 1000;

export type PlacementSyncPhase = "before-plan-fsync" | "plan-fsynced" | "artifact-built" | "before-cas" | "cas-returned" | "before-ack" | "acknowledged" | "imported" | "before-receipt" | "receipt-written";
type Phase = (phase: PlacementSyncPhase) => void | Promise<void>;
type Target = ShardSyncApplicationTarget & { auditor: ShardHistoryAuditor; remoteHistory?: ShardHistory; candidate?: ShardHistory; objects: PlannedGitObject[]; localPrunes: Map<string, PruneRow> };
interface Materialized { bundle: PlacementPublicationBundle; decisions: PlacementPublicationDecision[]; projection: PlacementProjection; old: (ShardHistory | undefined)[]; events: PlacementEvent[]; preCount: number; holdCount: number; exported: number; withheld: number }
const digest = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const oid = (v: unknown): v is string => typeof v === "string" && v.length === 40 && /^[a-f0-9]+$/.test(v);
const sameRealm = (a: PlacementRealm, b: PlacementRealm) => canonicalJSON(a) === canonicalJSON(b);
const physical = (target: Target): PlacementRealm => target.realm.scope === "user" ? { scope: "user" } : { scope: "project", keyHash: digest(target.realm.key) };
function refuse(category: PlacementRefusalCategory = "other"): never { throw new PlacementSyncRefusal(category); }
class LocalKeyOptInRefusal extends Error {}
function remoteRefusal(error: unknown, fallback: RemoteRealmCause = "other"): never {
  if (error instanceof RemoteRealmRefusal) throw error;
  if (error instanceof SyncPlacementFormatError || error instanceof Error && error.message === "sync placement activation metadata unavailable or changed; inspect the retained activation before continuing") throw new RemoteRealmRefusal("epoch");
  const category = placementRefusalCategoryOf(error) ?? classifyPlacementError(error);
  const cause: RemoteRealmCause = category === "lock" ? "lock" : category === "epoch" ? "epoch"
    : category === "remote" ? "remote" : category === "size-bound" ? "bound"
    : category === "source-selection" || category === "policy" || category === "writer-pin" ? "drift" : fallback;
  throw new RemoteRealmRefusal(cause);
}
/** #426: map a foreign error to a category by its class and allowlisted code only, never by its message text. */
export function classifyPlacementError(error: unknown): PlacementRefusalCategory | undefined {
  try {
    if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
    if (error instanceof ShardSourceChangedError) return "source-selection";
    if (error instanceof SharedWriterRevisionError) return "writer-pin";
    if (error instanceof SyncPlacementJournalError) { const code = Object.getOwnPropertyDescriptor(error, "code")?.value; return code === "bound" ? "size-bound" : code === "changed" ? "source-selection" : "epoch"; }
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (code === "EBUSY" || code === "SQLITE_BUSY" || code === "EAGAIN") return "lock";
    return undefined;
  } catch { return undefined; }
}
function directory(file: string): void { const s = lstatSync(file); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) refuse(); }
function emptyHistory(): ShardHistory { return { rows: new Map(), files: new Map(), origins: new Map(), manifests: new Map(), version: "v3" }; }
/** Internal phase observer is a fault seam, not part of SyncOptions or the package barrel. */
export async function syncPlacementMemory(store: MemoryStore, opts: SyncOptions = {}, phase?: Phase, testOnlyError?: (error:unknown)=>void, testOnlyClock?: () => number, targets?: readonly MemoryStore[]): Promise<SyncResult> {
  return new PlacementTransport(store, opts, phase, testOnlyError, testOnlyClock, targets).run();
}

type RemoteReadOptions = Pick<SyncOptions, "signal" | "visibility">;
/** Shared configured-remote proof for discovery and audited read-only preview. */
async function configuredRemoteContext(homeInput: string, opts: RemoteReadOptions, requireVisibility = true) {
  // Git tracing can write an arbitrary file outside the sync cache, which a read-only listing must not do.
  if (Object.entries(process.env).some(([name, value]) => name.startsWith("GIT_TRACE") && !!value)) throw new RemoteRealmRefusal("environment");
  const home = realPath(homeInput), markers = readPlacementRuntimeMarkers(home);
  if (!markers.profile || typeof markers.profile !== "object" || Object.getOwnPropertyDescriptor(markers.profile, "schema")?.value !== PLACEMENT_PROFILE_SCHEMA) return refuse("epoch");
  const active = readActivePlacementBinding(home, markers.profile, markers.shards);
  if (!active) return refuse("epoch");
  const inventory = readEffectiveRealmInventory(home, active), root = join(home, "shard-sync-placement"), cache = join(root, "objects.git");
  let rootStamp: string, configStamp: string, initial: BigIntStats;
  try { rootStamp = placementCacheRootStamp(home); configStamp = placementCacheConfigStamp(cache); initial = lstatSync(cache, { bigint: true }); }
  catch { throw new RemoteRealmRefusal("cache"); }
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== BigInt(process.getuid?.() ?? -1) || (initial.mode & 0o077n) !== 0n) throw new RemoteRealmRefusal("cache");
  if (!placementCacheTreePrivate(cache)) throw new RemoteRealmRefusal("cache");
  const forbidden = ["commondir", "shallow", "info/grafts", "objects/info/alternates", "objects/info/http-alternates", "config.worktree"];
  try { if (forbidden.some(name => lstatSync(join(cache, name), { throwIfNoEntry: false }) !== undefined)) throw new RemoteRealmRefusal("cache"); }
  catch { throw new RemoteRealmRefusal("cache"); }
  const check = () => {
    let stat: BigIntStats; try { stat = lstatSync(cache, { bigint: true }); } catch { throw new RemoteRealmRefusal("cache"); }
    const nowMarkers = readPlacementRuntimeMarkers(home), now = readActivePlacementBinding(home, nowMarkers.profile, nowMarkers.shards);
    if (!now || canonicalJSON(now.profile) !== canonicalJSON(active.profile) || canonicalJSON(now.shards) !== canonicalJSON(active.shards)) return refuse("source-selection");
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== initial.dev || stat.ino !== initial.ino
      || !cacheUnchanged()) throw new RemoteRealmRefusal("cache");
    try { inventory.assertCurrent(); } catch { return refuse("source-selection"); }
  };
  const cacheUnchanged = () => { try { return placementCacheRootStamp(home) === rootStamp && placementCacheConfigStamp(cache) === configStamp && !forbidden.some(name => lstatSync(join(cache, name), { throwIfNoEntry: false }) !== undefined); } catch { return false; } };
  const args = (values: string[]) => ["--no-replace-objects", "--git-dir", cache, "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.commitGraph=false", ...values];
  check();
  const config = await generationSyncGitBytes(root, args(["config", "--local", "--no-includes", "--null", "--list"]), opts.signal, undefined, 65536);
  check(); if (config.code !== 0) throw new RemoteRealmRefusal("cache");
  let settings: ReadonlyMap<string, string>; try { settings = validatePlacementCacheConfig(new TextDecoder("utf-8", { fatal: true }).decode(config.out)); } catch { throw new RemoteRealmRefusal("cache"); }
  const url = settings.get("remote.origin.url");
  if (settings.get("core.bare") !== "true" || settings.has("remote.origin.pushurl") && settings.get("remote.origin.pushurl") !== url) throw new RemoteRealmRefusal("cache");
  if (!url || url.length > 4096 || url.startsWith("-") || /[\r\n\0]/.test(url)) return refuse("remote");
  if (requireVisibility && await (opts.visibility ?? remoteVisibility)(url) !== "private") return refuse("remote");
  check();
  return { home, active, inventory, root, cache, url, args, check };
}

/** Read only the configured placement remote; discovery never initializes a cache or adopts a realm. */
export async function discoverRemotePlacementRealms(homeInput: string, opts: RemoteReadOptions = {}): Promise<RemoteOnlyRealm[]> {
  try {
    const context = await configuredRemoteContext(homeInput, opts);
    const realms = await listRemotePlacementRealms(context.inventory, async () => {
      const advertised = await generationSyncGitBytes(context.root, context.args(["ls-remote", "--refs", context.url, "refs/heads/amem/p/*"]), opts.signal, undefined, REMOTE_REALM_ADVERTISEMENT_BYTES);
      context.check(); if (advertised.code !== 0) return refuse("remote");
      return advertised.out;
    });
    context.check(); return realms;
  } catch (error) { return remoteRefusal(error); }
}

/** Recheck the reviewed head and configured remote immediately before staging publication. */
export async function assertRemoteAdoptionCurrent(homeInput: string, project: string, plan: RemoteAdoption, opts: RemoteReadOptions = {}): Promise<void> {
  try {
    plan = validateRemoteAdoption(plan);
    const ctx = await configuredRemoteContext(homeInput, opts), key = createHash("sha256").update(project).digest("hex");
    if (key !== plan.keyHash || ctx.active.epoch.homeHash !== plan.homeHash || ctx.active.profile.placementHead !== plan.epochHash
      || ctx.active.epoch.generation !== plan.generation || createHash("sha256").update(ctx.url).digest("hex") !== plan.remoteHash) return refuse("source-selection");
    const ref = shardSyncRef({ scope: "project", key: project }), result = await generationSyncGitBytes(ctx.root,
      ctx.args(["ls-remote", "--refs", ctx.url, ref]), opts.signal, undefined, 256);
    ctx.check(); if (result.code !== 0 || new TextDecoder("utf-8", { fatal: true }).decode(result.out) !== `${plan.remoteHead}\t${ref}\n`) return refuse("remote");
  } catch (error) { return remoteRefusal(error); }
}

export interface PreparedRemoteRealm { plan: RemoteAdoption; packs: RemoteStagedPack[] }
async function auditRemoteHistory(ctx: Awaited<ReturnType<typeof configuredRemoteContext>>, project: string, head: string, opts: RemoteReadOptions): Promise<ShardHistory> {
  const gitBytes = async (args: string[], max: number) => { ctx.check(); const result = await generationSyncGitBytes(ctx.root, ctx.args(args), opts.signal, undefined, max); ctx.check(); if (result.code !== 0) return refuse("remote"); return Buffer.from(result.out); };
  const auditor = new ShardHistoryAuditor({ realm: { scope: "project", key: project }, generation: ctx.active.epoch.generation, placement: true, publicPrune: true,
    git: async args => { ctx.check(); const result = await generationSyncGit(ctx.root, ctx.args(args), opts.signal); ctx.check(); if (result.code !== 0) return refuse("remote"); return result.out; },
    blob: async (oid, path) => gitBytes(["cat-file", "blob", oid], path === "shard.json" || path.startsWith("prune-witnesses/") ? 65536 : SHARD_PACK_MAX_BYTES),
    object: async (oid, type) => {
      const bytes = await gitBytes(["cat-file", type, oid], type === "commit" ? 65536 : SHARD_PACK_MAX_BYTES);
      if (createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex") !== oid) return refuse("remote"); return bytes;
    },
  });
  return auditor.history(head);
}

/** Reconstruct frozen pack bytes from the existing cache without contacting the remote. */
export async function recoverRemoteStagedPacks(homeInput: string, project: string, plan: RemoteAdoption): Promise<RemoteStagedPack[]> {
  try {
    plan = validateRemoteAdoption(plan);
    const ctx = await configuredRemoteContext(homeInput, {}, false), key = createHash("sha256").update(project).digest("hex");
    if (key !== plan.keyHash || ctx.active.epoch.homeHash !== plan.homeHash || ctx.active.profile.placementHead !== plan.epochHash
      || ctx.active.epoch.generation !== plan.generation || createHash("sha256").update(ctx.url).digest("hex") !== plan.remoteHash) return refuse("source-selection");
    const selection = selectRemoteMaterialization(await auditRemoteHistory(ctx, project, plan.remoteHead, {})), packs = remoteStagedPacks(selection);
    if (selection.omitted !== plan.omitted || canonicalJSON(packs.map(pack => ({ name: pack.name, bytes: pack.bytes.length }))) !== canonicalJSON(plan.packs)) return refuse("source-selection");
    ctx.check(); return packs;
  } catch (error) { return remoteRefusal(error, "staging"); }
}
/** Fetch and audit one explicitly named remote-only realm into the existing private cache, never the live shard. */
export async function prepareRemotePlacementRealm(homeInput: string, project: string, opts: RemoteReadOptions = {}): Promise<PreparedRemoteRealm> {
  let releaseRoot: (() => void) | undefined, releaseSync: (() => void) | undefined, incoming: string | undefined;
  let context: Awaited<ReturnType<typeof configuredRemoteContext>> | undefined;
  try {
    if (!project || Buffer.byteLength(project) > 400 || /[\r\n\0]/.test(project)) return refuse("source-selection");
    context = await configuredRemoteContext(homeInput, opts);
    const ctx = context, keyHash = createHash("sha256").update(project).digest("hex");
    // Ref names use only 16 hex characters; a prefix already bound to another full key is never adopted as a new realm.
    if (ctx.inventory.realms.some(realm => realm.scope === "project" && realm.keyHash.slice(0, 16) === keyHash.slice(0, 16))) return refuse("source-selection");
    const ref = shardSyncRef({ scope: "project", key: project }), source = previewSyncPlacementSources(ctx.home);
    const writers = readEffectiveSyncPlacementWriters(ctx.home), journalToken = placementWriterJournalToken(ctx.home, ctx.active.profile.placementHead);
    const journal = readPlacementWriterJournalAnchors(ctx.home, ctx.active.profile.placementHead);
    const journalHead = journal.sequence ? journal.records[journal.sequence - 1]!.seal : ctx.active.profile.placementHead;
    const check = () => {
      ctx.check();
      try { writers.assertCurrent(); if (placementWriterJournalToken(ctx.home, ctx.active.profile.placementHead) !== journalToken) return refuse("source-selection"); source.assertSourcesUnchanged(); }
      catch { return refuse("source-selection"); }
      ctx.check();
    };
    check(); releaseRoot = acquireMutation(ctx.root); if (!releaseRoot) return refuse("lock");
    releaseSync = generationSyncLock(ctx.root); if (!releaseSync) return refuse("lock");
    const gitBytes = async (args: string[], max: number) => { check(); const result = await generationSyncGitBytes(ctx.root, ctx.args(args), opts.signal, undefined, max); check(); if (result.code !== 0) return refuse("remote"); return Buffer.from(result.out); };
    const advertised = await gitBytes(["ls-remote", "--refs", ctx.url, ref], 256);
    const match = /^([a-f0-9]{40})\t([^\n]+)\n$/.exec(advertised.toString("utf8"));
    if (!match || match[2] !== ref) return refuse("remote");
    const head = match[1]!; incoming = `refs/amem/placement-incoming/${randomBytes(16).toString("hex")}`;
    await gitBytes(["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", ctx.url, `${ref}:${incoming}`], 65536);
    const fetched = (await gitBytes(["rev-parse", "--verify", incoming], 128)).toString("utf8").trim(); if (fetched !== head) return refuse("remote");
    const history = await auditRemoteHistory(ctx, project, head, opts), selection = selectRemoteMaterialization(history), packs = remoteStagedPacks(selection);
    if (!(await gitBytes(["ls-remote", "--refs", ctx.url, ref], 256)).equals(advertised)) return refuse("remote");
    check();
    const plan = createRemoteAdoption({ schema: REMOTE_ADOPTION_SCHEMA, homeHash: ctx.active.epoch.homeHash, epochHash: ctx.active.profile.placementHead,
      generation: ctx.active.epoch.generation, keyHash, remoteHash: createHash("sha256").update(ctx.url).digest("hex"), remoteHead: head,
      sourceHash: source.base.sourceHash, policyHash: source.base.policyHash, aliasesHash: source.base.aliasesHash,
      writerHash: writers.revisionHash, inventoryHead: ctx.inventory.extensionHead, journalSequence: journal.sequence, journalHead, omitted: selection.omitted,
      packs: packs.map(pack => ({ name: pack.name, bytes: pack.bytes.length })) });
    check(); return { plan, packs };
  } catch (error) { return remoteRefusal(error); }
  finally {
    if (context && incoming) try {
      context.check(); await generationSyncGit(context.root, context.args(["update-ref", "--no-deref", "-d", incoming]), undefined);
    } catch { /* no authoritative state uses this private cache ref */ }
    releaseSync?.(); releaseRoot?.();
  }
}
class PlacementTransport {
  readonly store: MemoryStore; readonly opts: SyncOptions; readonly phase?: Phase; readonly testOnlyError?: (error:unknown)=>void; readonly home: string; readonly root: string; readonly cache: string;
  readonly releases: (() => void)[] = []; readonly temporary: string[] = []; readonly refs: string[] = [];
  releaseCurated?: () => void;
  targets: Target[] = []; homeMutation?: MutationHandle; rootMutation?: MutationHandle; cacheIdentity?: {dev:number;ino:number}; cacheConfigIdentity?: string; epochHash = ""; journal!: PlacementJournalRead; capture?: PlacementCapture;
  machineId = ""; url = ""; revision = ""; accepted = false; factual = false; attempted = false; lastPolicyCheckUnixMs?: number; lastPolicyHash?: string; policyCheckSource?: "live"|"durable-intent"; attemptHash?: string;
  evaluator?: ReturnType<typeof outboundPolicyEvaluator>; applications?: ShardSyncApplications; current?: Materialized; recovered = false;
  writerInventory?:EffectiveSyncPlacementWriters;
  /** #462: a closed cause the catch block identified before `result` derives the rest. */
  failureCause?: SyncFailureCause;
  readonly clock: () => number; readonly progress?: SyncProgress; provedAt?: number; bound?: PlacementSyncBound; capturedPolicyVersion?: string;
  /** #288 step 1: the journal-objects bound's own composition, numbers only, set where the bound is measured. */
  journalObjects?: PlacementJournalObjectComposition;
  readonly selected?: readonly MemoryStore[];
  constructor(store: MemoryStore, opts: SyncOptions, phase?: Phase, testOnlyError?: (error:unknown)=>void, clock: () => number = () => performance.now(), selected?: readonly MemoryStore[]) { this.selected=selected; this.clock=clock; this.progress=opts.progress; this.testOnlyError=testOnlyError; this.store = store; this.opts = opts; this.phase = phase; this.home = store.profile.home; this.root = join(this.home, "shard-sync-placement"); this.cache = join(this.root, "objects.git"); }
  attest(): void {
    if (!this.opts.placementAttestation || this.opts.screen && !this.opts.policyVersion) refuse("policy");
    const value = memoryPolicySnapshot(this.opts.placementAttestation());
    if (!value || value.legacySyncQuiesced !== true || !Array.isArray(value.writers)) refuse("writer-pin");
    const writers = [...value.writers].sort((a,b) => a.writerId.localeCompare(b.writerId));
    if(!this.writerInventory||canonicalJSON(writers)!==canonicalJSON(this.writerInventory.writers))refuse("writer-pin");
    this.writerInventory.assertCurrent();
  }
  metadata(): void {
    this.writerInventory?.assertCurrent();
    if(this.rootMutation)assertMutationHandle(this.rootMutation,this.root);
    if(this.cacheIdentity){const stat=lstatSync(this.cache);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.dev!==this.cacheIdentity.dev||stat.ino!==this.cacheIdentity.ino)refuse();}
    if(this.cacheIdentity){
      for(const name of ["commondir","shallow","info/grafts","objects/info/alternates","objects/info/http-alternates","config.worktree"])if(existsSync(join(this.cache,name)))refuse();
      const stamp=this.configStamp();if(this.cacheConfigIdentity!==undefined&&stamp!==this.cacheConfigIdentity)refuse();
    }
    if (this.homeMutation) assertMutationHandle(this.homeMutation, this.home);
    for (const target of this.targets) if (target.mutation) assertMutationHandle(target.mutation, target.store.dir);
    const markers = readPlacementRuntimeMarkers(this.home), active = readActivePlacementBinding(this.home, markers.profile, markers.shards);
    if (!active || active.profile.placementHead !== this.epochHash || active.epoch.homeHash !== this.journal.epoch.homeHash) refuse("epoch");
  }
  verify(fresh: boolean): void {
    this.metadata();
    if (this.factual) { this.progress?.alive(); return; }
    if (this.opts.signal?.aborted) refuse();
    const complete = fresh || this.provedAt === undefined || this.clock() - this.provedAt >= PLACEMENT_PROOF_REUSE_MS;
    if (complete) {
      this.provedAt = undefined; this.attest(); this.capture?.assertUnchanged(); this.provedAt = this.clock();
      if(this.capture){this.lastPolicyHash=this.capture.context.policyHash;this.lastPolicyCheckUnixMs=Date.now();this.policyCheckSource="live";}
    }
    // The host policy version is a cheap callback: compare it on every check, not only on complete proofs.
    if (!complete && this.capture && this.opts.policyVersion && this.opts.policyVersion() !== this.capturedPolicyVersion) refuse("policy");
    this.progress?.proof(complete);
    for (const target of this.targets) for (const check of target.selectorChecks ?? []) check();
    this.metadata();
  }
  /** Fence check inside a proof scope: reuses a complete proof no older than PLACEMENT_PROOF_REUSE_MS. */
  check = (): void => this.verify(false);
  /** Effect boundary: always a fresh complete proof. */
  prove(): void { this.verify(true); }
  async call<T>(work: () => T | Promise<T>): Promise<T> { this.check(); const result = await work(); this.check(); return result; }
  args(args: string[]): string[] { return ["--no-replace-objects", "--git-dir", this.cache, "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.commitGraph=false", ...args]; }
  async git(args: string[]) { return this.call(() => generationSyncGit(this.root, this.args(args), this.opts.signal)); }
  async required(args: string[]): Promise<string> { const result = await this.git(args); if (result.code !== 0) refuse(); return result.out; }
  /** #426: the progress phase this run is in, kept even without a progress reporter so a refusal can name it. */
  phaseNow: SyncProgressPhase = "writer-verification";
  enter(...args: Parameters<SyncProgress["phase"]>): void { this.phaseNow = args[0]; this.progress?.phase(...args); }
  refusal?: PlacementRefusalCategory;
  /** #612: the last materialization's decision counts, and the counts a no-op cache hit returned. */
  decisionCounts?: PlacementNoopCounts; noopHit?: PlacementNoopCounts; noopKept=false;
  /** #612: the no-op reuse key over this run's captured and freshly read inputs; undefined when any input is missing. */
  noopSlot(): string { return digest(canonicalJSON({epochHash:this.epochHash,realms:this.targets.map(physical)})); }
  noopKey(): string|undefined {
    const capture=this.capture,version=amemReaderVersion();if(!capture||!version||!this.writerInventory||!this.epochHash)return undefined;
    // An arbitrary host screen has no cross-run identity, so it always takes the full path; only the package's deterministic screen binds.
    const screenIdentity=this.opts.screen===undefined?null:rowScreenIdentity(this.opts.screen);if(screenIdentity===undefined)return undefined;
    return placementNoopKey({version,screenIdentity,writersHash:hashJSON({writers:this.writerInventory.writers,revision:this.writerInventory.revisionHash??null}),
      policyHash:capture.context.policyHash,sourceHash:capture.context.sourceHash,aliasesHash:capture.context.aliasesHash,contextHash:placementCaptureContextHash(capture),
      markerHash:capture.markerHash,remoteHash:digest(this.url),journal:{sequence:this.journal.sequence,headHash:this.journal.headHash},
      targets:this.targets.map(target=>({remote:target.remote??null,local:target.local??null,pruned:[...(target.store.prunePort().snapshot().pruned??[])],fetched:[...target.fetched]}))});
  }
  async observe(phase: PlacementSyncPhase): Promise<void> { await this.phase?.(phase); }
  storage(factual = false): PlacementStorageOptions { if (!this.homeMutation) refuse(); return { mutation: this.homeMutation, assertCurrent: factual ? () => this.metadata() : this.check, ...(this.attemptHash ? { publicationAttemptHash: this.attemptHash } : {}) }; }
  configStamp():string {
    return placementCacheConfigStamp(this.cache);
  }
  async bindCacheConfig():Promise<void>{
    const before=this.configStamp(),output=await this.required(["config","--local","--no-includes","--null","--list"]);
    validatePlacementCacheConfig(output);
    if(this.configStamp()!==before)refuse();this.cacheConfigIdentity=before;
  }
  async independent(): Promise<boolean> {
    if (!existsSync(this.cache)) return false; directory(this.cache); const initial=lstatSync(this.cache);
    if (!placementCacheTreePrivate(this.cache)) refuse();
    if (existsSync(join(this.cache, "commondir")) || existsSync(join(this.cache, "objects", "info", "http-alternates")) || existsSync(join(this.cache, "objects", "info", "alternates")) || existsSync(join(this.cache, "shallow")) || existsSync(join(this.cache, "info", "grafts"))) refuse();
    if (await this.required(["rev-parse", "--is-bare-repository"]) !== "true" || await this.required(["rev-parse", "--show-object-format"]) !== "sha1" || (await this.git(["config", "--get", "core.worktree"])).code !== 1) refuse();
    if((await this.git(["config","--get","extensions.partialClone"])).code !== 1
      || (await this.git(["config","--get-regexp","^remote[.].*[.](promisor|partialclonefilter)$"])).code !== 1)refuse();
    const final=lstatSync(this.cache); if(final.isSymbolicLink()||!final.isDirectory()||final.dev!==initial.dev||final.ino!==initial.ino)refuse();
    this.cacheIdentity={dev:final.dev,ino:final.ino};await this.bindCacheConfig();return true;
  }
  async initialize(): Promise<void> {
    const markers = readPlacementRuntimeMarkers(this.home), active = readActivePlacementBinding(this.home, markers.profile, markers.shards);
    if (!active || this.store.profile.publicationFormat !== PLACEMENT_FORMAT || this.store.profile.placementHead !== active.profile.placementHead) refuse("epoch");
    this.epochHash = active.profile.placementHead; this.machineId = active.shards.machine.id; this.revision = readSelector(this.home).revision; this.journal = readPlacementJournal(this.home, this.epochHash);
    await yieldTurn(); // #462: no lock is held yet; each heavy read gets its own macrotask
    this.writerInventory=readEffectiveSyncPlacementWriters(this.home);await yieldTurn();this.attest();
    // #450: an inventory driver passes at most two explicitly opened realms (one unchanged publication plan); otherwise the store's own pair.
    const opened = this.selected ?? this.store.openedSyncTargets();
    if (!opened.length || opened.length > 2 || !opened.includes(this.store) || opened.some(item => item.profile.home !== this.home || !item.profile.sharded || !item.profile.generation
      || item.profile.generation !== this.store.profile.generation
      || !this.selected && !item.profile.shardUser && item.profile.shardKey !== this.store.profile.shardKey)) refuse("source-selection");
    for (const item of opened) {
      const realm = item.profile.shardUser ? { scope: "user" as const } : { scope: "project" as const, key: item.profile.shardKey! };
      const target = { store: item, realm, generation: item.profile.generation!, rows: new Map(), fetched: new Set(), sources: [], pending: [], origins: new Map(), holds: [], manifests: new Map(), eligible: new Set(), registered: [], objects: [], localPrunes: new Map() } as unknown as Target;
      target.auditor = new ShardHistoryAuditor({ realm, generation: target.generation, placement: true, publicPrune: true,
        git: args => this.required(args), blob: (object, path) => this.blob(object, path), object: (oid,type) => this.rawHistoryObject(oid,type) }); this.targets.push(target);
    }
    if (new Set(this.targets.map(target => shardSyncRef(target.realm))).size !== this.targets.length) refuse("source-selection");
    const local = this.targets.find(target => target.realm.scope === "project" && isLocalKey(target.realm.key));
    if (local?.realm.scope === "project" && this.opts.remote === undefined) throw new LocalKeyOptInRefusal(localKeyOptInMessage(local.realm.key));
    if (existsSync(this.root)) placementCacheRootStamp(this.home);
    const existing = existsSync(this.root) ? await this.independent() : false;
    if (!existing && !this.opts.remote) refuse("remote");
    this.url = this.opts.remote ?? await this.required(["remote", "get-url", "origin"]);
    if (!this.url || this.url.length > 4096 || this.url.startsWith("-") || /[\r\n\0]/.test(this.url)) refuse("remote");
    if (await this.call(() => (this.opts.visibility ?? remoteVisibility)(this.url)) !== "private") refuse("remote");
    await yieldTurn(); this.prove(); // a host callout ends any reusable proof
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    const transport = acquireMutation(this.root); if (!transport) refuse("lock"); this.rootMutation=transport; this.releases.push(transport);
    const sync = generationSyncLock(this.root); if (!sync) refuse("lock"); this.releases.push(sync);
    for (const dir of [...new Set([this.home, ...this.targets.map(target => target.store.dir)])].sort()) {
      const handle = acquireMutation(dir); if (!handle) refuse("lock"); this.releases.push(handle); if (dir === this.home) this.homeMutation = handle;
      for (const target of this.targets) if (target.store.dir === dir) target.mutation = handle;
    }
    // #450: each explicitly selected realm tracks and republishes its own curated cache.
    const curated = (this.selected ?? [this.store]).map(item => item.beginCuratedCacheUpdate());
    this.releaseCurated = () => { for (const release of curated.reverse()) release(); };
    this.journal = readPlacementJournal(this.home, this.epochHash); this.revision = readSelector(this.home).revision; this.attest();
    if (!existing) await this.required(["init", "--bare", "--template=", "--object-format=sha1", "-q", this.cache]);
    if (!await this.independent()) refuse();
    const previous = await this.git(["remote", "get-url", "origin"]);
    if (this.opts.remote) { this.cacheConfigIdentity=undefined; await this.required(previous.code === 0 ? ["remote", "set-url", "origin", this.url] : ["remote", "add", "origin", this.url]); }
    await this.bindCacheConfig();
    for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]])
      if (await this.required(args) !== this.url) refuse("remote");
    const reservation = this.journal.publicationReservation;
    const pending = reservation ? readPlacementPublication(this.home, this.epochHash, reservation.attemptHash) : undefined;
    if (!pending || pending.bundle.root.remoteHash === digest(this.url)) { this.enter("remote-verification"); await this.fetch(); }
  }
  async rawHistoryObject(object:string,type:"commit"|"tree"):Promise<Buffer>{
    // One process per object (#420): the typed SHA-1 below proves type, size and bytes, so no -t/-s preflight is needed.
    if(!oid(object))refuse();
    const limit=type==="commit"?65536:SHARD_PACK_MAX_BYTES;
    const result=await this.call(()=>generationSyncGitBytes(this.root,this.args(["cat-file",type,object]),this.opts.signal,undefined,limit));
    if(result.code!==0||createHash("sha1").update(`${type} ${result.out.length}\0`).update(result.out).digest("hex")!==object)refuse();
    return Buffer.from(result.out);
  }
  async blob(object: string, path: string): Promise<Buffer> {
    const limit = path === "shard.json" || path.startsWith("prune-witnesses/") ? 65536 : SHARD_PACK_MAX_BYTES;
    // The auditor proves the blob SHA-1; the output bound refuses an oversized object (#420).
    const result = await this.call(() => generationSyncGitBytes(this.root, this.args(["cat-file", "blob", object]), this.opts.signal, undefined, limit));
    if (result.code !== 0 || result.out.length < 1) refuse(); return Buffer.from(result.out);
  }
  async fetch(): Promise<void> {
    for (const target of this.targets) {
      const ref = shardSyncRef(target.realm); if ((await this.git(["symbolic-ref", "--quiet", ref])).code !== 1) refuse();
      const cached = await this.git(["rev-parse", "--verify", "--quiet", ref]);
      if (cached.code !== 0 && cached.code !== 1 || cached.code === 0 && !oid(cached.out)) refuse(); target.local = cached.code === 0 ? cached.out : undefined;
      const advertised = await this.git(["ls-remote", "--exit-code", "origin", ref]);
      if (advertised.code === 2) { if (target.local && !this.journal.publicationReservation) refuse(); target.remote = undefined; target.remoteHistory = undefined; continue; }
      const fields = advertised.out.split("\t"); if (advertised.code !== 0 || fields.length !== 2 || !oid(fields[0]) || fields[1] !== ref) refuse();
      const incoming = `refs/amem/placement-incoming/${randomBytes(16).toString("hex")}`; this.refs.push(incoming);
      await this.required(["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "origin", `${ref}:${incoming}`]);
      const tip = await this.required(["rev-parse", "--verify", incoming]); if (!oid(tip) || tip !== fields[0]) refuse();
      if (target.local && !await target.auditor.verifiedAncestor(target.local, tip) && !this.journal.publicationReservation) refuse();
      target.remote = tip; target.remoteHistory = await target.auditor.history(tip);
      target.rows = new Map(target.remoteHistory.rows); target.fetched = new Set(target.remoteHistory.rows.keys()); target.origins = new Map(target.remoteHistory.origins);
      target.manifests = new Map(target.remoteHistory.manifests); target.eligible = new Set([...target.manifests.values()].filter(item => item.eligible).map(item => item.row.id));
    }
  }
  async preflight(mergeLocal = true): Promise<void> {
    // #462: the collector yields inside the wire round trip, then re-proves the source metadata it exported.
    const pause = cooperativeYield();
    for (const target of this.targets) {
      const source = await shardSourceRowsAsync(target.store, target.realm, pause); target.sources = source.sources; target.pending = source.pending;
      target.localPrunes = new Map([...source.rows.filter((row): row is PruneRow => row.op === "prune"), ...source.pending.map(item => item.row)].map(row => [row.id,row]));
      if (mergeLocal) for (const row of source.rows) { const old = target.rows.get(row.id); if (old && hashJSON(old) !== hashJSON(row)) refuse(); target.rows.set(row.id, row); }
    }
    shardProvePrunes(this.targets);
  }
  async startCapture(): Promise<void> {
    const pending: PlacementPendingSource[] = this.targets.flatMap(target => target.pending.filter(item => !item.unclaimed).map(item => ({ realm: physical(target),
      pathHash: digest(`log/${item.row.machine}.jsonl`), offset: item.offset, prefixHash: item.prefixHash, line: item.line })));
    this.capturedPolicyVersion = this.opts.policyVersion?.();
    this.capture = await captureSyncPlacementContextAsync(this.home, { attest: this.opts.placementAttestation!, ...(this.opts.policyVersion ? { policyVersion: this.opts.policyVersion } : {}) }, this.targets.map(physical), pending);
    if (this.capture.activeHead !== this.epochHash || this.capture.context.homeHash !== this.journal.epoch.homeHash
      || canonicalJSON(this.capture.context.writers) !== canonicalJSON(this.writerInventory?.writers)
      || !!this.writerInventory?.revisionSequence&&this.capture.writerInventory?.revisionHash!==this.writerInventory.revisionHash) refuse("source-selection");
    await yieldTurn(); this.prove(); // #462: the complete proof that closes capture runs in its own turn; it is the same proof
  }
  async applicationCoordinator(): Promise<ShardSyncApplications> {
    if (!this.homeMutation) refuse();
    const applications = new ShardSyncApplications({ home: this.home, root: this.root, url: this.url, targets: this.targets, homeMutation: this.homeMutation,
      getRevision: () => this.revision, setRevision: revision => { this.revision = revision; }, check: this.check,
      history: (tip, target) => (target as Target).auditor.history(tip), candidateHistory: async target => (target as Target).candidate ?? (target as Target).remoteHistory ?? emptyHistory(),
      assertAncestor: async (a,b,target) => { if (!await (target as Target).auditor.verifiedAncestor(a,b)) refuse(); },
      readObject: async object => {
        const type = await this.required(["cat-file", "-t", object]); if (type !== "commit" && type !== "tree" && type !== "blob") refuse();
        const limit = type === "commit" ? 65536 : SHARD_PACK_MAX_BYTES; // the coordinator proves the typed SHA-1
        const result = await this.call(() => generationSyncGitBytes(this.root, this.args(["cat-file", type, object]), this.opts.signal, undefined, limit));
        if (result.code !== 0) refuse(); return { type, body: result.out };
      }, afterAdvance: () => { this.capture = undefined; this.metadata(); } });
    await applications.loadExisting(); this.applications = applications; return applications;
  }
  evaluate(value: unknown) {
    // The configured policy is read once; complete proofs on both sides bind that read to the captured policy hash.
    if (!this.evaluator) { this.prove(); this.evaluator = outboundPolicyEvaluator(this.home, this.opts.screen); this.prove(); }
    this.check(); const evaluate = this.evaluator, verdict = evaluate(structuredClone(value) as Record<string, unknown>); this.check(); return verdict;
  }
  nativeProofs(): Set<string> {
    const verified=new Set<string>();
    for(const target of this.targets){
      const candidates=[...target.rows.values()].filter((row):row is PruneRow=>row.op==="prune"&&row.generation===target.generation);
      const lineages=candidates.length&&existsSync(join(target.store.dir,"local",`publisher-boundary-${this.machineId}.json`))?publisherPruneLineages(target.store.profile,target.mutation!,candidates):undefined;
      for(const key of verifiedPlacementPrunes([{realm:target.realm,generation:target.generation,rows:target.rows,fetched:target.fetched,...(lineages?{lineageIds:new Set(lineages.keys())}:{})}]))verified.add(key);
    }
    return verified;
  }
  async materialize(createdUnixSeconds: number, frontier: PlacementJournalRead, frozen?: PlacementPublicationBundle): Promise<Materialized> {
    if (!this.capture) refuse(); const capture = this.capture;
    const projection = rebuildPlacementProjection(frontier.epoch, frontier.records.slice(0, frozen?.root.journal.sequence ?? frontier.sequence));
    const old = await Promise.all(this.targets.map(async (target, index) => {
      const head = frozen ? frozen.root.targets[index]?.expectedRemoteHead : target.remote;
      return head ? target.auditor.history(head) : undefined;
    }));
    const verified = this.nativeProofs();
    const materialized = await materializePlacementRows({capture,projection,generation:this.journal.epoch.generation,
      targets:this.targets.map(target=>({realm:target.realm,generation:target.generation,remote:target.remote,local:target.local,fetched:target.fetched,
        localPrunes:target.localPrunes,pruned:new Set(target.store.prunePort().snapshot().pruned??[])})),
      old,verifiedPrunes:verified,evaluate:value=>this.evaluate(value),createdUnixSeconds,...(frozen?{frozen}:{}),progress:{phase:(name,unit,total)=>this.enter(name,unit,total),advance:()=>this.progress?.advance()},
      readTree:(_index,head)=>this.required(["rev-parse",`${head}^{tree}`]),
      publisherLineages:(index,rows)=>{const target=this.targets[index]!;assertPublisherBoundary(target.store.profile,target.mutation!);return publisherPruneLineages(target.store.profile,target.mutation!,rows);}});
    // The row-evaluation scope closes with a complete proof before any verdict is planned or made durable.
    this.prove();
    for(const [index,target]of this.targets.entries())Object.assign(target,materialized.targets[index]!);
    const {decisions,plannedTargets:targets,objects}=materialized;
    {
      // Each decision lands in one bucket: policy-declined, source-local, or held for a journal/dependency reason.
      const counts={permitted:0,local:0,declined:0,held:0},other=new Set(["journal-hold","related-local","unsupported-reference","unverified-prune"]);
      for(const d of decisions)counts[d.eligible?"permitted":d.reason==="source-local"?"local":d.reason&&!other.has(d.reason)?"declined":"held"]++;
      this.decisionCounts=counts;this.progress?.counts(counts);
    }
    this.enter("publication-plan");
    const body={epochHash:this.epochHash,generation:this.journal.epoch.generation,homeHash:capture.context.homeHash,contextHash:placementCaptureContextHash(capture),markerHash:capture.markerHash,
      sourceHash:capture.context.sourceHash,aliasesHash:capture.context.aliasesHash,policyHash:capture.context.policyHash,remoteHash:digest(this.url),
      journal:frozen?.root.journal??{sequence:frontier.sequence,headHash:frontier.headHash},createdUnixSeconds,policySnapshotUnixMs:frozen?.root.policySnapshotUnixMs??this.lastPolicyCheckUnixMs??Date.now(),targets,reservedRecords:0,reservedRecordBytes:[] as number[]};
    const planPause=cooperativeYield();
    const v2 = frozen ? frozen.root.schema === PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA : placementDecisionReuseEnabled(this.home);
    const owners = v2 ? frozen ? frozen.root.chunks.filter(c => c.kind === "decisions" && c.ownerAttemptHash && typeof c.bucket === "string").map(c => ({ bucket: c.bucket!, hash: c.hash, count: c.count, bytes: c.bytes, ownerAttemptHash: c.ownerAttemptHash! })) : await placementDecisionOwners(this.home, this.epochHash, body.journal.sequence, body.targets.map(target => target.realm)) : [];
    const items = {sources:capture.prefixes,decisions,objects};
    let bundle=v2 ? await planPlacementPublicationV2Async(body,items,owners,planPause) : await planPlacementPublicationAsync(body,items,planPause);
    await yieldTurn(); // #462: planning is pure; each step gets its own turn
    let scheduled=await this.eventsAsync(bundle,projection,old,planPause);
    await yieldTurn();
    if(!frozen&&body.journal.sequence+scheduled.events.length>PLACEMENT_JOURNAL_MAX_RECORDS)
      throw new PlacementSyncBoundError({phase:"publication-plan",kind:"journal-records",limit:PLACEMENT_JOURNAL_MAX_RECORDS,observed:body.journal.sequence+scheduled.events.length});
    let head=body.journal.headHash;
    const lengths:number[]=[],pause=cooperativeYield();
    for(const [index,event]of scheduled.events.entries()){await pause();const record=createPlacementRecord(this.epochHash,body.journal.sequence+index+1,head,event);head=record.seal;lengths.push(publicationBytes(record).length);}
    await yieldTurn();
    bundle=v2 ? await planPlacementPublicationV2Async({...body,reservedRecords:lengths.length,reservedRecordBytes:lengths},items,owners,planPause) : await planPlacementPublicationAsync({...body,reservedRecords:lengths.length,reservedRecordBytes:lengths},items,planPause);
    await yieldTurn();
    scheduled=await this.eventsAsync(bundle,projection,old,planPause);
    if(frozen&&canonicalJSON(bundle)!==canonicalJSON(frozen))refuse();
    return{bundle,decisions,projection,old,...scheduled,exported:scheduled.events.filter(event=>event.kind==="publication-ambiguous").length,withheld:decisions.filter(decision=>!decision.eligible).length};
  }
  events(bundle:PlacementPublicationBundle,projection:PlacementProjection,old:(ShardHistory|undefined)[]):{events:PlacementEvent[];preCount:number;holdCount:number}{
    return drainSteps(placementPublicationEventSteps(bundle,projection,old));
  }
  /** #470: the same schedule, awaiting the caller's event loop between decisions; the event order is identical. */
  eventsAsync(bundle:PlacementPublicationBundle,projection:PlacementProjection,old:(ShardHistory|undefined)[],pause?:CooperativeYield):Promise<{events:PlacementEvent[];preCount:number;holdCount:number}>{
    return drainStepsAsync(placementPublicationEventSteps(bundle,projection,old),pause);
  }
  async frozenOld(bundle:PlacementPublicationBundle):(Promise<(ShardHistory|undefined)[]>){
    const values:(ShardHistory|undefined)[]=[];
    for(const [index,target]of this.targets.entries()){
      const planned=bundle.root.targets[index];if(!planned||!sameRealm(planned.realm,physical(target))||planned.refHash!==digest(shardSyncRef(target.realm)))refuse();
      values.push(planned.expectedRemoteHead?await target.auditor.history(planned.expectedRemoteHead):undefined);
    }
    return values;
  }
  async appendThrough(bundle:PlacementPublicationBundle,events:PlacementEvent[],count:number,factual=false):Promise<void>{
    const root=bundle.root;let read=readPlacementJournal(this.home,this.epochHash),head=root.journal.headHash;
    const records:PlacementRecord[]=[],pause=cooperativeYield();
    for(const [index,event]of events.entries()){
      await pause();
      const record=createPlacementRecord(this.epochHash,root.journal.sequence+index+1,head,event);head=record.seal;records.push(record);
    }
    this.enter(factual?"acknowledgment":"journal","records",count);
    const consumed=read.sequence-root.journal.sequence;
    if(consumed<0||consumed>root.reservedRecords)refuse();
    for(let index=0;index<Math.min(consumed,records.length);index++){
      await pause();
      if(canonicalJSON(read.records[root.journal.sequence+index])!==canonicalJSON(records[index]))refuse();
    }
    // #462: the journal this function compared must still be the journal it appends to after the yields above.
    {const now=readPlacementJournal(this.home,this.epochHash);if(now.sequence!==read.sequence||now.headHash!==read.headHash||now.pending!==read.pending)refuse();read=now;}
    if(read.pendingBatch){
      const index=read.sequence-root.journal.sequence, end=index+read.pendingBatch.count;
      if(read.pendingBatch.attemptHash!==root.seal || end>count || end>events.length)refuse();
      appendPlacementEvents(this.home,this.epochHash,events.slice(index,end),read.headHash,this.storage(factual));read=readPlacementJournal(this.home,this.epochHash);
    }else if(read.pending&&!read.pendingRecord&&formatFloorAtLeast(this.home,"sync","0.28.0")){
      const index=read.sequence-root.journal.sequence;
      // The storage writer compares the saved bytes against the exact canonical intent before writing.
      // Try the current bounded batch and the unsliced batch used by older writers, in that order. A torn intent
      // precedes every record write, so a prefix shared by both can safely complete the first slice and continue.
      const ends=[Math.min(count,index+PLACEMENT_APPEND_SLICE),count];
      for(const end of new Set(ends)) {
        try { appendPlacementEvents(this.home,this.epochHash,events.slice(index,end),read.headHash,this.storage(factual));read=readPlacementJournal(this.home,this.epochHash);break; }
        catch(error){ if(!(error instanceof SyncPlacementJournalError)||error.code!=="conflict")throw error; }
      }
    }
    if(read.pending){
      const sequence=read.pendingRecordSequence??read.sequence+1, index=sequence-root.journal.sequence-1;
      const record=records[index];
      if(!record||index>=count||read.pendingRecord&&canonicalJSON(read.pendingRecord)!==canonicalJSON(record))refuse();
      appendPlacementEvent(this.home,this.epochHash,events[index]!,record.previousHash,this.storage(factual));read=readPlacementJournal(this.home,this.epochHash);
    }
    this.progress?.advance(Math.max(0,Math.min(count,read.sequence-root.journal.sequence)));
    const next=read.sequence-root.journal.sequence;
    if(next<count&&formatFloorAtLeast(this.home,"sync","0.28.0")){
      // #462: the same records in order, as consecutive atomic batches with a macrotask turn between them. A crash between
      // batches leaves a durable prefix, which the `consumed` path above already resumes exactly as recorded.
      for(let at=next;at<count;at+=PLACEMENT_APPEND_SLICE){
        if(at>next)await yieldTurn();
        const end=Math.min(count,at+PLACEMENT_APPEND_SLICE),from=readPlacementJournal(this.home,this.epochHash);
        if(from.sequence!==root.journal.sequence+at)refuse();
        appendPlacementEvents(this.home,this.epochHash,events.slice(at,end),from.headHash,this.storage(factual));this.progress?.advance(end-at);
      }
      return;
    }
    for(let index=next;index<count;index++){
      await pause();
      const record=records[index];if(!record)refuse();appendPlacementEvent(this.home,this.epochHash,events[index]!,record.previousHash,this.storage(factual));this.progress?.advance();
    }
  }
  cacheStamp():string {
    const hash=createHash("sha256");
    const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){
      const file=join(dir,name),stat=lstatSync(file,{bigint:true});
      if(stat.isSymbolicLink()||stat.uid!==BigInt(process.getuid?.()??-1)||(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1n)))refuse();
      hash.update(canonicalJSON([file.slice(this.cache.length),String(stat.dev),String(stat.ino),String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs),String(stat.mode)]));
      if(stat.isDirectory())walk(file);
    }};
    walk(this.cache);return hash.digest("hex");
  }
  /** Bind installed bytes after all host callbacks, not merely the pure pre-install object plan.
   * ponytail: the final private-cache/source check and Git's accepted push are separate transactions.
   * Compatible writers honor the held fences; stronger same-user raw-writer isolation needs descriptor-bound immutable object access.
   * Policy tightening cannot revoke an already in-flight accepted push; the result reports that ceiling. */
  async installedObjectGuard(bundle:PlacementPublicationBundle):Promise<()=>void>{
    const before=this.cacheStamp();
    for(const chunk of bundle.chunks)if(chunk.kind==="objects")for(const item of chunk.items as PlacementPublicationObject[]){
      const result=await this.call(()=>generationSyncGitBytes(this.root,this.args(["cat-file",item.type,item.oid]),this.opts.signal,undefined,item.size));
      if(result.code!==0||result.out.length!==item.size||digest(result.out)!==item.sha256
        ||createHash("sha1").update(`${item.type} ${item.size}\0`).update(result.out).digest("hex")!==item.oid)refuse();
    }
    return()=>{if(this.cacheStamp()!==before)refuse();};
  }
  async allPublic(bundle:PlacementPublicationBundle):Promise<boolean>{
    for(const [index,planned]of bundle.root.targets.entries())if(planned.publish){
      const target=this.targets[index];if(!target||!target.remote||!planned.commit)return false;
      if(!await target.auditor.verifiedAncestor(planned.commit,target.remote))return false;
    }
    return true;
  }
  async terminalUnknown(read:PlacementPublicationRead):Promise<SyncResult>{
    this.factual=true;this.recovered=true;const root=read.bundle.root;this.attemptHash=root.seal;
    const projection=rebuildPlacementProjection(this.journal.epoch,this.journal.records.slice(0,root.journal.sequence));
    const holds=this.events(read.bundle,projection,[]).events.filter(event=>event.kind==="hold");
    const before=readPlacementJournal(this.home,this.epochHash);
    if(before.pending){
      const old=await this.frozenOld(read.bundle),schedule=this.events(read.bundle,projection,old);
      const sequence=before.pendingBatch ? before.sequence+before.pendingBatch.count : before.pendingRecordSequence??before.sequence+1;
      if(!before.pendingRecord&&schedule.events[sequence-root.journal.sequence-1]?.kind!=="hold")refuse();
      await this.appendThrough(read.bundle,schedule.events,Math.max(holds.length,sequence-root.journal.sequence),true);
    }else await this.appendThrough(read.bundle,holds,holds.length,true);
    if(read.pendingPhase==="artifact-built"){
      const guard=await this.installedObjectGuard(read.bundle);guard();
      recordPlacementPublicationPhase(this.home,this.epochHash,root.seal,"artifact-built",{exportHash:hashJSON(root.targets.map(target=>target.exportSetHash))},this.storage(true));
    }
    if(read.pendingPhase==="publication-intent"){
      const artifact=read.facts.find(fact=>fact.phase==="artifact-built");if(!artifact)refuse();
      recordPlacementPublicationPhase(this.home,this.epochHash,root.seal,"publication-intent",{artifactFactHash:artifact.seal,policyHash:root.policyHash,policyCheckUnixMs:root.policySnapshotUnixMs},this.storage(true));
    }
    read=readPlacementPublication(this.home,this.epochHash,root.seal);
    const journal=readPlacementJournal(this.home,this.epochHash),intent=read.facts.find(fact=>fact.phase==="publication-intent");
    await this.observe("before-receipt");
    recordPlacementPublicationPhase(this.home,this.epochHash,root.seal,"completed",{intentFactHash:intent?.seal??null,journal:{sequence:journal.sequence,headHash:journal.headHash},
      outcomeHash:hashJSON({attempt:root.seal,outcome:"unknown"}),outcome:"unknown"},this.storage(true));
    await this.observe("receipt-written");
    return this.result(false,"unknown","The retained placement attempt may have published; its frozen holds and unknown outcome were preserved. Start a fresh sync to recheck current sources.");
  }
  async materializeObjects(bundle:PlacementPublicationBundle):Promise<void>{
    this.enter("artifact-construction","objects",this.targets.reduce((sum,target)=>sum+target.objects.length,0));
    for(const target of this.targets)for(const object of target.objects){
      this.check();const file=join(this.root,`.placement-object-${randomBytes(16).toString("hex")}`);this.temporary.push(file);
      const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{let at=0;while(at<object.bytes.length){const n=writeSync(fd,object.bytes,at,object.bytes.length-at,at);if(n<=0)refuse();at+=n;}fsyncSync(fd);}finally{closeSync(fd);}
      const written=await this.required(["hash-object","-w","-t",object.type,"--no-filters","--",file]);if(written!==object.oid)refuse();this.progress?.advance();
    }
    const saved=readPlacementPublication(this.home,this.epochHash,bundle.root.seal);
    if(!saved.facts.some(fact=>fact.phase==="artifact-built"))recordPlacementPublicationPhase(this.home,this.epochHash,bundle.root.seal,"artifact-built",{exportHash:hashJSON(bundle.root.targets.map(target=>target.exportSetHash))},this.storage());
    await this.observe("artifact-built");this.prove();
  }
  async finish(material:Materialized,recovery=false):Promise<SyncResult>{
    this.factual=true;this.recovered=recovery;const root=material.bundle.root;
    await this.observe("before-ack");await this.appendThrough(material.bundle,material.events,material.events.length,true);await this.observe("acknowledged");this.metadata();
    for (const [index,target] of this.targets.entries()) {
      const planned = root.targets[index]!;
      const head = planned.publish ? planned.commit : target.remote;
      if (head) {
        const actual = await target.auditor.history(head); target.remoteHistory = actual; target.candidate = actual;
        target.rows = new Map(actual.rows); target.fetched = new Set(actual.rows.keys()); target.origins = new Map(actual.origins);
      } else { target.rows.clear(); target.fetched.clear(); target.candidate = emptyHistory(); }
    }
    await this.preflight(false);this.enter("import");
    const applications=await this.applicationCoordinator();await applications.prepare();
    for(const target of this.targets)for(const hold of target.holds)shardInstallHold(this.root,hold);
    await applications.install();
    for(const target of this.targets){
      shardImportRows(target);target.pending=[];target.selectorChecks=[];shardSelectorRetention(target,false,true);
    }
    applications.application.nativeApplied=this.targets.reduce((sum,target)=>sum+[...target.rows.values()].filter(row=>row.op==="prune"&&row.generation===target.generation).length,0);
    applications.application.transport="durable";applications.application.phase="complete";
    await this.observe("imported");this.metadata();
    for(const target of this.targets)ensurePublisherBoundary(target.store.profile,target.mutation!);
    for(const [index,target]of this.targets.entries())if(root.targets[index]!.publish){
      const planned=root.targets[index]!, ref=shardSyncRef(target.realm), existing=await this.git(["rev-parse","--verify","--quiet",ref]);
      if (existing.code === 0 && existing.out === planned.commit) continue;
      if (existing.code !== 1 && (existing.code !== 0 || existing.out !== planned.expectedCacheHead)) refuse();
      if (existing.code === 1 && planned.expectedCacheHead !== null) refuse();
      await this.required(["update-ref","--no-deref",ref,planned.commit!,planned.expectedCacheHead??"0".repeat(40)]);
    }
    await this.observe("before-receipt");this.enter("receipt");
    const read=readPlacementPublication(this.home,this.epochHash,root.seal),intent=read.facts.find(fact=>fact.phase==="publication-intent"),journal=readPlacementJournal(this.home,this.epochHash);
    if(!intent)refuse();
    recordPlacementPublicationPhase(this.home,this.epochHash,root.seal,"completed",{intentFactHash:intent.seal,journal:{sequence:journal.sequence,headHash:journal.headHash},
      outcomeHash:hashJSON({attempt:root.seal,commits:root.targets.map(target=>target.commit)}),outcome:"committed"},this.storage(true));
    await this.observe("receipt-written");return this.result(true,"committed");
  }
  importsNeeded():boolean{
    return this.targets.some(target=>{
      if(target.pending.length||target.batch||target.holds.some(hold=>!existsSync(hold.file)||existsSync(hold.file+".pending")))return true;
      const durable=new Set(target.store.prunePort().snapshot().durablePruneIds??[]);
      return [...target.fetched].some(id=>{
        const row=target.rows.get(id);if(!row)refuse();
        return row.op==="prune" ? row.generation===target.generation&&!durable.has(id)
          : !target.sources.some(source=>source.row.id===id&&source.publicWitness);
      });
    });
  }
  result(ok:boolean,outcome:"committed"|"unknown"|"not-needed",error?:string):SyncResult{
    // #462: a closed cause on every failure; the most specific known fact wins.
    const cause:SyncFailureCause|undefined=ok?undefined:this.opts.signal?.aborted?"stopped":this.bound?"bound":outcome==="unknown"?"unknown-outcome":this.failureCause??(this.refusal?"refusal":"unavailable");
    return{ok,pushed:this.accepted&&(this.attempted||this.recovered&&!!this.current?.bundle.root.targets.some(target=>target.publish)),entries:this.current?.exported??0,...(error?{error}:{}),
      ...(cause?{failure:{cause,...(cause==="refusal"&&this.refusal?{category:this.refusal}:{})}}:{}),...(this.applications?{pruneApplication:{...this.applications.application}}:{}),
      placementPublication:{...(this.attemptHash?{attemptHash:this.attemptHash}:{}),outcome,...(this.bound?{bound:this.bound}:{}),...(this.journalObjects?{journalObjects:this.journalObjects}:{}),...(this.refusal?{refusal:{category:this.refusal,phase:this.phaseNow}}:{}),withheld:this.current?.withheld??(this.noopHit?this.noopHit.local+this.noopHit.declined+this.noopHit.held:0),exported:this.current?.exported??0,
        ...(this.lastPolicyHash?{lastPolicyHash:this.lastPolicyHash}:{}),...(this.lastPolicyCheckUnixMs!==undefined?{lastPolicyCheckUnixMs:this.lastPolicyCheckUnixMs,policyCheckSource:this.policyCheckSource??(this.recovered?"durable-intent" as const:"live" as const)}:{}),
        policyCeiling:"last-positive-check-before-in-flight-push",...(this.recovered?{recovered:true}:{})}};
  }
  async run():Promise<SyncResult>{
    let result:SyncResult;
    try{result=await this.execute();}finally{releasePlacementStorageCaches();} // #420 memos live for one sync only
    // Success is reported only from the real receipt; a failed or stopped run can never leave a successful status.
    if(result.ok)this.progress?.finish("succeeded");
    else if(this.opts.signal?.aborted)this.progress?.finish("cancelled","cancelled");
    else this.progress?.finish("failed",this.bound?"bound":result.placementPublication?.outcome==="unknown"?"unknown-outcome":"unavailable",this.bound?"size-bound":this.refusal);
    return result;
  }
  /** Object slots the plan and its reserved journal chunks need, checked before the first durable plan byte. */
  assertPlanCapacity(bundle:PlacementPublicationBundle):void{
    // The refusal's own report (#288 step 1): the same inputs the count uses, split by what holds each object.
    let composition:PlacementJournalObjectComposition|undefined;
    const objects=readPlacementPublicationMetadata(this.home,this.epochHash,io=>{
      const planned=publicationFileNames(bundle.root),reserved=io.reservedJournalNames(bundle.root),names=io.names();
      composition=placementJournalObjectComposition({names:[...names,...planned,...reserved],plan:{root:bundle.root,reserved}});
      return new Set([...names,...planned,...reserved]).size+1;
    });
    if(composition)this.journalObjects=composition;
    if(objects>PLACEMENT_JOURNAL_MAX_OBJECTS)throw new PlacementSyncBoundError({phase:"publication-plan",kind:"journal-objects",limit:PLACEMENT_JOURNAL_MAX_OBJECTS,observed:objects},
      composition&&placementJournalObjectCompositionText(composition));
  }
  async execute():Promise<SyncResult>{
    try{
      this.enter("writer-verification");
      await this.initialize();
      const reservation=this.journal.publicationReservation,retained=reservation?readPlacementPublication(this.home,this.epochHash,reservation.attemptHash):undefined;
      if(retained){
        this.attemptHash=retained.bundle.root.seal;if(retained.pending&&!retained.pendingPhase)refuse();
        ensurePlacementPublicationDurability(this.home,this.epochHash,this.storage(true));
        const lastIntent=retained.facts.find(fact=>fact.phase==="publication-intent");if(lastIntent?.phase==="publication-intent"){this.lastPolicyHash=lastIntent.policyHash;this.lastPolicyCheckUnixMs=lastIntent.policyCheckUnixMs;this.policyCheckSource="durable-intent";}
        if(retained.bundle.root.remoteHash!==digest(this.url))return await this.terminalUnknown(retained);
        if(retained.facts.some(fact=>fact.phase==="publication-intent")&&await this.allPublic(retained.bundle)){
          this.factual=true;const old=await this.frozenOld(retained.bundle),projection=rebuildPlacementProjection(this.journal.epoch,this.journal.records.slice(0,retained.bundle.root.journal.sequence));
          const schedule=this.events(retained.bundle,projection,old),decisions=retained.bundle.chunks.filter(chunk=>chunk.kind==="decisions").flatMap(chunk=>chunk.items as PlacementPublicationDecision[]);
          this.current={bundle:retained.bundle,decisions,projection,old,...schedule,exported:schedule.events.filter(event=>event.kind==="publication-ambiguous").length,withheld:decisions.filter(decision=>!decision.eligible).length};
          this.accepted=true;return await this.finish(this.current,true);
        }
      }
      this.enter("source-capture");
      try { await yieldTurn();await this.preflight();for(const target of this.targets)if(existsSync(join(target.store.dir,"local",`publisher-boundary-${this.machineId}.json`)))assertPublisherBoundary(target.store.profile,target.mutation!);await yieldTurn();await this.startCapture(); }
      catch(error) { if(retained)return await this.terminalUnknown(retained);if(placementSyncBoundReceipt(error))throw error;throw new PlacementSyncRefusal(placementRefusalCategoryOf(error)??classifyPlacementError(error)??"other"); }
      if(retained){
        const root=retained.bundle.root;
        const stable=root.contextHash===placementCaptureContextHash(this.capture!)&&root.markerHash===this.capture!.markerHash&&root.sourceHash===this.capture!.context.sourceHash
          &&root.policyHash===this.capture!.context.policyHash&&root.targets.every((target,index)=>target.expectedRemoteHead===(this.targets[index]?.remote??null));
        if(!stable)return await this.terminalUnknown(retained);
      }
      // #612: a fresh attempt whose every no-op input equals the last not-needed run skips policy evaluation; any mismatch takes the full path.
      const noopKey=retained?undefined:this.noopKey();
      if(noopKey){
        const hit=readPlacementNoopCache(this.home,this.noopSlot(),noopKey);
        if(hit){
          await yieldTurn();const applications=await this.applicationCoordinator();await applications.prepare();
          if(!this.importsNeeded()){this.prove();this.noopHit=hit;this.noopKept=true;this.progress?.counts(hit);this.attemptHash=undefined;return this.result(true,"not-needed");}
        }
      }
      clearPlacementNoopCache(this.home,this.noopSlot());
      const frontier=retained?{...this.journal,sequence:retained.bundle.root.journal.sequence,headHash:retained.bundle.root.journal.headHash}:this.journal;
      const material=await this.materialize(retained?.bundle.root.createdUnixSeconds??Math.floor(Date.now()/1000),frontier,retained?.bundle);
      const changed=material.bundle.root.targets.some((target,index)=>target.publish&&target.commit!==(this.targets[index]!.remote??null));
      // Nothing durable exists for a fresh attempt yet: an epoch without room for this plan refuses here, typed.
      await yieldTurn();if(!retained&&(material.events.length||changed)) {
        try { this.assertPlanCapacity(material.bundle); }
        catch (error) {
          if (!(error instanceof PlacementSyncBoundError) || error.bound.kind !== "journal-objects" || material.bundle.root.schema !== PLACEMENT_PUBLICATION_PLAN_V2_SCHEMA) throw error;
          const {schema:_schema,chunks:_chunks,seal:_seal,...body} = material.bundle.root;
          const byKind = (kind: "sources" | "decisions" | "objects") => material.bundle.chunks.filter(chunk => chunk.kind === kind).flatMap(chunk => chunk.items);
          const fallback = planPlacementPublication(body, {sources:byKind("sources") as PlacementPublicationSource[], decisions:byKind("decisions") as PlacementPublicationDecision[], objects:byKind("objects") as PlacementPublicationObject[]});
          this.assertPlanCapacity(fallback); material.bundle = fallback;
          Object.assign(material, this.events(fallback, material.projection, material.old));
        }
      }
      this.current=material;this.attemptHash=material.bundle.root.seal;
      await yieldTurn();const applications=await this.applicationCoordinator();await applications.prepare();
      if(!retained&&!material.events.length&&!changed&&!this.importsNeeded()){
        this.attemptHash=undefined;
        if(noopKey&&this.decisionCounts&&noopKey===this.noopKey()){writePlacementNoopCache(this.home,this.noopSlot(),noopKey,this.decisionCounts);this.noopKept=true;}
        return this.result(true,"not-needed");
      }
      if(!retained){await this.observe("before-plan-fsync");await yieldTurn();this.prove();preparePlacementPublication(this.home,material.bundle,this.storage());await this.observe("plan-fsynced");await yieldTurn();this.prove();}
      // One mutation batch: a complete proof on each side, fence checks (and at most 1 s of proof reuse) per record.
      this.prove();await this.appendThrough(material.bundle,material.events,material.preCount);this.prove();
      await this.materializeObjects(material.bundle);
      let read=readPlacementPublication(this.home,this.epochHash,material.bundle.root.seal);
      const artifact=read.facts.find(fact=>fact.phase==="artifact-built");if(!artifact)refuse();
      this.prove();this.lastPolicyCheckUnixMs=Date.now();this.lastPolicyHash=material.bundle.root.policyHash;this.policyCheckSource="live";
      if(!read.facts.some(fact=>fact.phase==="publication-intent"))recordPlacementPublicationPhase(this.home,this.epochHash,material.bundle.root.seal,"publication-intent",{artifactFactHash:artifact.seal,policyHash:material.bundle.root.policyHash,policyCheckUnixMs:material.bundle.root.policySnapshotUnixMs},this.storage());
      ensurePlacementPublicationDurability(this.home,this.epochHash,this.storage());
      await this.observe("before-cas");this.enter("publication");this.prove();
      const installedGuard=await this.installedObjectGuard(material.bundle);
      this.prove();for(const target of this.targets)for(const check of target.selectorChecks??[])check();
      installedGuard();
      this.lastPolicyCheckUnixMs=Date.now(); this.lastPolicyHash=material.bundle.root.policyHash;this.policyCheckSource="live";
      const participating=material.bundle.root.targets.map((target,index)=>({target,index})).filter(item=>item.target.publish);
      this.attempted=participating.length>0;
      const sent=participating.length?await generationSyncGit(this.root,this.args(["push","--atomic","--no-follow-tags","-q",...participating.map(({target,index})=>`--force-with-lease=${shardSyncRef(this.targets[index]!.realm)}:${target.expectedRemoteHead??""}`),"origin",...participating.map(({target,index})=>`${target.commit}:${shardSyncRef(this.targets[index]!.realm)}`)]),this.opts.signal):{code:0};
      this.accepted=sent.code===0;await this.observe("cas-returned");
      if(!this.accepted)return this.result(false,"unknown","The placement publication outcome is unknown; retained receipts may have published. Recheck this exact attempt before retrying.");
      this.factual=true;return await this.finish(material);
    }catch(error){
      try { this.testOnlyError?.(error); } catch { /* Test observers never alter production results. */ }
      // #288 step 3: a started checkpoint pauses every placement effect with its own cause and next step.
      if(this.epochHash&&placementCheckpointPending(this.home,this.epochHash)){this.failureCause="checkpoint-pending";return this.result(false,this.attemptHash?"unknown":"not-needed",PLACEMENT_CHECKPOINT_PENDING_MESSAGE);}
      if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SharedWriterRevisionError){
        const code=Object.getOwnPropertyDescriptor(error,"code")?.value;
        if(code==="staging"||code==="pending"){this.failureCause="writer-renewal";return this.result(false,this.attemptHash?"unknown":"not-needed",new SharedWriterRevisionError(code).message);}
      }
      // #419: an expected size refusal before any attempt exists keeps its phase, kind, limit and observed value.
      const bound=this.attemptHash||this.journal?.publicationReservation?undefined:placementSyncBoundReceipt(error);
      // #288 step 1: the bound's own numbers-only clause is rebuilt from the receipt for the receipt's fields, so the
      // thrown error's detail is carried over explicitly; the result's error is what the person reads.
      if(bound){this.bound=bound;const detail=placementSyncBoundDetail(error);return this.result(false,"not-needed",placementSyncBoundMessage(bound)+(detail?` ${detail}`:""));}
      if(this.attemptHash)return this.result(false,"unknown","Placement sync stopped with a retained attempt that may have published; recheck its exact receipts before another publication.");
      if (error && typeof error === "object" && !types.isProxy(error) && error instanceof PlacementRealmRefusal && error.origin === "remote") { this.failureCause = "remote"; return this.result(false, "not-needed", error.message); }
      if (error instanceof LocalKeyOptInRefusal) { this.failureCause = "unavailable"; return this.result(false, "not-needed", error.message); }
      // #426: name the failing check by a fixed category and the phase; never the error's own text, which may carry a path.
      this.refusal=placementRefusalCategoryOf(error)??classifyPlacementError(error)??"other";
      return this.result(false,"not-needed",placementRefusalMessage(this.refusal,this.phaseNow));
    }finally{
      let ownedCache=true;try{this.metadata();}catch{ownedCache=false;}
      // #612: every terminal path other than a full-path not-needed or a cache hit invalidates its slot, under the held sync lock and
      // home ownership fence. Without the fence the slot stays; its key still binds every input, so it can only match an identical no-op.
      if(ownedCache&&!this.noopKept&&this.epochHash&&this.targets.length)try{this.metadata();clearPlacementNoopCache(this.home,this.noopSlot());}catch{}
      if(ownedCache){
        for(const ref of this.refs)try{this.metadata();await generationSyncGit(this.root,this.args(["update-ref","--no-deref","-d",ref]),undefined);}catch{}
        for(const file of this.temporary)try{this.metadata();rmSync(file,{force:true});}catch{}
      }
      for(const release of this.releases.reverse())try{release();}catch{}
      this.releaseCurated?.();
    }
  }
}
