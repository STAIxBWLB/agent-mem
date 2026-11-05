/** Complete selected-realm immutable history audit; Git acquisition and binding checks belong to the caller. */
import { createHash } from "node:crypto";
import { canonicalJSON, validGeneration } from "./generation.ts";
import { validatePruneRow, type PruneRow } from "./prune.ts";
import { verifyPublicPruneWitness } from "./public-prune-witness.ts";
import { decodeShardDescriptor, decodePlacementTransportDescriptor, decodeShardPack, decodeShardManifest, isShardManifestPath,
  shardSyncRef, SHARD_PACK_MAX_BYTES, type ShardSyncRealm, type ShardSyncRow } from "./shard-sync-format.ts";

export interface ShardHistoryOrigin { ref: string; commit: string; pack: string; blob: string }
export interface ShardHistoryManifest { path: string; bytes: Buffer; value: unknown; row: PruneRow; eligible: boolean; commit: string; blob: string }
export interface ShardHistory {
  rows: Map<string, ShardSyncRow>; files: Map<string, Buffer>; origins: Map<string, ShardHistoryOrigin>;
  version: "v1" | "v2" | "v3"; manifests: Map<string, ShardHistoryManifest>;
}
export interface ShardHistoryAuditorOptions {
  realm: ShardSyncRealm; generation: string; placement: boolean; publicPrune?: boolean;
  /** Complete successful Git output only. The port rechecks receiving bindings around every await. */
  git(args: string[]): Promise<string>;
  /** Caller acquisition bounds and validates objects. Audit also retains identity/newline/bound checks. */
  blob(oid: string, path: string): Promise<Buffer>;
}
export class ShardHistoryError extends Error {
  constructor() { super("Shard history is unavailable, inconsistent or unsupported; retain and inspect the complete selected history before continuing."); this.name = "ShardHistoryError"; }
}
function fail(): never { throw new ShardHistoryError(); }
const oid = (v: unknown): v is string => typeof v === "string" && v.length === 40 && /^[a-f0-9]+$/.test(v);
const packPath = (v: string) => /^rows\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/.exec(v)?.[0] === v;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const rank = { v1: 1, v2: 2, v3: 3 };
function detached(value: ShardHistory): ShardHistory {
  return { version: value.version, rows: new Map([...value.rows].map(([id, row]) => [id, structuredClone(row)])),
    files: new Map([...value.files].map(([path, bytes]) => [path, Buffer.from(bytes)])),
    origins: new Map([...value.origins].map(([id, origin]) => [id, { ...origin }])),
    manifests: new Map([...value.manifests].map(([path, manifest]) => [path, { ...manifest, bytes: Buffer.from(manifest.bytes), value: structuredClone(manifest.value), row: structuredClone(manifest.row) }])) };
}
export class ShardHistoryAuditor {
  readonly #options: ShardHistoryAuditorOptions;
  readonly #ref: string;
  readonly #histories = new Map<string, ShardHistory>();
  readonly #audited = new Set<string>();
  readonly #blobs = new Map<string, Buffer>();
  readonly #decoded = new Map<string, ShardSyncRow[]>();
  readonly #origins = new Map<string, ShardHistoryOrigin>();
  readonly #manifestOrigins = new Map<string, { commit: string; blob: string }>();
  #running = false;
  constructor(options: ShardHistoryAuditorOptions) {
    this.#ref = shardSyncRef(options.realm);
    if (!validGeneration(options.generation) || typeof options.placement !== "boolean" || options.publicPrune !== undefined && typeof options.publicPrune !== "boolean") fail();
    this.#options = { ...options, realm: structuredClone(options.realm), publicPrune: options.publicPrune ?? options.placement };
  }
  async #blob(object: string, path: string): Promise<Buffer> {
    const maximum = path === "shard.json" || isShardManifestPath(path) ? 64 * 1024 : SHARD_PACK_MAX_BYTES;
    let bytes = this.#blobs.get(object);
    if (!bytes) {
      const result = await this.#options.blob(object, path);
      if (!(result instanceof Uint8Array)) fail(); bytes = Buffer.from(result);
      if (bytes.length < 1 || bytes.length > maximum || bytes.at(-1) !== 10
        || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== object) fail();
      this.#blobs.set(object, bytes);
    }
    if (bytes.length > maximum) fail(); return bytes;
  }
  async #tree(commit: string): Promise<ShardHistory> {
    const entries = (await this.#options.git(["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean);
    const rows = new Map<string, ShardSyncRow>(), files = new Map<string, Buffer>(), origins = new Map<string, ShardHistoryOrigin>();
    const objects = new Map<string, string>(), manifests = new Map<string, ShardHistoryManifest>();
    for (const entry of entries) {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match || match[0] !== entry) fail();
      const path = match[2]!, object = match[1]!;
      if (files.has(path) || path !== "shard.json" && !packPath(path) && !isShardManifestPath(path)) fail();
      files.set(path, await this.#blob(object, path)); objects.set(path, object);
    }
    const descriptor = files.get("shard.json"); if (!descriptor) return fail();
    const version = this.#options.placement ? decodePlacementTransportDescriptor(descriptor, this.#options.realm) : decodeShardDescriptor(descriptor, this.#options.realm);
    if (version !== "v1" && !this.#options.publicPrune) fail();
    for (const [path, bytes] of files) if (packPath(path)) {
      const object = objects.get(path)!; let pack = this.#decoded.get(object);
      if (!pack) { pack = decodeShardPack(path, bytes, this.#options.realm, this.#options.generation); this.#decoded.set(object, pack); }
      else if (!path.endsWith(`/${digest(bytes)}.jsonl`) || pack.some(row => path !== `rows/${digest(row.machine)}/${digest(bytes)}.jsonl`)) fail();
      for (const row of pack) {
        const old = rows.get(row.id); if (old && canonicalJSON(old) !== canonicalJSON(row)) fail(); rows.set(row.id, row);
        if (!origins.has(row.id)) origins.set(row.id, this.#origins.get(row.id) ?? { ref: this.#ref, commit, pack: path, blob: object });
      }
    }
    for (const [path, bytes] of files) if (isShardManifestPath(path)) {
      if (version === "v1") fail();
      const value = decodeShardManifest(path, bytes), candidate = value as { prune?: unknown; pruneOccurrence?: { pack: string; blob: string }; witnesses?: { pack: string; blob: string }[] };
      const row = validatePruneRow(candidate.prune, undefined, "synced");
      if (canonicalJSON(rows.get(row.id)) !== canonicalJSON(row) || !candidate.pruneOccurrence || !Array.isArray(candidate.witnesses)) fail();
      const selected = new Map<string, { pack: string; blob: string; bytes: Buffer }>();
      for (const ref of [candidate.pruneOccurrence, ...candidate.witnesses]) {
        if (!ref || typeof ref.pack !== "string" || objects.get(ref.pack) !== ref.blob || !files.has(ref.pack)) fail();
        selected.set(ref.pack, { pack: ref.pack, blob: ref.blob, bytes: files.get(ref.pack)! });
      }
      const proof = verifyPublicPruneWitness(value, { realm: this.#options.realm, packs: [...selected.values()] });
      if (proof.status === "invalid") fail();
      const origin = this.#manifestOrigins.get(path) ?? { commit, blob: objects.get(path)! };
      manifests.set(path, { path, bytes, value, row, eligible: proof.status === "verified", ...origin });
    }
    return { rows, files, origins, version, manifests };
  }
  #accept(current: ShardHistory): void {
    // Commit origins only after the complete tree and every parent retention rule passed.
    for (const [id, origin] of current.origins) { if (!this.#origins.has(id)) this.#origins.set(id, origin); current.origins.set(id, this.#origins.get(id)!); }
    for (const [path, manifest] of current.manifests) {
      const first = this.#manifestOrigins.get(path) ?? { commit: manifest.commit, blob: manifest.blob };
      this.#manifestOrigins.set(path, first); current.manifests.set(path, { ...manifest, ...first });
    }
  }
  /** Only requested tips retain full row maps. Parent trees are reconstructed with decoded immutable blobs. */
  async history(tip: string): Promise<ShardHistory> {
    if (!oid(tip) || this.#running) return fail(); this.#running = true;
    try {
      const cached = this.#histories.get(tip); if (cached) return detached(cached);
      const lines = (await this.#options.git(["rev-list", "--topo-order", "--reverse", "--parents", tip])).split("\n").filter(Boolean);
      let latest: ShardHistory | undefined; const seen = new Set<string>();
      // ponytail: complete selected history still costs time and immutable selected-blob memory per invocation.
      // Upgrade with a validated immutable commit/blob digest cache, never an arbitrary history lifetime cliff.
      for (const line of lines) {
        const [commit, ...parents] = line.split(" ");
        if (!oid(commit) || parents.some(parent => !oid(parent)) || seen.has(commit)) return fail(); seen.add(commit);
        if (this.#audited.has(commit)) { if (commit === tip) latest = await this.#tree(commit); continue; }
        const current = await this.#tree(commit);
        for (const parent of parents) {
          if (!this.#audited.has(parent) || !seen.has(parent)) return fail();
          const previous = this.#histories.get(parent) ?? await this.#tree(parent);
          if (rank[current.version] < rank[previous.version]) fail();
          if (previous.version !== "v1") for (const [path, bytes] of previous.files)
            if (path !== "shard.json" && !current.files.get(path)?.equals(bytes)) fail();
          for (const row of previous.rows.values()) if (canonicalJSON(current.rows.get(row.id)) !== canonicalJSON(row)) fail();
        }
        this.#accept(current); this.#audited.add(commit); if (commit === tip) latest = current;
      }
      if (!latest || lines.at(-1)?.split(" ")[0] !== tip) return fail();
      this.#histories.set(tip, latest); return detached(latest);
    } catch { return fail(); }
    finally { this.#running = false; }
  }
}
