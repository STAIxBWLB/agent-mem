/** Activated placement transport. The public sync entrypoint owns dispatch; this module never activates a profile. */
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON, readSelector } from "./generation.ts";
import { generationSyncLock } from "./generation-sync.ts";
import { generationSyncGit, generationSyncGitBytes, remoteVisibility, type SyncOptions, type SyncResult } from "./sync.ts";
import { acquireMutation, assertMutationHandle, type MutationHandle } from "./mutation.ts";
import { isLocalKey, resolveShardProfile } from "./shard.ts";
import { memoryPolicySnapshot } from "./policy.ts";
import { outboundPolicyEvaluator, SYNC_SCREEN_MAX_BYTES, SYNC_SCREEN_MAX_ROWS } from "./sync-screen.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { captureSyncPlacementContext, type PlacementCapture, type PlacementPendingSource } from "./sync-placement-capture.ts";
import { compilePlacementDependencies, type DependencySource, type VerifiedDependencyEndpoint } from "./sync-placement-dependencies.ts";
import { compilePlacementGitObjects, type PlannedGitObject } from "./sync-placement-git.ts";
import { PLACEMENT_DESCRIPTOR_SCHEMA, PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import { createPlacementRecord, placementKeyId, SyncPlacementJournalError, type PlacementEvent, type PlacementKey, type PlacementRealm, type PlacementHoldReason, type PlacementRecord } from "./sync-placement-journal-format.ts";
import { rebuildPlacementProjection, type PlacementProjection } from "./sync-placement-projection.ts";
import { readPlacementJournal, appendPlacementEvent, ensurePlacementPublicationDurability, type PlacementJournalRead, type PlacementStorageOptions } from "./sync-placement-journal-storage.ts";
import { preparePlacementPublication, readPlacementPublication, recordPlacementPublicationPhase, type PlacementPublicationRead } from "./sync-placement-publication-storage.ts";
import { planPlacementPublication, publicationBytes, type PlacementPublicationBundle, type PlacementPublicationDecision, type PlacementPublicationObject, type PlacementPublicationTarget } from "./sync-placement-publication-plan.ts";
import { ShardHistoryAuditor, type ShardHistory } from "./shard-sync-history.ts";
import { ShardSyncApplications } from "./shard-sync-applications.ts";
import { shardSourceRows, shardProvePrunes, shardImportRows, shardSelectorRetention, shardInstallHold, shardHoldWarning, type ShardSyncApplicationTarget } from "./shard-sync.ts";
import { decodeShardPack, encodeShardPacks, encodeShardManifest, shardSyncRef, SHARD_PACK_MAX_BYTES, type ShardSyncRow } from "./shard-sync-format.ts";
import { assertPublisherBoundary, ensurePublisherBoundary, publisherPruneLineages } from "./prune-publisher-lineage.ts";
import { verifyPublicPruneWitness, type PublicPruneWitnessV1 } from "./public-prune-witness.ts";
import type { MemoryStore, Entry } from "./store.ts";
import type { PruneRow } from "./prune.ts";

export type PlacementSyncPhase = "before-plan-fsync" | "plan-fsynced" | "artifact-built" | "before-cas" | "cas-returned" | "before-ack" | "acknowledged" | "imported" | "before-receipt" | "receipt-written";
type Phase = (phase: PlacementSyncPhase) => void | Promise<void>;
type Target = ShardSyncApplicationTarget & { auditor: ShardHistoryAuditor; remoteHistory?: ShardHistory; candidate?: ShardHistory; objects: PlannedGitObject[]; localPrunes: Map<string, PruneRow> };
interface Materialized { bundle: PlacementPublicationBundle; decisions: PlacementPublicationDecision[]; projection: PlacementProjection; old: (ShardHistory | undefined)[]; events: PlacementEvent[]; preCount: number; holdCount: number; exported: number; withheld: number }
const digest = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const oid = (v: unknown): v is string => typeof v === "string" && v.length === 40 && /^[a-f0-9]+$/.test(v);
const sameRealm = (a: PlacementRealm, b: PlacementRealm) => canonicalJSON(a) === canonicalJSON(b);
const physical = (target: Target): PlacementRealm => target.realm.scope === "user" ? { scope: "user" } : { scope: "project", keyHash: digest(target.realm.key) };
const keyFor = (target: Target, row: ShardSyncRow): PlacementKey => ({ realm: physical(target), id: row.id, rowHash: hashJSON(row) });
function refuse(): never { throw new Error("placement sync unavailable"); }
function directory(file: string): void { const s = lstatSync(file); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) refuse(); }
function emptyHistory(): ShardHistory { return { rows: new Map(), files: new Map(), origins: new Map(), manifests: new Map(), version: "v3" }; }
/** Internal phase observer is a fault seam, not part of SyncOptions or the package barrel. */
export async function syncPlacementMemory(store: MemoryStore, opts: SyncOptions = {}, phase?: Phase, testOnlyError?: (error:unknown)=>void): Promise<SyncResult> {
  return new PlacementTransport(store, opts, phase, testOnlyError).run();
}
class PlacementTransport {
  readonly store: MemoryStore; readonly opts: SyncOptions; readonly phase?: Phase; readonly testOnlyError?: (error:unknown)=>void; readonly home: string; readonly root: string; readonly cache: string;
  readonly releases: (() => void)[] = []; readonly temporary: string[] = []; readonly refs: string[] = [];
  targets: Target[] = []; homeMutation?: MutationHandle; rootMutation?: MutationHandle; cacheIdentity?: {dev:number;ino:number}; cacheConfigIdentity?: string; epochHash = ""; journal!: PlacementJournalRead; capture?: PlacementCapture;
  machineId = ""; url = ""; revision = ""; accepted = false; factual = false; attempted = false; lastPolicyCheckUnixMs?: number; lastPolicyHash?: string; policyCheckSource?: "live"|"durable-intent"; attemptHash?: string;
  evaluator?: ReturnType<typeof outboundPolicyEvaluator>; applications?: ShardSyncApplications; current?: Materialized; recovered = false;
  constructor(store: MemoryStore, opts: SyncOptions, phase?: Phase, testOnlyError?: (error:unknown)=>void) { this.testOnlyError=testOnlyError; this.store = store; this.opts = opts; this.phase = phase; this.home = store.profile.home; this.root = join(this.home, "shard-sync-placement"); this.cache = join(this.root, "objects.git"); }
  attest(): void {
    if (!this.opts.placementAttestation || this.opts.screen && !this.opts.policyVersion) refuse();
    const value = memoryPolicySnapshot(this.opts.placementAttestation());
    if (!value || value.legacySyncQuiesced !== true || !Array.isArray(value.writers)) refuse();
    const writers = [...value.writers].sort((a,b) => a.writerId.localeCompare(b.writerId));
    if (canonicalJSON(writers) !== canonicalJSON(this.journal.activation.writers)) refuse();
  }
  metadata(): void {
    if(this.rootMutation)assertMutationHandle(this.rootMutation,this.root);
    if(this.cacheIdentity){const stat=lstatSync(this.cache);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.dev!==this.cacheIdentity.dev||stat.ino!==this.cacheIdentity.ino)refuse();}
    if(this.cacheIdentity){
      for(const name of ["commondir","shallow","info/grafts","objects/info/alternates","objects/info/http-alternates","config.worktree"])if(existsSync(join(this.cache,name)))refuse();
      const stamp=this.configStamp();if(this.cacheConfigIdentity!==undefined&&stamp!==this.cacheConfigIdentity)refuse();
    }
    if (this.homeMutation) assertMutationHandle(this.homeMutation, this.home);
    for (const target of this.targets) if (target.mutation) assertMutationHandle(target.mutation, target.store.dir);
    const markers = readPlacementRuntimeMarkers(this.home), active = readActivePlacementBinding(this.home, markers.profile, markers.shards);
    if (!active || active.profile.placementHead !== this.epochHash || active.epoch.homeHash !== this.journal.epoch.homeHash) refuse();
  }
  check = (): void => {
    this.metadata();
    if (this.factual) return;
    if (this.opts.signal?.aborted) refuse(); this.attest(); this.capture?.assertUnchanged();
    if(this.capture){this.lastPolicyHash=this.capture.context.policyHash;this.lastPolicyCheckUnixMs=Date.now();this.policyCheckSource="live";}
    for (const target of this.targets) for (const check of target.selectorChecks ?? []) check();
    this.metadata();
  };
  async call<T>(work: () => T | Promise<T>): Promise<T> { this.check(); const result = await work(); this.check(); return result; }
  args(args: string[]): string[] { return ["--no-replace-objects", "--git-dir", this.cache, "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.commitGraph=false", ...args]; }
  async git(args: string[]) { return this.call(() => generationSyncGit(this.root, this.args(args), this.opts.signal)); }
  async required(args: string[]): Promise<string> { const result = await this.git(args); if (result.code !== 0) refuse(); return result.out; }
  async observe(phase: PlacementSyncPhase): Promise<void> { await this.phase?.(phase); }
  storage(factual = false): PlacementStorageOptions { if (!this.homeMutation) refuse(); return { mutation: this.homeMutation, assertCurrent: factual ? () => this.metadata() : this.check, ...(this.attemptHash ? { publicationAttemptHash: this.attemptHash } : {}) }; }
  configStamp():string {
    const stat=lstatSync(join(this.cache,"config"),{bigint:true});
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid?.()??-1)||(stat.mode&0o077n)!==0n||stat.size>65536n)refuse();
    return canonicalJSON([String(stat.dev),String(stat.ino),String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs)]);
  }
  async bindCacheConfig():Promise<void>{
    const before=this.configStamp(),output=await this.required(["config","--local","--no-includes","--null","--list"]),seen=new Set<string>();
    const booleans=new Set(["core.filemode","core.bare","core.ignorecase","core.precomposeunicode","core.protecthfs","core.protectntfs","core.logallrefupdates","core.symlinks"]);
    for(const row of output.split("\0").filter(Boolean)){
      const at=row.indexOf("\n");if(at<1)refuse();const key=row.slice(0,at),value=row.slice(at+1);
      if(seen.has(key))refuse();seen.add(key);
      if(booleans.has(key)){if(value!=="true"&&value!=="false")refuse();}
      else if(key==="core.repositoryformatversion"){if(value!=="0"&&value!=="1")refuse();}
      else if(key==="extensions.objectformat"){if(value!=="sha1")refuse();}
      else if(!["remote.origin.url","remote.origin.fetch","remote.origin.pushurl"].includes(key))refuse();
    }
    if(this.configStamp()!==before)refuse();this.cacheConfigIdentity=before;
  }
  async independent(): Promise<boolean> {
    if (!existsSync(this.cache)) return false; directory(this.cache); const initial=lstatSync(this.cache);
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const file = join(dir, name), s = lstatSync(file); if (s.isSymbolicLink() || s.uid !== process.getuid?.() || !s.isFile() && !s.isDirectory() || s.isFile() && s.nlink !== 1 || name.endsWith(".promisor")) refuse(); if (s.isDirectory()) {directory(file);walk(file);} } }; walk(this.cache);
    if (existsSync(join(this.cache, "commondir")) || existsSync(join(this.cache, "objects", "info", "http-alternates")) || existsSync(join(this.cache, "objects", "info", "alternates")) || existsSync(join(this.cache, "shallow")) || existsSync(join(this.cache, "info", "grafts"))) refuse();
    if (await this.required(["rev-parse", "--is-bare-repository"]) !== "true" || await this.required(["rev-parse", "--show-object-format"]) !== "sha1" || (await this.git(["config", "--get", "core.worktree"])).code !== 1) refuse();
    if((await this.git(["config","--get","extensions.partialClone"])).code !== 1
      || (await this.git(["config","--get-regexp","^remote[.].*[.](promisor|partialclonefilter)$"])).code !== 1)refuse();
    const final=lstatSync(this.cache); if(final.isSymbolicLink()||!final.isDirectory()||final.dev!==initial.dev||final.ino!==initial.ino)refuse();
    this.cacheIdentity={dev:final.dev,ino:final.ino};await this.bindCacheConfig();return true;
  }
  async initialize(): Promise<void> {
    const markers = readPlacementRuntimeMarkers(this.home), active = readActivePlacementBinding(this.home, markers.profile, markers.shards);
    if (!active || this.store.profile.publicationFormat !== PLACEMENT_FORMAT || this.store.profile.placementHead !== active.profile.placementHead) refuse();
    this.epochHash = active.profile.placementHead; this.machineId = active.shards.machine.id; this.revision = readSelector(this.home).revision; this.journal = readPlacementJournal(this.home, this.epochHash); this.attest();
    const opened = this.store.openedSyncTargets();
    if (!opened.length || opened.length > 2 || !opened.includes(this.store) || opened.some(item => item.profile.home !== this.home || !item.profile.sharded || !item.profile.generation
      || !item.profile.shardUser && item.profile.shardKey !== this.store.profile.shardKey)) refuse();
    for (const item of opened) {
      const realm = item.profile.shardUser ? { scope: "user" as const } : { scope: "project" as const, key: item.profile.shardKey! };
      const target = { store: item, realm, generation: item.profile.generation!, rows: new Map(), fetched: new Set(), sources: [], pending: [], origins: new Map(), holds: [], manifests: new Map(), eligible: new Set(), registered: [], objects: [], localPrunes: new Map() } as unknown as Target;
      target.auditor = new ShardHistoryAuditor({ realm, generation: target.generation, placement: true, publicPrune: true,
        git: args => this.required(args), blob: (object, path) => this.blob(object, path), object: (oid,type) => this.rawHistoryObject(oid,type) }); this.targets.push(target);
    }
    if (new Set(this.targets.map(target => shardSyncRef(target.realm))).size !== this.targets.length) refuse();
    if (this.targets.some(target => target.realm.scope === "project" && isLocalKey(target.realm.key)) && this.opts.remote === undefined) refuse();
    if (existsSync(this.root)) directory(this.root);
    const existing = existsSync(this.root) ? await this.independent() : false;
    if (!existing && !this.opts.remote) refuse();
    this.url = this.opts.remote ?? await this.required(["remote", "get-url", "origin"]);
    if (!this.url || this.url.length > 4096 || this.url.startsWith("-") || /[\r\n\0]/.test(this.url)) refuse();
    if (await this.call(() => (this.opts.visibility ?? remoteVisibility)(this.url)) !== "private") refuse();
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    const transport = acquireMutation(this.root); if (!transport) refuse(); this.rootMutation=transport; this.releases.push(transport);
    const sync = generationSyncLock(this.root); if (!sync) refuse(); this.releases.push(sync);
    for (const dir of [...new Set([this.home, ...this.targets.map(target => target.store.dir)])].sort()) {
      const handle = acquireMutation(dir); if (!handle) refuse(); this.releases.push(handle); if (dir === this.home) this.homeMutation = handle;
      for (const target of this.targets) if (target.store.dir === dir) target.mutation = handle;
    }
    this.journal = readPlacementJournal(this.home, this.epochHash); this.revision = readSelector(this.home).revision; this.attest();
    if (!existing) await this.required(["init", "--bare", "--template=", "--object-format=sha1", "-q", this.cache]);
    if (!await this.independent()) refuse();
    const previous = await this.git(["remote", "get-url", "origin"]);
    if (this.opts.remote) { this.cacheConfigIdentity=undefined; await this.required(previous.code === 0 ? ["remote", "set-url", "origin", this.url] : ["remote", "add", "origin", this.url]); }
    await this.bindCacheConfig();
    for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]])
      if (await this.required(args) !== this.url) refuse();
    const reservation = this.journal.publicationReservation;
    const pending = reservation ? readPlacementPublication(this.home, this.epochHash, reservation.attemptHash) : undefined;
    if (!pending || pending.bundle.root.remoteHash === digest(this.url)) await this.fetch();
  }
  async rawHistoryObject(object:string,type:"commit"|"tree"):Promise<Buffer>{
    if(!oid(object)||await this.required(["cat-file","-t",object])!==type)refuse();
    const limit=type==="commit"?65536:SHARD_PACK_MAX_BYTES,size=Number(await this.required(["cat-file","-s",object]));
    if(!Number.isSafeInteger(size)||size<0||size>limit)refuse();
    const result=await this.call(()=>generationSyncGitBytes(this.root,this.args(["cat-file",type,object]),this.opts.signal,undefined,limit));
    if(result.code!==0||result.out.length!==size||createHash("sha1").update(`${type} ${size}\0`).update(result.out).digest("hex")!==object)refuse();
    return Buffer.from(result.out);
  }
  async blob(object: string, path: string): Promise<Buffer> {
    const limit = path === "shard.json" || path.startsWith("prune-witnesses/") ? 65536 : SHARD_PACK_MAX_BYTES;
    const size = Number(await this.required(["cat-file", "-s", object])); if (!Number.isSafeInteger(size) || size < 1 || size > limit) refuse();
    const result = await this.call(() => generationSyncGitBytes(this.root, this.args(["cat-file", "blob", object]), this.opts.signal, undefined, limit));
    if (result.code !== 0 || result.out.length !== size) refuse(); return Buffer.from(result.out);
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
  preflight(mergeLocal = true): void {
    for (const target of this.targets) {
      const source = shardSourceRows(target.store, target.realm); target.sources = source.sources; target.pending = source.pending;
      target.localPrunes = new Map([...source.rows.filter((row): row is PruneRow => row.op === "prune"), ...source.pending.map(item => item.row)].map(row => [row.id,row]));
      if (mergeLocal) for (const row of source.rows) { const old = target.rows.get(row.id); if (old && hashJSON(old) !== hashJSON(row)) refuse(); target.rows.set(row.id, row); }
    }
    shardProvePrunes(this.targets);
  }
  startCapture(): void {
    const pending: PlacementPendingSource[] = this.targets.flatMap(target => target.pending.filter(item => !item.unclaimed).map(item => ({ realm: physical(target),
      pathHash: digest(`log/${item.row.machine}.jsonl`), offset: item.offset, prefixHash: item.prefixHash, line: item.line })));
    this.capture = captureSyncPlacementContext(this.home, { attest: this.opts.placementAttestation!, ...(this.opts.policyVersion ? { policyVersion: this.opts.policyVersion } : {}) }, this.targets.map(physical), pending);
    if (this.capture.activeHead !== this.epochHash || this.capture.context.homeHash !== this.journal.epoch.homeHash
      || canonicalJSON(this.capture.context.writers) !== canonicalJSON(this.journal.activation.writers)) refuse();
    this.check();
  }
  async applicationCoordinator(): Promise<ShardSyncApplications> {
    if (!this.homeMutation) refuse();
    const applications = new ShardSyncApplications({ home: this.home, root: this.root, url: this.url, targets: this.targets, homeMutation: this.homeMutation,
      getRevision: () => this.revision, setRevision: revision => { this.revision = revision; }, check: this.check,
      history: (tip, target) => (target as Target).auditor.history(tip), candidateHistory: async target => (target as Target).candidate ?? (target as Target).remoteHistory ?? emptyHistory(),
      assertAncestor: async (a,b,target) => { if (!await (target as Target).auditor.verifiedAncestor(a,b)) refuse(); },
      readObject: async object => {
        const type = await this.required(["cat-file", "-t", object]); if (type !== "commit" && type !== "tree" && type !== "blob") refuse();
        const limit = type === "commit" ? 65536 : SHARD_PACK_MAX_BYTES, size = Number(await this.required(["cat-file", "-s", object]));
        if (!Number.isSafeInteger(size) || size < 0 || size > limit) refuse();
        const result = await this.call(() => generationSyncGitBytes(this.root, this.args(["cat-file", type, object]), this.opts.signal, undefined, limit));
        if (result.code !== 0 || result.out.length !== size) refuse(); return { type, body: result.out };
      }, afterAdvance: () => { this.capture = undefined; this.metadata(); } });
    await applications.loadExisting(); this.applications = applications; return applications;
  }
  evaluate(value: unknown) {
    this.check(); const evaluate = this.evaluator ??= outboundPolicyEvaluator(this.home, this.opts.screen), verdict = evaluate(structuredClone(value) as Record<string, unknown>); this.check(); return verdict;
  }
  nativeProofs(): Set<string> {
    const verified = new Set<string>();
    for (const target of this.targets) {
      const candidates = [...target.rows.values()].filter((row): row is PruneRow => row.op === "prune" && row.generation === target.generation);
      const lineages = candidates.length && existsSync(join(target.store.dir, "local", `publisher-boundary-${this.machineId}.json`)) ? publisherPruneLineages(target.store.profile, target.mutation!, candidates) : undefined;
      for (const row of candidates) {
      const complete = row.targets.every(item => [item,item.basis].every(ref => target.fetched.has(ref.id) && hashJSON(target.rows.get(ref.id)) === ref.rowHash));
      if (complete && (target.fetched.has(row.id) || lineages?.has(row.id))) verified.add(placementKeyId(keyFor(target,row)));
      }
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
    const sources: DependencySource[] = [], blocked = new Set<string>(), verified = this.nativeProofs();
    let sourceBytes=0;
    const admit=(row:unknown)=>{const bytes=Buffer.byteLength(canonicalJSON(row));if(sources.length>=SYNC_SCREEN_MAX_ROWS||sourceBytes+bytes>SYNC_SCREEN_MAX_BYTES)throw new SyncPlacementJournalError("bound");sourceBytes+=bytes;};
    const prunedByTarget = new Map(this.targets.map(target => [target, new Set(target.store.prunePort().snapshot().pruned ?? [])]));
    for (const source of capture.rows.values()) {
      const target = this.targets.find(target => sameRealm(physical(target), source.key.realm)); if (!target) refuse();
      const pruned = prunedByTarget.get(target)!.has(source.key.id) && !target.fetched.has(source.key.id);
      if (pruned) blocked.add(placementKeyId(source.key));
      admit(source.row); sources.push({ key: source.key, row: source.row, sourcePlacement: source.sourcePlacement, policy: this.evaluate(source.row), held: !!projection.get(source.key)?.held || !!pruned });
    }
    for (const target of this.targets) for (const row of target.localPrunes.values()) {
      const key = keyFor(target,row); if (sources.some(source => placementKeyId(source.key) === placementKeyId(key))) continue;
      admit(row); sources.push({ key, row, sourcePlacement: "synced", policy: this.evaluate(row), held: !!projection.get(key)?.held });
    }
    // Incoming verified occurrences are selected immutable originals too. Classify them before import so a private
    // remote goal cannot temporarily authorize a new dependent, and exposure/holds are durable in this same attempt.
    const seenSources=new Set(sources.map(source=>placementKeyId(source.key)));
    for(const [index,target]of this.targets.entries())for(const row of old[index]?.rows.values()??[])if(row.op!=="prune"||row.generation===target.generation){
      const key=keyFor(target,row),id=placementKeyId(key);if(seenSources.has(id))continue;seenSources.add(id);
      admit(row); sources.push({key,row,sourcePlacement:"synced",policy:this.evaluate(row),held:!!projection.get(key)?.held});
    }
    // Strong endpoints are already in sources and current holds cannot be bypassed by past publication. Only
    // deletion/prune exceptions need a second verified occurrence fact; do not duplicate every historical body.
    const publicNeeded=new Set<string>();
    for(const source of sources){const row=source.row as ShardSyncRow;
      if(row.op==="forget"||row.op==="demote")publicNeeded.add(row.target);
      if(row.op==="prune")for(const target of row.targets)for(const ref of [target,target.basis])publicNeeded.add(ref.id);
    }
    const endpoints: VerifiedDependencyEndpoint[] = this.targets.flatMap((target,index) => [...(old[index]?.rows.values() ?? [])].filter((row): row is Entry => row.op !== "prune"&&publicNeeded.has(row.id)).map(row => ({ key: keyFor(target,row), row })));
    const descriptorVerdicts = this.targets.map(target => this.evaluate({ schema: PLACEMENT_DESCRIPTOR_SCHEMA, ...target.realm, publicationFormat: PLACEMENT_FORMAT }));
    const publishes = this.targets.map(() => false);
    for (const source of sources) {
      const index = this.targets.findIndex(target => sameRealm(physical(target),source.key.realm));
      if (!descriptorVerdicts[index]!.ok) source.policy = descriptorVerdicts[index]!;
    }
    const sourceMap = new Map(sources.map(source => [placementKeyId(source.key), source]));
    let decisions: PlacementPublicationDecision[] = [];
    for (let pass = 0; pass < 2; pass++) {
      decisions = compilePlacementDependencies({ generation: this.journal.epoch.generation, selectedRealms: this.targets.map(physical), rows:sources, publicEndpoints:endpoints,
        verifiedPrunes:sources.filter(source => verified.has(placementKeyId(source.key))).map(source => source.key) }).map(decision => {
          const source = sourceMap.get(placementKeyId(decision.key))!;
          const index=this.targets.findIndex(target=>sameRealm(physical(target),decision.key.realm));
          const original=old[index]?.rows.get(decision.key.id), published=!!original&&hashJSON(original)===decision.key.rowHash;
          const reason=blocked.has(placementKeyId(decision.key)) && !projection.get(decision.key)?.held ? "related-local" : decision.reason ?? null;
          return { ...decision, sourcePlacement:source.sourcePlacement, reason,
            hold:!decision.eligible&&(reason!=="source-local"||published)&&!projection.get(decision.key)?.held };
        });
      let rejected = false;
      for (const [index,target] of this.targets.entries()) {
        const files = new Map(old[index]?.files), eligible = new Set(decisions.filter(decision => decision.eligible && sameRealm(decision.key.realm,physical(target))).map(decision => decision.key.id));
        const publish = descriptorVerdicts[index]!.ok && (!!old[index] || eligible.size > 0); publishes[index] = publish;
        if (publish) files.set("shard.json", Buffer.from(canonicalJSON({schema:PLACEMENT_DESCRIPTOR_SCHEMA,...target.realm,publicationFormat:PLACEMENT_FORMAT})+"\n"));
        const additions = sources.filter(source => sameRealm(source.key.realm,physical(target)) && eligible.has(source.key.id) && !old[index]?.rows.has(source.key.id)).map(source => source.row as ShardSyncRow);
        for (const [path,bytes] of encodeShardPacks(additions)) { const prior = files.get(path); if (prior && !prior.equals(bytes)) refuse(); files.set(path,bytes); }
        const manifests = new Map(old[index]?.manifests), occurrences = new Map<string,{pack:string;blob:string}>();
        for (const [path,bytes] of files) if (path.startsWith("rows/")) for (const row of decodeShardPack(path,bytes,target.realm,target.generation))
          if (!occurrences.has(row.id)) occurrences.set(row.id,{pack:path,blob:createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")});
        const native = additions.filter((row):row is PruneRow => row.op==="prune" && row.generation===target.generation);
        if (native.length) {
          assertPublisherBoundary(target.store.profile,target.mutation!);
          const lineages = publisherPruneLineages(target.store.profile,target.mutation!,native);
          for (const row of native) {
            const lineage = lineages.get(row.id), own = occurrences.get(row.id); if (!lineage || !own) refuse();
            const needed = new Map<string,string>(); for (const item of row.targets) for (const ref of [item,item.basis]) needed.set(ref.id,ref.rowHash);
            const witnesses = [...needed].sort(([a],[b])=>a.localeCompare(b)).map(([id,rowHash])=>{ const place=occurrences.get(id); if(!place)refuse(); return{id,rowHash,...place}; });
            const value:PublicPruneWitnessV1={schema:"agent-mem.public-prune-witness/v1",realm:target.realm,prune:row,lineage,pruneOccurrence:own,witnesses};
            const encoded=encodeShardManifest(value), packs=new Map([own,...witnesses].map(ref=>[ref.pack,{pack:ref.pack,blob:ref.blob,bytes:files.get(ref.pack)!}]));
            if(verifyPublicPruneWitness(value,{realm:target.realm,packs:[...packs.values()]}).status!=="verified")refuse();
            const verdict=this.evaluate(value);
            if(!verdict.ok){const source=sources.find(source=>source.key.id===row.id&&sameRealm(source.key.realm,physical(target)))!;source.policy=verdict;rejected=true;continue;}
            files.set(encoded.path,encoded.bytes); manifests.set(encoded.path,{path:encoded.path,bytes:encoded.bytes,value,row,eligible:true,commit:"0".repeat(40),blob:createHash("sha1").update(`blob ${encoded.bytes.length}\0`).update(encoded.bytes).digest("hex")});
          }
        }
        target.objects=[];
        if(publish){
          const previous=old[index]&&target.remote?{tree:await this.required(["rev-parse",`${frozen?.root.targets[index]?.expectedRemoteHead??target.remote}^{tree}`]),commit:frozen?.root.targets[index]?.expectedRemoteHead??target.remote!}:undefined;
          const objects=compilePlacementGitObjects(files,frozen?.root.targets[index]?.expectedRemoteHead??target.remote??null,createdUnixSeconds,previous);target.objects=objects.objects;target.commit=objects.commit;
          for(const [path,manifest]of manifests)if(manifest.commit==="0".repeat(40))manifests.set(path,{...manifest,commit:objects.commit});
        }else target.commit=target.remote;
        const rows=new Map(old[index]?.rows);for(const row of additions)rows.set(row.id,row);
        target.candidate={rows,files,origins:new Map(old[index]?.origins),version:publish?"v3":old[index]?.version??"v3",manifests};
      }
      if(!rejected)break;if(pass===1)refuse();
    }
    const targets:PlacementPublicationTarget[]=this.targets.map((target,index)=>{
      const publish=publishes[index]!,descriptor=target.candidate?.files.get("shard.json");
      return{realm:physical(target),publish,refHash:digest(shardSyncRef(target.realm)),expectedRemoteHead:frozen?.root.targets[index]?.expectedRemoteHead??target.remote??null,
        expectedCacheHead:frozen?.root.targets[index]?.expectedCacheHead??target.local??null,descriptorHash:digest(descriptor??Buffer.alloc(0)),
        exportSetHash:hashJSON([...target.candidate!.rows.values()].map(row=>({id:row.id,rowHash:hashJSON(row)})).sort((a,b)=>a.id.localeCompare(b.id))),
        tree:publish?target.objects.find(object=>object.type==="tree"&&object.path==="")!.oid:target.remote?frozen?.root.targets[index]?.tree??null:null,commit:target.commit??null};
    });
    for(const [index,target]of this.targets.entries())if(!targets[index]!.publish&&target.remote)targets[index]!.tree=await this.required(["rev-parse",`${target.remote}^{tree}`]);
    const objects:PlacementPublicationObject[]=this.targets.flatMap((target,targetIndex)=>target.objects.map(object=>({targetIndex,type:object.type,path:object.path === "" ? null : object.path,oid:object.oid,sha256:digest(object.bytes),size:object.bytes.length})));
    const body={epochHash:this.epochHash,generation:this.journal.epoch.generation,homeHash:capture.context.homeHash,contextHash:hashJSON(capture.context),markerHash:capture.markerHash,
      sourceHash:capture.context.sourceHash,aliasesHash:capture.context.aliasesHash,policyHash:capture.context.policyHash,remoteHash:digest(this.url),
      journal:frozen?.root.journal??{sequence:frontier.sequence,headHash:frontier.headHash},createdUnixSeconds,policySnapshotUnixMs:frozen?.root.policySnapshotUnixMs??this.lastPolicyCheckUnixMs??Date.now(),targets,reservedRecords:0,reservedRecordBytes:[] as number[]};
    let bundle=planPlacementPublication(body,{sources:capture.prefixes,decisions,objects});
    let scheduled=this.events(bundle,projection,old);
    let head=body.journal.headHash;
    const lengths=scheduled.events.map((event,index)=>{const record=createPlacementRecord(this.epochHash,body.journal.sequence+index+1,head,event);head=record.seal;return publicationBytes(record).length;});
    bundle=planPlacementPublication({...body,reservedRecords:lengths.length,reservedRecordBytes:lengths},{sources:capture.prefixes,decisions,objects});
    scheduled=this.events(bundle,projection,old);
    if(frozen&&canonicalJSON(bundle)!==canonicalJSON(frozen))refuse();
    return{bundle,decisions,projection,old,...scheduled,exported:scheduled.events.filter(event=>event.kind==="publication-ambiguous").length,withheld:decisions.filter(decision=>!decision.eligible).length};
  }
  events(bundle:PlacementPublicationBundle,projection:PlacementProjection,old:(ShardHistory|undefined)[]):{events:PlacementEvent[];preCount:number;holdCount:number}{
    const decisions=bundle.chunks.filter(chunk=>chunk.kind==="decisions").flatMap(chunk=>chunk.items as PlacementPublicationDecision[]).sort((a,b)=>placementKeyId(a.key).localeCompare(placementKeyId(b.key)));
    const holds:PlacementEvent[]=[],known:PlacementEvent[]=[],ambiguous:PlacementEvent[]=[],committed:PlacementEvent[]=[];
    const root=bundle.root;
    const make=(decision:PlacementPublicationDecision,kind:PlacementEvent["kind"],commit?:string):PlacementEvent=>{
      const base={requestId:hashJSON({attempt:root.seal,key:decision.key,kind,commit:commit??null}),key:decision.key,sourcePlacement:decision.sourcePlacement,
        effectHash:hashJSON({attempt:root.seal,context:root.contextHash,key:decision.key,kind,commit:commit??null})};
      if(kind==="hold"){
        const reason=decision.reason;
        const hold:PlacementHoldReason=reason==="secret"||reason==="personal-data"||reason==="deny-path"||reason==="private-or-invalid"||reason==="host"||reason==="person-local"?reason:"related-local";
        return{...base,kind,reason:hold};
      }
      const index=root.targets.findIndex(target=>sameRealm(target.realm,decision.key.realm));if(index<0)refuse();
      const outcome={attemptHash:root.seal,remoteHash:root.remoteHash,refHash:root.targets[index]!.refHash};
      if(kind==="publication-ambiguous")return{...base,kind,outcome};
      if(kind!=="publication-committed"||!commit)refuse();
      return{...base,kind,outcome:{...outcome,commit,proofHash:hashJSON({attempt:root.seal,key:decision.key,commit,remote:root.remoteHash,ref:root.targets[index]!.refHash})}};
    };
    for(const decision of decisions){
      const state=projection.get(decision.key);
      const index=root.targets.findIndex(target=>sameRealm(target.realm,decision.key.realm)),target=root.targets[index];if(!target)refuse();
      const original=old[index]?.rows.get(decision.key.id),published=original&&hashJSON(original)===decision.key.rowHash;
      if(decision.hold)holds.push(make(decision,"hold"));
      if(published&&state?.exposure!=="published"&&target.expectedRemoteHead)known.push(make(decision,"publication-committed",target.expectedRemoteHead));
      if(decision.eligible&&target.publish&&!published){
        ambiguous.push(make(decision,"publication-ambiguous"));committed.push(make(decision,"publication-committed",target.commit!));
      }
    }
    return{events:[...holds,...known,...ambiguous,...committed],preCount:holds.length+known.length+ambiguous.length,holdCount:holds.length};
  }
  async frozenOld(bundle:PlacementPublicationBundle):(Promise<(ShardHistory|undefined)[]>){
    const values:(ShardHistory|undefined)[]=[];
    for(const [index,target]of this.targets.entries()){
      const planned=bundle.root.targets[index];if(!planned||!sameRealm(planned.realm,physical(target))||planned.refHash!==digest(shardSyncRef(target.realm)))refuse();
      values.push(planned.expectedRemoteHead?await target.auditor.history(planned.expectedRemoteHead):undefined);
    }
    return values;
  }
  appendThrough(bundle:PlacementPublicationBundle,events:PlacementEvent[],count:number,factual=false):void{
    const root=bundle.root;let read=readPlacementJournal(this.home,this.epochHash),head=root.journal.headHash;
    const records:PlacementRecord[]=[];
    for(const [index,event]of events.entries()){
      const record=createPlacementRecord(this.epochHash,root.journal.sequence+index+1,head,event);head=record.seal;records.push(record);
    }
    const consumed=read.sequence-root.journal.sequence;
    if(consumed<0||consumed>root.reservedRecords)refuse();
    for(let index=0;index<Math.min(consumed,records.length);index++)
      if(canonicalJSON(read.records[root.journal.sequence+index])!==canonicalJSON(records[index]))refuse();
    if(read.pending){
      const sequence=read.pendingRecordSequence??read.sequence+1, index=sequence-root.journal.sequence-1;
      const record=records[index];
      if(!record||index>=count||read.pendingRecord&&canonicalJSON(read.pendingRecord)!==canonicalJSON(record))refuse();
      appendPlacementEvent(this.home,this.epochHash,events[index]!,record.previousHash,this.storage(factual));read=readPlacementJournal(this.home,this.epochHash);
    }
    for(let index=read.sequence-root.journal.sequence;index<count;index++){
      const record=records[index];if(!record)refuse();appendPlacementEvent(this.home,this.epochHash,events[index]!,record.previousHash,this.storage(factual));
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
      const type=await this.required(["cat-file","-t",item.oid]);
      const size=Number(await this.required(["cat-file","-s",item.oid]));
      if(type!==item.type||size!==item.size)refuse();
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
      const sequence=before.pendingRecordSequence??before.sequence+1;
      if(!before.pendingRecord&&schedule.events[sequence-root.journal.sequence-1]?.kind!=="hold")refuse();
      this.appendThrough(read.bundle,schedule.events,Math.max(holds.length,sequence-root.journal.sequence),true);
    }else this.appendThrough(read.bundle,holds,holds.length,true);
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
    for(const target of this.targets)for(const object of target.objects){
      this.check();const file=join(this.root,`.placement-object-${randomBytes(16).toString("hex")}`);this.temporary.push(file);
      const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{let at=0;while(at<object.bytes.length){const n=writeSync(fd,object.bytes,at,object.bytes.length-at,at);if(n<=0)refuse();at+=n;}fsyncSync(fd);}finally{closeSync(fd);}
      const written=await this.required(["hash-object","-w","-t",object.type,"--no-filters","--",file]);if(written!==object.oid)refuse();
    }
    const saved=readPlacementPublication(this.home,this.epochHash,bundle.root.seal);
    if(!saved.facts.some(fact=>fact.phase==="artifact-built"))recordPlacementPublicationPhase(this.home,this.epochHash,bundle.root.seal,"artifact-built",{exportHash:hashJSON(bundle.root.targets.map(target=>target.exportSetHash))},this.storage());
    await this.observe("artifact-built");this.check();
  }
  async finish(material:Materialized,recovery=false):Promise<SyncResult>{
    this.factual=true;this.recovered=recovery;const root=material.bundle.root;
    await this.observe("before-ack");this.appendThrough(material.bundle,material.events,material.events.length,true);await this.observe("acknowledged");this.metadata();
    for (const [index,target] of this.targets.entries()) {
      const planned = root.targets[index]!;
      const head = planned.publish ? planned.commit : target.remote;
      if (head) {
        const actual = await target.auditor.history(head); target.remoteHistory = actual; target.candidate = actual;
        target.rows = new Map(actual.rows); target.fetched = new Set(actual.rows.keys()); target.origins = new Map(actual.origins);
      } else { target.rows.clear(); target.fetched.clear(); target.candidate = emptyHistory(); }
    }
    this.preflight(false);
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
    await this.observe("before-receipt");
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
    return{ok,pushed:this.accepted&&(this.attempted||this.recovered&&!!this.current?.bundle.root.targets.some(target=>target.publish)),entries:this.current?.exported??0,...(error?{error}:{}),...(this.applications?{pruneApplication:{...this.applications.application}}:{}),
      placementPublication:{...(this.attemptHash?{attemptHash:this.attemptHash}:{}),outcome,withheld:this.current?.withheld??0,exported:this.current?.exported??0,
        ...(this.lastPolicyHash?{lastPolicyHash:this.lastPolicyHash}:{}),...(this.lastPolicyCheckUnixMs!==undefined?{lastPolicyCheckUnixMs:this.lastPolicyCheckUnixMs,policyCheckSource:this.policyCheckSource??(this.recovered?"durable-intent" as const:"live" as const)}:{}),
        policyCeiling:"last-positive-check-before-in-flight-push",...(this.recovered?{recovered:true}:{})}};
  }
  async run():Promise<SyncResult>{
    try{
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
      try { this.preflight();for(const target of this.targets)if(existsSync(join(target.store.dir,"local",`publisher-boundary-${this.machineId}.json`)))assertPublisherBoundary(target.store.profile,target.mutation!);this.startCapture(); }
      catch { if(retained)return await this.terminalUnknown(retained);throw new Error("placement source preflight unavailable"); }
      if(retained){
        const root=retained.bundle.root;
        const stable=root.contextHash===hashJSON(this.capture!.context)&&root.markerHash===this.capture!.markerHash&&root.sourceHash===this.capture!.context.sourceHash
          &&root.policyHash===this.capture!.context.policyHash&&root.targets.every((target,index)=>target.expectedRemoteHead===(this.targets[index]?.remote??null));
        if(!stable)return await this.terminalUnknown(retained);
      }
      const frontier=retained?{...this.journal,sequence:retained.bundle.root.journal.sequence,headHash:retained.bundle.root.journal.headHash}:this.journal;
      const material=await this.materialize(retained?.bundle.root.createdUnixSeconds??Math.floor(Date.now()/1000),frontier,retained?.bundle);this.current=material;this.attemptHash=material.bundle.root.seal;
      const applications=await this.applicationCoordinator();await applications.prepare();
      const changed=material.bundle.root.targets.some((target,index)=>target.publish&&target.commit!==(this.targets[index]!.remote??null));
      if(!retained&&!material.events.length&&!changed&&!this.importsNeeded()){this.attemptHash=undefined;return this.result(true,"not-needed");}
      if(!retained){await this.observe("before-plan-fsync");this.check();preparePlacementPublication(this.home,material.bundle,this.storage());await this.observe("plan-fsynced");this.check();}
      this.appendThrough(material.bundle,material.events,material.preCount);
      await this.materializeObjects(material.bundle);
      let read=readPlacementPublication(this.home,this.epochHash,material.bundle.root.seal);
      const artifact=read.facts.find(fact=>fact.phase==="artifact-built");if(!artifact)refuse();
      this.check();this.lastPolicyCheckUnixMs=Date.now();this.lastPolicyHash=material.bundle.root.policyHash;this.policyCheckSource="live";
      if(!read.facts.some(fact=>fact.phase==="publication-intent"))recordPlacementPublicationPhase(this.home,this.epochHash,material.bundle.root.seal,"publication-intent",{artifactFactHash:artifact.seal,policyHash:material.bundle.root.policyHash,policyCheckUnixMs:material.bundle.root.policySnapshotUnixMs},this.storage());
      ensurePlacementPublicationDurability(this.home,this.epochHash,this.storage());
      await this.observe("before-cas");this.check();
      const installedGuard=await this.installedObjectGuard(material.bundle);
      this.check();for(const target of this.targets)for(const check of target.selectorChecks??[])check();
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
      return this.result(false,this.attemptHash?"unknown":"not-needed",this.attemptHash?"Placement sync stopped with a retained attempt that may have published; recheck its exact receipts before another publication.":"Placement sync is unavailable; verify the active epoch, selected sources, policy, private remote and writer pins before retrying.");
    }finally{
      let ownedCache=true;try{this.metadata();}catch{ownedCache=false;}
      if(ownedCache){
        for(const ref of this.refs)try{this.metadata();await generationSyncGit(this.root,this.args(["update-ref","--no-deref","-d",ref]),undefined);}catch{}
        for(const file of this.temporary)try{this.metadata();rmSync(file,{force:true});}catch{}
      }
      for(const release of this.releases.reverse())try{release();}catch{}
    }
  }
}
