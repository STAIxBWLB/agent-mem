import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SHARD_SCHEMA = "agent-hub.memory.shard/v1";

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

