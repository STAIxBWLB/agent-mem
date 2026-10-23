import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, machineId, openShardStore } from "./store.ts";
import { aliasedKeys, readShardedSelection, resolveAlias, shardDir, shardKeyHash, readShardDescriptor } from "./shard.ts";

/**
 * Opens the curated store that holds one project's notes, without initializing anything (#15 T5 reads, never creates):
 * an unsplit home has one shared store (the project filter selects), a split home has one shard per project. A split home's
 * capture-only shard (no `generation.json` yet) has no curated store, and the answer is `undefined`, never an empty one made on the spot.
 */
export function openCuratedForRead(base: string, key: string): MemoryStore | undefined {
  const aliases = aliasedKeys(base, key), reconcile = aliases.length ? { canonical: key, aliases } : undefined;
  if (existsSync(join(base, "shards.json"))) {
    readShardedSelection(base);
    if (!existsSync(join(shardDir(base, key), "generation.json"))) return undefined;
    return openShardStore({ memoryDir: base, project: key, deferPromotions: true, lifecycle: "ignore", ...(reconcile ? { reconcile } : {}) });
  }
  if (!existsSync(join(base, "log")) && !existsSync(join(base, "local")) && !existsSync(join(base, "generations"))) return undefined;
  return new MemoryStore({ memoryDir: base, deferPromotions: true, ...(reconcile ? { reconcile } : {}) });
}

/** The canonical key of `key`, refused unless a shard of it exists. */
export function requireShard(base: string, key: string): string {
  const canonical = resolveAlias(base, key.trim());
  if (!canonical || !readShardDescriptor(base, shardKeyHash(canonical))) throw new Error(`no project shard for ${canonical || key}`);
  return canonical;
}

export const thisMachine = (base: string): string => machineId(base).id;
