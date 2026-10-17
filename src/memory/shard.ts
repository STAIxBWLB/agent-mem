import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  const op: AliasOp = { schema: SHARD_SCHEMA, op: "alias", at: input.at ?? new Date().toISOString(), machine: input.machine, alias, key, actor: input.actor };
  mkdirSync(base, { recursive: true, mode: 0o700 });
  appendFileSync(aliasLogPath(base), JSON.stringify(op) + "\n", { mode: 0o600 });
  return op;
}

/** Every alias op in order; a malformed line is skipped, never fatal. */
export function listAliases(base: string): AliasOp[] {
  let text = "";
  try { text = readFileSync(aliasLogPath(base), "utf8"); } catch { return []; }
  const ops: AliasOp[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const op = JSON.parse(line) as AliasOp;
      if (op?.schema === SHARD_SCHEMA && op.op === "alias" && typeof op.alias === "string" && typeof op.key === "string") ops.push(op);
    } catch { /* a malformed line is skipped */ }
  }
  return ops;
}

/** The canonical key for a possibly aliased one: the latest op for it, one hop (aliases never chain). */
export function resolveAlias(base: string, key: string): string {
  const ops = listAliases(base).filter((op) => op.alias === key);
  return ops.length ? ops[ops.length - 1]!.key : key;
}

/** `memoryBase(home)` plus the shard of `key` after alias resolution. */
export function captureShardDir(base: string, key: string, machine: string): string {
  return shardMachineDir(base, resolveAlias(base, key), machine);
}
