import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJSON, generationDescriptor, hashJSON, readProfileJSON, readSelector, validGeneration, type BoundProfile, type GenerationSeal } from "./generation.ts";

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

export const SHARD_SCHEMA = "agent-hub.memory.shard/v1";

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

export interface AliasOp { schema: typeof SHARD_SCHEMA; op: "alias"; at: string; machine: string; alias: string; key: string; actor: string }
/**
 * #27 option 2: the person's removal of one alias. An append-only op in the same local `aliases.jsonl` (never a shared-v1 segment, so no shared-v1 reader sees a new op
 * kind there: an older reader skips the line and keeps resolving the alias, which is the C1 "local only" placement). The latest op for an alias wins, so after an
 * `unalias` the key resolves to itself again, and a later `alias` op maps it again.
 */
export interface UnaliasOp { schema: typeof SHARD_SCHEMA; op: "unalias"; at: string; machine: string; alias: string; actor: string }
export type AliasLogOp = AliasOp | UnaliasOp;

export function aliasLogPath(base: string): string {
  return join(base, "aliases.jsonl");
}

/**
 * One person-reviewed alias op, appended to `aliases.jsonl`. An alias never chains (its target must not itself be
 * an alias), and a machine that races the append keeps both ops: the latest one wins at read time.
 */
export function appendAlias(base: string, input: { alias: string; key: string; actor: string; machine: string; at?: string }): AliasOp {
  const alias = input.alias.trim(), key = input.key.trim();
  if (!alias || !key) throw new Error("an alias needs both keys");
  if (alias === key) throw new Error("an alias cannot target itself");
  if (resolveAlias(base, key) !== key) throw new Error("an alias cannot target another alias");
  // The other direction too, using only the latest op per alias: a target abandoned by a later retarget or a removal is free again.
  const currentTargets = new Set(effectiveAliases(base).values());
  if (currentTargets.has(alias)) throw new Error("an alias target cannot become an alias");
  const op: AliasOp = { schema: SHARD_SCHEMA, op: "alias", at: input.at ?? new Date().toISOString(), machine: input.machine, alias, key, actor: input.actor };
  mkdirSync(base, { recursive: true, mode: 0o700 });
  appendFileSync(aliasLogPath(base), JSON.stringify(op) + "\n", { mode: 0o600 });
  return op;
}

/** Every alias and unalias op in order (the full history); a malformed or unknown line is skipped, never fatal. */
export function listAliases(base: string): AliasLogOp[] {
  let text = "";
  try { text = readFileSync(aliasLogPath(base), "utf8"); } catch { return []; }
  const ops: AliasLogOp[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const op = JSON.parse(line) as AliasLogOp;
      if (op?.schema !== SHARD_SCHEMA || typeof op.alias !== "string") continue;
      if (op.op === "alias" && typeof op.key === "string") ops.push(op);
      else if (op.op === "unalias") ops.push(op);
    } catch { /* a malformed line is skipped */ }
  }
  return ops;
}

/** The aliases in force: for each alias key the latest op decides, and an `unalias` removes it. Map of alias key to canonical key. */
export function effectiveAliases(base: string): Map<string, string> {
  const latest = new Map<string, string>();
  for (const op of listAliases(base)) { if (op.op === "alias") latest.set(op.alias, op.key); else latest.delete(op.alias); }
  return latest;
}

/** The canonical key for a possibly aliased one: the latest op for it, one hop (aliases never chain). An unaliased key is its own canonical key. */
export function resolveAlias(base: string, key: string): string {
  return effectiveAliases(base).get(key) ?? key;
}

/** Every key currently aliased to `canonical`, sorted (the keys whose curated rows the CLI and MCP project filter now covers, #27 option 1). */
export function aliasedKeys(base: string, canonical: string): string[] {
  return [...effectiveAliases(base)].filter(([, key]) => key === canonical).map(([alias]) => alias).sort();
}

/**
 * One person-reviewed removal, appended to `aliases.jsonl`. Nothing is rewritten: the alias line stays in the history and the later op wins. Refused when the key is
 * not aliased now, so a typo never records a removal that means nothing.
 */
export function appendUnalias(base: string, input: { alias: string; actor: string; machine: string; at?: string }): UnaliasOp {
  const alias = input.alias.trim();
  if (!alias) throw new Error("an alias removal needs the alias key");
  if (!effectiveAliases(base).has(alias)) throw new Error(`no alias to remove: ${alias} is not aliased now`);
  const op: UnaliasOp = { schema: SHARD_SCHEMA, op: "unalias", at: input.at ?? new Date().toISOString(), machine: input.machine, alias, actor: input.actor };
  mkdirSync(base, { recursive: true, mode: 0o700 });
  appendFileSync(aliasLogPath(base), JSON.stringify(op) + "\n", { mode: 0o600 });
  return op;
}

/** `memoryBase(home)` plus the shard of `key` after alias resolution. */
export function captureShardDir(base: string, key: string, machine: string): string {
  return shardMachineDir(base, resolveAlias(base, key), machine);
}

export const SHARDED_SCHEMA = "agent-mem.shards/v1";
export interface ShardedSelection { schema: typeof SHARDED_SCHEMA; generation: string; phase: "active"; selectorRevision: string }

export function userShardDir(base: string): string {
  return join(base, "user");
}

export function readShardedSelection(memoryDir: string): ShardedSelection {
  const value = readProfileJSON(join(memoryDir, "shards.json")) as { schema?: unknown; generation?: unknown; phase?: unknown; selectorRevision?: unknown } | undefined;
  if (!value || value.schema !== SHARDED_SCHEMA || !validGeneration(value.generation) || value.phase !== "active" || typeof value.selectorRevision !== "string") throw new Error("no active curated shard migration");
  return { schema: SHARDED_SCHEMA, generation: value.generation, phase: "active", selectorRevision: value.selectorRevision };
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
  for (const database of ["index.db", "search.db", "mutation-lock.db"]) for (const suffix of ["", "-wal", "-shm", "-journal"]) check(join(dir, database + suffix), false);
}

/** Open one already-sealed shard without consulting the legacy home or the catalog. */
export function resolveShardProfile(memoryDir: string, opts: { project?: string; user?: boolean }): BoundProfile {
  if (opts.user === true && opts.project !== undefined || opts.user !== true && !opts.project) throw new Error("choose exactly one project or the user shard");
  assertCuratedShardPaths(memoryDir, opts);
  const selection = readShardedSelection(memoryDir), generation = selection.generation;
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
  const selector = readSelector(memoryDir);
  if (selector.revision !== selection.selectorRevision) throw new Error("curated shard selector changed; resume or inspect migration state");
  const legacyMainHome = join(dir, "legacy-main");
  const hasLegacyMain = existsSync(legacyMainHome) || sources.sources.some(source => !!source && typeof source === "object" && "source" in source && source.source === "legacy-main");
  return { kind: "generation", home: memoryDir, dir, generation, selectorRevision: selector.revision,
    legacyHome: join(dir, "legacy"), ...(hasLegacyMain ? { legacyMainHome } : {}), sharded: true, ...(opts.user === true ? { shardUser: true } : { shardKey: opts.project! }) };
}
