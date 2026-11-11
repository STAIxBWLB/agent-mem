import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSelector } from "./generation.ts";
import { aliasedKeys, readShardDescriptor, readShardedSelection } from "./shard.ts";

/** Small selected-profile binding only; never a generation/source refresh. */
export function curatedProfileBinding(base: string, project: string): string {
  return JSON.stringify({ selector: readSelector(base).revision,
    shards: existsSync(join(base, "shards.json")) ? readShardedSelection(base) : null,
    aliases: aliasedKeys(base, project) });
}
/** Off-hook conservative invalidation: derived directories only, never enumerate authoritative logs. */
export function invalidateCuratedCaches(base: string): string[] {
  const projects = new Set<string>(), root = join(base, "projects");
  if (!existsSync(root)) return [];
  for (const hash of readdirSync(root)) {
    if (!/^[a-f0-9]{16}$/.test(hash)) continue;
    const directory = join(root, hash), stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const descriptor = readShardDescriptor(base, hash);
    const machines = join(directory, "machine");
    if (!existsSync(machines)) continue;
    const parent = lstatSync(machines); if (!parent.isDirectory() || parent.isSymbolicLink()) continue;
    for (const machine of readdirSync(machines)) {
      if (!/^[a-f0-9]{16}$/.test(machine)) continue;
      const scope = join(machines, machine), info = lstatSync(scope);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      // The preference slot (#370) is its own file here; a reader that only knows the curated one leaves it to age out.
      const files = ["brief-curated.json", "brief-preferences.json"].map(name => join(scope, name));
      if (!files.some(file => lstatSync(file, { throwIfNoEntry: false }))) continue;
      for (const file of files) rmSync(file, { force: true });
      if (descriptor) projects.add(descriptor.key);
    }
  }
  return [...projects];
}
