import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { legacyEntries, legacyHead, readLegacySnapshot, type LegacyCheckpoint } from "./bridge.ts";
import { acquireMutation } from "./mutation.ts";
import { canonicalPath, realPath } from "./platform.ts";
import { canonicalJSON, fsyncDirectory, generationDescriptor, generationDir, hashJSON, readProfileJSON, readSelector, resolveProfile, validGeneration, withProfileLock, writeProfileJSON, type BoundProfile } from "./generation.ts";
import { label, PLAIN, singleLine, type Style } from "./style.ts";

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
export type MigrationCheckpoint = "after-seal" | "before-selector" | "after-selector";
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
  /** Trusted fault-injection callback for crash recovery fixtures; no protocol data or authority. */
  checkpoint?: (stage: MigrationCheckpoint) => void | Promise<void>;
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
async function counts(memoryDir: string, generation: string | undefined, now: number, limits?: readonly SourcePrefix[], capturedCommit?: string): Promise<MigrationCounts> {
  const core = await import("./store.ts");
  let skippedRows = 0;
  const commit = capturedCommit ?? (generation ? legacyHead(memoryDir, generation) : undefined);
  const segments = readLegacySnapshot(memoryDir, { generation, commit, ...(limits ? { limits } : {}), onMalformed: () => skippedRows++ });
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

function refuseShardSelection(memoryDir: string): void {
  try { lstatSync(join(memoryDir, "shards.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("ordinary generation migration is unavailable after shard migration starts; inspect amem status and use amem migrate --shards --resume; the existing selector was retained");
}

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  if (options.authorizedPerson !== true || options.tty !== true) throw new Error("migration requires an authorized person in a terminal");
  if (!["dry-run", "apply", "resume", "deactivate"].includes(options.mode) || options.generation !== undefined && !validGeneration(options.generation)) throw new Error("invalid migration request");
  const memoryDir = existsSync(options.memoryDir) ? realPath(options.memoryDir) : canonicalPath(options.memoryDir);
  refuseShardSelection(memoryDir);
  const selection = readSelector(memoryDir);
  // Explicit undo reads only the selector: broken/missing G must not make the escape back to v1 impossible.
  const selectedG = selection.selector?.kind === "generation" ? selection.selector.generation : undefined;
  const initial: BoundProfile = options.mode === "deactivate"
    ? { kind: selectedG ? "generation" : "shared-v1", home: memoryDir, dir: selectedG ? join(memoryDir, "generations", selectedG) : memoryDir, generation: selectedG, selectorRevision: selection.revision }
    : resolveProfile(memoryDir);
  if (options.mode === "dry-run") {
    return { mode: options.mode, profile: initial, counts: await counts(memoryDir, options.generation ?? initial.generation, (options.now ?? Date.now)()), consequence };
  }
  return withProfileLock(memoryDir, async () => {
    refuseShardSelection(memoryDir);
    const selected = readSelector(memoryDir);
    if (selected.revision !== initial.selectorRevision) return changed();
    if (options.mode === "deactivate") {
      let releaseGeneration: (() => void) | undefined;
      try {
        if (initial.kind === "generation") {
          // Use an existing safe fence when available; never create, repair or validate corrupt generation state.
          const parent = join(memoryDir, "generations"), file = join(initial.dir, "mutation-lock.db");
          const safeDirectory = (path: string) => existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
          if (safeDirectory(parent) && safeDirectory(initial.dir) && existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) {
            let unavailable = false;
            try { releaseGeneration = acquireMutation(initial.dir); } catch { unavailable = true; }
            if (!unavailable && !releaseGeneration) throw new Error("generation mutation lock is busy");
          }
          if (readSelector(memoryDir).revision !== initial.selectorRevision) return changed();
          writeProfileJSON(join(memoryDir, "profile.json"), { schema: "agent-mem.profile/v1", kind: "shared-v1" });
        }
        return { mode: options.mode, profile: resolveProfile(memoryDir), consequence };
      } finally { releaseGeneration?.(); }
    }
    // Migration apply/resume never initialize an absent or invalid legacy identity.
    const machine = identity(memoryDir);
    let journal: MigrationJournal;
    if (options.mode === "resume") {
      journal = readJournal(memoryDir);
      if (options.generation !== undefined && options.generation !== journal.generation) return changed();
    } else {
      if (initial.kind === "generation") {
        if (options.generation !== undefined && options.generation !== initial.generation) throw new Error("deactivate the current generation before selecting another");
        return { mode: options.mode, profile: initial, alreadyActive: true, counts: await counts(memoryDir, initial.generation, (options.now ?? Date.now)()), consequence };
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
      return { mode: options.mode, profile, alreadyActive: true, counts: await counts(memoryDir, journal.generation, (options.now ?? Date.now)(), journal.sources, journal.legacyCommit), consequence };
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
        if (options.checkpoint) await options.checkpoint("after-seal");
      }
      verifySources(memoryDir, journal.generation, journal.sources, journal.legacyCommit);
      resolveProfile(memoryDir, { generation: journal.generation });
      if (options.checkpoint) await options.checkpoint("before-selector");
      if (readSelector(memoryDir).revision !== journal.selectorRevision) return changed();
      verifySources(memoryDir, journal.generation, journal.sources, journal.legacyCommit);
      writeProfileJSON(join(memoryDir, "profile.json"), { schema: "agent-mem.profile/v1", kind: "generation", generation: journal.generation });
      if (options.checkpoint) await options.checkpoint("after-selector");
      journal.phase = "active"; rememberJournal(memoryDir, journal);
      return { mode: options.mode, profile: resolveProfile(memoryDir), counts: await counts(memoryDir, journal.generation, (options.now ?? Date.now)(), journal.sources, journal.legacyCommit), consequence };
    } finally { releaseGeneration(); }
  });
}

/** Render a migration result for a person; JSON output remains owned by the CLI. */
export function migrationText(result: MigrationResult, s: Style = PLAIN): string {
  const active = result.profile.kind === "generation";
  const needsResume = result.mode === "resume" && !active;
  const state = needsResume ? "attention" : result.mode === "dry-run" ? "preview" : "complete";
  const groups = (value: Record<string, number>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${singleLine(key)}=${count}`).join(", ");
  const countRows = result.counts ? [
    ["valid", result.counts.validRows], ["skipped", result.counts.skippedRows], ["tailBytes", result.counts.tailBytes],
    ["expired", result.counts.expiredRows], ["eligible", result.counts.eligibleRows],
  ].map(([key, value]) => `${label(s, "ok")} ${key} ${value}`) : [`${label(s, "skipped")} counts not returned for this mode`];
  const operationCounts = result.counts ? groups(result.counts.byOp) : "", tierCounts = result.counts ? groups(result.counts.byTier) : "";
  if (operationCounts) countRows.push(`${label(s, "ok")} operations ${operationCounts}`);
  if (tierCounts) countRows.push(`${label(s, "ok")} tiers ${tierCounts}`);
  let action = "none";
  if (result.mode === "dry-run" && !active) action = "apply migration (remove --dry-run, keep other options): amem migrate";
  else if (needsResume) action = "resume migration: amem migrate --resume";
  else if (result.mode === "deactivate" && active) action = "deactivate generation: amem migrate --deactivate";
  const lines = [
    `${s.bold("amem migrate:")} ${state}${result.alreadyActive ? " (already active)" : ""}`,
    `${label(s, "ok")} profile ${result.profile.kind}${result.profile.generation ? ` (generation ${result.profile.generation.slice(0, 8)})` : ""}`,
    `${label(s, "ok")} home ${singleLine(result.profile.home)}`,
    `${label(s, "ok")} current directory ${singleLine(result.profile.dir)}`,
    ...countRows,
    `${label(s, "ok")} effect ${singleLine(result.consequence)}`,
    `Next action: ${action}`,
  ];
  return lines.join("\n");
}
