import { existsSync } from "node:fs";
import { join } from "node:path";
import { readWorkBrief, workLogSegments, workPolicyRevision } from "./brief-work.ts";
import { configuredPolicyOptions } from "./memory/config.ts";
import { machineId } from "./memory/machine.ts";
import { recordBriefPublicationFailure } from "./memory/metrics.ts";
import { aliasedKeys, resolveAlias, shardDir } from "./memory/shard.ts";
import { WorkListStore } from "./memory/work-lists.ts";

/** Explicit off-hook preparation for existing work logs, including logs written before snapshots existed. */
export async function prepareWorkBriefCache(base: string, project: string, cwd: string): Promise<void> {
  try {
    const canonical = resolveAlias(base, project), aliases = aliasedKeys(base, canonical);
    if (![canonical, ...aliases].some(key => existsSync(join(shardDir(base, key), "work", "log")))) return;
    const segments = workLogSegments(base, canonical, aliases);
    if (!segments) return recordBriefPublicationFailure(base, "work", "source_unavailable");
    const machine = machineId(base).id, policyOptions = () => configuredPolicyOptions(base, cwd);
    const homeRevision = workPolicyRevision(configuredPolicyOptions(base)), effectiveRevision = workPolicyRevision(policyOptions());
    const current = (policy: string, revision?: string) => {
      const brief = readWorkBrief({ base, project: canonical, machine, revision });
      return brief?.policy === policy && JSON.stringify(brief.segments) === JSON.stringify(segments);
    };
    if (current(homeRevision) && (homeRevision === effectiveRevision || current(effectiveRevision, effectiveRevision))) return;
    const store = new WorkListStore({ base, project: canonical, aliases, policy: () => false, briefPolicyOptions: policyOptions });
    try { await store.publishBrief(); }
    finally { store.close(); }
  } catch { recordBriefPublicationFailure(base, "work", "source_unavailable"); }
}
