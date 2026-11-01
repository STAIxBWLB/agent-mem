import { assertNoPublicPruneIntent, readPublicPruneView } from "./public-prune-view.ts";
import { indexFileName } from "./index-file.ts";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON, readProfileJSON, readSelector, validGeneration, PROFILE_LOCK_TIMEOUT_MS, type BoundProfile, type GenerationSeal } from "./generation.ts";
import { SHARD_SCHEMA, resolveAlias } from "./aliases.ts";

/**
 * #15 T1: the per-project shard layout under the user home. One shard per project key at `projects/<key-hash>/`;
 * the machine scope (capture tier, spool, per-machine config) lives one level down at `machine/<id>/`, so the
 * layout already matches the #15 scope table (machine scope never syncs) while D1's `projects/<key-hash>/` stays
 * the shard root the later phases put the curated logs and index into. Each shard holds its own locks (its own
 * sqlite files), so two projects never contend.
 *
 * Identity (D2): the project key is `memoryProjectKey` (the normalized origin URL), unchanged; a worktree, a
 * submodule and the main checkout share the repository's key, and two unrelated same-named repositories without a
 * remote get distinct path-hash keys, flagged `local` in the shard's `project.json` and in the catalog. A
 * person-reviewed alias op maps a renamed, moved or claude-mem-imported key onto the canonical one; aliases are
 * append-only ops in `aliases.jsonl`, resolved one hop, and never merged automatically on a name match.
 */

export { SHARD_SCHEMA, aliasLogPath, appendAlias, appendUnalias, listAliases, effectiveAliases, resolveAlias, aliasedKeys, type AliasOp, type UnaliasOp, type AliasLogOp } from "./aliases.ts";

/** The directory name of one project's shard: a hash, since keys are URLs and path-hash forms. */
export function shardKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** A key in the no-remote path-hash form (`chain@hash8`) is this machine's only; the catalog flags it. */
export const isLocalKey = (key: string): boolean => /.+@[0-9a-f]{8}$/.test(key);

export function shardDir(base: string, key: string): string {
  return join(base, "projects", shardKeyHash(key));
}

/** The machine scope of one shard: capture.db, the spool and the per-machine config. */
export function shardMachineDir(base: string, key: string, machine: string): string {
  return join(shardDir(base, key), "machine", machine);
}

export interface ShardDescriptor { schema: typeof SHARD_SCHEMA; key: string; local: boolean }

/**
 * The shard's own record of its key (the directory name is a hash). Created once, race-safe: every writer links
 * its own temp file into place and the winner's content stands, exactly like `machine.json`.
 */
export function ensureShardDescriptor(base: string, key: string): ShardDescriptor {
  const dir = shardDir(base, key);
  const file = join(dir, "project.json");
  const read = (): ShardDescriptor | undefined => {
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as ShardDescriptor;
      if (d?.schema === SHARD_SCHEMA && d.key === key && typeof d.local === "boolean") return d;
    } catch { /* none, or unreadable */ }
    return undefined;
  };
  const found = read();
  if (found) return found;
  const descriptor: ShardDescriptor = { schema: SHARD_SCHEMA, key, local: isLocalKey(key) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(descriptor) + "\n", { mode: 0o600 });
  try { linkSync(tmp, file); } catch { /* another process created it: its content wins */ } finally { rmSync(tmp, { force: true }); }
  const won = read();
  if (!won) throw new Error(`${file} holds no valid shard descriptor; remove it and a new one is made`);
  return won;
}

/** Every shard's descriptor, for the catalog. A shard without a readable descriptor is skipped, never fatal. */
export function readShardDescriptor(base: string, hash: string): ShardDescriptor | undefined {
  try {
    const d = JSON.parse(readFileSync(join(base, "projects", hash, "project.json"), "utf8")) as ShardDescriptor;
    if (d?.schema === SHARD_SCHEMA && typeof d.key === "string" && typeof d.local === "boolean") return d;
  } catch { /* absent or unreadable */ }
  return undefined;
}

/** `memoryBase(home)` plus the shard of `key` after alias resolution. */
export function captureShardDir(base: string, key: string, machine: string): string {
  return shardMachineDir(base, resolveAlias(base, key), machine);
}

export const SHARDED_SCHEMA = "agent-mem.shards/v1";
export const SHARDED_V2_SCHEMA = "agent-mem.shards/v2";
export const SHARDED_V2_FIELDS = ["schema", "generation", "phase", "selectorRevision", "sourceGeneration", "sources", "machine", "legacyCommit", "deadLeasesRemoved"] as const;
export interface ShardedSelection { schema: typeof SHARDED_SCHEMA | typeof SHARDED_V2_SCHEMA; generation: string; phase: "active"; selectorRevision: string }

export function userShardDir(base: string): string {
  return join(base, "user");
}

type ShardedJournal = Record<string, unknown> & ShardedSelection;
function shardJournal(memoryDir: string): ShardedJournal {
  const value = readProfileJSON(join(memoryDir, "shards.json")) as Record<string, unknown> | undefined;
  if (!value || (value.schema !== SHARDED_SCHEMA && value.schema !== SHARDED_V2_SCHEMA) || !validGeneration(value.generation) || value.phase !== "active" || typeof value.selectorRevision !== "string") throw new Error("no active curated shard migration");
  if (value.schema === SHARDED_V2_SCHEMA && Object.keys(value).some(key => !(SHARDED_V2_FIELDS as readonly string[]).includes(key))) throw new Error("unsupported curated shard view");
  return value as ShardedJournal;
}
function compatibleShardAdvance(before: ShardedJournal, after: ShardedJournal): boolean {
  if (before.schema !== SHARDED_V2_SCHEMA || after.schema !== SHARDED_V2_SCHEMA) return false;
  const { selectorRevision: _old, ...old } = before, { selectorRevision: _next, ...next } = after;
  return canonicalJSON(old) === canonicalJSON(next);
}
function shardSnapshot(memoryDir: string, deadline: number) {
  assertNoPublicPruneIntent(memoryDir, deadline);
  let journal = shardJournal(memoryDir);
  for (let attempt = 0; attempt < 6 && Date.now() <= deadline; attempt++) {
    let selector: ReturnType<typeof readSelector>;
    try { selector = readSelector(memoryDir, deadline); }
    catch (error) {
      // The writer's spent wait budget or unavailable proof is never restarted here.
      if (error instanceof Error && error.message === "public prune view unavailable") throw error;
      const current = shardJournal(memoryDir);
      if (current.selectorRevision === journal.selectorRevision || !compatibleShardAdvance(journal, current)) throw error;
      journal = current; continue;
    }
    const current = shardJournal(memoryDir);
    if (canonicalJSON(current) !== canonicalJSON(journal)) {
      if (!compatibleShardAdvance(journal, current)) throw new Error("curated shard selector changed");
      journal = current; continue;
    }
    if ((journal.schema === SHARDED_V2_SCHEMA) !== (selector.selector?.schema === "agent-mem.profile/v2")) throw new Error("curated shard selector changed");
    if (journal.schema === SHARDED_V2_SCHEMA && (selector.revision !== journal.selectorRevision || selector.selector?.generation !== journal.generation)) continue;
    return { journal, selector };
  }
  throw new Error("curated shard selector changed");
}
export function readShardedSelection(memoryDir: string): ShardedSelection {
  const { journal } = shardSnapshot(memoryDir, Date.now() + PROFILE_LOCK_TIMEOUT_MS);
  return { schema: journal.schema, generation: journal.generation, phase: "active", selectorRevision: journal.selectorRevision };
}

/** Fixed curated paths cannot redirect writes into legacy inputs or another shard.
 * ponytail: same-user concurrent parent replacement needs descriptor-relative opens; fixed preflight does not claim that fence.
 */
export function assertCuratedShardPaths(memoryDir: string, opts: { project?: string; user?: boolean }): void {
  const dir = opts.user === true ? userShardDir(memoryDir) : shardDir(memoryDir, opts.project!);
  const check = (path: string, directory: boolean) => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("curated shard path is not a regular owned path");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  if (opts.user !== true) check(join(memoryDir, "projects"), true);
  check(dir, true);
  for (const folder of ["log", "local", "legacy", "legacy/log", "legacy/local", "legacy-main", "legacy-main/log", "legacy-main/local"]) check(join(dir, folder), true);
  for (const name of ["project.json", "generation.json", "generation-seal.json", "migration-sources.json", "machine.json", "legacy/machine.json", "legacy-main/machine.json", "prune-translations.jsonl"]) check(join(dir, name), false);
  for (const database of new Set(["index.db", "index-v2.db", indexFileName(false), indexFileName(true), "search.db", "mutation-lock.db"])) for (const suffix of ["", "-wal", "-shm", "-journal"]) check(join(dir, database + suffix), false);
}

/** Open one already-sealed shard without consulting the legacy home or the catalog. */
export function resolveShardProfile(memoryDir: string, opts: { project?: string; user?: boolean }): BoundProfile {
  if (opts.user === true && opts.project !== undefined || opts.user !== true && !opts.project) throw new Error("choose exactly one project or the user shard");
  assertCuratedShardPaths(memoryDir, opts);
  const deadline = Date.now() + PROFILE_LOCK_TIMEOUT_MS, initial = shardSnapshot(memoryDir, deadline), generation = initial.journal.generation;
  const dir = opts.user === true ? userShardDir(memoryDir) : shardDir(memoryDir, opts.project!);
  if (opts.project !== undefined && readShardDescriptor(memoryDir, shardKeyHash(opts.project))?.key !== opts.project) throw new Error("curated shard project identity mismatch");
  const expected = generationDescriptor(generation);
  if (canonicalJSON(readProfileJSON(join(dir, "generation.json"), 4096)) !== canonicalJSON(expected)) throw new Error("curated shard generation metadata mismatch");
  const sources = readProfileJSON(join(dir, "migration-sources.json")) as { schema?: unknown; sources?: unknown; legacyCommit?: unknown } | undefined;
  const seal = readProfileJSON(join(dir, "generation-seal.json"), 4096) as GenerationSeal | undefined;
  if (!sources || sources.schema !== "agent-mem.migration-sources/v1" || !Array.isArray(sources.sources)
    || !seal || seal.schema !== "agent-mem.generation-seal/v1" || seal.generation !== generation
    || seal.descriptorHash !== hashJSON(expected) || seal.sourceDigest !== hashJSON({ sources: sources.sources, legacyCommit: sources.legacyCommit })) throw new Error("curated shard source seal mismatch");
  const rootMachine = readProfileJSON(join(memoryDir, "machine.json"), 4096) as { id?: unknown } | undefined;
  const shardMachine = readProfileJSON(join(dir, "machine.json"), 4096) as { id?: unknown } | undefined;
  if (typeof rootMachine?.id !== "string" || !/^[a-f0-9]{16}$/.test(rootMachine.id) || rootMachine.id !== shardMachine?.id) throw new Error("curated shard machine identity mismatch");
  const final = shardSnapshot(memoryDir, deadline), selector = final.selector;
  if (canonicalJSON(final.journal) !== canonicalJSON(initial.journal) && !compatibleShardAdvance(initial.journal, final.journal)
    || selector.revision !== final.journal.selectorRevision) throw new Error("curated shard selector changed; resume or inspect migration state");
  if (selector.selector?.schema === "agent-mem.profile/v2") readPublicPruneView(memoryDir, selector.selector.pruneInputSetHash, generation, deadline);
  const legacyMainHome = join(dir, "legacy-main");
  const hasLegacyMain = existsSync(legacyMainHome) || sources.sources.some(source => !!source && typeof source === "object" && "source" in source && source.source === "legacy-main");
  return { kind: "generation", home: memoryDir, dir, generation, selectorRevision: selector.revision,
    ...(selector.selector?.schema === "agent-mem.profile/v2" ? { foreignPruneFormat: selector.selector.foreignPruneFormat, pruneInputSetHash: selector.selector.pruneInputSetHash } : {}),
    legacyHome: join(dir, "legacy"), ...(hasLegacyMain ? { legacyMainHome } : {}), sharded: true, ...(opts.user === true ? { shardUser: true } : { shardKey: opts.project! }) };
}
