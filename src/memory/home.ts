import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "./platform.ts";

/** Core memory directory. AGENTHUB_HOME retains its historical parent-home meaning. */
export function memoryHome(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.AMEM_HOME?.trim();
  if (own) return canonicalPath(own);
  return join(canonicalPath(env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub")), "memory");
}

/** The store's own base convention: `StoreOptions.home` names the parent and gets `/memory` appended. */
export function memoryBase(home?: string): string {
  return home === undefined ? memoryHome() : join(home, "memory");
}
