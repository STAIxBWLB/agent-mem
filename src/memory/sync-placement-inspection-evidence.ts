/** Read-only retained placement evidence. Neither a planned object nor a cached ref is a publication receipt. */
import { capturePlacementPublicationMetadata, type PlacementJournalRead, type PlacementPublicationStored } from "./sync-placement-journal-storage.ts";
import { rebuildPlacementProjection, type PlacementProjection } from "./sync-placement-projection.ts";
import { SyncPlacementJournalError } from "./sync-placement-journal-format.ts";
import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, hashJSON } from "./generation.ts";
import { memoryGitEnv, memoryGitSync } from "./platform.ts";
import { placementCacheConfigStamp, validatePlacementCacheConfig } from "./sync-placement-cache.ts";
import { SYNC_SCREEN_MAX_BYTES, SYNC_SCREEN_MAX_ROWS } from "./sync-screen.ts";
import { PUBLIC_PRUNE_REPLAY_MAX_BYTES } from "./public-prune-input-chain.ts";
import { ShardHistoryAuditor } from "./shard-sync-history.ts";
import { SHARD_PACK_MAX_BYTES, shardSyncRef, type ShardSyncRealm } from "./shard-sync-format.ts";
import type { PlacementKey, PlacementRealm } from "./sync-placement-journal-format.ts";
import { placementKeyId } from "./sync-placement-journal-format.ts";
import type { ShardHistory } from "./shard-sync-history.ts";
import type { PlacementPublicationDecision, PlacementPublicationObject } from "./sync-placement-publication-plan.ts";

export interface InspectionJournal {
  journal: PlacementJournalRead;
  projection: PlacementProjection;
  publications: ReadonlyMap<string, PlacementPublicationStored>;
  assertCurrent(): void;
}

export function captureInspectionJournal(home: string, epochHash: string): InspectionJournal {
  const captured = capturePlacementPublicationMetadata(home, epochHash, io => {
    const journal = io.journal();
    if (journal.pending) throw new SyncPlacementJournalError("pending");
    const attempts = new Set<string>();
    for (const name of io.names()) {
      const match = /^publication-([a-f0-9]{64})-/.exec(name);
      if (match) attempts.add(match[1]!);
    }
    const publications = new Map<string, PlacementPublicationStored>();
    for (const attempt of [...attempts].sort()) {
      const publication = io.publication(attempt);
      if (publication.pending) throw new SyncPlacementJournalError("pending");
      const frontier = (sequence: number) => sequence === 0 ? publication.bundle.root.epochHash : journal.records[sequence - 1]?.seal;
      if (frontier(publication.bundle.root.journal.sequence) !== publication.bundle.root.journal.headHash) throw new SyncPlacementJournalError("corrupt");
      const receipt = publication.facts.find(fact => fact.phase === "completed");
      if (receipt?.phase === "completed" && frontier(receipt.journal.sequence) !== receipt.journal.headHash) throw new SyncPlacementJournalError("corrupt");
      publications.set(attempt, publication);
    }
    return { journal, projection: rebuildPlacementProjection(journal.epoch, journal.records), publications };
  });
  return { ...captured.value, assertCurrent: captured.assertCurrent };
}

export interface InspectionExposureProof { remoteHash: string; refHash: string; commit: string }
export interface InspectionTarget { realm: ShardSyncRealm; generation: string }
export interface RetainedInspectionHistories {
  old: (ShardHistory | undefined)[];
  tips: (string | undefined)[];
  published: Map<string, InspectionExposureProof[]>;
  uncertain: Set<string>;
}
const physicalRealm = (realm: ShardSyncRealm): PlacementRealm => realm.scope === "user" ? { scope: "user" } : { scope: "project", keyHash: hash(realm.key) };

/** Historical core acknowledgement plus exact immutable membership, never a current remote-head observation. */
export async function inspectRetainedPublicationHistories(snapshot: InspectionJournal, targets: readonly InspectionTarget[], objects?: PlacementInspectionObjects): Promise<RetainedInspectionHistories> {
  const result: RetainedInspectionHistories = { old: targets.map(() => undefined), tips: targets.map(() => undefined), published: new Map(), uncertain: new Set() };
  const selected = new Map(targets.map((target, index) => [canonicalJSON(physicalRealm(target.realm)), index]));
  const publications = [...snapshot.publications.values()].sort((a, b) => a.bundle.root.journal.sequence - b.bundle.root.journal.sequence || a.bundle.root.seal.localeCompare(b.bundle.root.seal));
  for (const publication of publications) {
    const root = publication.bundle.root, decisions = publication.bundle.chunks.filter(chunk => chunk.kind === "decisions").flatMap(chunk => chunk.items as PlacementPublicationDecision[]);
    const receipt = publication.facts.find(fact => fact.phase === "completed"), artifact = publication.facts.find(fact => fact.phase === "artifact-built");
    for (const decision of decisions) {
      const target = root.targets.find(target => canonicalJSON(target.realm) === canonicalJSON(decision.key.realm));
      if (selected.has(canonicalJSON(decision.key.realm)) && target && (target.publish && decision.eligible || target.expectedRemoteHead !== null)) result.uncertain.add(placementKeyId(decision.key));
    }
    if (!objects || publication.phase !== "completed" || receipt?.phase !== "completed" || receipt.outcome !== "committed") continue;
    if (receipt.outcomeHash !== hashJSON({ attempt: root.seal, commits: root.targets.map(target => target.commit) })
      || artifact?.phase !== "artifact-built" || artifact.exportHash !== hashJSON(root.targets.map(target => target.exportSetHash))) unavailable();
    for (const [targetIndex, planned] of root.targets.entries()) {
      const index = selected.get(canonicalJSON(planned.realm)); if (index === undefined) continue;
      const target = targets[index]!, tip = planned.commit ?? planned.expectedRemoteHead;
      if (!tip) continue;
      if (planned.refHash !== hash(shardSyncRef(target.realm))) unavailable();
      const history = await objects.auditor(target.realm, target.generation).history(tip);
      if (history.rows.size > SYNC_SCREEN_MAX_ROWS) bound();
      const membership = [...history.rows.values()].map(row => ({ id: row.id, rowHash: hashJSON(row) })).sort((a, b) => a.id.localeCompare(b.id));
      if (hashJSON(membership) !== planned.exportSetHash || hash(history.files.get("shard.json") ?? Buffer.alloc(0)) !== planned.descriptorHash
        || planned.tree !== objects.tree(tip)) unavailable();
      const retained = publication.bundle.chunks.filter(chunk => chunk.kind === "objects").flatMap(chunk => chunk.items as PlacementPublicationObject[]);
      for (const object of retained) if (object.targetIndex === targetIndex) {
        const body = objects.object(object.oid, object.type, object.type === "commit" ? 65536 : SHARD_PACK_MAX_BYTES);
        if (body.length !== object.size || hash(body) !== object.sha256) unavailable();
      }
      for (const row of membership) {
        const key: PlacementKey = { realm: physicalRealm(target.realm), ...row }, id = placementKeyId(key);
        const proof = { remoteHash: root.remoteHash, refHash: planned.refHash, commit: tip };
        const prior = result.published.get(id) ?? [];
        if (!prior.some(value => canonicalJSON(value) === canonicalJSON(proof))) prior.push(proof);
        result.published.set(id, prior);
      }
      // Only the retained selected origin supplies publication dependencies. A receipt from another remote
      // is historical exposure, never a reason to hydrate its bodies into the current publication target.
      if (root.remoteHash === objects.remoteHash) { result.old[index] = history; result.tips[index] = tip; }
    }
  }
  for (const proofs of result.published.values()) proofs.sort((a, b) => canonicalJSON(a).localeCompare(canonicalJSON(b)));
  objects?.assertCurrent(); snapshot.assertCurrent(); return result;
}

const unavailable = (): never => { throw new SyncPlacementJournalError("corrupt"); };
const bound = (): never => { throw new SyncPlacementJournalError("bound"); };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const oid = (value: string) => /^[a-f0-9]{40}$/.test(value);
const forbidden = ["commondir", "shallow", "info/grafts", "objects/info/alternates", "objects/info/http-alternates", "config.worktree"];

/** Bind the complete private cache inventory, not a mutable ref as evidence of a remote acknowledgement.
 * ponytail: diagnostic cache metadata shares the 20000-entry/8MiB ceiling and the existing 256MiB replay-disk
 * ceiling. Larger inventories need a reviewed immutable object inventory; no entry is silently skipped. */
function cacheInventory(cache: string): string {
  const pending = [cache], rows: unknown[] = []; let metadataBytes = 0, diskBytes = 0;
  const record = (file: string) => {
    if (rows.length >= SYNC_SCREEN_MAX_ROWS) return bound();
    const stat = lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n
      || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n) || file.endsWith(".promisor")) unavailable();
    if (stat.isFile()) { diskBytes += Number(stat.size); if (diskBytes > PUBLIC_PRUNE_REPLAY_MAX_BYTES) bound(); }
    const row = [file, stat.isDirectory() ? "directory" : "file", ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)];
    metadataBytes += Buffer.byteLength(canonicalJSON(row)); if (metadataBytes > SYNC_SCREEN_MAX_BYTES) bound(); rows.push(row);
    return stat.isDirectory();
  };
  record(cache);
  while (pending.length) {
    const reader = opendirSync(pending.pop()!);
    try { for (;;) { const entry = reader.readSync(); if (!entry) break; const file = join(reader.path, entry.name); if (record(file)) pending.push(file); } }
    finally { reader.closeSync(); }
  }
  return hash(canonicalJSON(rows.sort((a, b) => canonicalJSON(a).localeCompare(canonicalJSON(b)))));
}

/** Fixed local Git reads only. No initialization, fetch, remote probing, write command, credential or lazy fetch. */
export class PlacementInspectionObjects {
  readonly cache: string;
  readonly remoteHash: string;
  private readonly home: string;
  private readonly stamp: string;
  private readonly inventory: string;
  private readonly check: () => void;
  private bytes = 0;
  private sourceRows = 0;
  private sourceBytes = 0;
  private readonly sourcePacks = new Set<string>();
  private readonly objects = new Map<string, { type: string; bytes: Buffer }>();
  private readonly auditors = new Map<string, ShardHistoryAuditor>();
  constructor(home: string, check: () => void) {
    this.home = home; this.cache = join(home, "shard-sync-placement", "objects.git"); this.check = check;
    this.inventory = cacheInventory(this.cache); this.stamp = placementCacheConfigStamp(this.cache);
    this.quick();
    const config = validatePlacementCacheConfig(this.text(["config", "--local", "--no-includes", "--null", "--list"]));
    const origin = config.get("remote.origin.url");
    if (!origin || origin.length > 4096 || origin.startsWith("-") || /[\r\n\0]/.test(origin) || config.has("remote.origin.pushurl") && config.get("remote.origin.pushurl") !== origin) unavailable();
    this.remoteHash = hash(origin);
    if (this.text(["rev-parse", "--is-bare-repository"]) !== "true" || this.text(["rev-parse", "--show-object-format"]) !== "sha1") unavailable();
    this.assertCurrent();
  }
  private quick(): void {
    this.check(); this.cacheCheck();
  }
  private cacheCheck(): void {
    if (placementCacheConfigStamp(this.cache) !== this.stamp) throw new SyncPlacementJournalError("changed");
    for (const file of forbidden) if (lstatSync(join(this.cache, file), { throwIfNoEntry: false })) unavailable();
  }
  private run(args: string[], maximum: number): { code: number; bytes: Buffer } {
    this.quick();
    if (!["config", "rev-parse", "rev-list", "symbolic-ref", "cat-file"].includes(args[0] ?? "")) unavailable();
    const env = memoryGitEnv(process.env, { repositoryIsolation: true, readOnlyDiagnostic: true });
    const result = memoryGitSync(["--no-replace-objects", "--git-dir", this.cache, "-c", "protocol.allow=never", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.commitGraph=false", ...args],
      { encoding: "buffer", cwd: this.home, env, timeout: 10000, killSignal: "SIGKILL", maxBuffer: maximum });
    this.quick();
    if (result.error) { if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") bound(); unavailable(); }
    return { code: result.status ?? -1, bytes: result.stdout };
  }
  text(args: string[]): string {
    const result = this.run(args, SYNC_SCREEN_MAX_BYTES); if (result.code !== 0) unavailable();
    return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes).trim();
  }
  ref(realm: ShardSyncRealm): string | undefined {
    const ref = shardSyncRef(realm), symbolic = this.run(["symbolic-ref", "--quiet", ref], 65536);
    if (symbolic.code !== 1) unavailable();
    const result = this.run(["rev-parse", "--verify", "--quiet", ref], 65536), value = result.bytes.toString("utf8").trim();
    if (result.code === 1) return undefined;
    if (result.code !== 0 || !oid(value)) unavailable(); return value;
  }
  object(object: string, type: "commit" | "tree" | "blob", maximum: number): Buffer {
    if (!oid(object)) unavailable();
    const prior = this.objects.get(object); if (prior) { if (prior.type !== type || prior.bytes.length > maximum) unavailable(); return Buffer.from(prior.bytes); }
    if (this.objects.size >= SYNC_SCREEN_MAX_ROWS) bound();
    if (this.text(["cat-file", "-t", object]) !== type) unavailable();
    const size = Number(this.text(["cat-file", "-s", object]));
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum || this.bytes + size > SYNC_SCREEN_MAX_BYTES) bound();
    const result = this.run(["cat-file", type, object], Math.max(1, maximum));
    if (result.code !== 0 || result.bytes.length !== size || createHash("sha1").update(`${type} ${size}\0`).update(result.bytes).digest("hex") !== object) unavailable();
    this.bytes += size; this.objects.set(object, { type, bytes: result.bytes }); return Buffer.from(result.bytes);
  }
  auditor(realm: ShardSyncRealm, generation: string): ShardHistoryAuditor {
    const key = canonicalJSON([realm, generation]); let auditor = this.auditors.get(key);
    if (!auditor) {
      auditor = new ShardHistoryAuditor({ realm, generation, placement: true, publicPrune: true, git: async args => this.text(args),
        object: async (id, type) => this.object(id, type, type === "commit" ? 65536 : SHARD_PACK_MAX_BYTES),
        blob: async (id, path) => {
          const bytes = this.object(id, "blob", path === "shard.json" || path.startsWith("prune-witnesses/") ? 65536 : SHARD_PACK_MAX_BYTES);
          const physical = canonicalJSON([realm, id]);
          if (path.startsWith("rows/") && !this.sourcePacks.has(physical)) {
            let lines = 0; for (const byte of bytes) if (byte === 10) lines++;
            if (this.sourceRows + lines > SYNC_SCREEN_MAX_ROWS || this.sourceBytes + bytes.length > SYNC_SCREEN_MAX_BYTES) bound();
            this.sourceRows += lines; this.sourceBytes += bytes.length; this.sourcePacks.add(physical);
          }
          return bytes;
        } });
      this.auditors.set(key, auditor);
    }
    return auditor;
  }
  tree(commit: string): string {
    const body = this.object(commit, "commit", 65536), first = body.subarray(0, body.indexOf(10)).toString("ascii");
    if (!/^tree [a-f0-9]{40}$/.test(first)) unavailable(); return first.slice(5);
  }
  assertCurrent(): void {
    this.check(); this.assertRetained();
  }
  /** Passive final proof: never invokes an attestation/policy callback after another input's final check. */
  assertRetained(): void {
    this.cacheCheck(); if (cacheInventory(this.cache) !== this.inventory) throw new SyncPlacementJournalError("changed");
  }
}
