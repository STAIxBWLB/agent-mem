import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSelector } from "./generation.ts";
import { aliasedKeys, readShardDescriptor, readShardedSelection, resolveAlias, shardKeyHash } from "./shard.ts";

/** Small selected-profile binding only; never a generation/source refresh. */
export function curatedProfileBinding(base: string, project: string): string {
  return JSON.stringify({ selector: readSelector(base).revision,
    shards: existsSync(join(base, "shards.json")) ? readShardedSelection(base) : null,
    aliases: aliasedKeys(base, project) });
}
export interface CuratedCacheCandidate { project: string; activity: number; warm: boolean }

function fileActivity(file: string): number | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isFile()) return stat.mtimeMs;
  } catch { /* An unreadable derived file gives no activity signal. */ }
}

/** Off-hook conservative invalidation: derived directories only, never enumerate authoritative logs.
 * #424: `projects` limits removal to those projects' cache directories (an alias resolves to its canonical directory),
 * so one project's write keeps every other project's prebuilt brief. Omitted, every project is invalidated. */
export function invalidateCuratedCaches(base: string, projects?: readonly string[], observe?: { machine: string; now: number; candidate: (candidate: CuratedCacheCandidate) => void }): string[] {
  const invalidated = new Set<string>(), root = join(base, "projects");
  if (!existsSync(root)) return [];
  const only = projects && new Set(projects.flatMap(project => [shardKeyHash(project), shardKeyHash(resolveAlias(base, project))]));
  for (const hash of readdirSync(root)) {
    if (!/^[a-f0-9]{16}$/.test(hash) || only && !only.has(hash)) continue;
    const directory = join(root, hash), stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const descriptor = readShardDescriptor(base, hash);
    const machines = join(directory, "machine");
    const parent = lstatSync(machines, { throwIfNoEntry: false });
    if (parent && !parent.isDirectory()) continue;
    if (observe && descriptor && shardKeyHash(descriptor.key) === hash && fileActivity(join(directory, "generation.json")) !== undefined) {
      const scope = join(machines, observe.machine);
      const local = lstatSync(scope, { throwIfNoEntry: false });
      if (!local || local.isDirectory()) {
        const lastCurated = fileActivity(join(scope, "brief-curated.json"));
        observe.candidate({ project: descriptor.key, activity: fileActivity(join(scope, "brief-capture.json")) ?? 0,
          warm: lastCurated !== undefined && observe.now - lastCurated < 24 * 60 * 60 * 1000 });
      }
    }
    if (!parent) continue;
    for (const machine of readdirSync(machines)) {
      if (!/^[a-f0-9]{16}$/.test(machine)) continue;
      const scope = join(machines, machine), info = lstatSync(scope);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      // The preference slot (#370) is its own file here; a reader that only knows the curated one leaves it to age out.
      const files = ["brief-curated.json", "brief-preferences.json"].map(name => join(scope, name));
      if (!files.some(file => lstatSync(file, { throwIfNoEntry: false }))) continue;
      for (const file of files) rmSync(file, { force: true });
      if (descriptor) invalidated.add(descriptor.key);
    }
  }
  return [...invalidated];
}
