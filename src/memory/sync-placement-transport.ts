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
import { outboundPolicyEvaluator } from "./sync-screen.ts";
import { readActivePlacementBinding } from "./sync-placement-active.ts";
import { readPlacementRuntimeMarkers } from "./sync-placement-guard.ts";
import { captureSyncPlacementContext, placementCaptureContextHash, type PlacementCapture, type PlacementPendingSource } from "./sync-placement-capture.ts";
import { readEffectiveSyncPlacementWriters, type EffectiveSyncPlacementWriters } from "./sync-placement-effective-writers.ts";
import { SharedWriterRevisionError } from "./sync-placement-writer-revision-format.ts";
import { types } from "node:util";
import type { PlannedGitObject } from "./sync-placement-git.ts";
import { PLACEMENT_FORMAT } from "./sync-placement-format.ts";
import { createPlacementRecord, placementKeyId, type PlacementEvent, type PlacementRealm, type PlacementHoldReason, type PlacementRecord } from "./sync-placement-journal-format.ts";
import { rebuildPlacementProjection, type PlacementProjection } from "./sync-placement-projection.ts";
import { readPlacementJournal, appendPlacementEvent, ensurePlacementPublicationDurability, type PlacementJournalRead, type PlacementStorageOptions } from "./sync-placement-journal-storage.ts";
import { preparePlacementPublication, readPlacementPublication, recordPlacementPublicationPhase, type PlacementPublicationRead } from "./sync-placement-publication-storage.ts";
import { planPlacementPublication, publicationBytes, type PlacementPublicationBundle, type PlacementPublicationDecision, type PlacementPublicationObject } from "./sync-placement-publication-plan.ts";
import { ShardHistoryAuditor, type ShardHistory } from "./shard-sync-history.ts";
import { ShardSyncApplications } from "./shard-sync-applications.ts";
import { shardSourceRows, shardProvePrunes, shardImportRows, shardSelectorRetention, shardInstallHold, shardHoldWarning, type ShardSyncApplicationTarget } from "./shard-sync.ts";
import { shardSyncRef, SHARD_PACK_MAX_BYTES } from "./shard-sync-format.ts";
import { assertPublisherBoundary, ensurePublisherBoundary, publisherPruneLineages } from "./prune-publisher-lineage.ts";
import type { MemoryStore } from "./store.ts";
import type { PruneRow } from "./prune.ts";
import { materializePlacementRows, verifiedPlacementPrunes } from "./sync-placement-materialize.ts";
import { placementCacheConfigStamp, placementCacheRootStamp, validatePlacementCacheConfig } from "./sync-placement-cache.ts";

export type PlacementSyncPhase = "before-plan-fsync" | "plan-fsynced" | "artifact-built" | "before-cas" | "cas-returned" | "before-ack" | "acknowledged" | "imported" | "before-receipt" | "receipt-written";
type Phase = (phase: PlacementSyncPhase) => void | Promise<void>;
type Target = ShardSyncApplicationTarget & { auditor: ShardHistoryAuditor; remoteHistory?: ShardHistory; candidate?: ShardHistory; objects: PlannedGitObject[]; localPrunes: Map<string, PruneRow> };
interface Materialized { bundle: PlacementPublicationBundle; decisions: PlacementPublicationDecision[]; projection: PlacementProjection; old: (ShardHistory | undefined)[]; events: PlacementEvent[]; preCount: number; holdCount: number; exported: number; withheld: number }
const digest = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const oid = (v: unknown): v is string => typeof v === "string" && v.length === 40 && /^[a-f0-9]+$/.test(v);
const sameRealm = (a: PlacementRealm, b: PlacementRealm) => canonicalJSON(a) === canonicalJSON(b);
const physical = (target: Target): PlacementRealm => target.realm.scope === "user" ? { scope: "user" } : { scope: "project", keyHash: digest(target.realm.key) };
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
  writerInventory?:EffectiveSyncPlacementWriters;
  constructor(store: MemoryStore, opts: SyncOptions, phase?: Phase, testOnlyError?: (error:unknown)=>void) { this.testOnlyError=testOnlyError; this.store = store; this.opts = opts; this.phase = phase; this.home = store.profile.home; this.root = join(this.home, "shard-sync-placement"); this.cache = join(this.root, "objects.git"); }
  attest(): void {
    if (!this.opts.placementAttestation || this.opts.screen && !this.opts.policyVersion) refuse();
    const value = memoryPolicySnapshot(this.opts.placementAttestation());
    if (!value || value.legacySyncQuiesced !== true || !Array.isArray(value.writers)) refuse();
    const writers = [...value.writers].sort((a,b) => a.writerId.localeCompare(b.writerId));
    if(!this.writerInventory||canonicalJSON(writers)!==canonicalJSON(this.writerInventory.writers))refuse();
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
    return placementCacheConfigStamp(this.cache);
  }
  async bindCacheConfig():Promise<void>{
    const before=this.configStamp(),output=await this.required(["config","--local","--no-includes","--null","--list"]);
    validatePlacementCacheConfig(output);
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
    this.epochHash = active.profile.placementHead; this.machineId = active.shards.machine.id; this.revision = readSelector(this.home).revision; this.journal = readPlacementJournal(this.home, this.epochHash); this.writerInventory=readEffectiveSyncPlacementWriters(this.home);this.attest();
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
    if (existsSync(this.root)) placementCacheRootStamp(this.home);
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
      || canonicalJSON(this.capture.context.writers) !== canonicalJSON(this.writerInventory?.writers)
      || this.capture.writerInventory?.revisionHash!==this.writerInventory?.revisionHash) refuse();
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
      old,verifiedPrunes:verified,evaluate:value=>this.evaluate(value),createdUnixSeconds,...(frozen?{frozen}:{}),
      readTree:(_index,head)=>this.required(["rev-parse",`${head}^{tree}`]),
      publisherLineages:(index,rows)=>{const target=this.targets[index]!;assertPublisherBoundary(target.store.profile,target.mutation!);return publisherPruneLineages(target.store.profile,target.mutation!,rows);}});
    for(const [index,target]of this.targets.entries())Object.assign(target,materialized.targets[index]!);
    const {decisions,plannedTargets:targets,objects}=materialized;
    const body={epochHash:this.epochHash,generation:this.journal.epoch.generation,homeHash:capture.context.homeHash,contextHash:placementCaptureContextHash(capture),markerHash:capture.markerHash,
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
        const stable=root.contextHash===placementCaptureContextHash(this.capture!)&&root.markerHash===this.capture!.markerHash&&root.sourceHash===this.capture!.context.sourceHash
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
      if(error&&typeof error==="object"&&!types.isProxy(error)&&error instanceof SharedWriterRevisionError){
        const code=Object.getOwnPropertyDescriptor(error,"code")?.value;
        if(code==="staging"||code==="pending")return this.result(false,this.attemptHash?"unknown":"not-needed",new SharedWriterRevisionError(code).message);
      }
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
