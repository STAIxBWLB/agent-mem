import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, openShardStore } from "./store.ts";
import { readShardDescriptor, shardKeyHash } from "./shard.ts";

/** Rebuild derived curated views after the profile and source writer fences have released. */
export async function rebuildCuratedCachesAfterProfileChange(base: string, previousProjects: readonly string[]): Promise<void> {
  try {
    const projects = new Set(previousProjects);
    const sharded = existsSync(join(base, "shards.json"));

    if (!sharded) {
      let store: MemoryStore | undefined;
      try {
        store = new MemoryStore({ memoryDir: base, deferPromotions: true });
        store.prepareCuratedBriefs();
      } catch { /* A missing derived cache is safer than stale publication or a failed migration. */ }
      finally { try { store?.close(); } catch { /* Cache maintenance never changes migration success. */ } }
      return;
    }

    const root = join(base, "projects");
    if (existsSync(root)) for (const hash of readdirSync(root)) {
      if (!/^[a-f0-9]{16}$/.test(hash)) continue;
      const descriptor = readShardDescriptor(base, hash);
      if (descriptor && existsSync(join(root, hash, "generation.json"))) projects.add(descriptor.key);
    }

    for (const project of projects) {
      if (!existsSync(join(base, "projects", shardKeyHash(project), "generation.json"))) continue;
      let store: MemoryStore | undefined;
      try {
        store = openShardStore({ memoryDir: base, project, deferPromotions: true });
        store.prepareCuratedBriefs([project]);
      } catch { /* Keep this derived cache unavailable; never turn a committed migration into failure. */ }
      finally { try { store?.close(); } catch { /* Cache maintenance never changes migration success. */ } }
    }
  } catch { /* Cache maintenance never changes migration success; invalidated files stay missing. */ }
}
