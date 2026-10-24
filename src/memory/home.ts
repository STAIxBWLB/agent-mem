import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "./platform.ts";
import { configuredHome } from "./config.ts";

/** Where the memory home came from, for `amem status`. */
export type HomeSource = "AMEM_HOME" | "config" | "default";
export interface ResolvedHome { home: string; source: HomeSource }

/**
 * Core memory directory, and where that answer came from. In order: `AMEM_HOME`; the `home` key of the default home's `amem.config.json` (F1, agent-mem#40);
 * the historical default `~/.agenthub/memory` (AGENTHUB_HOME retains its historical parent-home meaning).
 */
export function resolveMemoryHome(env: NodeJS.ProcessEnv = process.env): ResolvedHome {
  const own = env.AMEM_HOME?.trim();
  if (own) return { home: canonicalPath(own), source: "AMEM_HOME" };
  const fallback = join(canonicalPath(env.AGENTHUB_HOME?.trim() || join(homedir(), ".agenthub")), "memory");
  const moved = configuredHome(fallback);
  return moved ? { home: canonicalPath(moved), source: "config" } : { home: fallback, source: "default" };
}
export function memoryHome(env: NodeJS.ProcessEnv = process.env): string { return resolveMemoryHome(env).home; }

/** The store's own base convention: `StoreOptions.home` names the parent and gets `/memory` appended. */
export function memoryBase(home?: string): string {
  return home === undefined ? memoryHome() : join(home, "memory");
}
