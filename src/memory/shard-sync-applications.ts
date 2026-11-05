/** Shared v2/v3 public-prune application preflight and durable view installation. No row import or transport publication. */
import { createHash } from "node:crypto";
import { canonicalJSON, readSelector } from "./generation.ts";
import { advancePublicPruneView } from "./public-prune-advance.ts";
import { readPublicPruneView, type PublicPruneViewV1 } from "./public-prune-view.ts";
import { collectPublicPruneGitGraph } from "./shard-sync-graph.ts";
import { PublicPruneInputError, PUBLIC_PRUNE_REPLAY_MAX_BYTES, PUBLIC_PRUNE_MAX_SETS, preparePublicPruneInputBatch,
  persistPublicPruneInputBatch, readPublicPruneInputDescriptor, readPublicPruneInputSetChain, reducePublicPruneInputs,
  type PublicPruneInputOptions } from "./public-prune-inputs.ts";
import { decodeShardPack, shardSyncRef, SHARD_PACK_MAX_BYTES } from "./shard-sync-format.ts";
import { shardPrepareHolds, shardSelectorRetention, type ShardSyncApplicationTarget, type ShardSyncApplicationPhase,
  type ShardSyncHoldReceipt } from "./shard-sync.ts";
import type { ShardHistory } from "./shard-sync-history.ts";
import type { MutationHandle } from "./mutation.ts";
import type { SyncResult } from "./sync.ts";
import type { PruneRow } from "./prune.ts";

type Target = ShardSyncApplicationTarget;
export interface ShardApplicationGitObject { type: "commit" | "tree" | "blob"; body: Uint8Array }
export interface ShardSyncApplicationsOptions {
  home: string; root: string; url: string; targets: Target[]; homeMutation: MutationHandle;
  getRevision(): string; setRevision(revision: string): void; check(): void;
  history(tip: string, target: Target): Promise<ShardHistory>;
  /** Placement supplies an already audited in-memory candidate before installing Git objects. */
  candidateHistory(target: Target): Promise<ShardHistory>;
  assertAncestor(ancestor: string, descendant: string, target: Target): Promise<void>;
  readObject(oid: string): Promise<ShardApplicationGitObject>;
  /** Rebind the caller's acquisition cache to these same immutable raw bytes, avoiding a second retained body. */
  retainGraphObject?(oid: string, rawBytes: Uint8Array): void | Promise<void>;
  /** Re-prove source/policy stability and update the caller's metadata binding after a legitimate view commit. */
  afterAdvance(): void | Promise<void>;
  phase?(phase: ShardSyncApplicationPhase): void | Promise<void>;
}
export class ShardSyncApplicationError extends Error {
  constructor(message: string) { super(message); this.name = "ShardSyncApplicationError"; }
}
function refuse(message: string): never { throw new ShardSyncApplicationError(message); }
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const oid = (value: unknown): value is string => typeof value === "string" && value.length === 40 && /^[a-f0-9]+$/.test(value);
const realmKey = (target: Target) => target.realm.scope === "user" ? "user" : `project:${target.realm.key}`;
export class ShardSyncApplications {
  readonly #options: ShardSyncApplicationsOptions;
  #boundView?: PublicPruneViewV1;
  readonly #objects = new Map<string, ShardApplicationGitObject>();
  readonly #graphs = new Map<string, Uint8Array>();
  readonly #sets = new Set<string>();
  #objectBytes = 0;
  readonly application: NonNullable<SyncResult["pruneApplication"]> = { transport: "unconfirmed", proofComplete: 0, projectionActive: null, nativeApplied: null, held: 0, phase: "preflight" };
  constructor(options: ShardSyncApplicationsOptions) { this.#options = options; }
  get boundView(): Readonly<PublicPruneViewV1> | undefined { return this.#boundView && structuredClone(this.#boundView); }
  async #checked<T>(work: () => T | Promise<T>): Promise<T> { this.#options.check(); const value = await work(); this.#options.check(); return value; }
  async #proveHoldSource(target: Target, receipt: ShardSyncHoldReceipt): Promise<void> {
    if (!target.remote) refuse("foreign prune has no selected public source");
    await this.#checked(() => this.#options.assertAncestor(receipt.source.commit, target.remote!, target));
    const original = await this.#checked(() => this.#options.history(receipt.source.commit, target)), bytes = original.files.get(receipt.source.pack);
    if (!bytes || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== receipt.source.blob
      || !decodeShardPack(receipt.source.pack, bytes, target.realm, target.generation).some(row => canonicalJSON(row) === canonicalJSON(receipt.row))
      || receipt.source.ref !== shardSyncRef(target.realm)) refuse("shard sync prune hold source mismatch");
  }
  async loadExisting(): Promise<void> {
    const o = this.#options; o.check();
    const selected = readSelector(o.home).selector;
    if ((selected?.schema !== "agent-mem.profile/v2" && selected?.schema !== "agent-mem.profile/v3")
      || o.targets.some(target => target.generation !== selected.generation)) refuse("selected public-prune profile unavailable");
    this.#boundView = readPublicPruneView(o.home, selected.pruneInputSetHash, selected.generation);
    for (const target of o.targets) {
      target.registered = []; const set = this.#boundView.realms[realmKey(target)]; if (!set) continue;
      // Shared across selected realms and retries; neither reopening an overlay nor repeating preflight resets the allowance.
      const chain = readPublicPruneInputSetChain({ dir: target.store.dir, receivingGeneration: target.generation, inputSetHash: set, ...(target.store.profile.publicationFormat ? {publicationFormat:target.store.profile.publicationFormat} : {}) });
      for (const commitment of chain.commitments) this.#sets.add(`${target.store.dir}:${commitment}`);
      if (this.#sets.size > PUBLIC_PRUNE_MAX_SETS) throw new PublicPruneInputError("resource");
      const projection = reducePublicPruneInputs({ dir: target.store.dir, realm: target.realm, receivingGeneration: target.generation, inputSetHash: set, ...(target.store.profile.publicationFormat ? {publicationFormat:target.store.profile.publicationFormat} : {}) });
      for (const hash of projection.inputs) {
        const descriptor = readPublicPruneInputDescriptor({ dir: target.store.dir, hash });
        if (!target.remote || descriptor.source.remoteHash !== digest(o.url)) refuse("registered prune source history disappeared or its remote binding changed");
        await this.#checked(() => o.assertAncestor(descriptor.source.commit, target.remote!, target));
        const original = await this.#checked(() => o.history(descriptor.source.commit, target)), manifest = original.manifests.get(descriptor.source.manifestPath);
        if (!manifest || !manifest.eligible || manifest.blob !== descriptor.source.manifestBlob || descriptor.source.ref !== shardSyncRef(target.realm)
          || digest(canonicalJSON(manifest.value)) !== descriptor.witnessHash) refuse("registered prune anchor no longer has exact audited evidence");
        target.registered.push(descriptor);
      }
    }
    o.check();
  }
  async #readObject(object: string): Promise<ShardApplicationGitObject> {
    if (!oid(object)) refuse("Git object identity invalid");
    const cached = this.#objects.get(object); if (cached) return cached;
    const value = await this.#checked(() => this.#options.readObject(object));
    if (!value || !["commit", "tree", "blob"].includes(value.type) || !(value.body instanceof Uint8Array)) refuse("Git object type refused");
    const limit = value.type === "commit" ? 65536 : SHARD_PACK_MAX_BYTES;
    if (value.body.length > limit) refuse("Git object exceeds complete evidence bound");
    const header = Buffer.from(`${value.type} ${value.body.length}\0`), encodedSize = header.length + value.body.length;
    if (this.#objectBytes + encodedSize > PUBLIC_PRUNE_REPLAY_MAX_BYTES) throw new PublicPruneInputError("resource");
    if (createHash("sha1").update(header).update(value.body).digest("hex") !== object) refuse("Git object identity mismatch");
    this.#objectBytes += encodedSize; this.#objects.set(object, value); return value;
  }
  async prepare(): Promise<void> {
    const o = this.#options; o.check(); if (!this.#boundView) refuse("public-prune application preflight is missing");
    this.application.proofComplete = 0; this.application.held = 0; let plannedSets = this.#sets.size;
    for (const target of o.targets) {
      const current = await this.#checked(() => o.candidateHistory(target)); target.manifests = new Map(current.manifests);
      target.eligible = new Set([...current.manifests.values()].filter(item => item.eligible).map(item => item.row.id)); this.application.proofComplete += target.eligible.size;
      const initial = this.#boundView.realms[realmKey(target)] ?? null, inputs: NonNullable<PublicPruneInputOptions["input"]>[] = [];
      for (const record of [...current.manifests.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        if (!record.eligible || record.row.generation === target.generation) continue;
        const witnessHash = digest(canonicalJSON(record.value)); if (target.registered.some(item => item.witnessHash === witnessHash)) continue;
        if (++plannedSets > PUBLIC_PRUNE_MAX_SETS) throw new PublicPruneInputError("resource");
        // A pure candidate is not publication evidence. Foreign anchors must still be in actual selected remote history.
        if (!target.remote) refuse("foreign prune has no selected public source");
        await this.#checked(() => o.assertAncestor(record.commit, target.remote!, target));
        const original = await this.#checked(() => o.history(record.commit, target)), anchor = original.manifests.get(record.path);
        if (!anchor || !anchor.eligible || anchor.blob !== record.blob || canonicalJSON(anchor.value) !== canonicalJSON(record.value)) refuse("foreign prune anchor lacks exact audited public evidence");
        const acquired = await this.#checked(() => collectPublicPruneGitGraph({ commit: record.commit, manifestPath: record.path, manifestBlob: record.blob, realm: target.realm, ...(target.store.profile.publicationFormat ? {publicationFormat:target.store.profile.publicationFormat} : {}), readObject: object => this.#readObject(object) }));
        const objects: { oid: string; bytes: Uint8Array }[] = [];
        for (const item of acquired) {
          const prior = this.#graphs.get(item.oid); if (prior && !Buffer.from(prior).equals(item.bytes)) refuse("conflicting Git graph bytes");
          const bytes = prior ?? item.bytes; this.#graphs.set(item.oid, bytes);
          const cached = this.#objects.get(item.oid); if (!cached) refuse("Git graph acquisition receipt unavailable");
          this.#objects.set(item.oid, { type: cached.type, body: bytes.subarray(bytes.indexOf(0) + 1) });
          if (o.retainGraphObject) await this.#checked(() => o.retainGraphObject!(item.oid, bytes));
          objects.push({ oid: item.oid, bytes });
        }
        inputs.push({ witnessHash, source: { remoteHash: digest(o.url), ref: shardSyncRef(target.realm), commit: record.commit, manifestPath: record.path, manifestBlob: record.blob }, objects });
      }
      target.batch = undefined;
      if (inputs.length) {
        const binding = { realm: target.realm, receivingGeneration: target.generation, selectorRevision: o.getRevision(), inputSetHash: initial, ...(target.store.profile.publicationFormat ? {publicationFormat:target.store.profile.publicationFormat} : {}) };
        target.batch = preparePublicPruneInputBatch({ dir: target.store.dir, binding, current: () => { o.check(); return { ...binding, selectorRevision: o.getRevision() }; }, inputs }, target.mutation!);
      }
    }
    await this.#checked(() => shardPrepareHolds(o.targets, o.root, o.url, (target, receipt) => this.#proveHoldSource(target, receipt)));
    this.application.held = o.targets.reduce((sum, target) => sum + target.holds.length, 0); this.application.phase = "prepared";
  }
  async install(): Promise<void> {
    const o = this.#options; o.check(); if (!this.#boundView) refuse("public-prune application preflight is missing");
    const realms = { ...this.#boundView.realms };
    for (const target of o.targets) if (target.batch) {
      const installed = persistPublicPruneInputBatch(target.batch, { mutation: target.mutation!, observe: () => o.check() }); realms[realmKey(target)] = installed.inputSetHash;
      if (o.phase) await this.#checked(() => o.phase!("inputs-installed"));
    }
    const view: PublicPruneViewV1 = { ...this.#boundView, realms };
    if (canonicalJSON(view) !== canonicalJSON(this.#boundView)) {
      for (const target of o.targets) shardSelectorRetention(target, true, true);
      const result = await advancePublicPruneView({ memoryDir: o.home, view, expectedRevision: o.getRevision(), mutations: [o.homeMutation, ...o.targets.map(target => target.mutation!)] });
      o.setRevision(result.revision); this.#boundView = view;
      for (const target of o.targets) target.store.refresh();
      await o.afterAdvance();
      if (o.phase) await this.#checked(() => o.phase!("view-committed"));
    }
    this.application.projectionActive = o.targets.reduce((sum, target) => sum + [...target.eligible].filter(id => (target.rows.get(id) as PruneRow).generation !== target.generation).length, 0);
    this.application.phase = "active"; o.check();
  }
}
