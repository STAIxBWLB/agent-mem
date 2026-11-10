import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBriefCache } from "./brief-cache.ts";
import { curatedCacheFresh } from "./brief-curated.ts";
import { curatedProfileBinding } from "./memory/curated-cache-state.ts";
import { canonicalPath } from "./memory/platform.ts";
import { aliasedKeys, captureShardDir, resolveAlias } from "./memory/shard.ts";
import { machineId, MemoryStore, openShardStore } from "./memory/store.ts";

/**
 * Explicit off-hook WRITE: opens the selected store with promotions deferred and atomically
 * prepares one private curated cache (at most four 32-row pages and a 32 KiB file).
 * Hosts must schedule this deliberately outside their hook latency budget. Never raises a floor.
 */
export function prepareCuratedBriefCache(base: string, project: string): void {
  if (typeof base !== "string" || !base.trim() || typeof project !== "string" || !project.trim()) {
    throw Error("curated cache preparation needs a memory directory and project; supply both before retrying off-hook");
  }
  const home = canonicalPath(base), key = resolveAlias(home, project), aliases = aliasedKeys(home, key);
  const options = { memoryDir: home, deferPromotions: true, ...(aliases.length ? { reconcile: { canonical: key, aliases } } : {}) };
  const store = existsSync(join(home, "shards.json")) ? openShardStore({ ...options, project: key }) : new MemoryStore(options);
  try {
    store.prepareCuratedBriefs([key]);
    const cache = readBriefCache({ directory: captureShardDir(home, key, machineId(home).id), project: key, section: "curated" });
    if (!cache || !curatedCacheFresh(cache, curatedProfileBinding(home, key), Date.now())) {
      throw Error("curated cache preparation could not publish a current snapshot; run amem doctor, check source/file permissions, then retry off-hook");
    }
  } finally { store.close(); }
}
