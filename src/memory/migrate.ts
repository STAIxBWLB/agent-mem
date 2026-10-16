import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { legacyEntries, legacyHead, readLegacySnapshot, type LegacyCheckpoint } from "./bridge.ts";
import { acquireMutation } from "./mutation.ts";
import { canonicalPath, realPath } from "./platform.ts";
import { canonicalJSON, fsyncDirectory, generationDescriptor, generationDir, hashJSON, readProfileJSON, readSelector, resolveProfile, validGeneration, withProfileLock, writeProfileJSON, type BoundProfile } from "./generation.ts";

export interface SourcePrefix extends LegacyCheckpoint { tailBytes: number }
interface MigrationJournal {
  schema: "agent-mem.migration/v1";
  generation: string;
  selectorRevision: string;
  phase: "captured" | "built" | "sealed" | "active";
  sources: SourcePrefix[];
  machine: { id: string; label: string };
  legacyCommit?: string;
}
export interface MigrationCounts {
  validRows: number;
  skippedRows: number;
  byOp: Record<string, number>;
  byTier: Record<string, number>;
  tailBytes: number;
  expiredRows: number;
  eligibleRows: number;
}
export interface MigrationResult {
  mode: MigrateOptions["mode"];
  profile: BoundProfile;
  counts?: MigrationCounts;
  alreadyActive?: boolean;
  consequence: string;
}
export interface MigrateOptions {
  /** Direct M, with no historical parent-home conversion. */
  memoryDir: string;
  mode: "dry-run" | "apply" | "resume" | "deactivate";
  generation?: string;
  authorizedPerson: boolean;
  tty: boolean;
  /** Trusted builder must verify complete incremental/rebuild table equality. Injection is for crash fixtures. */
  buildIndex?: (profile: BoundProfile, sources: readonly SourcePrefix[], legacyCommit?: string) => void | Promise<void>;
  now?: () => number;
}
const changed = (): never => { throw new Error("migration source or selector changed; inspect local migration state before continuing"); };
const consequence = "Generation writes never enter shared v1; legacy writers may continue. Deactivation omits generation-only notes and prune decisions.";
/** Capture only complete authored prefixes. This performs no writes, lock creation, index opens or network. */
export function readMigrationSources(memoryDir: string, generation?: string): SourcePrefix[] {
  const commit = generation ? legacyHead(memoryDir, generation) : undefined;
  return readLegacySnapshot(memoryDir, { generation, commit }).map(({ bytes: _bytes, local: _local, ...source }) => source);
}
export function readMigrationPrefix(memoryDir: string, source: SourcePrefix, generation?: string): Buffer {
  return readLegacySnapshot(memoryDir, { generation, commit: source.commit, limits: [source] })[0]!.bytes;
}
function verifySources(memoryDir: string, generation: string, sources: readonly SourcePrefix[], legacyCommit?: string): void {
  readLegacySnapshot(memoryDir, { generation, commit: legacyCommit, limits: sources });
}

function identity(memoryDir: string): { id: string; label: string } {
  const value = readProfileJSON(join(memoryDir, "machine.json"), 4096) as { id?: unknown; label?: unknown } | undefined;
  if (!value || typeof value.id !== "string" || !/^[a-f0-9]{16}$/.test(value.id) || typeof value.label !== "string") throw new Error("initialize a valid legacy machine identity before migration");
  return { id: value.id, label: value.label };
}
function journalAt(memoryDir: string): string { return join(memoryDir, "migration.json"); }
function readJournal(memoryDir: string): MigrationJournal {
  const value = readProfileJSON(journalAt(memoryDir)) as MigrationJournal | undefined;
  if (!value || value.schema !== "agent-mem.migration/v1" || !validGeneration(value.generation) || !["captured", "built", "sealed", "active"].includes(value.phase)
    || !(value.selectorRevision === "absent" || /^[a-f0-9]{64}$/.test(value.selectorRevision)) || !Array.isArray(value.sources)
    || !value.machine || !/^[a-f0-9]{16}$/.test(value.machine.id) || typeof value.machine.label !== "string") throw new Error("no valid resumable migration journal");
  for (const source of value.sources) if (!["legacy-local", "legacy-main"].includes(source.source) || typeof source.path !== "string" || !Number.isSafeInteger(source.offset) || source.offset < 0 || !/^[a-f0-9]{64}$/.test(source.hash)
    || !Number.isSafeInteger(source.tailBytes) || source.tailBytes < 0) throw new Error("invalid migration source receipt");
  return value;
}
async function defaultBuild(profile: BoundProfile, sources: readonly SourcePrefix[], legacyCommit?: string): Promise<void> {
  const core = await import("./store.ts");
  await core.buildGenerationIndex(profile, sources, legacyCommit);
}
async function counts(memoryDir: string, generation: string | undefined, now: number): Promise<MigrationCounts> {
  const core = await import("./store.ts");
  let skippedRows = 0;
  const commit = generation ? legacyHead(memoryDir, generation) : undefined;
  const segments = readLegacySnapshot(memoryDir, { generation, commit, onMalformed: () => skippedRows++ });
  const rows = legacyEntries(segments, { onMalformed: () => {} });
  const result = core.summarizeRawExpiry(rows.map(row => canonicalJSON(row)), now, segments.reduce((sum, source) => sum + source.tailBytes, 0));
  return { ...result, skippedRows };
}

function rememberJournal(memoryDir: string, journal: MigrationJournal): void {
  writeProfileJSON(journalAt(memoryDir), journal);
}
function writeSources(memoryDir: string, journal: MigrationJournal): void {
  writeProfileJSON(join(generationDir(memoryDir, journal.generation), "migration-sources.json"),
    { schema: "agent-mem.migration-sources/v1", sources: journal.sources, legacyCommit: journal.legacyCommit });
}

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  if (options.authorizedPerson !== true || options.tty !== true) throw new Error("migration requires an authorized person in a terminal");
  if (!["dry-run", "apply", "resume", "deactivate"].includes(options.mode) || options.generation !== undefined && !validGeneration(options.generation)) throw new Error("invalid migration request");
  const memoryDir = existsSync(options.memoryDir) ? realPath(options.memoryDir) : canonicalPath(options.memoryDir);
  const initial = resolveProfile(memoryDir);
  if (options.mode === "dry-run") {
    return { mode: options.mode, profile: initial, counts: await counts(memoryDir, options.generation ?? initial.generation, (options.now ?? Date.now)()), consequence };
  }
  // No directory/identity is silently initialized by migration itself.
  const machine = identity(memoryDir);
  return withProfileLock(memoryDir, async () => {
    const selected = readSelector(memoryDir);
    if (selected.revision !== initial.selectorRevision) return changed();
    if (options.mode === "deactivate") {
      if (initial.kind === "generation") {
        const releaseGeneration = acquireMutation(initial.dir);
        if (!releaseGeneration) throw new Error("generation mutation lock is busy");
        try {
          if (readSelector(memoryDir).revision !== initial.selectorRevision) return changed();
          writeProfileJSON(join(memoryDir, "profile.json"), { schema: "agent-mem.profile/v1", kind: "shared-v1" });
        } finally { releaseGeneration(); }
      }
      return { mode: options.mode, profile: resolveProfile(memoryDir), consequence };
    }
    let journal: MigrationJournal;
    if (options.mode === "resume") {
      journal = readJournal(memoryDir);
      if (options.generation !== undefined && options.generation !== journal.generation) return changed();
    } else {
      if (initial.kind === "generation") {
        if (options.generation !== undefined && options.generation !== initial.generation) throw new Error("deactivate the current generation before selecting another");
        return { mode: options.mode, profile: initial, alreadyActive: true, consequence };
      }
      if (existsSync(journalAt(memoryDir))) {
        const previous = readJournal(memoryDir);
        if (previous.phase !== "active") throw new Error("unfinished migration requires explicit resume");
      }
      const generation = options.generation ?? randomBytes(16).toString("hex");
      const dir = generationDir(memoryDir, generation);
      let generationMachine = machine;
      if (existsSync(dir)) {
        // Reopening a sealed, same-machine generation is explicit selection, not recovery of an unknown staging dir.
        resolveProfile(memoryDir, { generation });
        const existing = readProfileJSON(join(dir, "machine.json")) as { id?: unknown; label?: unknown } | undefined;
        if (!existing || existing.id !== machine.id || typeof existing.label !== "string") return changed();
        generationMachine = { id: machine.id, label: existing.label };
      }
      const releaseLegacy = acquireMutation(memoryDir);
      if (!releaseLegacy) throw new Error("legacy mutation lock is busy");
      let sources: SourcePrefix[], legacyCommit: string | undefined;
      try {
        legacyCommit = existsSync(dir) ? legacyHead(memoryDir, generation) : undefined;
        const previous = existsSync(dir) ? readProfileJSON(join(dir, "migration-sources.json")) as { sources?: SourcePrefix[]; legacyCommit?: string } | undefined : undefined;
        const segments = readLegacySnapshot(memoryDir, { generation, commit: legacyCommit, previousCommit: previous?.legacyCommit, checkpoints: previous?.sources });
        sources = segments.map(({ bytes: _bytes, local: _local, ...source }) => source);
      } finally { releaseLegacy(); }
      journal = { schema: "agent-mem.migration/v1", generation, selectorRevision: initial.selectorRevision, phase: "captured", sources, machine: generationMachine, legacyCommit };
      // Persist G before creating any staging state, so crash recovery cannot invent a second generation.
      rememberJournal(memoryDir, journal);
    }
    const dir = generationDir(memoryDir, journal.generation);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const folder of ["log", "local"]) mkdirSync(join(dir, folder), { recursive: true, mode: 0o700 });
    for (const [name, value] of [["generation.json", generationDescriptor(journal.generation)], ["machine.json", journal.machine]] as const) {
      const prior = readProfileJSON(join(dir, name));
      if (prior === undefined) writeProfileJSON(join(dir, name), value);
      else if (canonicalJSON(prior) !== canonicalJSON(value)) return changed();
    }
    rememberJournal(memoryDir, journal);
    fsyncDirectory(join(memoryDir, "generations")); fsyncDirectory(memoryDir);
    if (selected.selector?.kind === "generation" && selected.selector.generation === journal.generation) {
      const profile = resolveProfile(memoryDir);
      journal.phase = "active"; rememberJournal(memoryDir, journal);
      return { mode: options.mode, profile, alreadyActive: true, consequence };
    }
    if (selected.revision !== journal.selectorRevision) return changed();
    if (canonicalJSON(readProfileJSON(join(dir, "generation.json"))) !== canonicalJSON(generationDescriptor(journal.generation))
      || canonicalJSON(readProfileJSON(join(dir, "machine.json"))) !== canonicalJSON(journal.machine) || journal.machine.id !== machine.id) return changed();
    verifySources(memoryDir, journal.generation, journal.sources, journal.legacyCommit);
    const profile: BoundProfile = { kind: "generation", home: memoryDir, dir, generation: journal.generation, selectorRevision: journal.selectorRevision };
    const releaseGeneration = acquireMutation(dir);
    if (!releaseGeneration) throw new Error("generation mutation lock is busy");
    try {
      if (journal.phase !== "sealed" && journal.phase !== "active") writeSources(memoryDir, journal);
      if (journal.phase !== "sealed" && journal.phase !== "active") {
        await (options.buildIndex ?? defaultBuild)(profile, journal.sources, journal.legacyCommit);
        journal.phase = "built"; rememberJournal(memoryDir, journal);
        verifySources(memoryDir, journal.generation, journal.sources, journal.legacyCommit);
        writeProfileJSON(join(dir, "generation-seal.json"), { schema: "agent-mem.generation-seal/v1", generation: journal.generation,
          descriptorHash: hashJSON(generationDescriptor(journal.generation)), sourceDigest: hashJSON({ sources: journal.sources, legacyCommit: journal.legacyCommit }) });
        journal.phase = "sealed"; rememberJournal(memoryDir, journal);
      }
      verifySources(memoryDir, journal.generation, journal.sources, journal.legacyCommit);
      resolveProfile(memoryDir, { generation: journal.generation });
      if (readSelector(memoryDir).revision !== journal.selectorRevision) return changed();
      writeProfileJSON(join(memoryDir, "profile.json"), { schema: "agent-mem.profile/v1", kind: "generation", generation: journal.generation });
      journal.phase = "active"; rememberJournal(memoryDir, journal);
      return { mode: options.mode, profile: resolveProfile(memoryDir), consequence };
    } finally { releaseGeneration(); }
  });
}
