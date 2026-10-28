import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { legacyEntries, legacyHead, readLegacySnapshot, SegmentReader, type LegacySegment } from "./bridge.ts";
import { canonicalJSON, generationDescriptor, generationDir, hashJSON, readProfileJSON, readSelector, validGeneration, validateGeneration, withProfileLock, writeProfileJSON, type BoundProfile, validateVaultLinkRow, type VaultLinkRow } from "./generation.ts";
import { coalesceGenerationSource, explicitExpirySnapshot } from "./generation-index.ts";
import { pruneId, prunePayloadHash, reducePruneRows, validatePruneRow, type PruneRow, type PruneSourceRow } from "./prune.ts";
import { acquireMutation } from "./mutation.ts";
import { canonicalPath, realPath } from "./platform.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
import { assertCuratedShardPaths, ensureShardDescriptor, shardDir, SHARDED_SCHEMA, userShardDir, SHARD_SCHEMA } from "./shard.ts";
import { buildGenerationIndex, type Entry } from "./store.ts";
import { readMigrationSources, type SourcePrefix } from "./migrate.ts";
import { label, PLAIN, singleLine, type Style } from "./style.ts";

const USER = Symbol("shared-user-shard");
type Destination = string | typeof USER;
const JOURNAL = "shards.json";
const CONSEQUENCE = "Legacy bytes are never rewritten; unannounced older readers cannot be detected and remain safe only because of that rule. Before splitting a live home, ensure every installed host uses openShardStore; ordinary new MemoryStore opens are refused once the shard marker exists. No host capability registry is available to prove an absent host safe.";

interface ShardJournal {
  schema: typeof SHARDED_SCHEMA;
  generation: string;
  sourceGeneration?: string;
  phase: "captured" | "active";
  selectorRevision: string;
  sources: SourcePrefix[];
  machine: { id: string; label: string };
  legacyCommit?: string;
  deadLeasesRemoved?: DeadLeaseRemoval[];
}
export interface DeadLeaseRemoval { lease: string; at: string }
export interface ShardMigrationCounts { rows: number; skippedRows: number; byShard: Record<string, number>; userRows: number; byProject: Record<string, number>; tailBytes: number;
  legacyRows: number; generationRows: number; generationLocalRows: number; pruneRows: number; translatedPruneRows: number; refusedRows: number; sharedSupersededByPrivate: number; sharedSupersededByPrivateIds: string[]; crossPrivateReplacement: number; crossPrivateReplacementIds: string[]; danglingRows: number; danglingIds: string[]; legacyLocalRows: number; legacyMainRows: number }
export interface ShardMigrationResult { mode: ShardMigrationOptions["mode"]; generation: string; active: boolean; alreadyActive?: boolean; counts: ShardMigrationCounts; consequence: string; deadLeasesRemoved?: DeadLeaseRemoval[]; refusals?: string[] }
export interface ShardMigrationOptions {
  memoryDir: string;
  mode: "dry-run" | "apply" | "resume";
  generation?: string;
  authorizedPerson: boolean;
  tty: boolean;
  checkpoint?: (stage: "after-shard" | "before-active") => void | Promise<void>;
  /** Test seam: runs after the last preflight and reader admission, before the destination shard locks are taken. */
  beforeCapture?: () => void | Promise<void>;
}
interface Capture { segments: LegacySegment[]; sources: SourcePrefix[]; legacyCommit?: string; sourceGeneration?: string }
interface PruneTranslation { schema: "agent-mem.shard-prune-translation/v1"; sourceId: string; sourceHash: string; translatedId: string }
interface RoutedLine { id: string; line: string; source: string; path: string; end: number; local: boolean; destinations: Destination[]; translation?: PruneTranslation }
interface RoutePlan extends ShardMigrationCounts { lines: RoutedLine[]; destinations: Set<Destination> }

const changed = (): never => { throw new Error("shard migration source or selector changed; inspect local migration state before continuing"); };
const destinationDir = (memoryDir: string, destination: Destination) => destination === USER ? userShardDir(memoryDir) : shardDir(memoryDir, destination);
const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sourceKey = (source: string, path: string) => `${source}:${path}`;
const realmRoot = (dir: string, source: string) => source === "generation" ? dir : join(dir, source === "legacy-main" ? "legacy-main" : "legacy");
const emptyCounts = (): ShardMigrationCounts => ({ rows: 0, skippedRows: 0, byShard: {}, userRows: 0, byProject: {}, tailBytes: 0, legacyRows: 0, generationRows: 0, generationLocalRows: 0, pruneRows: 0, translatedPruneRows: 0, refusedRows: 0, sharedSupersededByPrivate: 0, sharedSupersededByPrivateIds: [], crossPrivateReplacement: 0, crossPrivateReplacementIds: [], danglingRows: 0, danglingIds: [], legacyLocalRows: 0, legacyMainRows: 0 });

function identity(memoryDir: string): { id: string; label: string } {
  const value = readProfileJSON(join(memoryDir, "machine.json"), 4096) as { id?: unknown; label?: unknown } | undefined;
  if (!value || typeof value.id !== "string" || !/^[a-f0-9]{16}$/.test(value.id) || typeof value.label !== "string") throw new Error("initialize a valid legacy machine identity before shard migration");
  return { id: value.id, label: value.label };
}

function readJournal(memoryDir: string, optional = false): ShardJournal | undefined {
  const value = readProfileJSON(join(memoryDir, JOURNAL)) as Partial<ShardJournal> | undefined;
  if (!value) {
    if (optional) return undefined;
    throw new Error("no resumable shard migration journal");
  }
  if (value.schema !== SHARDED_SCHEMA || !validGeneration(value.generation) || !["captured", "active"].includes(value.phase ?? "")
    || value.sourceGeneration !== undefined && (!validGeneration(value.sourceGeneration) || value.sourceGeneration !== value.generation)
    || typeof value.selectorRevision !== "string" || !Array.isArray(value.sources) || !value.machine
    || typeof value.machine.id !== "string" || typeof value.machine.label !== "string") throw new Error("invalid shard migration journal");
  if (value.deadLeasesRemoved !== undefined && (!Array.isArray(value.deadLeasesRemoved) || value.deadLeasesRemoved.length > 128 || value.deadLeasesRemoved.some(row =>
    !row || typeof row !== "object" || Object.keys(row).some(key => !["lease", "at"].includes(key)) || typeof row.lease !== "string" || !/^[1-9][0-9]*-[0-9a-f]{64}\.json$/.test(row.lease) ||
    typeof row.at !== "string" || Number.isNaN(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at))) throw new Error("invalid removed reader lease audit");
  return value as ShardJournal;
}

function capture(memoryDir: string, generation: string | undefined, previous?: ShardJournal, sourceGeneration?: string): Capture {
  const origin = sourceGeneration ?? previous?.sourceGeneration;
  const bridgeGeneration = origin ?? generation;
  const legacyCommit = bridgeGeneration ? legacyHead(memoryDir, bridgeGeneration) : undefined;
  const segments = readLegacySnapshot(memoryDir, {
    ...(bridgeGeneration ? { generation: bridgeGeneration } : {}), ...(legacyCommit ? { commit: legacyCommit } : {}),
    ...(bridgeGeneration && previous?.legacyCommit ? { previousCommit: previous.legacyCommit } : {}),
    ...(previous ? { checkpoints: previous.sources.filter(source => source.source !== "generation") } : {}),
  });
  if (origin) {
    validateGeneration(memoryDir, origin);
    const root = generationDir(memoryDir, origin), reader = new SegmentReader(), returned = new Set<string>();
    for (const folder of ["log", "local"]) {
      const dir = join(root, folder), stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) changed();
      for (const name of readdirSync(dir).sort().filter(name => name.endsWith(".jsonl"))) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) changed();
        const path = `${folder}/${name}`, prior = previous?.sources.find(source => source.source === "generation" && source.path === path);
        const data = reader.read(join(dir, name), prior, true);
        if (data.tailBytes) throw new Error("selected generation has an incomplete authored tail; finish its original recovery before shard migration");
        segments.push({ ...data, source: "generation", path, local: folder === "local" }); returned.add(path);
      }
    }
    for (const old of previous?.sources ?? []) if (old.source === "generation" && !returned.has(old.path)) changed();
  }
  return { segments, sources: segments.map(({ bytes: _bytes, local: _local, ...source }) => source), ...(legacyCommit ? { legacyCommit } : {}), ...(origin ? { sourceGeneration: origin } : {}) };
}

function* completeLines(segment: LegacySegment): Generator<{ line?: string; end: number }> {
  let offset = 0;
  while (offset < segment.bytes.length) {
    const end = segment.bytes.indexOf(10, offset);
    if (end < 0) changed();
    const raw = segment.bytes.subarray(offset, end); offset = end + 1;
    let line: string;
    try { line = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { if (segment.source === "generation") throw new Error("invalid selected generation entry"); yield { end: offset }; continue; }
    yield { line, end: offset };
  }
}

function route(captured: Capture, completed?: readonly SourcePrefix[], dryRun = false): RoutePlan {
  const legacy = legacyEntries(captured.segments.filter(segment => segment.source !== "generation"));
  const byId = new Map(legacy.map(row => [row.id, row])), snapshotRows = new Map<string, PruneSourceRow>();
  const occurrences: { row: Entry; line: string; end: number; segment: LegacySegment }[] = [];
  const vaultLinks: { row: VaultLinkRow; line: string; end: number; segment: LegacySegment }[] = [];
  const prunes: { row: PruneRow; line: string; end: number; segment: LegacySegment }[] = [];
  const completedBySource = new Map((completed ?? []).map(source => [sourceKey(source.source, source.path), source.offset]));
  const result = emptyCounts();
  for (const segment of captured.segments) for (const item of completeLines(segment)) {
    const isNew = item.end > (completedBySource.get(sourceKey(segment.source, segment.path)) ?? 0);
    if (item.line === undefined) { if (isNew) result.skippedRows++; continue; }
    if (!item.line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(item.line); } catch {
      if (segment.source === "generation") throw new Error("invalid selected generation entry");
      if (isNew) result.skippedRows++; continue;
    }
    if (segment.source === "generation" && value && typeof value === "object" && (value as { op?: unknown }).op === "prune") {
      const row = validatePruneRow(value, captured.sourceGeneration, segment.local ? "local" : "synced");
      if (segment.path !== `${segment.local ? "local" : "log"}/${row.machine}.jsonl`) throw new Error("selected generation prune placement mismatch");
      prunes.push({ row, line: item.line, end: item.end, segment }); continue;
    }
    if (segment.source === "generation" && value && typeof value === "object" && (value as { op?: unknown }).op === "vault_link") {
      const row = validateVaultLinkRow(value, captured.sourceGeneration, segment.local ? "local" : "synced");
      if (segment.path !== `local/${row.machine}.jsonl`) throw new Error("selected generation vault link placement mismatch");
      vaultLinks.push({ row, line: item.line, end: item.end, segment }); continue;
    }
    let row: Entry | undefined;
    if (segment.source === "generation") {
      const bytes = Buffer.from(item.line + "\n");
      row = legacyEntries([{ ...segment, bytes, offset: bytes.length, hash: hashBytes(bytes) }], { strict: true })[0];
      if (!row) throw new Error("invalid selected generation entry");
    } else {
      const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
      row = typeof id === "string" ? byId.get(id) : undefined;
      if (!row || canonicalJSON(value) !== canonicalJSON(row)) { if (isNew) result.skippedRows++; continue; }
    }
    snapshotRows.set(row.id, coalesceGenerationSource(snapshotRows.get(row.id), row, segment));
    byId.set(row.id, row); occurrences.push({ row, line: item.line, end: item.end, segment });
  }
  const entries = [...byId.values()], owners = new Map<string, Destination>();
  for (const row of entries) if (row.op === "note" || row.op === "goal") owners.set(row.id, row.scope === "shared" ? USER : row.project);
  const snapshot = { rows: [...snapshotRows.values()], expiries: explicitExpirySnapshot([...snapshotRows.values()]) };
  const proof = reducePruneRows(prunes.map(({ row, segment }) => ({ row, placement: segment.local ? "local" as const : "synced" as const })), snapshot, captured.sourceGeneration ?? "0".repeat(32));
  if (proof.invalid || proof.pending.length) {
    result.refusedRows += proof.invalid + proof.pending.length;
    if (!dryRun) throw new Error("selected generation prune proof is invalid or incomplete; no shard migration effects were applied");
  }
  const ordered = entries.toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const copies = new Map<string, string>(), descendants = new Map<string, string[]>();
  for (const row of ordered) if (row.op === "note" && row.promotedFrom) {
    copies.set(row.promotedFrom, row.id);
    const children = descendants.get(row.promotedFrom) ?? []; children.push(row.id); descendants.set(row.promotedFrom, children);
  }
  const lastCopy = (id: string): string => {
    const seen = new Set<string>(); let at = id;
    while (copies.has(at)) { if (seen.has(at)) throw new Error("cyclic promotion input; person inspection required"); seen.add(at); at = copies.get(at)!; }
    return at;
  };
  const promotionOwners = (id: string): Destination[] => {
    const seen = new Set<string>([id]), pending = [id], found = new Set<Destination>();
    for (let index = 0; index < pending.length; index++) {
      const at = pending[index]!, owner = owners.get(at); if (owner !== undefined) found.add(owner);
      for (const child of descendants.get(at) ?? []) { if (seen.has(child)) throw new Error("cyclic promotion input; person inspection required"); seen.add(child); pending.push(child); }
    }
    return [...found];
  };
  const forgotten = new Set(entries.flatMap(row => row.op === "forget" ? [row.target] : []));
  const gone = (id: string) => forgotten.has(id) || proof.targets.has(id) || (byId.get(id)?.op === "note" && forgotten.has((byId.get(id) as { promotedFrom?: string }).promotedFrom ?? ""));
  const replacements = new Map<string, { next: string; origin: Entry; when: string }>();
  const relate = (old: string, next: string, origin: Entry) => {
    const when = `${origin.at} ${next}`;
    if (when >= (replacements.get(old)?.when ?? "")) replacements.set(old, { next, origin, when });
  };
  for (const row of ordered) {
    if (row.op === "note" && row.supersedes) relate(row.supersedes, row.id, row);
    if (row.op === "supersede" && row.by) relate(row.target, row.by, row);
  }
  for (const [old, relation] of replacements) {
    const target = lastCopy(old), terminal = lastCopy(relation.next);
    if (gone(terminal) || !owners.has(target)) continue;
    // An embedded relation in another private body needs a witness even when its copy is shared.
    // Explicit supersede ops are safe metadata and follow promotion owners below.
    const visibleOrigin = relation.origin.op !== "note" || owners.get(relation.origin.id) === USER || owners.get(relation.origin.id) === owners.get(target);
    const equivalentOp = !visibleOrigin && entries.some(row => row.op === "supersede" && row.target === old && row.by && lastCopy(row.by) === terminal);
    const next = visibleOrigin || equivalentOp ? terminal : relation.next;
    if (!owners.has(next) && relation.origin.op === "supersede") continue; // IDs-only dangling metadata remains inert until its replacement arrives.
    if (!owners.has(next)) { result.refusedRows++; if (!dryRun) throw new Error("replacement terminal identity is unavailable; person inspection required"); continue; }
    if (owners.get(target) === owners.get(next) || owners.get(next) === USER) continue;
    // ponytail: a body-free lifecycle witness can remove this shared->private ceiling; never copy private replacement text.
    // Expiry without an immutable forget/prune observation stays conservatively live here.
    result.refusedRows++;
    if (owners.get(target) === USER) {
      result.sharedSupersededByPrivateIds.push(target);
      if (!dryRun) throw new Error(`shared superseded by private (${target}); un-supersede, or promote the replacement to shared, then rerun shard migration`);
    } else {
      result.crossPrivateReplacementIds.push(target);
      if (!dryRun) throw new Error(`cross-project private replacement (${target}); un-supersede, or promote the replacement to shared, then rerun shard migration`);
    }
  }
  result.sharedSupersededByPrivateIds = [...new Set(result.sharedSupersededByPrivateIds)].sort(); result.sharedSupersededByPrivate = result.sharedSupersededByPrivateIds.length;
  result.crossPrivateReplacementIds = [...new Set(result.crossPrivateReplacementIds)].sort(); result.crossPrivateReplacement = result.crossPrivateReplacementIds.length;
  const suggestions = new Map<string, Destination[]>(), dangling = new Set<string>();
  const carryDangling = (row: Entry, known: Destination[] = []): Destination[] => {
    dangling.add(row.id); return [...new Set<Destination>([USER, ...known])];
  };
  const destinationsOf = (row: Entry): Destination[] => {
    if (row.op === "note" || row.op === "goal") return [owners.get(row.id)!];
    if (row.op === "settle") {
      const project = row.target.split("#", 1)[0];
      if (!project) return carryDangling(row);
      return [...new Set<Destination>([project, ...entries.filter(entry => entry.op === "note" && entry.task === row.target).map(entry => owners.get(entry.id)!)])];
    }
    if (row.op === "suggest") {
      const split = row.by?.indexOf(":") ?? -1, to = split < 0 ? "" : row.by!.slice(split + 1);
      const from = owners.get(row.target), other = owners.get(to);
      const destinations = from === undefined || other === undefined ? carryDangling(row, [from, other].filter((value): value is Destination => value !== undefined)) : [...new Set<Destination>([from, other])];
      suggestions.set(row.id, destinations); return destinations;
    }
    if (row.op === "confirm" || row.op === "reject") {
      const destinations = suggestions.get(row.target);
      if (!destinations) return carryDangling(row);
      return destinations;
    }
    const owner = owners.get(row.target);
    if (owner === undefined) return carryDangling(row);
    if (row.op === "supersede" && row.by && !owners.has(lastCopy(row.by))) return carryDangling(row, promotionOwners(row.target));
    return row.op === "forget" || row.op === "supersede" ? promotionOwners(row.target) : [owner];
  };
  for (const row of entries) if (row.op === "suggest") destinationsOf(row);
  const destinations = new Set<Destination>([USER, ...owners.values()]), lines: RoutedLine[] = [];
  for (const { row, line, end, segment } of occurrences) {
    const targets = destinationsOf(row); for (const target of targets) destinations.add(target);
    if (end <= (completedBySource.get(sourceKey(segment.source, segment.path)) ?? 0)) continue;
    lines.push({ id: row.id, line, source: segment.source, path: segment.path, end, local: segment.local, destinations: targets });
    if (segment.source === "generation") { result.generationRows++; if (segment.local) result.generationLocalRows++; }
    else { result.legacyRows++; if (segment.source === "legacy-main") result.legacyMainRows++; else result.legacyLocalRows++; }
  }
  result.pruneRows = prunes.filter(input => input.end > (completedBySource.get(sourceKey(input.segment.source, input.segment.path)) ?? 0)).length;
  for (const input of proof.invalid || proof.pending.length ? [] : prunes) {
    const groups = new Map<Destination, PruneRow["targets"]>();
    for (const target of input.row.targets) {
      const destination = owners.get(target.id);
      if (destination === undefined) throw new Error("prune target has no shard owner");
      const group = groups.get(destination) ?? []; group.push(target); groups.set(destination, group);
    }
    for (const [destination, targets] of groups) {
      destinations.add(destination);
      const { id: _id, ...body } = input.row;
      const row = groups.size === 1 ? input.row : { ...body, targets, id: pruneId({ ...body, targets }) };
      validatePruneRow(row, captured.sourceGeneration, input.segment.local ? "local" : "synced");
      const subset = snapshot.rows.filter(source => destinationsOf(source.row).includes(destination));
      const translatedProof = reducePruneRows([{ row, placement: input.segment.local ? "local" : "synced" }], { rows: subset, expiries: explicitExpirySnapshot(subset) }, input.row.generation);
      if (translatedProof.invalid || translatedProof.pending.length) throw new Error("per-shard prune proof is incomplete; no shard migration effects were applied");
      if (input.end <= (completedBySource.get(sourceKey(input.segment.source, input.segment.path)) ?? 0)) continue;
      lines.push({ id: row.id, line: groups.size === 1 ? input.line : canonicalJSON(row), source: "generation", path: input.segment.path, end: input.end, local: input.segment.local, destinations: [destination],
        ...(groups.size > 1 ? { translation: { schema: "agent-mem.shard-prune-translation/v1" as const, sourceId: input.row.id, sourceHash: prunePayloadHash(input.row), translatedId: row.id } } : {}) });
      if (groups.size > 1) result.translatedPruneRows++;
    }
  }
  for (const input of vaultLinks) {
    const witness = byId.get(input.row.target), destination = owners.get(input.row.target);
    if (!witness || witness.op !== "note" || witness.project !== input.row.project || hashJSON(witness) !== input.row.rowHash || destination === undefined) throw new Error("vault link exact target has no shard witness");
    destinations.add(destination);
    if (input.end <= (completedBySource.get(sourceKey(input.segment.source, input.segment.path)) ?? 0)) continue;
    lines.push({ id: input.row.id, line: input.line, source: "generation", path: input.segment.path, end: input.end, local: true, destinations: [destination] });
    result.generationRows++; result.generationLocalRows++;
  }
  result.danglingIds = [...dangling].sort(); result.danglingRows = dangling.size;
  const ordering = new Map(captured.segments.map((segment, index) => [sourceKey(segment.source, segment.path), index]));
  lines.sort((a, b) => ordering.get(sourceKey(a.source, a.path))! - ordering.get(sourceKey(b.source, b.path))! || a.end - b.end);
  const increment = (record: Record<string, number>, key: string) => Object.defineProperty(record, key, { value: (Object.hasOwn(record, key) ? record[key]! : 0) + 1, enumerable: true, writable: true, configurable: true });
  for (const line of lines) for (const destination of line.destinations) { increment(result.byShard, destination === USER ? "user" : destination); if (destination === USER) result.userRows++; else increment(result.byProject, destination); }
  return { ...result, lines, destinations, rows: lines.length, tailBytes: captured.sources.reduce((sum, source) => sum + source.tailBytes, 0) };
}

function prepareShard(memoryDir: string, destination: Destination, generation: string, machine: { id: string; label: string }): string {
  const dir = destinationDir(memoryDir, destination);
  if (destination !== USER) ensureShardDescriptor(memoryDir, destination);
  for (const folder of ["log", "local", "legacy/log", "legacy/local", "legacy-main/log", "legacy-main/local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
  for (const [path, value] of [["generation.json", generationDescriptor(generation)], ["machine.json", machine], ["legacy/machine.json", machine], ["legacy-main/machine.json", machine]] as const) {
    const file = join(dir, path), prior = readProfileJSON(file);
    if (prior === undefined) writeProfileJSON(file, value);
    else if (path === "generation.json" ? canonicalJSON(prior) !== canonicalJSON(value) : (prior as { id?: unknown }).id !== machine.id) changed();
  }
  return dir;
}

/** An interrupted mkdir may precede machine.json; only byte-empty, regular segments lack provenance safely. */
function copiedBridge(root: string): LegacySegment[] {
  const refused = (): never => { throw new Error("copied bridge identity is unavailable; inspect its original initialization or writer recovery before resuming"); };
  const dir = lstatSync(root, { throwIfNoEntry: false });
  if (!dir) return [];
  if (dir.isSymbolicLink() || !dir.isDirectory()) return refused();
  const machine = lstatSync(join(root, "machine.json"), { throwIfNoEntry: false });
  if (machine) {
    if (machine.isSymbolicLink() || !machine.isFile()) return refused();
    return readLegacySnapshot(root);
  }
  for (const name of readdirSync(root)) {
    if (name !== "log" && name !== "local") return refused();
    const folder = join(root, name), stat = lstatSync(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return refused();
    for (const file of readdirSync(folder)) {
      const path = join(folder, file), entry = lstatSync(path);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(file) || entry.isSymbolicLink() || !entry.isFile() || entry.size !== 0) return refused();
    }
  }
  return [];
}

function existingRows(dir: string, generation: string): { ids: Map<string, Set<string>>; tails: Map<string, Buffer> } {
  const ids = new Map<string, Set<string>>(), tails = new Map<string, Buffer>();
  const legacy = copiedBridge(join(dir, "legacy"));
  const main = copiedBridge(join(dir, "legacy-main")).map(segment => ({ ...segment, source: "legacy-main" }));
  const own: LegacySegment[] = [], reader = new SegmentReader();
  for (const folder of ["log", "local"]) for (const name of (existsSync(join(dir, folder)) ? readdirSync(join(dir, folder)) : []).sort().filter(name => name.endsWith(".jsonl"))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) changed();
    own.push({ ...reader.read(join(dir, folder, name), undefined, true), source: "generation", path: `${folder}/${name}`, local: folder === "local" });
  }
  for (const segment of [...legacy, ...main, ...own]) {
    const key = sourceKey(segment.source, segment.path), known = new Set<string>();
    for (const item of completeLines(segment)) {
      if (item.line === undefined) throw new Error("copied shard input is not valid UTF-8");
      if (!item.line.trim()) continue;
      const value = JSON.parse(item.line) as { op?: unknown; id?: unknown };
      if (segment.source === "generation" && value.op === "prune") known.add(validatePruneRow(value, generation, segment.local ? "local" : "synced").id);
      else if (segment.source === "generation" && value.op === "vault_link") known.add(validateVaultLinkRow(value, generation, segment.local ? "local" : "synced").id);
      else {
        const bytes = Buffer.from(item.line + "\n");
        const row = legacyEntries([{ ...segment, bytes, offset: bytes.length, hash: hashBytes(bytes) }], { strict: segment.source === "generation" })[0];
        if (row) known.add(row.id);
      }
    }
    ids.set(key, known);
    if (segment.tailBytes) tails.set(key, readFileSync(join(realmRoot(dir, segment.source), segment.path)).subarray(segment.offset));
  }
  return { ids, tails };
}

/** Read-only append plan shared by preflight and the eventual receipt writer. */
function receiptRemainder(dir: string, receipts: readonly PruneTranslation[]): Buffer {
  const path = join(dir, "prune-translations.jsonl"), bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const end = bytes.lastIndexOf(10) + 1, complete = bytes.subarray(0, end), tail = bytes.subarray(end);
  const known = new Map<string, PruneTranslation>();
  for (const line of new TextDecoder("utf-8", { fatal: true }).decode(complete).split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as PruneTranslation;
    if (row.schema !== "agent-mem.shard-prune-translation/v1" || !/^[a-f0-9]{32}$/.test(row.sourceId) || !/^[a-f0-9]{32}$/.test(row.translatedId) || !/^[a-f0-9]{64}$/.test(row.sourceHash)) throw new Error("invalid shard prune translation receipt; inspect its original recovery");
    const prior = known.get(row.translatedId); if (prior && canonicalJSON(prior) !== canonicalJSON(row)) changed();
    known.set(row.translatedId, row);
  }
  const pending: Buffer[] = [];
  for (const receipt of receipts) {
    const prior = known.get(receipt.translatedId);
    if (prior) { if (canonicalJSON(prior) !== canonicalJSON(receipt)) changed(); continue; }
    pending.push(Buffer.from(canonicalJSON(receipt) + "\n")); known.set(receipt.translatedId, receipt);
  }
  if (tail.length && (!pending[0] || tail.length >= pending[0].length || !pending[0].subarray(0, tail.length).equals(tail))) throw new Error("shard prune translation receipt tail does not match; inspect its original recovery before resuming");
  return Buffer.concat(pending).subarray(tail.length);
}

/** #176 R2: the person-run recovery for a shard file whose last row a crashed writer left unfinished (docs/curated-shard-migration.md). */
const tornTail = (memoryDir: string, file: string) => `curated shard copied tail cannot be completed at ${relative(memoryDir, file)}: a writer stopped mid-row. Recover by hand: stop every amem and agent-hub process using this memory home, keep a copy of the file, cut it back to its last newline (the cut bytes are an unfinished row no reader has indexed), then run amem migrate --shards --resume`;

function assessDestination(memoryDir: string, destination: Destination, plan: RoutePlan, generation: string, machine: { id: string; label: string }) {
  const dir = destinationDir(memoryDir, destination);
  for (const [path, value] of [["generation.json", generationDescriptor(generation)], ["machine.json", machine], ["legacy/machine.json", machine], ["legacy-main/machine.json", machine]] as const) {
    const prior = readProfileJSON(join(dir, path));
    if (prior !== undefined && (path === "generation.json" ? canonicalJSON(prior) !== canonicalJSON(value) : (prior as { id?: unknown }).id !== machine.id)) changed();
  }
  if (destination !== USER) {
    const descriptor = readProfileJSON(join(dir, "project.json")) as { schema?: unknown; key?: unknown; local?: unknown } | undefined;
    if (descriptor && (descriptor.schema !== SHARD_SCHEMA || descriptor.key !== destination || typeof descriptor.local !== "boolean")) changed();
  }
  const existing = existingRows(dir, generation), completions = new Map<string, { line: RoutedLine; remainder: Buffer }>();
  const lines = plan.lines.filter(line => line.destinations.includes(destination));
  for (const [key, tail] of existing.tails) {
    const next = lines.find(line => sourceKey(line.source, line.path) === key && !existing.ids.get(key)?.has(line.id));
    // A native writer's unrelated tail is not a migration-owned append or recovery record.
    if (!next && key.startsWith("generation:")) continue;
    const bytes = next && Buffer.from(next.line + "\n");
    if (!bytes || tail.length >= bytes.length || !bytes.subarray(0, tail.length).equals(tail)) throw new Error(tornTail(memoryDir, join(realmRoot(dir, key.slice(0, key.indexOf(":"))), key.slice(key.indexOf(":") + 1))));
    completions.set(key, { line: next!, remainder: bytes.subarray(tail.length) });
  }
  const receiptBytes = receiptRemainder(dir, lines.flatMap(line => line.translation ? [line.translation] : []));
  return { existing, completions, receiptBytes };
}

function writeRoutes(memoryDir: string, plan: RoutePlan, generation: string, machine: { id: string; label: string }): Set<Destination> {
  const affected = new Set<Destination>();
  for (const destination of plan.destinations) {
    const assessed = assessDestination(memoryDir, destination, plan, generation, machine);
    const dir = prepareShard(memoryDir, destination, generation, machine), { existing } = assessed;
    if (!existsSync(join(dir, "generation-seal.json"))) affected.add(destination);
    for (const [key, completion] of assessed.completions) {
      const line = completion.line;
      appendFileSync(join(realmRoot(dir, line.source), line.path), completion.remainder, { mode: 0o600 });
      if (!existing.ids.has(key)) existing.ids.set(key, new Set()); existing.ids.get(key)!.add(line.id); affected.add(destination);
    }
    for (const line of plan.lines) {
      if (!line.destinations.includes(destination)) continue;
      const key = sourceKey(line.source, line.path);
      if (!existing.ids.get(key)?.has(line.id)) {
        const target = join(realmRoot(dir, line.source), line.path);
        if (existsSync(target)) { const current = readFileSync(target); if (current.length && current.at(-1) !== 10) throw new Error(tornTail(memoryDir, target)); }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); appendFileSync(target, line.line + "\n", { mode: 0o600 });
        if (!existing.ids.has(key)) existing.ids.set(key, new Set()); existing.ids.get(key)!.add(line.id); affected.add(destination);
      }
    }
    if (assessed.receiptBytes.length) appendFileSync(join(dir, "prune-translations.jsonl"), assessed.receiptBytes, { mode: 0o600 });
  }
  return affected;
}

/** Each destination shard's own writer lock, taken in a fixed order; a busy one refuses before any journal change. */
function lockDestinations(memoryDir: string, destinations: Iterable<Destination>): () => void {
  const releases: (() => void)[] = [];
  const releaseAll = () => { for (const release of releases.splice(0).reverse()) release(); };
  try {
    for (const dir of [...destinations].map(destination => destinationDir(memoryDir, destination)).sort()) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const release = acquireMutation(dir);
      if (!release) throw new Error("curated shard writer lock is busy; retry the shard migration once that writer finishes");
      releases.push(release);
    }
  } catch (error) { releaseAll(); throw error; }
  return releaseAll;
}

function buildShard(memoryDir: string, destination: Destination, generation: string, selectorRevision: string): void {
  const dir = destinationDir(memoryDir, destination), legacyHome = join(dir, "legacy"), legacyMainHome = join(dir, "legacy-main");
  const sources = [...readMigrationSources(legacyHome), ...readMigrationSources(legacyMainHome).map(source => ({ ...source, source: "legacy-main" }))];
  writeProfileJSON(join(dir, "migration-sources.json"), { schema: "agent-mem.migration-sources/v1", sources });
  const profile: BoundProfile = { kind: "generation", home: memoryDir, dir, generation, selectorRevision,
    legacyHome, legacyMainHome, sharded: true, ...(destination === USER ? { shardUser: true } : { shardKey: destination }) };
  buildGenerationIndex(profile, sources);
  writeProfileJSON(join(dir, "generation-seal.json"), { schema: "agent-mem.generation-seal/v1", generation,
    descriptorHash: hashJSON(generationDescriptor(generation)), sourceDigest: hashJSON({ sources, legacyCommit: undefined }) });
}

function counts(plan: RoutePlan): ShardMigrationCounts {
  const { lines: _lines, destinations: _destinations, ...value } = plan; return value;
}
const refusalSummary = (value: ShardMigrationCounts) => {
  const refusals = [...(value.sharedSupersededByPrivate ? [`shared superseded by private: ${value.sharedSupersededByPrivate}`] : []), ...(value.crossPrivateReplacement ? [`cross-project private replacement: ${value.crossPrivateReplacement}; un-supersede, or promote the replacement to shared, then rerun`] : [])];
  return refusals.length ? { refusals } : {};
};
const removalEvidence = (journal: ShardJournal | undefined) => journal?.deadLeasesRemoved?.length ? { deadLeasesRemoved: journal.deadLeasesRemoved } : {};

export function shardMigrationStatus(memoryDir: string): { active: boolean; generation?: string; phase?: "captured" | "active"; pending: ShardMigrationCounts; deadLeasesRemoved?: DeadLeaseRemoval[]; refusals?: string[] } {
  const dir = existsSync(memoryDir) ? realPath(memoryDir) : canonicalPath(memoryDir), journal = readJournal(dir, true);
  if (!journal) return { active: false, pending: emptyCounts() };
  const plan = route(capture(dir, journal.generation, journal), journal.sources, true);
  return { active: journal.phase === "active", phase: journal.phase, generation: journal.generation, pending: counts(plan), ...refusalSummary(plan), ...removalEvidence(journal) };
}

function preflight(memoryDir: string, options: ShardMigrationOptions, chosen?: string, dryRun = false) {
  const selection = readSelector(memoryDir), previous = readJournal(memoryDir, true), machine = identity(memoryDir);
  if (options.mode === "resume" && !previous) throw new Error("no resumable shard migration journal");
  if (previous && previous.selectorRevision !== selection.revision) changed();
  const selected = selection.selector?.kind === "generation" ? selection.selector.generation : undefined;
  const sourceGeneration = previous?.sourceGeneration ?? selected;
  const generation = options.generation ?? previous?.generation ?? chosen ?? selected ?? randomBytes(16).toString("hex");
  if (previous && generation !== previous.generation || sourceGeneration && generation !== sourceGeneration) changed();
  const captured = capture(memoryDir, generation, previous, sourceGeneration), plan = route(captured, previous?.sources, dryRun);
  const regular = (path: string) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("shard migration planned path is not a regular file");
  };
  for (const segment of captured.segments) {
    const source = segment.source === "generation" ? join(generationDir(memoryDir, sourceGeneration!), segment.path)
      : segment.source === "legacy-main" ? join(generationDir(memoryDir, sourceGeneration ?? generation), "bridge-snapshots", segment.commit!, segment.path) : join(memoryDir, segment.path);
    regular(source);
  }
  for (const destination of plan.destinations) {
    assertCuratedShardPaths(memoryDir, destination === USER ? { user: true } : { project: destination });
    const dir = destinationDir(memoryDir, destination);
    regular(join(dir, "prune-translations.jsonl"));
    for (const line of plan.lines) if (line.destinations.includes(destination)) regular(join(realmRoot(dir, line.source), line.path));
    assessDestination(memoryDir, destination, plan, generation, machine);
  }
  return { selection, previous, machine, generation, captured, plan, sourceGeneration };
}

export async function migrateShards(options: ShardMigrationOptions): Promise<ShardMigrationResult> {
  if (options.authorizedPerson !== true || options.tty !== true) throw new Error("shard migration requires an authorized person in a terminal");
  if (!["dry-run", "apply", "resume"].includes(options.mode) || options.generation !== undefined && !validGeneration(options.generation)) throw new Error("invalid shard migration request");
  const memoryDir = existsSync(options.memoryDir) ? realPath(options.memoryDir) : canonicalPath(options.memoryDir);
  // Validate every immutable prune and routing decision before even a profile/mutation lock creates metadata.
  const initial = preflight(memoryDir, options, undefined, options.mode === "dry-run");
  if (options.mode === "dry-run") return { mode: options.mode, generation: initial.generation, active: initial.previous?.phase === "active", counts: counts(initial.plan), ...refusalSummary(initial.plan), consequence: CONSEQUENCE, ...removalEvidence(initial.previous) };
  return withProfileLock(memoryDir, async () => {
    const release = acquireMutation(memoryDir);
    if (!release) throw new Error("legacy mutation lock is busy");
    let releaseOwn: (() => void) | undefined;
    let checked: ReturnType<typeof preflight>;
    try {
      if (initial.sourceGeneration) {
        releaseOwn = acquireMutation(generationDir(memoryDir, initial.sourceGeneration));
        if (!releaseOwn) throw new Error("selected generation mutation lock is busy");
      }
      checked = preflight(memoryDir, options, initial.generation);
      if (checked.selection.revision !== initial.selection.revision || checked.machine.id !== initial.machine.id) changed();
    } finally { releaseOwn?.(); release(); }
    const { machine, selection, previous, generation, captured, plan, sourceGeneration } = checked!;
    const journal: ShardJournal = previous ?? { schema: SHARDED_SCHEMA, generation, ...(sourceGeneration ? { sourceGeneration } : {}), phase: "captured", selectorRevision: selection.revision, sources: [], machine };
    const persist = () => writeProfileJSON(join(memoryDir, JOURNAL), journal);
    const admission = () => assertNoLiveReaders(memoryDir, { onDeadLeaseRemoved: ({ lease }) => {
      if (!/^[1-9][0-9]*-[0-9a-f]{64}\.json$/.test(lease)) throw new Error("invalid removed reader lease evidence");
      if (journal.deadLeasesRemoved?.some(row => row.lease === lease)) return;
      journal.deadLeasesRemoved = [...(journal.deadLeasesRemoved ?? []), { lease, at: new Date().toISOString() }].slice(-128);
      persist(); // Positive cleanup remains visible even if a later lease refuses this migration.
    } });
    admission();
    if (options.beforeCapture) await options.beforeCapture();
    const alreadyActive = journal.phase === "active" && plan.lines.length === 0;
    // Existing source checkpoints stay committed only after all affected shards are sealed.
    // A resumed active split must stop serving reads before the first copied append.
    // #176 R1: a shard writer that crashed after preflight could leave a partial row in a file the copy appends to,
    // and writeRoutes would refuse only after the journal says captured. Hold every destination's writer lock from a
    // last tail check through the copy, so that check is what the copy sees. Released before buildShard, which opens
    // its own store; captured already fences shard writers by then. The post-captured tail check in writeRoutes stays
    // reachable only by writers that bypass both this lock and the reader lease (the mutation.ts ponytail ceiling).
    const releaseShards = lockDestinations(memoryDir, plan.destinations);
    let affected: Set<Destination>;
    try {
      for (const destination of plan.destinations) assessDestination(memoryDir, destination, plan, generation, machine);
      if (!alreadyActive) journal.phase = "captured";
      persist();
      affected = writeRoutes(memoryDir, plan, generation, machine);
    } finally { releaseShards(); }
    for (const destination of affected) {
      buildShard(memoryDir, destination, generation, selection.revision);
      if (options.checkpoint) await options.checkpoint("after-shard");
    }
    admission();
    if (options.checkpoint) await options.checkpoint("before-active");
    journal.phase = "active"; journal.sources = captured.sources;
    if (captured.legacyCommit) journal.legacyCommit = captured.legacyCommit;
    persist();
    return { mode: options.mode, generation, active: true, ...(alreadyActive ? { alreadyActive: true } : {}), counts: counts(plan), ...refusalSummary(plan), consequence: CONSEQUENCE, ...removalEvidence(journal) };
  });
}

/** Render a shard migration result for a person; JSON output remains owned by the CLI. */
export function shardMigrationText(result: ShardMigrationResult, s: Style = PLAIN): string {
  const counts = result.counts;
  const groupRows = (name: string, value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${label(s, "ok")} ${name} ${singleLine(key)} ${count}`);
  const countRows = [
    ["rows", counts.rows], ["skipped", counts.skippedRows], ["userRows", counts.userRows], ["tailBytes", counts.tailBytes],
    ["legacyRows", counts.legacyRows], ["generationRows", counts.generationRows], ["generationLocalRows", counts.generationLocalRows],
    ["legacyLocalRows", counts.legacyLocalRows], ["legacyMainRows", counts.legacyMainRows], ["pruneRows", counts.pruneRows],
    ["translatedPruneRows", counts.translatedPruneRows], ["refusedRows", counts.refusedRows],
    ["sharedSupersededByPrivate", counts.sharedSupersededByPrivate], ["crossPrivateReplacement", counts.crossPrivateReplacement],
    ["danglingRows", counts.danglingRows],
  ].map(([key, value]) => {
    const flagged = key === "refusedRows" && counts.refusedRows > 0 || key === "sharedSupersededByPrivate" && counts.sharedSupersededByPrivate > 0
      || key === "crossPrivateReplacement" && counts.crossPrivateReplacement > 0 || key === "danglingRows" && counts.danglingRows > 0;
    return `${label(s, flagged ? "attention" : "ok")} ${key} ${value}`;
  });
  const warnings = result.refusals ?? [];
  const attention = warnings.length > 0 || counts.refusedRows > 0 || counts.danglingRows > 0 || (!result.active && result.mode === "resume");
  const state = attention ? "attention" : result.mode === "dry-run" ? "preview" : result.active ? "complete" : "attention";
  const action = warnings.length || counts.refusedRows > 0 || counts.danglingRows > 0 ? "resolve the listed refusals or flagged rows before retrying"
    : result.mode === "dry-run" && (!result.active || counts.rows > 0) ? "apply shard migration: amem migrate --shards --apply"
    : result.mode === "resume" && !result.active ? "resume shard migration: amem migrate --shards --resume"
      : "none";
  return [
    `${s.bold("amem migrate --shards:")} ${state}${result.alreadyActive ? " (already active)" : ""}`,
    `${label(s, "ok")} generation ${result.generation.slice(0, 8)}`,
    ...countRows,
    ...groupRows("shard rows", counts.byShard),
    ...groupRows("project rows", counts.byProject),
    ...(result.deadLeasesRemoved?.length ? [`${label(s, "ok")} dead reader leases removed ${result.deadLeasesRemoved.length}`] : []),
    ...(warnings.length ? ["Refusals:", ...warnings.map(reason => `  ${label(s, "attention")} ${singleLine(reason)}`)] : []),
    `${label(s, "ok")} effect ${singleLine(result.consequence)}`,
    `Next action: ${action}`,
  ].join("\n");
}
