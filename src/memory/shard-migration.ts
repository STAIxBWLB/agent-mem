import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { legacyEntries, legacyHead, readLegacySnapshot, type LegacySegment } from "./bridge.ts";
import { canonicalJSON, generationDescriptor, hashJSON, readProfileJSON, readSelector, validGeneration, withProfileLock, writeProfileJSON, type BoundProfile } from "./generation.ts";
import { acquireMutation } from "./mutation.ts";
import { canonicalPath, realPath } from "./platform.ts";
import { assertNoLiveReaders } from "./reader-lease.ts";
import { ensureShardDescriptor, shardDir, SHARDED_SCHEMA, userShardDir } from "./shard.ts";
import { buildGenerationIndex, type Entry } from "./store.ts";
import { readMigrationSources, type SourcePrefix } from "./migrate.ts";

const USER = "user";
const JOURNAL = "shards.json";
const CONSEQUENCE = "Legacy bytes are never rewritten; unannounced older readers cannot be detected and remain safe only because of that rule.";

interface ShardJournal {
  schema: typeof SHARDED_SCHEMA;
  generation: string;
  phase: "captured" | "active";
  selectorRevision: string;
  sources: SourcePrefix[];
  machine: { id: string; label: string };
  legacyCommit?: string;
}
export interface ShardMigrationCounts { rows: number; skippedRows: number; byShard: Record<string, number>; tailBytes: number }
export interface ShardMigrationResult { mode: ShardMigrationOptions["mode"]; generation: string; active: boolean; alreadyActive?: boolean; counts: ShardMigrationCounts; consequence: string }
export interface ShardMigrationOptions {
  memoryDir: string;
  mode: "dry-run" | "apply" | "resume";
  generation?: string;
  authorizedPerson: boolean;
  tty: boolean;
  checkpoint?: (stage: "after-shard" | "before-active") => void | Promise<void>;
}
interface Capture { segments: LegacySegment[]; sources: SourcePrefix[]; legacyCommit?: string }
interface RoutedLine { id: string; line: string; path: string; local: boolean; destinations: string[] }
interface RoutePlan extends ShardMigrationCounts { lines: RoutedLine[]; destinations: Set<string> }

const changed = (): never => { throw new Error("shard migration source or selector changed; inspect local migration state before continuing"); };
const destinationDir = (memoryDir: string, destination: string) => destination === USER ? userShardDir(memoryDir) : shardDir(memoryDir, destination);
const sourceKey = (source: string, path: string) => `${source}:${path}`;

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
    || typeof value.selectorRevision !== "string" || !Array.isArray(value.sources) || !value.machine
    || typeof value.machine.id !== "string" || typeof value.machine.label !== "string") throw new Error("invalid shard migration journal");
  return value as ShardJournal;
}

function capture(memoryDir: string, generation: string | undefined, previous?: ShardJournal): Capture {
  const legacyCommit = generation ? legacyHead(memoryDir, generation) : undefined;
  const segments = readLegacySnapshot(memoryDir, {
    ...(generation ? { generation } : {}), ...(legacyCommit ? { commit: legacyCommit } : {}),
    ...(generation && previous?.legacyCommit ? { previousCommit: previous.legacyCommit } : {}),
    ...(previous ? { checkpoints: previous.sources } : {}),
  });
  return { segments, sources: segments.map(({ bytes: _bytes, local: _local, ...source }) => source), ...(legacyCommit ? { legacyCommit } : {}) };
}

function route(capture: Capture, completed?: readonly SourcePrefix[]): RoutePlan {
  const entries = legacyEntries(capture.segments), byId = new Map(entries.map((row) => [row.id, row]));
  const owners = new Map<string, string>();
  for (const row of entries) if (row.op === "note" || row.op === "goal") owners.set(row.id, row.scope === "shared" ? USER : row.project);
  const suggestions = new Map<string, string[]>();
  const destinationsOf = (row: Entry): string[] => {
    if (row.op === "note" || row.op === "goal") return [owners.get(row.id)!];
    if (row.op === "settle") {
      const project = row.target.split("#", 1)[0];
      if (!project) throw new Error(`cannot route legacy settlement ${row.id}`);
      return [project];
    }
    if (row.op === "suggest") {
      const split = row.by?.indexOf(":") ?? -1, to = split < 0 ? "" : row.by!.slice(split + 1);
      const from = owners.get(row.target), other = owners.get(to);
      if (!from || !other) throw new Error(`cannot route legacy suggestion ${row.id}`);
      const destinations = [...new Set([from, other])];
      suggestions.set(row.id, destinations);
      return destinations;
    }
    if (row.op === "confirm" || row.op === "reject") {
      const destinations = suggestions.get(row.target);
      if (!destinations) throw new Error(`cannot route legacy suggestion verdict ${row.id}`);
      return destinations;
    }
    const owner = owners.get(row.target);
    if (!owner) throw new Error(`cannot route legacy ${row.op} ${row.id}: its target is absent`);
    return [owner];
  };
  // Verdicts can precede their suggestion in segment order: index all suggestion destinations before routing any row.
  for (const row of entries) if (row.op === "suggest") destinationsOf(row);

  const completedBySource = new Map((completed ?? []).map((source) => [sourceKey(source.source, source.path), source.offset]));
  const lines: RoutedLine[] = [], destinations = new Set(owners.values());
  let skippedRows = 0;
  for (const segment of capture.segments) {
    const completeBefore = completedBySource.get(sourceKey(segment.source, segment.path)) ?? 0;
    let offset = 0;
    for (const bytes of segment.bytes.toString("utf8").split("\n").filter(Boolean)) {
      const end = offset + Buffer.byteLength(bytes) + 1;
      offset = end;
      if (end <= completeBefore) continue;
      let id = "";
      try { id = String((JSON.parse(bytes) as { id?: unknown }).id ?? ""); } catch { skippedRows++; continue; }
      const row = byId.get(id);
      if (!row) { skippedRows++; continue; }
      const rowDestinations = destinationsOf(row);
      for (const destination of rowDestinations) destinations.add(destination);
      lines.push({ id, line: bytes, path: segment.path, local: segment.local, destinations: rowDestinations });
    }
  }
  const byShard: Record<string, number> = {};
  for (const line of lines) for (const destination of line.destinations) byShard[destination] = (byShard[destination] ?? 0) + 1;
  return { lines, destinations, rows: lines.length, skippedRows, byShard, tailBytes: capture.sources.reduce((sum, source) => sum + source.tailBytes, 0) };
}

function prepareShard(memoryDir: string, destination: string, generation: string, machine: { id: string; label: string }): string {
  const dir = destinationDir(memoryDir, destination);
  if (destination !== USER) ensureShardDescriptor(memoryDir, destination);
  for (const folder of ["log", "local", "legacy/log", "legacy/local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
  for (const [path, value] of [["generation.json", generationDescriptor(generation)], ["machine.json", machine], ["legacy/machine.json", machine]] as const) {
    const file = join(dir, path), prior = readProfileJSON(file);
    if (prior === undefined) writeProfileJSON(file, value);
    else if (canonicalJSON(prior) !== canonicalJSON(value)) changed();
  }
  return dir;
}

function existingIds(dir: string): Set<string> {
  return new Set(legacyEntries(readLegacySnapshot(join(dir, "legacy"))).map((row) => row.id));
}

function writeRoutes(memoryDir: string, plan: RoutePlan, generation: string, machine: { id: string; label: string }): Set<string> {
  const affected = new Set<string>();
  for (const destination of plan.destinations) {
    const dir = prepareShard(memoryDir, destination, generation, machine);
    const existing = existingIds(dir);
    if (!existsSync(join(dir, "generation-seal.json"))) affected.add(destination);
    for (const line of plan.lines) {
      if (!line.destinations.includes(destination) || existing.has(line.id)) continue;
      const target = join(dir, "legacy", line.path);
      if (existsSync(target)) {
        const current = readFileSync(target);
        if (current.length && current.at(-1) !== 10) throw new Error(`curated shard legacy tail is incomplete: ${target}`);
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      appendFileSync(target, line.line + "\n", { mode: 0o600 });
      existing.add(line.id);
      affected.add(destination);
    }
  }
  return affected;
}

function buildShard(memoryDir: string, destination: string, generation: string, selectorRevision: string): void {
  const dir = destinationDir(memoryDir, destination), legacyHome = join(dir, "legacy");
  const sources = readMigrationSources(legacyHome);
  writeProfileJSON(join(dir, "migration-sources.json"), { schema: "agent-mem.migration-sources/v1", sources });
  const profile: BoundProfile = { kind: "generation", home: memoryDir, dir, generation, selectorRevision,
    legacyHome, sharded: true, ...(destination === USER ? { shardUser: true } : { shardKey: destination }) };
  buildGenerationIndex(profile, sources);
  writeProfileJSON(join(dir, "generation-seal.json"), { schema: "agent-mem.generation-seal/v1", generation,
    descriptorHash: hashJSON(generationDescriptor(generation)), sourceDigest: hashJSON({ sources, legacyCommit: undefined }) });
}

function counts(plan: RoutePlan): ShardMigrationCounts {
  return { rows: plan.rows, skippedRows: plan.skippedRows, byShard: plan.byShard, tailBytes: plan.tailBytes };
}

export function shardMigrationStatus(memoryDir: string): { active: boolean; generation?: string; pending: ShardMigrationCounts } {
  const dir = existsSync(memoryDir) ? realPath(memoryDir) : canonicalPath(memoryDir), journal = readJournal(dir, true);
  if (!journal || journal.phase !== "active") return { active: false, pending: { rows: 0, skippedRows: 0, byShard: {}, tailBytes: 0 } };
  const plan = route(capture(dir, journal.generation, journal), journal.sources);
  return { active: true, generation: journal.generation, pending: counts(plan) };
}

export async function migrateShards(options: ShardMigrationOptions): Promise<ShardMigrationResult> {
  if (options.authorizedPerson !== true || options.tty !== true) throw new Error("shard migration requires an authorized person in a terminal");
  if (!["dry-run", "apply", "resume"].includes(options.mode) || options.generation !== undefined && !validGeneration(options.generation)) throw new Error("invalid shard migration request");
  const memoryDir = existsSync(options.memoryDir) ? realPath(options.memoryDir) : canonicalPath(options.memoryDir);
  if (options.mode === "dry-run") {
    const journal = readJournal(memoryDir, true), selection = readSelector(memoryDir);
    const generation = options.generation ?? journal?.generation ?? (selection.selector?.kind === "generation" ? selection.selector.generation : undefined);
    const plan = route(capture(memoryDir, generation, journal), journal?.sources);
    return { mode: options.mode, generation: generation ?? "", active: journal?.phase === "active", counts: counts(plan), consequence: CONSEQUENCE };
  }
  return withProfileLock(memoryDir, async () => {
    assertNoLiveReaders(memoryDir);
    const machine = identity(memoryDir), selection = readSelector(memoryDir);
    const previous = readJournal(memoryDir, true);
    if (options.mode === "resume" && !previous) throw new Error("no resumable shard migration journal");
    if (previous && previous.selectorRevision !== selection.revision) return changed();
    const generation = options.generation ?? previous?.generation ?? randomBytes(16).toString("hex");
    if (previous && generation !== previous.generation) return changed();
    const journal: ShardJournal = previous ?? { schema: SHARDED_SCHEMA, generation, phase: "captured", selectorRevision: selection.revision, sources: [], machine };
    const release = acquireMutation(memoryDir);
    if (!release) throw new Error("legacy mutation lock is busy");
    let captured: Capture;
    try { captured = capture(memoryDir, generation, previous); } finally { release(); }
    const plan = route(captured, previous?.sources);
    if (journal.phase === "active" && plan.lines.length === 0) {
      journal.sources = captured.sources;
      if (captured.legacyCommit) journal.legacyCommit = captured.legacyCommit;
      writeProfileJSON(join(memoryDir, JOURNAL), journal);
      return { mode: options.mode, generation, active: true, alreadyActive: true, counts: counts(plan), consequence: CONSEQUENCE };
    }
    assertNoLiveReaders(memoryDir);
    writeProfileJSON(join(memoryDir, JOURNAL), journal);
    const affected = writeRoutes(memoryDir, plan, generation, machine);
    for (const destination of affected) {
      buildShard(memoryDir, destination, generation, selection.revision);
      if (options.checkpoint) await options.checkpoint("after-shard");
    }
    assertNoLiveReaders(memoryDir);
    if (options.checkpoint) await options.checkpoint("before-active");
    journal.phase = "active";
    journal.sources = captured.sources;
    if (captured.legacyCommit) journal.legacyCommit = captured.legacyCommit;
    writeProfileJSON(join(memoryDir, JOURNAL), journal);
    return { mode: options.mode, generation, active: true, counts: counts(plan), consequence: CONSEQUENCE };
  });
}
